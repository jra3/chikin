import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "./log.js";

/**
 * One live MCP session = one client connection to a named browser. Bridges the
 * client's HTTP MCP transport to a single `chrome-devtools-mcp` child (stdio).
 *
 * A Session is ephemeral: it exists only while a client is connected, and is
 * used for request routing and the single-active-session-per-name guard. The
 * browser *container's* idle lifetime is tracked separately, per name, in the
 * Registry's activity map — so a container can outlive a session (warm for a
 * fast reconnect) and still be reaped once it's been idle long enough.
 */
export class Session {
  readonly name: string;
  readonly http: StreamableHTTPServerTransport;
  readonly child: StdioClientTransport;

  sessionId: string | undefined;

  private closed = false;
  private readonly onClose: (s: Session, reason: string) => void;

  constructor(
    name: string,
    http: StreamableHTTPServerTransport,
    child: StdioClientTransport,
    onClose: (s: Session, reason: string) => void,
  ) {
    this.name = name;
    this.http = http;
    this.child = child;
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
    await Promise.allSettled([this.http.close(), this.child.close()]);
  }
}
