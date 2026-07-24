// Drives the bridge subprocess over raw stdio MCP to prove the heartbeat keeps
// a browser alive past the idle reaper, and that a tool call after a long idle
// does NOT hang. Run with the gateway on a short IDLE_TTL_SEC.
//
// Since issue #57 the heartbeat only holds a browser for ATTACHED_IDLE_TTL_SEC
// (default 4h), which this run is far inside. Set ATTACHED_IDLE_TTL_SEC low on
// the gateway to exercise the opposite case: the session IS evicted mid-idle and
// the bridge must reconnect transparently, so the tool call below still passes
// (with a fresh profile for a disposable inst-* name).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "..", "client", "bridge.mjs");
const url = process.env.URL || "http://localhost:8080/b/hbtest/";
const IDLE_MS = Number(process.env.IDLE_MS || 40000);

const child = spawn("node", [bridge, url], {
  env: { ...process.env, CHIKIN_HEARTBEAT_MS: "4000" },
  stdio: ["pipe", "pipe", "inherit"],
});

const waiters = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const rpc = (id, method, params) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`TIMEOUT waiting for ${method} (id=${id})`)), 30000);
    waiters.set(id, (m) => { clearTimeout(t); res(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });

let code = 1;
try {
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hbtest", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // chikin_identify is required before any browser tool (breaking-change gate).
  await rpc(10, "tools/call", { name: "chikin_identify", arguments: { handle: "hb-itest" } });
  await rpc(2, "tools/call", { name: "new_page", arguments: { url: "https://example.com/" } });
  const before = await rpc(3, "tools/call", { name: "list_pages", arguments: {} });
  console.log(`  PASS  first list_pages ok (${(before.result?.content?.[0]?.text || "").slice(0, 30)}...)`);

  console.log(`  ...idling ${IDLE_MS / 1000}s (gateway IDLE_TTL is much shorter; heartbeat must keep it alive)`);
  await new Promise((r) => setTimeout(r, IDLE_MS));

  const after = await rpc(4, "tools/call", { name: "list_pages", arguments: {} });
  const ok = after.result && !after.error;
  console.log(`  ${ok ? "PASS" : "FAIL"}  list_pages after long idle ${ok ? "succeeded (no hang, not reaped)" : "FAILED"}`);
  code = ok ? 0 : 1;
} catch (e) {
  console.log(`  FAIL  ${e.message}`);
  code = 1;
} finally {
  child.kill();
  process.exit(code);
}
