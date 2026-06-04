#!/usr/bin/env node
// Transparent stdio<->HTTP MCP bridge, with a keepalive heartbeat.
//
// Claude Code speaks MCP over stdio to a subprocess; the chikin gateway speaks
// MCP over Streamable HTTP at /b/<name>/. This bridge pumps frames between the
// two so a stdio client drives a per-instance browser behind the gateway. The
// browser name is baked into the URL (argv[2]) by the chikin-mcp launcher.
//
// Heartbeat: the gateway reaps a browser after IDLE_TTL_SEC with no MCP traffic.
// Claude Code can sit idle between tool calls far longer than that, so the
// bridge sends a periodic `ping` to refresh the gateway-side activity clock.
// This keeps a browser alive for as long as its window is open (the bridge runs
// for the window's lifetime); when the window closes the bridge exits, the
// pings stop, and the reaper reclaims the browser normally. Ping replies are
// swallowed so they never reach the client.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  process.stderr.write("chikin bridge: missing gateway URL argument\n");
  process.exit(64);
}

const token = process.env.CHIKIN_TOKEN;
const httpOpts = token
  ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  : undefined;
const HEARTBEAT_MS = Number(process.env.CHIKIN_HEARTBEAT_MS || 120000);

const log = (m) => process.stderr.write(`chikin bridge: ${m}\n`);

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(new URL(url), httpOpts);

let ready = false; // client handshake complete -> safe to heartbeat
const pingIds = new Set(); // internal heartbeat ids we must not forward
// Client requests forwarded to the gateway that are still awaiting a reply. A
// request is a frame with both a `method` and an `id`; notifications (no id)
// and the client's own responses (no method) are not tracked. If the gateway
// link breaks, every pending id MUST get a JSON-RPC error reply or the client
// (Claude Code) hangs forever waiting on a tool call that will never return.
const inflight = new Map();

// Send a JSON-RPC error back to the client for a pending request, so it
// unblocks instead of hanging. -32001 = "gateway link lost".
const failRequest = (id, message) => {
  inflight.delete(id);
  stdio
    .send({ jsonrpc: "2.0", id, error: { code: -32001, message } })
    .catch((e) => log(`->client error send failed: ${e?.message ?? e}`));
};

stdio.onmessage = (m) => {
  if (m && m.method === "notifications/initialized") ready = true;
  const tracked = m && m.method !== undefined && m.id !== undefined && !pingIds.has(m.id);
  if (tracked) inflight.set(m.id, true);
  http.send(m).catch((e) => {
    const why = e?.message ?? String(e);
    log(`->gateway send failed: ${why}`);
    // The gateway dropped this request (e.g. the browser was reaped and the
    // session 404s). Answer the client so it doesn't hang, then exit so the
    // launcher respawns us — a fresh bridge re-initializes and the gateway
    // provisions a new browser for this name.
    if (tracked) failRequest(m.id, `chikin browser was reclaimed mid-session (${why}); session reset — retry the request`);
    drainAndShutdown(`gateway send failed: ${why}`);
  });
};
http.onmessage = (m) => {
  if (m && pingIds.has(m.id)) {
    pingIds.delete(m.id); // swallow heartbeat reply
    return;
  }
  if (m && m.id !== undefined) inflight.delete(m.id); // reply delivered
  stdio.send(m).catch((e) => log(`->client send failed: ${e?.message ?? e}`));
};

let shuttingDown = false;
// Fail any still-pending client requests, then tear down. Idempotent so the
// several teardown triggers (send failure, gateway close/error, stdio close)
// can all funnel here without double-exiting.
const drainAndShutdown = (why, code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of inflight.keys())
    failRequest(id, `chikin browser link lost (${why}); session reset — retry the request`);
  clearInterval(hb);
  log(why);
  http.close().catch(() => {});
  // Give the error replies a tick to flush to stdout before exiting.
  setTimeout(() => {
    stdio.close().catch(() => {});
    process.exit(code);
  }, 50).unref?.();
};
stdio.onclose = () => drainAndShutdown("client disconnected (stdio closed)");
http.onclose = () => drainAndShutdown("gateway session closed");
http.onerror = (e) => {
  const why = e?.message ?? String(e);
  log(`gateway error: ${why}`);
  // A transport-level error with requests in flight means those replies are
  // never coming — unblock the client and respawn rather than hang.
  if (inflight.size > 0) drainAndShutdown(`gateway error: ${why}`);
};

await http.start();
await stdio.start();

let seq = 0;
const hb = setInterval(() => {
  if (!ready) return;
  const id = `chikin-hb-${++seq}`;
  pingIds.add(id);
  http.send({ jsonrpc: "2.0", id, method: "ping" }).catch((e) => {
    pingIds.delete(id);
    const why = e?.message ?? String(e);
    log(`heartbeat failed: ${why}`);
    // A failed ping means the gateway session is dead (or the browser already
    // reaped). Respawn now — within HEARTBEAT_MS, well before the idle-reap
    // window and before the client's next call — instead of silently letting
    // activity go stale until the next real request hangs.
    drainAndShutdown(`heartbeat failed: ${why}`);
  });
}, HEARTBEAT_MS);
hb.unref?.();

log(`linked stdio <-> ${url} (heartbeat ${HEARTBEAT_MS}ms)`);
