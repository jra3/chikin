import { Session } from "./session.js";

/** Per-name browser activity, used by the reaper. Outlives any single session. */
export interface Activity {
  /** epoch ms of the last MCP frame or stream close for this browser. */
  last: number;
  /** open server->client SSE streams right now. >0 means a client is attached. */
  streams: number;
  /**
   * epoch ms of the last frame that actually drove the BROWSER — a `tools/call`
   * the gate forwarded to chrome-devtools-mcp (bridge.ts).
   *
   * Deliberately separate from `last`, which measures MCP protocol traffic and
   * is therefore useless as an activity signal for an attached client: the
   * client bridge fires a JSON-RPC `ping` every `CHIKIN_HEARTBEAT_MS` (120s)
   * for the stated purpose of keeping `last` fresh (client/bridge.mjs), so on
   * an attached session `last` never ages past ~2 minutes no matter how long
   * the browser has sat on about:blank (issue #57). Heartbeat pings,
   * `chikin_identify`, `chikin_reset` and identity-blocked calls all leave this
   * clock alone; only real browser work moves it.
   *
   * Seeded to the record's creation time so a browser that has never done any
   * work still has a well-defined age. Attaching or re-attaching an SSE stream
   * does NOT refresh it — clients routinely close and reopen that stream while
   * idle between tool calls (see server.ts), which would recreate exactly the
   * heartbeat problem this field exists to escape.
   */
  lastBrowserActivity: number;
  /**
   * Canary counters for the stale-target wedge (#73). Deliberately TWO numbers,
   * because they answer different questions and the interesting state is the
   * gap between them:
   *
   *  - `navStrikes`    — how often the child's reported view disagreed with the
   *                      browser's real page set (a SUSPICION, cumulative; not
   *                      the consecutive counter the bridge escalates on).
   *  - `childRespawns` — how often a child was actually torn down and replaced,
   *                      for ANY reason (an ACTION: wedge verdict, transport
   *                      close, CDP-failure streak, `chikin_reset`).
   *
   * Many strikes with no respawns means the detector is firing on something
   * systematic that is not a wedge — the exact shape of both false-positive
   * classes fixed in #72, and precisely what a single counter would hide.
   */
  navStrikes: number;
  childRespawns: number;
  /**
   * Chrome as reported by the running browser's CDP `/json/version` at attach.
   *
   * Load-bearing, not trivia: `Dockerfile` leaves `google-chrome-stable`
   * deliberately unpinned (CHK-009/M4), and Chrome — not chrome-devtools-mcp —
   * is the variable that governs whether the wedge reproduces (147 wedged, 150
   * does not). `chromeImage` is a fixed tag over moving content, so without
   * this a recurrence is as unattributable as the original report was.
   */
  chromeVersion?: string;
}

/**
 * Tracks live sessions (by name and MCP session id) for routing and the
 * single-active-session-per-name guard (issue #6), plus a per-name activity
 * record that drives idle reaping (issue #7). Activity is intentionally
 * decoupled from session lifetime: when a client disconnects, the session is
 * removed (freeing the name immediately) but the activity record persists so
 * the still-running container is reaped once it's been idle past the TTL.
 */
export class Registry {
  private byName = new Map<string, Session>();
  private bySessionId = new Map<string, Session>();
  private byHandle = new Map<string, Session>();
  private pending = new Set<string>();
  private provisioning = new Map<string, number>();
  private activity = new Map<string, Activity>();

  /**
   * True if a live SESSION exists for this name, or one is being created. Says
   * nothing about a browser: since issue #63 a session owns no container until
   * its first browser tool call, so `has()` is true for names with no browser
   * behind them. For an in-flight provision use `isPending()`.
   */
  has(name: string): boolean {
    return this.byName.has(name) || this.pending.has(name);
  }

  /**
   * True while ANY provision for this name is in flight: a name reserved for a
   * session still being created, or a container being provisioned for a session
   * that is already live (lazy attach / child respawn — see markProvisioning).
   * The reaper reads this both to skip a mid-provision name and, re-evaluated
   * inside the provisioner's create gate, to call off a profile-volume removal
   * that would otherwise land between seeding a volume and mounting it
   * (CHK-015).
   */
  isPending(name: string): boolean {
    return this.pending.has(name) || this.provisioning.has(name);
  }

  /**
   * Mark a container provision as in flight OUTSIDE the reserve/add window.
   * Since issue #63 the container is created lazily, on the session's first
   * browser tool call — long after `add()` cleared the reservation — and a child
   * respawn re-provisions later still, so `reserve()` no longer covers every
   * provision site and CHK-015's guarantee would have a hole exactly where the
   * new code provisions. Counted rather than a boolean because two provisions
   * for one name can overlap (a respawn during an attach). Always balance with
   * `clearProvisioning` in a `finally`, or the name becomes unreapable.
   */
  markProvisioning(name: string): void {
    this.provisioning.set(name, (this.provisioning.get(name) ?? 0) + 1);
  }

  clearProvisioning(name: string): void {
    const n = this.provisioning.get(name);
    if (n === undefined) return;
    if (n > 1) this.provisioning.set(name, n - 1);
    else this.provisioning.delete(name);
  }

  /**
   * Atomically claim a name for provisioning. Returns false if the name is
   * already live or pending. Race-free as long as it's called synchronously
   * before any await.
   */
  reserve(name: string, now: number = Date.now()): boolean {
    if (this.has(name)) return false;
    this.pending.add(name);
    this.touch(name, now);
    return true;
  }

  release(name: string): void {
    this.pending.delete(name);
  }

  /** Promote a reserved name to a live session. */
  add(session: Session): void {
    this.pending.delete(session.name);
    this.byName.set(session.name, session);
  }

  bindSessionId(sessionId: string, session: Session): void {
    this.bySessionId.set(sessionId, session);
  }

  getByName(name: string): Session | undefined {
    return this.byName.get(name);
  }

  /**
   * Claim a chikin_identify handle for a session, enforcing global uniqueness
   * across live sessions (the analogue of the single-session-per-name guard, but
   * for the display/correlation label). Returns false if the handle is already
   * held by a *different* live session, so the driving agent can pick another.
   * Idempotent for the same session; re-identifying with a new handle frees the
   * session's previous one. Sets `session.handle` on success so the map and the
   * field never drift.
   */
  claimHandle(handle: string, session: Session): boolean {
    const holder = this.byHandle.get(handle);
    if (holder && holder !== session && !holder.isClosed) return false;
    if (session.handle && session.handle !== handle) {
      if (this.byHandle.get(session.handle) === session) this.byHandle.delete(session.handle);
    }
    this.byHandle.set(handle, session);
    session.handle = handle;
    return true;
  }

  getByHandle(handle: string): Session | undefined {
    return this.byHandle.get(handle);
  }

  getBySessionId(sessionId: string): Session | undefined {
    return this.bySessionId.get(sessionId);
  }

  /** Remove a session's routing entries. Keeps the activity record (stamped). */
  remove(session: Session, now: number = Date.now()): void {
    this.pending.delete(session.name);
    if (this.byName.get(session.name) === session) {
      this.byName.delete(session.name);
    }
    if (session.sessionId && this.bySessionId.get(session.sessionId) === session) {
      this.bySessionId.delete(session.sessionId);
    }
    // Free the handle so the driving instance (or another) can reuse it on the
    // next connect. The handle is per-session, not sticky like the profile.
    if (session.handle && this.byHandle.get(session.handle) === session) {
      this.byHandle.delete(session.handle);
    }
    this.touch(session.name, now);
  }

  all(): Session[] {
    return [...this.byName.values()];
  }

  // --- activity -------------------------------------------------------------

  private newActivity(now: number): Activity {
    return { last: now, streams: 0, lastBrowserActivity: now, navStrikes: 0, childRespawns: 0 };
  }

  touch(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name);
    if (a) a.last = now;
    else this.activity.set(name, this.newActivity(now));
  }

  /**
   * Stamp REAL browser work (a forwarded `tools/call`). Also refreshes `last`,
   * since a tool call is protocol traffic too. Called from exactly one place —
   * the bridge's client pump, on `classifyClientFrame(...) === "forward"` — so
   * that pings and gateway-owned tools can never move this clock (issue #57).
   */
  touchBrowserActivity(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name);
    if (a) {
      a.last = now;
      a.lastBrowserActivity = now;
    } else {
      this.activity.set(name, this.newActivity(now));
    }
  }

  streamOpened(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name) ?? this.newActivity(now);
    a.streams += 1;
    a.last = now;
    this.activity.set(name, a);
  }

  streamClosed(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name);
    if (!a) return;
    a.streams = Math.max(0, a.streams - 1);
    a.last = now;
  }

  /** A nav verification disagreed with the browser (suspicion, not action). */
  noteNavStrike(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name) ?? this.newActivity(now);
    a.navStrikes += 1;
    this.activity.set(name, a);
  }

  /** A child was torn down and replaced, whatever the cause (action). */
  noteChildRespawn(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name) ?? this.newActivity(now);
    a.childRespawns += 1;
    this.activity.set(name, a);
  }

  setChromeVersion(name: string, version: string, now: number = Date.now()): void {
    const a = this.activity.get(name) ?? this.newActivity(now);
    a.chromeVersion = version;
    this.activity.set(name, a);
  }

  /**
   * Fleet-wide canary rollup for /healthz. Chrome versions are reported as a
   * SET: more than one means the fleet is running mixed browsers (an image
   * rotated under long-lived containers), which is itself worth seeing when
   * reading strike counts.
   */
  canarySummary(): { navStrikes: number; childRespawns: number; chromeVersions: string[] } {
    let navStrikes = 0;
    let childRespawns = 0;
    const versions = new Set<string>();
    for (const a of this.activity.values()) {
      navStrikes += a.navStrikes;
      childRespawns += a.childRespawns;
      if (a.chromeVersion) versions.add(a.chromeVersion);
    }
    return { navStrikes, childRespawns, chromeVersions: [...versions].sort() };
  }

  getActivity(name: string): Activity | undefined {
    return this.activity.get(name);
  }

  activityNames(): string[] {
    return [...this.activity.keys()];
  }

  dropActivity(name: string): void {
    this.activity.delete(name);
  }
}
