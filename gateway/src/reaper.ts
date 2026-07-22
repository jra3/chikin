import { config } from "./config.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";
import type { Provisioner } from "./provisioner.js";

/**
 * Periodically reclaims idle browsers (issue #7). A browser is reaped only when
 * it has NO attached client stream AND has been idle past IDLE_TTL. Reaping
 * tears down any session, then stops AND removes the container, but preserves
 * the named profile volume so a reconnect restores cookies/state. Removing (not
 * just stopping) is essential: stopped containers still count against MAX_FLEET,
 * so leaving them around leaks fleet slots until provisioning locks up.
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
    log.info(`reaper: started (idle_ttl=${config.idleTtlMs}ms interval=${config.reapIntervalMs}ms)`);
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
      if (a.streams > 0) continue; // attached client -> never reap
      if (now - a.last <= config.idleTtlMs) continue;

      const idleSec = Math.round((now - a.last) / 1000);
      log.info(`reaper: reclaiming ${name} (idle ${idleSec}s, no open stream)`);
      try {
        const session = this.registry.getByName(name);
        if (session) await session.close("reaped: idle");
        await this.provisioner.stopContainer(name);
        await this.provisioner.removeContainer(name);
        this.registry.dropActivity(name);
      } catch (e) {
        log.warn(`reaper: failed to reclaim ${name}`, String(e));
      }
    }
  }
}
