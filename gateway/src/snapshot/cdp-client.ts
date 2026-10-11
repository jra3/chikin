/**
 * The smallest CDP client the gateway can own: one websocket to one target,
 * request/reply by id, events dropped on the floor.
 *
 * This is the gateway's SECOND connection to a Browser's Chrome, beside the
 * chrome-devtools-mcp child's puppeteer connection. Chrome accepts any number
 * of DevTools clients, and the CDP lane (`cdp.ts`) only guards against a
 * second *driver* by Name, so the two coexist — which is the whole point: a
 * call on this socket never waits on the child's per-session tool mutex, and
 * never holds it (ADR 0006). The cost is that two drivers share one tab;
 * `takeSnapshot` only reads, so for it that cost is nil.
 *
 * Node >= 22 ships a global `WebSocket` (undici); the gateway's `engines`
 * already requires that, so no dependency is added. `@types/node` 20 does not
 * declare the global, hence the local declaration.
 */

// The subset of the WHATWG WebSocket surface used here. Declared locally rather
// than lifting `lib: ["dom"]` into a server-side tsconfig.
interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}
declare const WebSocket: { new (url: string): WsLike; readonly OPEN: number };

/** Chrome answered the call with a protocol error. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

/** The socket went away, or the deadline passed, before a reply arrived. */
export class CdpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpTransportError";
  }
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedWith: Error | null = null;

  private constructor(private readonly ws: WsLike) {
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", (ev) => this.failAll(new CdpTransportError(`CDP socket closed (${ev.code} ${ev.reason})`)));
    ws.addEventListener("error", () => this.failAll(new CdpTransportError("CDP socket error")));
  }

  /** Open `url` and resolve once the handshake completes; reject on error or deadline. */
  static connect(url: string, timeoutMs = 5000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new CdpTransportError(`CDP connect to ${url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpTransportError(`CDP connect to ${url} failed`));
      });
    });
  }

  /**
   * One command. `timeoutMs` is legitimate here in a way ADR 0006 says a clock
   * on an injected child call is not: this socket is ours, nothing queues in
   * front of the command, so the clock measures the call itself.
   */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTransportError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpTransportError(`send failed: ${String(e)}`));
      }
    });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "done");
    this.failAll(new CdpTransportError("CDP client closed"));
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not ours to judge; Chrome does not send malformed JSON
    }
    if (typeof msg.id !== "number") return; // an event
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message ?? "unknown CDP error"));
    else p.resolve(msg.result);
  }

  private failAll(err: Error): void {
    if (this.closedWith) return;
    this.closedWith = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
