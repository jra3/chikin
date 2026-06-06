#!/usr/bin/env node
// Transparent, SELF-HEALING stdio<->HTTP MCP bridge with a keepalive heartbeat.
//
// Claude Code speaks MCP over stdio to this subprocess; the chikin gateway
// speaks MCP over Streamable HTTP at /b/<name>/. This bridge pumps frames
// between the two so a stdio client drives a per-instance browser behind the
// gateway. The browser name is baked into the URL (argv[2]) by chikin-mcp.
//
// RESILIENCE (issue: a transient SSE drop must not kill the MCP server). The
// MCP *session* (the client's one-time `initialize` handshake) lives in the
// client and is never repeated. So when the gateway link breaks — a flaky SSE
// stream (`TypeError: terminated`), or the gateway tearing the session down
// because its browser/child died — we MUST NOT exit the process: Claude Code
// does not restart a stdio MCP server mid-session, so exiting deregisters every
// tool until a manual `/mcp` reconnect. Instead we:
//   1. fail any in-flight request with a retryable JSON-RPC error (its result
//      is genuinely gone), so the client unblocks instead of hanging;
//   2. transparently rebuild the HTTP transport and REPLAY the cached
//      `initialize` (+ `notifications/initialized`) against a fresh gateway
//      session, swallowing the replayed responses (the client already has them);
//   3. keep the stdio side — and the process — alive throughout.
// The client never sees the session drop; its next tool call just works (a
// reconnect re-provisions the browser for this name, warm profile intact).
//
// Heartbeat: the gateway reaps a browser after IDLE_TTL_SEC with no MCP traffic.
// Claude Code sits idle between tool calls far longer than that, so we send a
// periodic `ping` to refresh the gateway-side activity clock. A failed ping is
// just another reconnect trigger. Ping replies are swallowed.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Reconnect backoff bounds. We retry indefinitely (the process stays up so the
// client keeps its tools) but never hot-loop.
const RECONNECT_MIN_MS = Number(process.env.CHIKIN_RECONNECT_MIN_MS || 500);
const RECONNECT_MAX_MS = Number(process.env.CHIKIN_RECONNECT_MAX_MS || 30000);
const REPLAY_TIMEOUT_MS = Number(process.env.CHIKIN_REPLAY_TIMEOUT_MS || 20000);

const log = (m) => process.stderr.write(`chikin bridge: ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stdio = new StdioServerTransport();

let http = null; // current StreamableHTTPClientTransport (replaced on reconnect)
let generation = 0; // bumped per transport so stale callbacks are ignored
let ready = false; // client handshake complete -> safe to heartbeat
let reconnecting = false;
let shuttingDown = false;

// The client's one-time `initialize` request, cached so we can replay it to a
// fresh gateway session after a link loss. Without this, a rebuilt transport
// has no MCP session and the gateway 400s every (non-initialize) request.
//
// It is ALSO persisted to disk: if this process hard-crashes, the chikin-mcp
// supervisor respawns us, but the client never re-sends `initialize` — without
// the persisted frame the fresh bridge could never establish a gateway session
// and every call would fail forever. Recovery is lazy: the first forwarded
// request 400s (no session), which triggers scheduleReconnect, which replays
// the recovered frame. A live client's own `initialize` always overwrites a
// (possibly stale) recovered frame before any replay can use it, so a leftover
// file from a previous crash is harmless on a genuinely fresh session.
const initPath = join(
  process.env.XDG_RUNTIME_DIR || tmpdir(),
  `chikin-bridge${new URL(url).pathname.replace(/[^a-zA-Z0-9-]+/g, "-")}init.json`,
);
let initFrame = null;
try {
  initFrame = JSON.parse(readFileSync(initPath, "utf8"));
  log(`recovered persisted initialize (${initPath}); resuming session after respawn`);
} catch {
  /* no persisted frame — normal fresh start */
}

const pingIds = new Set(); // internal heartbeat ids we must not forward
// Client requests forwarded to the gateway still awaiting a reply. A request is
// a frame with both `method` and `id`; notifications (no id) and the client's
// own responses (no method) are not tracked. If the link breaks, every pending
// id MUST get a JSON-RPC error or the client (Claude Code) hangs forever.
const inflight = new Map();

// -32001 = "gateway link lost". Send a JSON-RPC error to the client for a
// pending request so it unblocks instead of hanging.
const failRequest = (id, message) => {
  inflight.delete(id);
  stdio
    .send({ jsonrpc: "2.0", id, error: { code: -32001, message } })
    .catch((e) => log(`->client error send failed: ${e?.message ?? e}`));
};

const failAllInflight = (message) => {
  for (const id of [...inflight.keys()]) failRequest(id, message);
};

// Build + wire a fresh HTTP transport bound to the current generation. Stale
// callbacks (from a transport we've already discarded) are dropped by the
// generation check so they can't trigger a second reconnect.
function makeHttp(gen) {
  const h = new StreamableHTTPClientTransport(new URL(url), httpOpts);
  h.onmessage = (m) => {
    if (gen !== generation) return;
    if (m && pingIds.has(m.id)) {
      pingIds.delete(m.id); // swallow heartbeat reply
      return;
    }
    if (m && m.id !== undefined) inflight.delete(m.id); // reply delivered
    stdio.send(m).catch((e) => log(`->client send failed: ${e?.message ?? e}`));
  };
  h.onclose = () => {
    if (gen !== generation || shuttingDown) return;
    scheduleReconnect("gateway session closed");
  };
  h.onerror = (e) => {
    if (gen !== generation || shuttingDown) return;
    scheduleReconnect(`gateway error: ${e?.message ?? String(e)}`);
  };
  return h;
}

// Replay the cached initialize handshake against a freshly-started transport so
// the gateway re-establishes an MCP session for this browser name. The replayed
// responses are swallowed — the client already completed initialize once.
function replayInitialize(h, gen) {
  if (!initFrame) return Promise.resolve(); // client never initialized yet
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("initialize replay timed out")),
      REPLAY_TIMEOUT_MS,
    );
    const prev = h.onmessage;
    h.onmessage = (m) => {
      if (gen !== generation) return;
      if (m && m.id === initFrame.id) {
        clearTimeout(timer);
        h.onmessage = prev; // restore normal pumping
        // Tell the gateway we're initialized, then we're live again.
        h.send({ jsonrpc: "2.0", method: "notifications/initialized" })
          .then(resolve)
          .catch(reject);
      }
      // swallow anything else that arrives mid-replay
    };
    h.send(initFrame).catch(reject);
  });
}

// Rebuild the gateway link without dropping the stdio session. Idempotent: many
// triggers (send failure, transport close/error, heartbeat) funnel here.
async function scheduleReconnect(why) {
  if (shuttingDown || reconnecting) return;
  reconnecting = true;
  ready = false;
  log(`reconnecting: ${why}`);
  // Pending replies are never coming on the dead transport — unblock the client.
  failAllInflight(`chikin gateway link reset (${why}); retry the request`);
  try {
    await http?.close();
  } catch {}

  let delay = RECONNECT_MIN_MS;
  for (;;) {
    if (shuttingDown) return;
    const gen = ++generation;
    const h = makeHttp(gen);
    try {
      await h.start();
      await replayInitialize(h, gen);
      http = h;
      reconnecting = false;
      ready = initFrame != null;
      log(`reconnected (gen ${gen})`);
      return;
    } catch (e) {
      try {
        await h.close();
      } catch {}
      log(`reconnect attempt failed: ${e?.message ?? e}; retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }
}

// Client -> gateway. Cache the initialize frame; track requests so a link loss
// can fail them; forward everything to the live transport.
stdio.onmessage = (m) => {
  if (m && m.method === "initialize") {
    initFrame = m;
    try {
      writeFileSync(initPath, JSON.stringify(m)); // survive a hard crash + respawn
    } catch (e) {
      log(`initialize persist failed: ${e?.message ?? e}`);
    }
  }
  if (m && m.method === "notifications/initialized") ready = true;
  const tracked = m && m.method !== undefined && m.id !== undefined && !pingIds.has(m.id);
  if (tracked) inflight.set(m.id, true);

  const target = http;
  if (!target || reconnecting) {
    // Mid-reconnect: don't hang the client. Fail this request; the client
    // retries and by then the link is usually back.
    if (tracked) failRequest(m.id, "chikin gateway link resetting; retry the request");
    return;
  }
  const gen = generation; // bind this send to the transport it used
  target.send(m).catch((e) => {
    const why = e?.message ?? String(e);
    log(`->gateway send failed: ${why}`);
    // Only fail the request if a reconnect hasn't already done so (a duplicate
    // error reply for the same id would confuse the client).
    if (tracked && inflight.has(m.id))
      failRequest(m.id, `chikin gateway send failed (${why}); retry the request`);
    // A STALE rejection (the transport was already replaced while this send's
    // failure was in flight) must not tear down the freshly rebuilt link.
    if (gen === generation) scheduleReconnect(`send failed: ${why}`);
  });
};

// Only a genuine client disconnect (stdio closed) — or a signal from the
// supervisor — tears us down. Both are clean exits (initPath is removed).
stdio.onclose = () => shutdown("client disconnected (stdio closed)");
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function shutdown(why, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  failAllInflight(`chikin bridge shutting down (${why})`);
  clearInterval(hb);
  log(why);
  try {
    unlinkSync(initPath); // clean exit: the session is over, drop the crash-recovery frame
  } catch {}
  http?.close().catch(() => {});
  setTimeout(() => {
    stdio.close().catch(() => {});
    process.exit(code);
  }, 50).unref?.();
}

// Initial connect, then start the stdio side.
{
  const gen = ++generation;
  http = makeHttp(gen);
  await http.start();
}
await stdio.start();

let seq = 0;
const hb = setInterval(() => {
  if (!ready || reconnecting || !http) return;
  const id = `chikin-hb-${++seq}`;
  pingIds.add(id);
  const gen = generation; // bind to the transport this ping rode on
  http.send({ jsonrpc: "2.0", id, method: "ping" }).catch((e) => {
    pingIds.delete(id);
    const why = e?.message ?? String(e);
    log(`heartbeat failed: ${why}`);
    // A failed ping means the gateway session is dead (or browser reaped).
    // Reconnect now — well before the next real request would hang. Skip if
    // the rejection is stale (the transport was already replaced).
    if (gen === generation) scheduleReconnect(`heartbeat failed: ${why}`);
  });
}, HEARTBEAT_MS);
hb.unref?.();

log(`linked stdio <-> ${url} (heartbeat ${HEARTBEAT_MS}ms, self-healing)`);
