import { config } from "./config.js";
import { log } from "./log.js";
import { liveChildren } from "./children.js";
import type { Registry } from "./registry.js";
import type { FleetMember, Provisioner } from "./provisioner.js";

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
 *
 * Since issue #63 the map also holds names with NO container: a session
 * provisions its browser lazily, on its first browser tool call. Those hold no
 * fleet slot, but they are not free: every session owns a chrome-devtools-mcp
 * child process and that child's watchdog. So a session whose client is still
 * there (an open stream, or MCP traffic inside the idle TTL) is left alone,
 * and one whose client has gone is closed here (issue #122). Nothing else can
 * close it: clients exit without DELETE, and an `inst-<ppid>` name never
 * reconnects to be reclaimed as stale. Its disposable profile volume is
 * collected in the same pass, so a container that disappeared out-of-band
 * cannot leak one (issue #58).
 */
export class Reaper {
  private timer: NodeJS.Timeout | undefined;
  /** Consecutive sweeps that ended with more children than sessions (#125). */
  private excessSweeps = 0;

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
    // Which names actually hold a container right now. Deliberately read from
    // Docker every sweep rather than tracked as a gateway-side flag: a flag that
    // drifted to "no container" would leak that container's slot forever, which
    // is precisely the class of bug this reaper exists to prevent.
    let fleet: FleetMember[] | null = null;
    try {
      fleet = await this.provisioner.listFleet();
    } catch (e) {
      // Unknown fleet state: fall back to reaping on the activity record alone,
      // rather than silently suspending reaping until Docker answers again.
      log.warn("reaper: could not list fleet", String(e));
    }
    // Adopt running fleet containers we aren't yet tracking (gateway restart,
    // manual start) so they're subject to the same idle policy.
    for (const m of fleet ?? []) {
      if (m.state === "running" && !this.registry.getActivity(m.name)) {
        log.info(`reaper: adopting untracked running container ${m.name}`);
        this.registry.touch(m.name, now);
      }
    }
    const containers = fleet && new Set(fleet.map((m) => m.name));

    for (const name of this.registry.activityNames()) {
      const a = this.registry.getActivity(name);
      if (!a) continue;
      if (this.registry.isPending(name)) continue; // mid-provision -> not idle (CHK-015)

      // Since issue #63 an activity record no longer implies a fleet slot: a
      // session provisions its browser lazily, on its first browser tool call,
      // so a connected-but-never-used session is tracked here while owning no
      // container. There is no SLOT to reclaim from it, but there is a child
      // process (issue #122), so the question here is whether its client is
      // still there:
      //
      //  - an open stream or a CDP hold means yes, at any age;
      //  - so does MCP traffic inside the detached idle TTL, which a live
      //    client bridge supplies with its 120s ping even between streams;
      //  - past that with neither, the client has gone. It exited without a
      //    DELETE and its `inst-<ppid>` name will never reconnect, so this is
      //    the only place the session and its child can be closed.
      //
      // That is the same test the detached tier below applies to a name that
      // does hold a container, so a session's lifetime no longer depends on
      // whether it happened to browse.
      //
      // The disposable PROFILE VOLUME goes in the same pass (issue #58): a name
      // whose container vanished out-of-band leaves ~200 MB behind. The TTL is
      // what stops a just-started session from being raced, and `isPending`
      // re-checks the same thing inside the create gate.
      if (containers && !containers.has(name)) {
        if (a.streams > 0 || a.cdp > 0) continue;
        if (now - a.last <= config.idleTtlMs) continue;
        try {
          const session = this.registry.getByName(name);
          if (session) {
            log.info(
              `reaper: closing abandoned session ${name}: no browser, no open stream, ` +
                `idle ${Math.round((now - a.last) / 1000)}s`,
            );
            await session.close("reaped: idle, no browser");
            // Closing waits for the child to exit. A client that took the name
            // in that window owns the record now; leave it everything.
            if (this.registry.has(name)) continue;
          }
          const unclaimed = () =>
            !this.registry.has(name) &&
            !this.registry.isPending(name) &&
            !this.registry.heldByCdp(name);
          const discarded = await this.provisioner.removeInstanceVolume(name, unclaimed);
          if (discarded) {
            log.info(
              `reaper: discarded orphaned profile volume for ${name} — it has no container and no ` +
                `session, and has been idle ${Math.round((now - a.last) / 1000)}s`,
            );
          }
          // The same recheck after the Docker call: a client that connected
          // meanwhile owns this record, its open-stream count included.
          if (unclaimed()) this.registry.dropActivity(name);
        } catch (e) {
          // Leave the record in place so the next sweep retries the reclaim.
          log.warn(`reaper: failed to reclaim ${name}`, String(e));
        }
        continue;
      }

      // Two-tier TTL (issue #57). An attached client no longer makes a browser
      // unreapable — it only buys the much longer ATTACHED_IDLE_TTL_SEC, and
      // that tier is measured against real browser work, because `a.last` is
      // refreshed by the client bridge's keepalive ping every ~120s and so can
      // never age out on an attached session.
      //
      // An open CDP websocket counts as attachment too (#87). It is the same
      // question — is anybody holding this browser? — and the same answer
      // serves: the tier is measured against `lastBrowserActivity`, which that
      // lane samples from the driver's own socket traffic rather than stamping
      // on a timer, so a driver that connected and went quiet still ages out.
      const attached = a.streams > 0 || a.cdp > 0;
      let why: string;
      if (attached) {
        if (config.attachedIdleTtlMs <= 0) continue; // escape hatch: never reap attached
        if (now - a.lastBrowserActivity <= config.attachedIdleTtlMs) continue;
        const workIdleSec = Math.round((now - a.lastBrowserActivity) / 1000);
        // Say which lane is losing its browser, because the two recover
        // differently: an MCP client rebuilds its transport and replays
        // initialize, while a CDP driver's websocket simply dies under it and
        // its script sees the failure. Both are deliberate; only one is quiet.
        const holder =
          a.cdp > 0
            ? "a CDP driver is still attached — its websocket dies with the container"
            : "a client stream is still open — it reconnects transparently";
        why =
          `evicting ATTACHED ${name}: no browser work for ${workIdleSec}s ` +
          `(> ATTACHED_IDLE_TTL_SEC=${Math.round(config.attachedIdleTtlMs / 1000)}s), ` +
          holder;
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

    this.checkChildren();
  }

  /**
   * Every session owns one child, so more children than sessions means a
   * process nobody owns (#125). A child swap and a session still being created
   * both hold one extra for a moment, so a single sweep is not evidence: warn
   * when the excess is still there on the next one, once, until it clears.
   */
  private checkChildren(): void {
    const children = liveChildren();
    const sessions = this.registry.all().length;
    if (children <= sessions) {
      this.excessSweeps = 0;
      return;
    }
    this.excessSweeps += 1;
    if (this.excessSweeps === 2) {
      log.warn(
        `reaper: ${children} chrome-devtools-mcp children for ${sessions} session(s), on two ` +
          `consecutive sweeps. ${children - sessions} child process(es) belong to no session (see #122)`,
      );
    }
  }
}
