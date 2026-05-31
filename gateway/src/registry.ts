import { Session } from "./session.js";

/** Per-name browser activity, used by the reaper. Outlives any single session. */
export interface Activity {
  /** epoch ms of the last MCP frame or stream close for this browser. */
  last: number;
  /** open server->client SSE streams right now. >0 means a client is attached. */
  streams: number;
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
  private pending = new Set<string>();
  private activity = new Map<string, Activity>();

  /** True if a session exists or is being provisioned for this name. */
  has(name: string): boolean {
    return this.byName.has(name) || this.pending.has(name);
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
    this.touch(session.name, now);
  }

  all(): Session[] {
    return [...this.byName.values()];
  }

  // --- activity -------------------------------------------------------------

  touch(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name);
    if (a) a.last = now;
    else this.activity.set(name, { last: now, streams: 0 });
  }

  streamOpened(name: string, now: number = Date.now()): void {
    const a = this.activity.get(name) ?? { last: now, streams: 0 };
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
