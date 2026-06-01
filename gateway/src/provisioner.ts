import Docker from "dockerode";
import { config, containerName, volumeName } from "./config.js";
import { log } from "./log.js";

export class FleetFullError extends Error {
  constructor(max: number) {
    super(`fleet is full (MAX_FLEET=${max}); reclaim an idle browser or raise the cap`);
    this.name = "FleetFullError";
  }
}

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface FleetMember {
  name: string;
  containerId: string;
  state: string; // running | exited | created | ...
  status: string;
}

export class Provisioner {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker =
      docker ?? new Docker({ host: config.dockerHost, port: config.dockerPort, protocol: "http" });
  }

  /** Fail fast at startup if the fleet image is missing (issue #5). */
  async checkImage(): Promise<void> {
    try {
      await this.docker.getImage(config.image).inspect();
    } catch {
      throw new ProvisionError(
        `fleet image '${config.image}' not found via docker-socket-proxy. ` +
          `Build it (docker build -t ${config.image} .) before starting the gateway.`,
      );
    }
  }

  /** Containers we manage, by the `chikin.fleet=1` label. */
  async listFleet(): Promise<FleetMember[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: ["chikin.fleet=1"] },
    });
    return list.map((c) => ({
      name: c.Labels["chikin.name"] ?? (c.Names[0] ?? "").replace(/^\/?chikin-chrome-/, ""),
      containerId: c.Id,
      state: c.State,
      status: c.Status,
    }));
  }

  private async ensureVolume(name: string): Promise<void> {
    const vol = volumeName(name);
    try {
      await this.docker.getVolume(vol).inspect();
      return; // already exists — leave its profile untouched
    } catch {
      // fall through to create
    }
    log.info(`provisioner: creating profile volume ${vol}`);
    await this.docker.createVolume({
      Name: vol,
      Labels: { "chikin.fleet": "1", "chikin.name": name },
    });
    // Ownership is fixed by the container's entrypoint self-chown (it starts as
    // root, chowns /data to the chrome UID, then drops privileges).

    // Seed from the golden snapshot so the browser starts logged in. Skipped if
    // unset, if this volume *is* the seed, or if the seed doesn't exist yet.
    const seed = config.seedVolume;
    if (seed && seed !== vol) {
      try {
        await this.docker.getVolume(seed).inspect();
        log.info(`provisioner: seeding ${vol} from ${seed}`);
        await this.seedVolumeFrom(seed, vol);
      } catch (e) {
        log.warn(`provisioner: seed volume ${seed} unavailable; ${vol} starts empty`, String(e));
      }
    }
  }

  /**
   * Clone a seed volume's contents into a freshly-created profile volume so a
   * new browser starts from the golden (logged-in) profile. Cookies decrypt
   * across containers because every browser uses the keyring-less `basic`
   * password store (the os_crypt key travels in the copied `Local State`).
   * Best-effort: on failure the browser just starts with an empty profile.
   */
  private async seedVolumeFrom(seedVol: string, targetVol: string): Promise<void> {
    const script =
      "set -e; cp -a /seed/. /data/ 2>/dev/null || true; " +
      // drop instance locks + saved tabs/session so the clone opens clean (about:blank)
      // but keeps Cookies / Login Data / Local Storage / Local State (the os_crypt key).
      "rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie; " +
      'rm -rf /data/Default/Sessions "/data/Default/Current Session" "/data/Default/Current Tabs" "/data/Default/Last Session" "/data/Default/Last Tabs"';
    const helper = await this.docker.createContainer({
      Image: config.image,
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: [script],
      User: "0:0",
      Labels: { "chikin.fleet": "1", "chikin.seed": "1" },
      HostConfig: {
        Binds: [`${seedVol}:/seed:ro`, `${targetVol}:/data`],
        NetworkMode: "none",
        AutoRemove: true,
      },
    });
    await helper.start();
    try {
      const res = (await helper.wait()) as { StatusCode?: number };
      if (res?.StatusCode && res.StatusCode !== 0) {
        log.warn(`provisioner: seed copy into ${targetVol} exited ${res.StatusCode}`);
      }
    } catch (e) {
      // AutoRemove can race the wait result; the copy itself usually succeeded.
      log.debug(`provisioner: seed copy wait (${targetVol}): ${String(e)}`);
    }
  }

  private buildCreateOptions(name: string): Docker.ContainerCreateOptions {
    const shared = config.sharedDir;
    return {
      name: containerName(name),
      Image: config.image,
      Labels: { "chikin.fleet": "1", "chikin.name": name },
      Env: [
        "ENABLE_VNC=1",
        `VNC_PORT=${config.vncPort}`,
        `CDP_PORT=${config.cdpPort}`,
        `WINDOW_SIZE=${config.windowSize}`,
      ],
      HostConfig: {
        Binds: [
          `${volumeName(name)}:/data`,
          // Shared scratch: ~/Downloads + upload path, mirrored at the host
          // path so chrome-devtools-mcp upload_file works verbatim (issue #8).
          `${shared}:/home/chrome/Downloads:rw`,
          `${shared}:${shared}:rw`,
        ],
        ShmSize: 2 * 1024 * 1024 * 1024,
        NetworkMode: config.network,
        RestartPolicy: { Name: "unless-stopped" },
      },
    };
  }

  /**
   * Ensure `chikin-chrome-<name>` exists and is running, then block until its
   * CDP endpoint answers. Creates the container (and volume) on first use,
   * starts it if stopped, reuses it if already running. Enforces MAX_FLEET for
   * genuinely new browsers. Returns the container's IP on the control network —
   * we connect to CDP by IP because Chrome's DevTools HTTP endpoint rejects a
   * Host header that is a DNS name (DNS-rebinding protection).
   */
  async ensureContainer(name: string): Promise<string> {
    const cname = containerName(name);
    const container = this.docker.getContainer(cname);
    let info: Docker.ContainerInspectInfo | null = null;
    try {
      info = await container.inspect();
    } catch {
      info = null;
    }

    if (info) {
      if (!info.State.Running) {
        log.info(`provisioner: starting existing container ${cname}`);
        await container.start();
      } else {
        log.debug(`provisioner: reusing running container ${cname}`);
      }
    } else {
      // New browser — enforce the cap against everything we already manage.
      const fleet = await this.listFleet();
      const existing = fleet.filter((m) => m.name !== name).length;
      if (existing >= config.maxFleet) {
        throw new FleetFullError(config.maxFleet);
      }
      await this.ensureVolume(name);
      log.info(`provisioner: creating container ${cname}`);
      const created = await this.docker.createContainer(this.buildCreateOptions(name));
      // Attach the egress network so the browser can reach the internet; the
      // primary chikin-net is internal-only (CDP isolated from the host).
      try {
        await this.docker.getNetwork(config.egressNetwork).connect({ Container: created.id });
      } catch (e) {
        log.warn(`provisioner: could not attach ${cname} to ${config.egressNetwork}`, String(e));
      }
      await created.start();
    }

    const ip = await this.resolveIp(name);
    await this.waitHealthy(name, ip);
    return ip;
  }

  /** The container's IP on the control network (used for CDP by IP). */
  private async resolveIp(name: string): Promise<string> {
    const info = await this.docker.getContainer(containerName(name)).inspect();
    const ip = info.NetworkSettings.Networks?.[config.network]?.IPAddress;
    if (!ip) {
      throw new ProvisionError(
        `${containerName(name)} has no IP on network ${config.network}`,
      );
    }
    return ip;
  }

  /** Poll the container's CDP /json/version until it answers or we time out. */
  private async waitHealthy(name: string, ip: string): Promise<void> {
    const url = `http://${ip}:${config.cdpPort}/json/version`;
    const deadline = Date.now() + config.provisionTimeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          await res.text();
          log.info(`provisioner: ${containerName(name)} is healthy`);
          return;
        }
        lastErr = `status ${res.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ProvisionError(
      `${containerName(name)} did not become healthy within ${config.provisionTimeoutMs}ms (${lastErr})`,
    );
  }

  /** Stop a browser, preserving its named profile volume (issue #7). */
  async stopContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(name)).stop({ t: 5 });
      log.info(`provisioner: stopped ${containerName(name)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 304 = already stopped; treat as success.
      if (!/already stopped|304|not running/i.test(msg)) {
        log.warn(`provisioner: stop ${containerName(name)} failed`, msg);
      }
    }
  }
}
