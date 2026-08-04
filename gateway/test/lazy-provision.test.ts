import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * End-to-end proof of lazy provisioning (issue #63): connecting an MCP client
 * must NOT consume a fleet slot.
 *
 * The reported failure was eight Claude Code windows that merely had chikin in
 * their MCP config saturating MAX_FLEET=8 with browsers parked on about:blank —
 * every row `handle: —`, `browser idle` equal to its own container age — while
 * the one session that actually needed a browser was locked out for its entire
 * lifetime (an MCP client fixes its tool registry at session start, so freeing a
 * slot afterwards could not give it the browser lane back).
 *
 * This runs the real gateway over real HTTP with a real child process, and only
 * Docker stubbed out, so it fails if anyone ever reattaches provisioning to the
 * handshake. `config` is frozen at module load, so the env below is set before
 * the gateway modules are imported — node:test gives each test FILE its own
 * process, which is what makes that safe here.
 */

// A stand-in for chrome-devtools-mcp: newline-delimited JSON-RPC over stdio,
// dependency-free so it runs from a temp dir. It ECHOES the --browserUrl it was
// launched with, which is what lets the assertions below tell a BROWSER-LESS
// child apart from one bound to a real container. It also records its pid, so a
// child the gateway forgot to close is detectable as a still-live process.
// It also stalls its `initialize` reply for as long as a hold file exists, which
// is how a test freezes the gateway inside `replayInitialize` — the window where
// a child has been spawned but nothing owns it yet.
const FAKE_CDM = `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
appendFileSync("__PIDFILE__", process.pid + "\\n");
const HOLD_FILE = "__HOLDFILE__";
const i = process.argv.indexOf("--browserUrl");
const browserUrl = i >= 0 ? process.argv[i + 1] : "(none)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function handle(m) {
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") {
    while (existsSync(HOLD_FILE)) await sleep(20);
    reply({
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "chrome_devtools", version: "0.0.0" },
      instructions: "UPSTREAM DOC",
    });
  } else if (m.method === "tools/list")
    reply({ tools: [{ name: "list_pages", description: "fake", inputSchema: { type: "object" } }] });
  else if (m.method === "tools/call")
    reply({ content: [{ type: "text", text: "browserUrl=" + browserUrl }] });
  else reply({});
}
let queue = Promise.resolve();
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue; // notification
    queue = queue.then(() => handle(m));
  }
});
`;

// The Host guard trusts 127.0.0.1:<config.port>, and config.port is frozen at
// import time — so claim a free port first and hand it to the config as PORT.
const port = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

const tmp = mkdtempSync(join(tmpdir(), "chikin-lazy-"));
const fakeCdm = join(tmp, "fake-cdm.mjs");
// The pidfile path is baked into the script rather than passed as an env var:
// StdioClientTransport spawns children with a curated default environment, so
// nothing the test sets in `process.env` would reach them.
const pidFile = join(tmp, "children.pids");
const holdFile = join(tmp, "hold-initialize");
writeFileSync(
  fakeCdm,
  FAKE_CDM.replace("__PIDFILE__", pidFile).replace("__HOLDFILE__", holdFile),
  { mode: 0o755 },
);

const spawnedPids = (): number[] =>
  existsSync(pidFile)
    ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number)
    : [];
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Poll until every pid is gone; returns whatever is still alive at the deadline. */
async function stillAlive(pids: number[], ms = 5000): Promise<number[]> {
  const deadline = Date.now() + ms;
  let alive = pids.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    alive = alive.filter(isAlive);
  }
  return alive;
}

process.env.PORT = String(port);
process.env.CDM_COMMAND = fakeCdm;
process.env.GATEWAY_TOKEN = ""; // auth off; this test is about provisioning

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { FleetFullError } = await import("../src/provisioner.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const BROWSER_IP = "10.99.0.7";

/** Docker, stubbed. `ensured` counts every container the gateway asks for. */
function stubProvisioner() {
  const state = {
    ensured: [] as string[],
    fail: null as Error | null,
    // Hold a provision open, the way a cold container does for tens of seconds,
    // and announce that one has started. Lets a test act inside that window.
    hold: null as Promise<void> | null,
    onEnter: () => {},
  };
  const provisioner = {
    ensureContainer: async (name: string) => {
      state.onEnter();
      if (state.hold) await state.hold;
      if (state.fail) throw state.fail;
      state.ensured.push(name);
      return BROWSER_IP;
    },
    recreateContainer: async () => {},
    listFleet: async () => [],
  };
  return { provisioner, state };
}

const registry = new Registry();
const { provisioner, state } = stubProvisioner();
const app = createApp({ registry, provisioner: provisioner as never });
let server: Server;
test.before(async () => {
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
test.after(async () => {
  // Tear down every session explicitly: each one owns a child PROCESS, and a
  // leaked one keeps this test file's event loop alive forever.
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function connect(name: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/b/${name}/`),
  );
  const client = new Client({ name: "lazy-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  // Terminating the MCP session is what makes the gateway close the session and
  // reap its child process; a bare client.close() leaves both alive.
  const close = async () => {
    try {
      await transport.terminateSession();
    } catch {
      /* best effort */
    }
    await client.close();
  };
  return { client, close };
}

const textOf = (r: unknown) =>
  (((r as { content?: { text?: string }[] }).content ?? []) as { text?: string }[])
    .map((c) => c.text ?? "")
    .join("");

test("connecting, listing tools, identifying and pinging provision NOTHING (issue #63)", async () => {
  state.ensured.length = 0;
  const { client, close } = await connect("inst-lazy");
  try {
    // The whole MCP handshake completed against a browser-less child.
    assert.deepEqual(state.ensured, [], "initialize must not claim a fleet slot");

    const tools = await client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    assert.ok(names.has("list_pages"), "upstream tools are registered with no browser");
    assert.ok(names.has("chikin_identify") && names.has("chikin_reset"), "gateway tools too");
    assert.deepEqual(state.ensured, [], "tools/list must not claim a fleet slot");

    // A browser tool BLOCKED by the identify gate never reaches Chrome, so it
    // must not provision one either — the gate and the allocation agree.
    const blocked = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /chikin_identify/);
    assert.deepEqual(state.ensured, [], "a gated call must not claim a fleet slot");

    const ident = await client.callTool({
      name: "chikin_identify",
      arguments: { handle: "lazy-test" },
    });
    assert.notEqual(ident.isError, true, textOf(ident));
    assert.deepEqual(state.ensured, [], "chikin_identify is answered by the gateway, browser-free");

    // The keepalive the client bridge fires every 120s — the thing that made the
    // old idle clock useless — also costs nothing now.
    await client.ping();
    assert.deepEqual(state.ensured, [], "the keepalive ping must not claim a fleet slot");

    // ...and the FIRST real browser call is what claims it.
    const call = await client.callTool({ name: "list_pages", arguments: {} });
    assert.notEqual(call.isError, true, textOf(call));
    assert.deepEqual(state.ensured, ["inst-lazy"], "the first browser tool call provisions");
    assert.match(
      textOf(call),
      new RegExp(`browserUrl=http://${BROWSER_IP}:`),
      "and the call ran against the REAL container, not the browser-less placeholder",
    );

    // A second call reuses the attached browser rather than re-provisioning.
    const again = await client.callTool({ name: "list_pages", arguments: {} });
    assert.match(textOf(again), new RegExp(`browserUrl=http://${BROWSER_IP}:`));
    assert.deepEqual(state.ensured, ["inst-lazy"], "the browser is attached once, then reused");
  } finally {
    await close();
  }
});

test("a full fleet fails one tool call, not the whole session (issue #63 impact)", async () => {
  state.ensured.length = 0;
  state.fail = new FleetFullError(8);
  const { client, close } = await connect("inst-full");
  try {
    // The session comes up EVEN THOUGH the fleet is full. This is the point: an
    // MCP client fixes its tool registry at session start, so the old 429 on
    // initialize cost the caller its browser lane for the whole session.
    const tools = await client.listTools();
    assert.ok(new Set(tools.tools.map((t) => t.name)).has("list_pages"), "tools still registered");
    await client.callTool({ name: "chikin_identify", arguments: { handle: "full-test" } });

    const denied = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(denied.isError, true, "the call fails...");
    assert.match(textOf(denied), /fleet is full/, "...naming the real reason");
    assert.match(textOf(denied), /still registered/, "...and saying the session survived");

    // Free a slot. The SAME session picks the browser up with no reconnect —
    // exactly what the reporter could not do.
    state.fail = null;
    const ok = await client.callTool({ name: "list_pages", arguments: {} });
    assert.notEqual(ok.isError, true, textOf(ok));
    assert.match(textOf(ok), new RegExp(`browserUrl=http://${BROWSER_IP}:`));
    assert.deepEqual(state.ensured, ["inst-full"], "retry attached without a reconnect");
  } finally {
    state.fail = null;
    await close();
  }
});

// The attach path spawns a child AFTER an await that can run for tens of
// seconds, which is long enough for the client to vanish. `Session.close` runs
// its teardown against whatever child is current at that moment — the
// browser-less one — so a child spawned afterwards is owned by nobody and
// survives, holding a CDP connection, until the gateway restarts.
test("a client that disconnects mid-provision leaves no orphaned child process", { timeout: 30_000 }, async () => {
  state.ensured.length = 0;
  const before = spawnedPids().length;
  let release!: () => void;
  state.hold = new Promise<void>((r) => (release = r));
  const provisionStarted = new Promise<void>((r) => (state.onEnter = r));

  try {
    const { client, close } = await connect("inst-vanish");
    await client.callTool({ name: "chikin_identify", arguments: { handle: "vanish-test" } });
    // Fire the browser call and DON'T wait for it: the client goes away while
    // the provision it triggered is still in flight.
    void client.callTool({ name: "list_pages", arguments: {} }).catch(() => {});
    await provisionStarted;
    await close();
    // `remove` runs from Session.close, which sets isClosed first — so this is
    // the barrier proving the session really was closed before the provision
    // returns, rather than a sleep hoping it was.
    while (registry.getByName("inst-vanish")) await new Promise((r) => setTimeout(r, 20));
    release();
    // Let the resumed attach do whatever it is going to do.
    await new Promise((r) => setTimeout(r, 300));

    const leaked = await stillAlive(spawnedPids().slice(before));
    // Reap before asserting: a leaked child holds this test process's event loop
    // open, so a regression would hang the run instead of failing it.
    for (const pid of leaked) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* raced us to it */
      }
    }
    assert.deepEqual(leaked, [], "every child spawned for this session must be closed with it");
  } finally {
    state.hold = null;
    state.onEnter = () => {};
  }
});

// The narrower window: the provision SUCCEEDED and the browser-bound child is
// already running when the client vanishes, so the child exists but nothing owns
// it yet — `Session.close` ran against the browser-less one and the attach never
// reaches the assignment that would hand it over. Freezing the child's replayed
// `initialize` is what holds the gateway inside that window on demand.
test("a client that disconnects after the browser child is up leaves no orphan", { timeout: 30_000 }, async () => {
  state.ensured.length = 0;
  const before = spawnedPids().length;
  try {
    const { client, close } = await connect("inst-vanish-late");
    await client.callTool({ name: "chikin_identify", arguments: { handle: "vanish-late" } });
    const handshakeChildren = spawnedPids().length;

    writeFileSync(holdFile, "");
    void client.callTool({ name: "list_pages", arguments: {} }).catch(() => {});
    // The browser-bound child has started (and is now stuck on the hold file).
    while (spawnedPids().length === handshakeChildren) await new Promise((r) => setTimeout(r, 20));
    await close();
    while (registry.getByName("inst-vanish-late")) await new Promise((r) => setTimeout(r, 20));
    rmSync(holdFile, { force: true });
    await new Promise((r) => setTimeout(r, 300));

    const spawned = spawnedPids().slice(before);
    assert.ok(
      spawned.length >= 2,
      `the browser-bound child must actually have been spawned (got ${spawned.length})`,
    );
    const leaked = await stillAlive(spawned);
    for (const pid of leaked) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* raced us to it */
      }
    }
    assert.deepEqual(leaked, [], "the browser-bound child must be closed with the session too");
  } finally {
    rmSync(holdFile, { force: true });
  }
});

test("chikin_reset on a browser-less session is a no-op, not a provision", async () => {
  state.ensured.length = 0;
  const { client, close } = await connect("inst-reset");
  try {
    const r = await client.callTool({ name: "chikin_reset", arguments: {} });
    assert.notEqual(r.isError, true, textOf(r));
    assert.match(textOf(r), /nothing to reset/i);
    assert.deepEqual(state.ensured, [], "resetting a browser that doesn't exist must not create one");
  } finally {
    await close();
  }
});
