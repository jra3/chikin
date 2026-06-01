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

stdio.onmessage = (m) => {
  if (m && m.method === "notifications/initialized") ready = true;
  http.send(m).catch((e) => log(`->gateway send failed: ${e?.message ?? e}`));
};
http.onmessage = (m) => {
  if (m && pingIds.has(m.id)) {
    pingIds.delete(m.id); // swallow heartbeat reply
    return;
  }
  stdio.send(m).catch((e) => log(`->client send failed: ${e?.message ?? e}`));
};

const shutdown = (code, why) => {
  clearInterval(hb);
  log(why);
  http.close().catch(() => {});
  stdio.close().catch(() => {});
  process.exit(code);
};
stdio.onclose = () => shutdown(0, "client disconnected (stdio closed)");
http.onclose = () => shutdown(0, "gateway session closed");
http.onerror = (e) => log(`gateway error: ${e?.message ?? e}`);

await http.start();
await stdio.start();

let seq = 0;
const hb = setInterval(() => {
  if (!ready) return;
  const id = `chikin-hb-${++seq}`;
  pingIds.add(id);
  http.send({ jsonrpc: "2.0", id, method: "ping" }).catch((e) => {
    pingIds.delete(id);
    log(`heartbeat failed: ${e?.message ?? e}`);
  });
}, HEARTBEAT_MS);
hb.unref?.();

log(`linked stdio <-> ${url} (heartbeat ${HEARTBEAT_MS}ms)`);
