import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./log.js";

/**
 * One live MCP session = one client connection to a named browser. Bridges the
 * client's HTTP MCP transport to a `chrome-devtools-mcp` child (stdio).
 *
 * A Session is ephemeral: it exists only while a client is connected, and is
 * used for request routing and the single-active-session-per-name guard. The
 * browser *container's* idle lifetime is tracked separately, per name, in the
 * Registry's activity map — so a container can outlive a session (warm for a
 * fast reconnect) and still be reaped once it's been idle long enough.
 *
 * The child process is NOT owned directly by the Session: the bridge keeps it
 * replaceable so a crashed `chrome-devtools-mcp` (or a wedged Chrome) can be
 * respawned transparently without tearing down the client's HTTP session. The
 * bridge hands us a `closeChild` thunk that tears down whatever child is current
 * at close time.
 */
export class Session {
  readonly name: string;
  readonly http: StreamableHTTPServerTransport;

  sessionId: string | undefined;

  private closed = false;
  private readonly onClose: (s: Session, reason: string) => void;
  private readonly closeChild: () => Promise<void>;

  constructor(
    name: string,
    http: StreamableHTTPServerTransport,
    closeChild: () => Promise<void>,
    onClose: (s: Session, reason: string) => void,
  ) {
    this.name = name;
    this.http = http;
    this.closeChild = closeChild;
    this.onClose = onClose;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Tear down the bridge once. Container lifecycle is the caller's concern. */
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    log.info(`session[${this.name}]: closing (${reason})`);
    this.onClose(this, reason);
    await Promise.allSettled([this.http.close(), this.closeChild()]);
  }
}
