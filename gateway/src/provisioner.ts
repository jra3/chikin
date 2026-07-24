import Docker from "dockerode";
import {
  config,
  containerName,
  isInstanceName,
  isInstanceVolume,
  volumeLabels,
  volumeName,
} from "./config.js";
import { seccompProfile } from "./seccomp.js";
// buildCreateOptions is exported above and used both here and by tests.
import { log } from "./log.js";

/**
 * Build the browser container's SecurityOpt (H1 renderer-sandbox hardening).
 *
 * Always keeps `no-new-privileges` on. For sandbox mode auto|on it also inlines
 * the custom seccomp profile so Chrome's user-namespace sandbox can build its
 * namespaces + chroot the renderer under CapDrop:["ALL"] (see seccomp.ts). The
 * entrypoint makes the per-browser launch decision (probe host userns, sandbox
 * or fall back); attaching the widened seccomp is inert on a host that can't do
 * unprivileged userns (the kernel still denies CLONE_NEWUSER regardless), so
 * carrying it in the auto-fallback case grants a compromised renderer nothing.
 * Mode `off` is exactly the pre-hardening posture: Docker's default seccomp.
 */
export function securityOpt(): string[] {
  const opt = ["no-new-privileges"];
  if (config.sandbox === "off") return opt;
  const profile = seccompProfile();
  if (profile) {
    opt.push(`seccomp=${profile}`);
  } else if (config.sandbox === "on") {
    // Forced on but we can't even attach the profile — the entrypoint probe will
    // then fail and (mode=on) abort the container. Surface the root cause here.
    log.error(
      "CHIKIN_SANDBOX=on but the seccomp profile could not be loaded; browsers will fail to boot",
    );
  }
  return opt;
}

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

/**
 * Per-container resource caps (M3), read from the central env config. Returned
 * as a partial HostConfig so buildCreateOptions can spread it in. Each knob is
 * omitted when its config value is 0/≤0, so the shipped defaults are "capped"
 * while an operator can still opt an individual limit back out via env.
 */
export function resourceLimits(): Partial<Docker.HostConfig> {
  const limits: Partial<Docker.HostConfig> = {};
  if (config.memoryMb > 0) {
    const bytes = config.memoryMb * 1024 * 1024;
    limits.Memory = bytes;
    // Pin swap to Memory so the container can't escape the RAM cap into swap.
    limits.MemorySwap = bytes;
  }
  if (config.pidsLimit > 0) {
    limits.PidsLimit = config.pidsLimit;
  }
  if (config.cpus > 0) {
    // Docker's single-knob CPU cap. 1 CPU == 1e9 NanoCpus; round to an integer.
    limits.NanoCpus = Math.round(config.cpus * 1e9);
  }
  if (config.nofile > 0) {
    limits.Ulimits = [{ Name: "nofile", Soft: config.nofile, Hard: config.nofile }];
  }
  return limits;
}

/**
 * Container create options for a fleet browser. Exported (module-level, no
 * instance state) so the mount config is unit-testable at this seam.
 *
 * Shared-scratch isolation (M2 / CHK-007): each browser mounts ONLY its own
 * `${SHARED_DIR}/<name>` subdir — never the bare shared root — both as
 * ~/Downloads and mirrored at the verbatim host path so chrome-devtools-mcp
 * `upload_file` works with a real host path (issue #8). Peers never mount each
 * other's subdir, so isolation is structural, not permission-based. `<name>` is
 * charset-validated upstream (names.ts), so the path can't traverse; we still
 * build it only from the validated name. Docker auto-creates the per-name host
 * dir as root:0755 on first mount; the entrypoint chowns ~/Downloads to chrome.
 */
export function buildCreateOptions(name: string): Docker.ContainerCreateOptions {
  const shared = config.sharedDir;
  const scratch = `${shared}/${name}`;
  return {
    name: containerName(name),
    Image: config.image,
    Labels: { "chikin.fleet": "1", "chikin.name": name },
    Env: [
      "ENABLE_VNC=1",
      `VNC_PORT=${config.vncPort}`,
      `CDP_PORT=${config.cdpPort}`,
      `WINDOW_SIZE=${config.windowSize}`,
      // The entrypoint makes the actual sandbox launch decision (probe host
      // userns; sandbox or fall back). The gateway attaches the matching seccomp
      // profile in securityOpt() below. See config.sandbox / entrypoint.sh.
      `CHIKIN_SANDBOX=${config.sandbox}`,
    ],
    HostConfig: {
      Binds: [
        `${volumeName(name)}:/data`,
        // Per-name scratch: ~/Downloads + upload path, mirrored at the verbatim
        // host path so chrome-devtools-mcp upload_file works (issue #8). Scoped
        // to ${SHARED_DIR}/<name> for cross-browser isolation (M2 / CHK-007).
        `${scratch}:/home/chrome/Downloads:rw`,
        `${scratch}:${scratch}:rw`,
      ],
      ShmSize: 2 * 1024 * 1024 * 1024,
      NetworkMode: config.network,
      RestartPolicy: { Name: "unless-stopped" },
      // Least-privilege hardening (CHK-005). Drop all Linux capabilities, then
      // add back only what the entrypoint's root bootstrap needs before it
      // setpriv-drops to the chrome user: CHOWN + DAC_OVERRIDE to chown the
      // fresh /data profile volume and ~/Downloads, SETUID/SETGID for the
      // privilege drop, and KILL so tini (PID 1, root) can signal the
      // unprivileged child on stop. Chrome itself then runs with no
      // capabilities. no-new-privileges blocks regaining privileges via setuid
      // binaries.
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL"],
      // no-new-privileges always on; for sandbox mode auto|on this also inlines
      // the custom seccomp profile that lets Chrome's userns sandbox run without
      // adding any capability (H1 hardening). See securityOpt() / seccomp.ts.
      SecurityOpt: securityOpt(),
      // Per-container resource caps (M3). MAX_FLEET bounds the count of
      // browsers; these bound what one browser can consume so a single
      // hostile/runaway page can't OOM, fork-bomb, or CPU-starve the host and
      // take down every other client's browser. All configurable via env
      // (config.ts); each knob is omitted entirely when its config is 0 so the
      // default is "capped" but an operator can opt back out.
      ...resourceLimits(),
    },
  };
}

export interface FleetMember {
  name: string;
  containerId: string;
  state: string; // running | exited | created | ...
  status: string;
}

/** Outcome of one orphan-instance-volume sweep (issue #58). */
export interface OrphanSweepResult {
  /** Volumes actually deleted. */
  removed: string[];
  /** Instance volumes skipped because a container still mounts them. */
  inUse: string[];
  /** Instance volumes Docker refused to delete. */
  failed: string[];
}

/** What the entrypoint decided for a browser's renderer sandbox (from its logs). */
export type SandboxStatus = "sandboxed" | "fell-back" | "disabled" | "failed" | "unknown";

export class Provisioner {
  private docker: Docker;
  // Per-container sandbox decision, parsed once from the container's logs and
  // cached by containerId (the decision is fixed for a container's lifetime; a
  // recreated container gets a fresh id and is re-read). Surfaced on the
  // dashboard so an operator can see each browser's real posture (H1).
  private sandboxCache = new Map<string, SandboxStatus>();
  // Serializes the fleet-cap check-and-create critical section (CHK-010). The
  // cap is a read-then-act (listFleet → compare → create); without this, N
  // concurrent provisions of distinct new names each observe the same pre-create
  // fleet size, all pass the check, and overshoot MAX_FLEET. Only the fast
  // docker calls run under the lock; the slow waitHealthy poll stays outside, so
  // concurrent cold-starts still warm up in parallel.
  private createGate: Promise<unknown> = Promise.resolve();

  constructor(docker?: Docker) {
    this.docker =
      docker ?? new Docker({ host: config.dockerHost, port: config.dockerPort, protocol: "http" });
  }

  /**
   * Create a container, keeping the config OUT of the request URL.
   *
   * dockerode/docker-modem mirrors the ENTIRE create config into the request
   * query string (not just `?name=`), then ALSO sends it in the POST body. A
   * small config happens to fit — which is why the pre-sandbox fleet worked —
   * but the ~10KB inlined seccomp profile URL-encodes to ~25KB and overflows the
   * socket-proxy's (haproxy) request-line buffer, which rejects it with a bare
   * 400. Using docker-modem's `_query`/`_body` convention keeps only the name in
   * the URL and the config (profile included) in the body where it belongs.
   */
  private createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    const { name, platform, ...body } = opts as Docker.ContainerCreateOptions & {
      platform?: string;
    };
    const query: Record<string, unknown> = {};
    if (name !== undefined) query.name = name;
    if (platform !== undefined) query.platform = platform;
    return this.docker.createContainer({
      _query: query,
      _body: body,
    } as unknown as Docker.ContainerCreateOptions);
  }

  /** Run `fn` after all previously-gated calls settle (a simple async mutex). */
  private serializeCreate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.createGate.then(fn, fn);
    this.createGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Fail fast at startup if the fleet image is unusable (issue #5).
   *
   * "Present OR pullable": bringing the stack up with the BASE compose file
   * alone points CHROME_IMAGE at `ghcr.io/jra3/chikin:<tag>`, which a developer
   * who only ever built locally does not have — the gateway then died here and
   * crash-looped under `restart: unless-stopped`. So try a pull first (the
   * socket-proxy already allows IMAGES + POST), which makes the plain
   * `docker compose up -d` path just work, and only fail if that can't help —
   * with a message naming the exact fix. `chikin:local` is never pullable, so
   * that case falls through to the message quickly.
   */
  async checkImage(): Promise<void> {
    try {
      await this.docker.getImage(config.image).inspect();
      return;
    } catch {
      // fall through to the pull attempt
    }
    log.warn(`fleet image '${config.image}' not present locally; attempting pull`);
    try {
      await this.pullImage(config.image);
      await this.docker.getImage(config.image).inspect();
      log.info(`fleet image '${config.image}' pulled`);
      return;
    } catch (e) {
      throw new ProvisionError(
        `fleet image '${config.image}' is not present and could not be pulled ` +
          `(${e instanceof Error ? e.message : String(e)}). Fix one of:\n` +
          `  • local/dev images: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d   (or: make dev-up)\n` +
          `  • pinned ghcr images: docker compose --profile build pull && docker compose up -d   (or: make pull up)\n` +
          `Note: CHROME_IMAGE is hardcoded in docker-compose.yml (only the tag comes from CHIKIN_VERSION), ` +
          `so setting CHROME_IMAGE in .env has NO effect — the dev override file is what selects local images.`,
      );
    }
  }

  /** Pull an image through the socket-proxy, bounded so startup can't hang. */
  private async pullImage(image: string, timeoutMs = 180_000): Promise<void> {
    const stream = (await this.docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pull timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Volumes on the host that look like a golden profile seed, used only to spot
   * the "seed exists but SEED_VOLUME is unset" misconfiguration at startup.
   * Per-name profile volumes (chikin-profile-*) are excluded — they are not seeds.
   */
  async findSeedVolumes(): Promise<string[]> {
    const res = (await this.docker.listVolumes()) as { Volumes?: { Name?: string }[] | null };
    return (res.Volumes ?? [])
      .map((v) => v?.Name ?? "")
      .filter((n) => n && /seed/i.test(n) && !n.startsWith(config.volumePrefix))
      .sort();
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
    // chikin.role splits disposables (inst-*) from profiles worth keeping, so a
    // label-scoped prune can be aimed at the garbage only (issue #59). Labels
    // are immutable after create, so this only ever applies to NEW volumes —
    // the gateway's own safety checks go by name, never by this label.
    await this.docker.createVolume({ Name: vol, Labels: volumeLabels(name) });
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

  /**
   * Is this container running an image other than the one we would create it
   * from today? Compares resolved image IDs, not tags: the common case is a
   * rebuilt `chikin:local` (or a moved `:latest`), where the tag is identical
   * and only the ID differs — which is exactly the 30-hour browser still
   * running pre-sandbox-hardening code in issue #57.
   *
   * Fails safe: any doubt (image gone, proxy hiccup, missing field) returns
   * false, so a Docker glitch can never cascade into recreating containers.
   */
  private async isImageStale(info: Docker.ContainerInspectInfo): Promise<boolean> {
    const running = info.Image;
    if (!running) return false;
    try {
      const current = await this.docker.getImage(config.image).inspect();
      return !!current?.Id && current.Id !== running;
    } catch (e) {
      log.debug(`provisioner: could not resolve ${config.image} for a staleness check: ${String(e)}`);
      return false;
    }
  }

  /**
   * Create + start a fleet container for `name` (volume, egress network, start).
   * MUST be called inside `serializeCreate` — its callers do the cap check (new
   * browsers) or the remove-then-recreate (image rotation) in the same critical
   * section, so a freed slot can never be claimed by a concurrent provision
   * between the two halves (CHK-010 / issue #27).
   */
  private async createAndStart(name: string): Promise<void> {
    const cname = containerName(name);
    await this.ensureVolume(name);
    log.info(`provisioner: creating container ${cname}`);
    const created = await this.createContainer(buildCreateOptions(name));
    // Attach the egress network so the browser can reach the internet; the
    // primary chikin-net is internal-only (CDP isolated from the host).
    try {
      await this.docker.getNetwork(config.egressNetwork).connect({ Container: created.id });
    } catch (e) {
      log.warn(`provisioner: could not attach ${cname} to ${config.egressNetwork}`, String(e));
    }
    await created.start();
  }

  /**
   * Ensure `chikin-chrome-<name>` exists and is running, then block until its
   * CDP endpoint answers. Creates the container (and volume) on first use,
   * starts it if stopped, reuses it if already running. Enforces MAX_FLEET for
   * genuinely new browsers. Returns the container's IP on the control network —
   * we connect to CDP by IP because Chrome's DevTools HTTP endpoint rejects a
   * Host header that is a DNS name (DNS-rebinding protection).
   *
   * `opts.canRotateImage` opts this name into IMAGE ROTATION (issue #57): if the
   * existing container runs an image other than the current one, it is recreated
   * instead of reused, so a long-lived browser stops silently outliving image
   * upgrades — and with them the hardening they carry (the reporter's 30-hour
   * browser whose `sandbox` column read `—` while every other row read
   * `sandboxed`). The bridge passes `() => no client stream is attached`, so
   * rotation only ever happens on a COLD attach: nobody's live session is torn
   * down to fix an image problem, and there is no blunt max-age cap that would
   * do exactly that. The profile volume is preserved across the rotation.
   */
  async ensureContainer(
    name: string,
    opts?: { canRotateImage?: () => boolean },
  ): Promise<string> {
    const cname = containerName(name);
    const container = this.docker.getContainer(cname);
    let info: Docker.ContainerInspectInfo | null = null;
    try {
      info = await container.inspect();
    } catch {
      info = null;
    }

    let rotated = false;
    if (info && opts?.canRotateImage?.() && (await this.isImageStale(info))) {
      // Remove-then-recreate under ONE createGate hold: the removal frees a
      // fleet slot, and re-claiming it outside the gate is precisely the
      // MAX_FLEET TOCTOU that CHK-010 closed. No cap check is needed inside —
      // the slot being reused is the one we just freed, so the count is flat.
      await this.serializeCreate(async () => {
        // Re-check inside the gate: everything above is awaited, so a client
        // stream may have attached while we were inspecting.
        if (!opts.canRotateImage?.()) {
          log.info(`provisioner: skipping image rotation for ${cname} — a client attached`);
          return;
        }
        log.info(
          `provisioner: recreating ${cname} on the current ${config.image} ` +
            `(it was started from an older image; profile volume preserved)`,
        );
        await this.stopContainer(name);
        await this.removeContainer(name);
        await this.createAndStart(name);
        rotated = true;
      });
    }

    if (rotated) {
      // Created and started inside the gate above; nothing left to do but wait
      // for its CDP to answer.
    } else if (info) {
      if (!info.State.Running) {
        log.info(`provisioner: starting existing container ${cname}`);
        await container.start();
      } else {
        log.debug(`provisioner: reusing running container ${cname}`);
      }
    } else {
      // New browser — enforce the cap against everything we already manage.
      // The check-and-create runs under createGate so concurrent provisions of
      // distinct names can't all pass the cap and overshoot MAX_FLEET (CHK-010).
      // createContainer makes the container visible to the next listFleet(), so
      // serialization is enough to keep the count honest.
      await this.serializeCreate(async () => {
        const fleet = await this.listFleet();
        const existing = fleet.filter((m) => m.name !== name).length;
        if (existing >= config.maxFleet) {
          throw new FleetFullError(config.maxFleet);
        }
        await this.createAndStart(name);
      });
    }

    const ip = await this.resolveIp(name);
    await this.waitHealthy(name, ip);
    return ip;
  }

  /**
   * The renderer-sandbox decision a running browser's entrypoint made, parsed
   * from the `CHIKIN_SANDBOX_STATUS=` marker it logs at launch. Cached by
   * containerId. Best-effort: returns "unknown" if logs are unreadable or the
   * marker hasn't been emitted yet. Read over the Docker API (GET .../logs) via
   * the socket-proxy, which the CONTAINERS scope already permits.
   */
  async sandboxStatus(containerId: string): Promise<SandboxStatus> {
    const cached = this.sandboxCache.get(containerId);
    if (cached) return cached;
    try {
      const buf = (await this.docker.getContainer(containerId).logs({
        stdout: true,
        stderr: true,
        tail: 400,
        follow: false,
      })) as unknown as Buffer;
      // The log stream is multiplexed with 8-byte frame headers, but each marker
      // is a whole line inside a single frame, so it survives as contiguous ASCII.
      const matches = buf.toString("utf8").match(/CHIKIN_SANDBOX_STATUS=([a-z-]+)/g);
      if (matches && matches.length) {
        const status = matches[matches.length - 1].split("=")[1] as SandboxStatus;
        this.sandboxCache.set(containerId, status);
        return status;
      }
    } catch (e) {
      log.debug(`provisioner: could not read sandbox status for ${containerId}: ${String(e)}`);
    }
    return "unknown";
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

  /**
   * Remove a fleet container. The named profile volume is left intact, so a
   * reconnect recreates the container and reseeds from the saved cookies/state.
   * Callers stop the container first (graceful, so Chrome flushes to the volume)
   * — `force` here just makes removal idempotent if it's somehow still running.
   */
  async removeContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(name)).remove({ force: true });
      log.info(`provisioner: removed ${containerName(name)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 = already gone; treat as success.
      if (!/no such container|404/i.test(msg)) {
        log.warn(`provisioner: remove ${containerName(name)} failed`, msg);
      }
    }
  }

  /**
   * Remove a DISPOSABLE per-instance profile volume (issue #58). Returns true
   * only if a volume was actually removed.
   *
   * Safety, in order:
   *  1. The volume must be `chikin-profile-inst-*`. This name test — not the
   *     `chikin.role=instance` label — is authoritative, because Docker volume
   *     labels are immutable after creation: every volume that predates this
   *     change is unlabelled, including `chikin-profile-golden`. `golden`,
   *     `hermes` and every named client profile fail the test and are left
   *     alone, whatever their labels say (issue #59).
   *  2. Removal runs inside `createGate`, the same mutex that wraps
   *     ensureVolume → createContainer → start. A provision therefore cannot be
   *     interleaved: we can never delete a volume between the moment it is
   *     seeded and the moment its container mounts it (CHK-015 / issue #32).
   *  3. `guard` is re-evaluated INSIDE the gate — the reaper passes
   *     `() => !registry.isPending(name)` so a provision that began after the
   *     sweep's own pending check still calls the reap off.
   * Docker itself is the final backstop: it refuses to remove a volume a live
   * container still mounts.
   */
  async removeInstanceVolume(name: string, guard?: () => boolean): Promise<boolean> {
    const vol = volumeName(name);
    if (!isInstanceName(name)) {
      log.debug(`provisioner: keeping profile volume ${vol} (not a disposable instance)`);
      return false;
    }
    return this.serializeCreate(async () => {
      if (guard && !guard()) {
        log.info(`provisioner: not removing ${vol} — a provision for ${name} is in flight`);
        return false;
      }
      try {
        await this.docker.getVolume(vol).remove();
        log.info(`provisioner: removed instance profile volume ${vol}`);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 404 = already gone; treat as success-shaped (nothing removed by us).
        if (!/no such volume|404/i.test(msg)) {
          log.warn(`provisioner: remove volume ${vol} failed`, msg);
        }
        return false;
      }
    });
  }

  /**
   * One-shot sweep for instance profile volumes orphaned before the reaper
   * learned to remove them (issue #58 measured 222 orphans / ~47 GB on one
   * host). Selection is doubly conservative:
   *
   *  - by NAME: only `chikin-profile-inst-<something>`. `chikin-profile-golden`,
   *    `chikin-profile-hermes`, every named client profile and the seed volume
   *    are not candidates and are never inspected further (issue #59).
   *  - by OWNERSHIP: only volumes that NO container on the host mounts. That set
   *    is computed here from `listContainers({all:true})` rather than trusting
   *    the daemon's `dangling` flag, and considers non-fleet containers too.
   *
   * Fails closed: if the container list can't be read we throw before removing
   * anything, so an unknown ownership state never becomes a deletion.
   */
  async sweepOrphanInstanceVolumes(): Promise<OrphanSweepResult> {
    const out: OrphanSweepResult = { removed: [], inUse: [], failed: [] };
    const res = (await this.docker.listVolumes()) as { Volumes?: { Name?: string }[] | null };
    const candidates = (res.Volumes ?? [])
      .map((v) => v?.Name ?? "")
      .filter((n) => isInstanceVolume(n) && n !== config.seedVolume)
      .sort();
    if (!candidates.length) return out;

    const mounted = new Set<string>();
    for (const c of await this.docker.listContainers({ all: true })) {
      for (const m of c.Mounts ?? []) {
        if (m?.Name) mounted.add(m.Name);
      }
    }

    for (const vol of candidates) {
      if (mounted.has(vol)) {
        out.inUse.push(vol);
        continue;
      }
      try {
        await this.docker.getVolume(vol).remove();
        out.removed.push(vol);
      } catch (e) {
        log.warn(`provisioner: sweep could not remove ${vol}`, String(e));
        out.failed.push(vol);
      }
    }
    return out;
  }

  /**
   * Tear down a (possibly wedged) browser container so the next `ensureContainer`
   * rebuilds it from scratch. The profile volume is preserved — including for
   * inst-* browsers, whose session must survive a Chrome respawn — so the fresh
   * container reseeds from the saved cookies/state. Used by the bridge's
   * child-respawn path when Chrome itself has stopped answering CDP.
   *
   * This is why instance profiles are named volumes we remove explicitly rather
   * than anonymous volumes with AutoRemove (issue #58's second direction):
   * AutoRemove would destroy the profile on this path, it is rejected outright
   * by Docker alongside our `RestartPolicy: unless-stopped`, and the seed clone
   * writes into the volume BEFORE the container exists, so an anonymous volume
   * would have to move seeding into container startup and change the seeding
   * contract.
   */
  async recreateContainer(name: string): Promise<void> {
    await this.stopContainer(name);
    await this.removeContainer(name);
  }

  /**
   * Remove leftover non-running fleet containers from a previous run, reboot, or
   * crash. Profile volumes are preserved. Without this, stopped containers
   * accumulate across restarts and silently saturate MAX_FLEET, blocking all new
   * browsers (the "fleet is full" lockup). Returns how many were removed.
   */
  async gcExited(): Promise<number> {
    let removed = 0;
    for (const m of await this.listFleet()) {
      if (m.state === "running") continue;
      try {
        await this.docker.getContainer(m.containerId).remove({ force: true });
        log.info(`provisioner: gc removed ${containerName(m.name)} (${m.state})`);
        removed++;
      } catch (e) {
        log.warn(`provisioner: gc remove ${containerName(m.name)} failed`, String(e));
      }
    }
    return removed;
  }
}
