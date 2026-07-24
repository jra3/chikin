import { config } from "./config.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";
import type { Provisioner } from "./provisioner.js";

/**
 * Periodically reclaims idle browsers (issue #7). Reaping tears down any
 * session, then stops AND removes the container. Removing (not just stopping)
 * is essential: stopped containers still count against MAX_FLEET, so leaving
 * them around leaks fleet slots until provisioning locks up.
 *
 * The idle policy has TWO tiers (issue #57), because "idle" means two different
 * things depending on whether a client is still holding the session open:
 *
 *  - DETACHED (no client stream): reclaimed after IDLE_TTL_SEC of no MCP
 *    traffic at all. Unchanged, and the path that has always worked.
 *  - ATTACHED (a client stream is open): reclaimed after the much longer
 *    ATTACHED_IDLE_TTL_SEC with no real BROWSER work — a forwarded `tools/call`
 *    (Activity.lastBrowserActivity), never the client bridge's keepalive ping.
 *    Attachment used to short-circuit reaping unconditionally, which is what
 *    actually saturated fleets at MAX_FLEET with every browser on about:blank:
 *    a connected-but-idle Claude Code window held its slot for its whole
 *    lifetime. Setting ATTACHED_IDLE_TTL_SEC=0 restores that old behaviour.
 *
 * Evicting an attached session is survivable by design: the client bridge fails
 * in-flight requests retryably, rebuilds its transport and replays `initialize`
 * (client/bridge.mjs). What it cannot restore is the PROFILE — see the eviction
 * log lines below.
 *
 * The profile volume follows the same rule the name implies: a disposable
 * `inst-<pid>` browser's volume is removed with its container (issue #58),
 * while a named profile (golden, hermes, any sticky client name) is preserved
 * so a reconnect restores cookies/state.
 *
 * Reaping is driven by the per-name activity map, not by live sessions, so a
 * container that outlives its session (warm for fast reconnect) is still
 * reclaimed once idle. Running containers with no activity record — e.g.
 * orphans from a previous gateway run — are adopted with a one-time grace
 * stamp so they too get reaped after the TTL instead of leaking forever.
 */
export class Reaper {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private registry: Registry,
    private provisioner: Provisioner,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), config.reapIntervalMs);
    this.timer.unref?.();
    const attached =
      config.attachedIdleTtlMs > 0
        ? `${config.attachedIdleTtlMs}ms of no browser tool call`
        : "never (ATTACHED_IDLE_TTL_SEC=0)";
    log.info(
      `reaper: started (idle_ttl=${config.idleTtlMs}ms attached_idle_ttl=${attached} ` +
        `interval=${config.reapIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Exposed for tests. */
  async sweep(now: number = Date.now()): Promise<void> {
    // Adopt running fleet containers we aren't yet tracking (gateway restart,
    // manual start) so they're subject to the same idle policy.
    try {
      for (const m of await this.provisioner.listFleet()) {
        if (m.state === "running" && !this.registry.getActivity(m.name)) {
          log.info(`reaper: adopting untracked running container ${m.name}`);
          this.registry.touch(m.name, now);
        }
      }
    } catch (e) {
      log.warn("reaper: could not list fleet", String(e));
    }

    for (const name of this.registry.activityNames()) {
      const a = this.registry.getActivity(name);
      if (!a) continue;
      if (this.registry.isPending(name)) continue; // mid-provision -> not idle (CHK-015)

      // Two-tier TTL (issue #57). An attached client no longer makes a browser
      // unreapable — it only buys the much longer ATTACHED_IDLE_TTL_SEC, and
      // that tier is measured against real browser work, because `a.last` is
      // refreshed by the client bridge's keepalive ping every ~120s and so can
      // never age out on an attached session.
      const attached = a.streams > 0;
      let why: string;
      if (attached) {
        if (config.attachedIdleTtlMs <= 0) continue; // escape hatch: never reap attached
        if (now - a.lastBrowserActivity <= config.attachedIdleTtlMs) continue;
        const workIdleSec = Math.round((now - a.lastBrowserActivity) / 1000);
        why =
          `evicting ATTACHED ${name}: no browser tool call for ${workIdleSec}s ` +
          `(> ATTACHED_IDLE_TTL_SEC=${Math.round(config.attachedIdleTtlMs / 1000)}s), ` +
          `a client stream is still open — it reconnects transparently`;
      } else {
        if (now - a.last <= config.idleTtlMs) continue;
        why = `reclaiming ${name} (idle ${Math.round((now - a.last) / 1000)}s, no open stream)`;
      }

      log.info(`reaper: ${why}`);
      try {
        const session = this.registry.getByName(name);
        if (session) await session.close("reaped: idle");
        await this.provisioner.stopContainer(name);
        await this.provisioner.removeContainer(name);
        // ...and, for a disposable `inst-<pid>` browser, its profile volume too
        // (issue #58: the container half of this leak was fixed in 98a1e2f, the
        // volume half was not — ~200 MB per browser ever provisioned). Named
        // profiles (golden, hermes, sticky client names) are kept: the call is a
        // no-op for them, decided by NAME so it holds for volumes created before
        // chikin.role labels existed. The guard is re-checked inside the
        // provisioner's create gate so a provision that started during this
        // sweep cannot lose its freshly-seeded volume (CHK-015).
        const discarded = await this.provisioner.removeInstanceVolume(
          name,
          () => !this.registry.isPending(name),
        );
        // Say plainly what was thrown away. Since #58 a reaped disposable loses
        // its profile with its container, so a reconnect — including the
        // transparent one an evicted ATTACHED session makes — starts from a
        // fresh clone of the seed. Anyone who notices "my tabs and my login are
        // gone" should be able to find the reason in this log, not infer it.
        if (discarded) {
          log.info(
            `reaper: DISCARDED ${name}'s profile volume — its next connect starts from a fresh ` +
              `seed clone; open tabs and any login acquired in-session (not in the seed) are gone`,
          );
        }
        this.registry.dropActivity(name);
      } catch (e) {
        log.warn(`reaper: failed to reclaim ${name}`, String(e));
      }
    }
  }
}
