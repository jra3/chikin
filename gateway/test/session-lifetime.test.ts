import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A session owns a child PROCESS, so "who closes a session" is a memory
 * question (issue #122): 731 chrome-devtools-mcp children and ~89 GiB after 3.5
 * days, every one of them still owned by a session the registry held. Nothing
 * closed a session that had no container: the reaper skipped it, clients
 * exited without DELETE, and `inst-<ppid>` names never came back to be
 * reclaimed.
 *
 * Like lazy-provision.test.ts this runs the real gateway over real HTTP with a
 * real child process and only Docker stubbed, because the claim under test is
 * about processes. Every assertion here ends at "that pid is gone", never at
 * "close was called".
 */

// A stand-in for chrome-devtools-mcp: newline-delimited JSON-RPC over stdio. It
// records its pid so a child nobody closed shows up as a live process.
const FAKE_CDM = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync("__PIDFILE__", process.pid + "\\n");
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
    const result =
      m.method === "initialize"
        ? {
            protocolVersion: m.params.protocolVersion,
            capabilities: { logging: {}, tools: {} },
            serverInfo: { name: "chrome_devtools", version: "0.0.0" },
            instructions: "UPSTREAM DOC",
          }
        : m.method === "tools/list"
          ? { tools: [{ name: "list_pages", description: "fake", inputSchema: { type: "object" } }] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

// config.port is frozen at import and the Host guard trusts 127.0.0.1:<port>,
// so the port is claimed before the gateway modules load.
const port = await freePort();
const tmp = mkdtempSync(join(tmpdir(), "chikin-lifetime-"));
const fakeCdm = join(tmp, "fake-cdm.mjs");
const pidFile = join(tmp, "children.pids");
writeFileSync(fakeCdm, FAKE_CDM.replace("__PIDFILE__", pidFile), { mode: 0o755 });

// client/bridge.mjs resolves the MCP SDK from its own directory, and CI
// installs dependencies under gateway/ only. A copy inside gateway/dist
// (gitignored) resolves gateway/node_modules, so the real bridge runs here.
const gatewayRoot = fileURLToPath(new URL("../../", import.meta.url));
const bridgeDir = mkdtempSync(join(gatewayRoot, "dist", ".bridge-"));
const bridgeScript = join(bridgeDir, "bridge.mjs");
copyFileSync(fileURLToPath(new URL("../../../client/bridge.mjs", import.meta.url)), bridgeScript);

process.env.PORT = String(port);
process.env.CDM_COMMAND = fakeCdm;
process.env.GATEWAY_TOKEN = "";

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { Reaper } = await import("../src/reaper.js");
const { config } = await import("../src/config.js");
const { forgetHandshakes } = await import("../src/bridge.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spawnedPids = (): number[] =>
  existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Poll until every pid is gone; returns whatever is still alive at the deadline. */
async function stillAlive(pids: number[], ms = 6000): Promise<number[]> {
  const deadline = Date.now() + ms;
  let alive = pids.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    await sleep(50);
    alive = alive.filter(isAlive);
  }
  return alive;
}
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
/** A leaked child holds this file's event loop open: kill it before asserting. */
function assertAllGone(leaked: number[], message: string): void {
  for (const pid of leaked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* raced us to it */
    }
  }
  assert.deepEqual(leaked, [], message);
}

// Docker, stubbed: no container ever exists, which is the whole premise.
const provisioner = {
  listFleet: async () => [],
  removeInstanceVolume: async () => false,
  stopContainer: async () => {},
  removeContainer: async () => {},
  ensureContainer: async () => {
    throw new Error("no test here drives a browser");
  },
};

const registry = new Registry();
const app = createApp({ registry, provisioner: provisioner as never });
const reaper = new Reaper(registry, provisioner as never); // swept by hand, never started
let server: Server;
test.before(async () => {
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
test.after(async () => {
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(bridgeDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const base = `http://127.0.0.1:${port}`;

/**
 * Connect a client. Since #129 a session only gets a child process when the
 * gateway cannot answer for it, so `child: true` starts from a cold handshake
 * cache: the first session to see a given `initialize` is answered by a real
 * child, which is the process the lifetime tests below follow. `child: false`
 * connects on whatever the cache holds and returns no pid.
 */
async function connect(name: string, opts: { child: boolean } = { child: true }) {
  if (opts.child) forgetHandshakes();
  const before = spawnedPids().length;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/b/${name}/`));
  const client = new Client({ name: "lifetime-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  if (opts.child) await until(`${name}'s child to start`, () => spawnedPids().length > before);
  // The SDK opens the standalone event stream just AFTER connect() resolves.
  // It is what tells the gateway a client is attached, so wait for it.
  await until(`${name}'s event stream`, () => (registry.getActivity(name)?.streams ?? 0) > 0);
  const pid = opts.child ? spawnedPids()[before] : undefined;
  return {
    client,
    transport,
    pid: pid as number,
    /** What a killed client looks like to the gateway: the link drops, no DELETE. */
    abandon: async () => {
      await client.close();
      await until(`${name}'s stream to close`, () => (registry.getActivity(name)?.streams ?? 0) === 0);
    },
  };
}

const healthz = async () =>
  (await (await fetch(`${base}/healthz`)).json()) as {
    sessions: number;
    children: number;
    browserless: number;
  };

test("the reaper closes sessions abandoned without a container, and their children exit (#123)", { timeout: 60_000 }, async () => {
  // One at a time: `connect` finds its child by its offset in the pid file.
  const sessions = [];
  for (const name of ["inst-gone-1", "inst-gone-2", "inst-gone-3"]) sessions.push(await connect(name));
  const pids = sessions.map((s) => s.pid);
  assert.equal(new Set(pids).size, 3, "three sessions, three distinct child processes");
  assert.equal(pids.filter(isAlive).length, 3, "each session owns a live child process");

  for (const s of sessions) await s.abandon();
  // No DELETE arrived and the name will never reconnect, so only the reaper
  // can find these. Inside the TTL they are left alone...
  await reaper.sweep(Date.now() + 1000);
  assert.equal(registry.all().length, 3, "an abandoned session is kept until the idle TTL");

  // ...and past it they go, child process included.
  await reaper.sweep(Date.now() + config.idleTtlMs + 1000);
  assert.deepEqual(registry.all().map((s) => s.name), [], "every abandoned session is closed");
  assertAllGone(await stillAlive(pids), "every abandoned session's child process has exited");
  for (const name of ["inst-gone-1", "inst-gone-2", "inst-gone-3"])
    assert.equal(registry.getActivity(name), undefined, "and its bookkeeping is dropped");
});

test("a connected client that never browses keeps its session and its child (#123)", { timeout: 60_000 }, async () => {
  const s = await connect("inst-connected");
  try {
    // An open stream means the client is there, however long it has been quiet.
    await reaper.sweep(Date.now() + config.idleTtlMs * 10);
    assert.ok(registry.getByName("inst-connected"), "a live client is not evicted");
    assert.ok(isAlive(s.pid), "and its child keeps running");
    await s.client.ping();
  } finally {
    await s.transport.terminateSession().catch(() => {});
    await s.client.close();
  }
});

test("DELETE closes the session and its child process exits (#124)", { timeout: 60_000 }, async () => {
  const s = await connect("inst-delete");
  assert.ok(isAlive(s.pid));
  await s.transport.terminateSession();
  await until("the session to leave the registry", () => !registry.getByName("inst-delete"));
  assertAllGone(await stillAlive([s.pid]), "the child of a terminated session has exited");
  await s.client.close();
});

test("/healthz counts sessions, live children and browser-less sessions (#125)", { timeout: 60_000 }, async () => {
  await until("children left by earlier tests to exit", async () => (await healthz()).children === 0);
  assert.deepEqual(await healthz().then(({ sessions, children, browserless }) => ({ sessions, children, browserless })), {
    sessions: 0,
    children: 0,
    browserless: 0,
  });

  const a = await connect("inst-count-a");
  const b = await connect("inst-count-b");
  const during = await healthz();
  assert.equal(during.sessions, 2);
  assert.equal(during.children, 2, "one child process per session");
  assert.equal(during.browserless, 2, "neither has made a browser tool call");

  for (const s of [a, b]) {
    await s.transport.terminateSession();
    await s.client.close();
  }
  // The count follows the PROCESS, so it reaches zero only once both have exited.
  await until("the child count to return to zero", async () => (await healthz()).children === 0);
  assert.equal((await healthz()).sessions, 0);
  assertAllGone(await stillAlive([a.pid, b.pid]), "a zero count means zero processes");
});

test("a session that only handshakes, lists tools and pings has no child process (#129)", { timeout: 60_000 }, async () => {
  await until("children left by earlier tests to exit", async () => (await healthz()).children === 0);
  // The first session answers from a real child and fills the cache.
  const a = await connect("inst-warm-a");
  const aTools = await a.client.listTools();
  const before = spawnedPids().length;

  const b = await connect("inst-warm-b", { child: false });
  try {
    const bTools = await b.client.listTools();
    await b.client.ping();
    await sleep(200); // room for a child the gateway should not be spawning
    assert.equal(spawnedPids().length, before, "the second session spawned no child");
    const h = await healthz();
    assert.equal(h.sessions, 2);
    assert.equal(h.children, 1, "only the session that filled the cache has a child");

    // What the client sees is the same either way.
    assert.deepEqual(bTools, aTools, "tools/list from the gateway matches the child's, chikin tools included");
    assert.deepEqual(b.client.getServerVersion(), a.client.getServerVersion());
    assert.deepEqual(b.client.getServerCapabilities(), a.client.getServerCapabilities());
    assert.equal(b.client.getInstructions(), a.client.getInstructions());
    assert.match(b.client.getInstructions() ?? "", /chikin_identify[\s\S]*UPSTREAM DOC/, "chikin's contract, then upstream's");
  } finally {
    for (const s of [a, b]) {
      await s.transport.terminateSession().catch(() => {});
      await s.client.close();
    }
  }
});

test("a request the gateway cannot answer itself gets a child, and the child's reply (#129)", { timeout: 60_000 }, async () => {
  const a = await connect("inst-fallback-a"); // warms the cache
  const b = await connect("inst-fallback-b", { child: false });
  try {
    const before = spawnedPids().length;
    await b.client.setLoggingLevel("debug");
    assert.equal(spawnedPids().length, before + 1, "logging/setLevel is the child's to answer, so it spawned one");
    await b.client.ping();
    assert.equal((await healthz()).children, 2);
  } finally {
    for (const s of [a, b]) {
      await s.transport.terminateSession().catch(() => {});
      await s.client.close();
    }
  }
  await until("both children to exit", async () => (await healthz()).children === 0);
});

// --- client/bridge.mjs (#124) ------------------------------------------------

/** Run the real bridge and speak newline-delimited JSON-RPC to its stdio. */
function startBridge(url: string) {
  const proc: ChildProcess = spawn(process.execPath, [bridgeScript, url], {
    stdio: ["pipe", "pipe", "pipe"],
    // Its crash-recovery frame goes in XDG_RUNTIME_DIR; keep it out of the real one.
    env: { PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: tmp },
  });
  let out = "";
  const frames: { id?: number; result?: unknown }[] = [];
  proc.stdout!.on("data", (d: Buffer) => {
    out += d.toString();
    let n;
    while ((n = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, n).trim();
      out = out.slice(n + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  let stderr = "";
  proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => proc.once("exit", (code) => r(code)));
  const send = (m: unknown) => proc.stdin!.write(JSON.stringify(m) + "\n");
  const initialize = async () => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "bridge-test", version: "0.0.0" },
      },
    });
    await until(`the bridge to relay initialize (stderr: ${stderr})`, () => frames.some((f) => f.id === 1));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { proc, exited, initialize, stderr: () => stderr };
}

for (const how of ["SIGTERM", "stdin close"] as const) {
  test(`client/bridge.mjs ends its gateway session on ${how} (#124)`, { timeout: 60_000 }, async () => {
    const name = how === "SIGTERM" ? "inst-bridge-term" : "inst-bridge-eof";
    forgetHandshakes(); // a cold cache, so this session has a child to follow
    const before = spawnedPids().length;
    const bridge = startBridge(`${base}/b/${name}/`);
    try {
      await bridge.initialize();
      await until("the gateway session", () => registry.getByName(name) !== undefined);
      const pid = spawnedPids()[before];
      assert.ok(isAlive(pid), "the session owns a live child");

      if (how === "SIGTERM") bridge.proc.kill("SIGTERM");
      else bridge.proc.stdin!.end();
      assert.equal(await bridge.exited, 0, `a clean exit (stderr: ${bridge.stderr()})`);

      // No reaper runs in this test: only the bridge's own DELETE can do this.
      await until("the bridge's session to leave the registry", () => !registry.getByName(name), 3000);
      assertAllGone(await stillAlive([pid]), "and its child process has exited");
    } finally {
      bridge.proc.kill("SIGKILL");
    }
  });
}

test("client/bridge.mjs still exits promptly when the gateway never answers the DELETE (#124)", { timeout: 60_000 }, async () => {
  // Just enough Streamable HTTP for a handshake, and a DELETE that hangs.
  let deletes = 0;
  const stub = createServer((req, res) => {
    if (req.method === "DELETE") {
      deletes++;
      return; // never answered
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (m.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-session" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          result:
            m.method === "initialize"
              ? {
                  protocolVersion: m.params?.protocolVersion,
                  capabilities: {},
                  serverInfo: { name: "stub", version: "0" },
                }
              : {},
        }),
      );
    });
  });
  const stubPort = await freePort();
  await new Promise<void>((r) => stub.listen(stubPort, "127.0.0.1", r));
  const bridge = startBridge(`http://127.0.0.1:${stubPort}/b/inst-stub/`);
  try {
    await bridge.initialize();
    const t0 = Date.now();
    bridge.proc.kill("SIGTERM");
    assert.equal(await bridge.exited, 0);
    const took = Date.now() - t0;
    assert.equal(deletes, 1, "it tried to end the session");
    assert.ok(took < 3000, `a dead gateway must not hold the client's exit (took ${took}ms)`);
  } finally {
    bridge.proc.kill("SIGKILL");
    stub.closeAllConnections?.();
    await new Promise((r) => stub.close(r));
  }
});
