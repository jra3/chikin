import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a Browser's Chrome DevTools endpoint, for the gateway's OWN
 * CDP client (`src/snapshot/cdp-client.ts`): `/json/list` over HTTP and a
 * real RFC 6455 websocket per page that answers commands by script.
 *
 * `cdp.test.ts` fakes Chrome too, but its upgrade handler only echoes bytes —
 * enough to prove a splice, useless to a client that speaks the protocol. This
 * one does the handshake, unmasks client frames and frames its replies, so the
 * client under test is exercised the way Chrome would exercise it, with no
 * websocket library added to the gateway or its tests.
 */

export interface FakePage {
  id: string;
  url: string;
  title?: string;
  type?: string;
  /** What `Runtime.evaluate` answers. Called per command, so a test can vary it. */
  evaluate?: (params: Record<string, unknown>) => unknown;
}

export interface FakeCdp {
  ip: string;
  port: number;
  pages: FakePage[];
  /** Every command received, in order, with the page it arrived on. */
  commands: { page: string; method: string; params: Record<string, unknown> }[];
  /** Upgrade paths seen, so a test can assert the client dialled by page id. */
  upgrades: string[];
  close(): Promise<void>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Frame one text message, server → client (never masked). */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Pull complete client frames off a buffer; returns the texts and the leftover. */
function unframe(buf: Buffer): { texts: string[]; closed: boolean; rest: Buffer } {
  const texts: string[] = [];
  let closed = false;
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    off = p + len;
    if (opcode === 0x8) closed = true;
    else if (opcode === 0x1) texts.push(payload.toString("utf8"));
    // ping/pong/binary: ignored; the CDP client sends none
  }
  return { texts, closed, rest: buf.subarray(off) };
}

/** `port` 0 (default) picks a free one; pass the port the gateway's config was frozen with to stand in for a container. */
export async function startFakeCdp(pages: FakePage[], port = 0): Promise<FakeCdp> {
  const commands: FakeCdp["commands"] = [];
  const upgrades: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/json/list")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          pages.map((p) => ({
            id: p.id,
            type: p.type ?? "page",
            url: p.url,
            title: p.title ?? "",
            webSocketDebuggerUrl: `ws://172.29.0.9:9222/devtools/page/${p.id}`,
          })),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, sock) => {
    const socket = sock as net.Socket;
    upgrades.push(req.url ?? "");
    const m = /^\/devtools\/page\/(.+)$/.exec(req.url ?? "");
    const page = m ? pages.find((p) => p.id === m[1]) : undefined;
    if (!page) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const { texts, closed, rest } = unframe(buf);
      buf = Buffer.from(rest);
      for (const t of texts) {
        const msg = JSON.parse(t) as { id: number; method: string; params?: Record<string, unknown> };
        const params = msg.params ?? {};
        commands.push({ page: page.id, method: msg.method, params });
        const reply = (body: Record<string, unknown>) => socket.write(frame(JSON.stringify({ id: msg.id, ...body })));
        if (msg.method === "Runtime.evaluate") {
          const out = page.evaluate ? page.evaluate(params) : null;
          if (out instanceof Error) reply({ result: { exceptionDetails: { text: out.message } } });
          else if (out === HANG) return; // never answer: the client's deadline is under test
          else reply({ result: { result: { type: typeof out, value: out } } });
        } else reply({ error: { code: -32601, message: `'${msg.method}' wasn't found` } });
      }
      if (closed) socket.end();
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  return {
    ip: "127.0.0.1",
    port,
    pages,
    commands,
    upgrades,
    close: async () => {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Return this from a page's `evaluate` to leave the command unanswered. */
export const HANG: unique symbol = Symbol("hang");
