import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const run = promisify(execFile);

/**
 * The CDP lane (#87), proven on the wire rather than in pieces.
 *
 * The lane's whole job is that an address Chrome hands out — one on an
 * `internal: true` network — comes back pointing at this gateway instead, and
 * that the websocket the driver then opens reaches the browser. A unit test of
 * the rewrite function alone would pass with the proxy unmounted, so most of
 * what follows runs through a real listener against a fake Chrome.
 */

/** Claim a free loopback port and give it straight back. */
async function freePort(): Promise<number> {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}

// Both ports are frozen into `config` at import time — the Host guard trusts
// 127.0.0.1:<config.port>, and the lane dials <ip>:<config.cdpPort> — so claim
// them before anything under src/ is loaded. Same reason lazy-provision.test.ts
// does this.
const gatewayPort = await freePort();
const chromePort = await freePort();
process.env.PORT = String(gatewayPort);
process.env.CHROME_CDP_PORT = String(chromePort);
process.env.GATEWAY_TOKEN = ""; // auth off: this file is about the lane, not the token

const { createApp, makeUpgradeHandler } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { rewriteCdpJson, matchCdpUpgrade, cdpAccessOk, trackCdpActivity } = await import(
  "../src/cdp.js"
);

const SELF = `127.0.0.1:${gatewayPort}`;

// What a real Chrome answers /json/version with: a websocket URL on the
// container's own chikin-net address, which is exactly the address no host
// process can reach.
//
// PRETTY-PRINTED, three spaces, one key per line — because that is what Chrome
// sends, and the gateway's rewrite is a string replace that preserves it. A
// compact `JSON.stringify` here is a fake that is easier to parse than the real
// thing, and anything downstream reading `"Browser": "..."` off the wire (see
// the bin/chikin-pw test below) then passes against the fake and fails against
// Chrome.
const CHROME_JSON = JSON.stringify(
  {
    Browser: "Chrome/153.0.8010.36",
    webSocketDebuggerUrl: "ws://172.29.0.9:9222/devtools/browser/8f2c-abc",
    "V8-Version": "15.3",
  },
  null,
  3,
);

/** A stand-in for Chrome's DevTools endpoint: the JSON handshake and an upgrade. */
function fakeChrome(): {
  server: Server;
  upgrades: string[];
  hostHeaders: string[];
  sockets: net.Socket[];
} {
  const upgrades: string[] = [];
  const hostHeaders: string[] = [];
  // An upgraded socket is no longer tracked by its http.Server, so
  // closeAllConnections() cannot reach it — hold them and tear them down by
  // hand, or this test file never exits.
  const sockets: net.Socket[] = [];
  const server = http.createServer((req, res) => {
    hostHeaders.push(String(req.headers.host));
    if (req.url?.startsWith("/json/version")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(CHROME_JSON);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  // Accept the upgrade and echo whatever the driver sends, so a test can prove
  // the splice carries traffic in both directions.
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    hostHeaders.push(String(req.headers.host));
    sockets.push(socket as net.Socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d: Buffer) => socket.write(d));
  });
  return { server, upgrades, hostHeaders, sockets };
}

/**
 * Docker, stubbed: every browser is "already running" on loopback.
 *
 * `slow` makes one name's Docker calls take a while, which is the only way to
 * test what happens DURING a provision — the window a second handshake races
 * in, and the window a driver can abort in.
 */
function stubProvisioner() {
  const ensured: string[] = [];
  const slow = new Map<string, number>();
  // Names whose container has vanished from under a driver — the wedge/reap
  // case the lane has to answer honestly instead of quietly rebuilding.
  const gone = new Set<string>();
  const wait = async (name: string): Promise<void> => {
    const ms = slow.get(name);
    if (ms) await new Promise((r) => setTimeout(r, ms));
  };
  const provisioner = {
    ensureContainer: async (name: string) => {
      ensured.push(name);
      await wait(name);
      return "127.0.0.1";
    },
    resolveIp: async (name: string) => {
      await wait(name);
      if (gone.has(name)) throw new Error(`no such container: chikin-chrome-${name}`);
      return "127.0.0.1";
    },
    recreateContainer: async () => {},
    listFleet: async () => [],
  };
  return { provisioner, ensured, slow, gone };
}

const registry = new Registry();
const { provisioner, ensured, slow, gone } = stubProvisioner();
const chrome = fakeChrome();
const deps = { registry, provisioner: provisioner as never };
const gateway = http.createServer(createApp(deps));
gateway.on("upgrade", makeUpgradeHandler(deps));

test.before(async () => {
  chrome.server.listen(chromePort, "127.0.0.1");
  await once(chrome.server, "listening");
  gateway.listen(gatewayPort, "127.0.0.1");
  await once(gateway, "listening");
});

test.after(async () => {
  for (const s of chrome.sockets) s.destroy();
  gateway.closeAllConnections?.();
  chrome.server.closeAllConnections?.();
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => chrome.server.close(r));
});

/** GET through the real listener, with full control of the request headers. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: gatewayPort, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** POST the MCP initialize frame for `name` — the only frame that opens a session. */
function initialize(name: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        path: `/b/${name}/`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// --- the handshake ----------------------------------------------------------

test("the /json handshake points the driver back at the gateway, not at chikin-net", async () => {
  const res = await get("/cdp/pw-one/json/version");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { webSocketDebuggerUrl: string; Browser: string };
  assert.equal(
    body.webSocketDebuggerUrl,
    `ws://${SELF}/cdp/pw-one/devtools/browser/8f2c-abc`,
    "the address Chrome advertises is unreachable from the host; it must be rewritten",
  );
  assert.equal(body.Browser, "Chrome/153.0.8010.36", "everything else survives the rewrite");
  assert.ok(ensured.includes("pw-one"), "the first CDP request provisions the browser (lazily, as MCP does)");
  const act = registry.getActivity("pw-one");
  assert.ok(act && act.lastBrowserActivity > 0, "taking a browser counts as browser work");
});

test("the upstream is addressed by IP, because Chrome rejects a named Host", () => {
  assert.ok(
    chrome.hostHeaders.every((h) => h.startsWith("127.0.0.1:")),
    `Chrome refuses any Host that is not an IP or localhost; saw ${JSON.stringify(chrome.hostHeaders)}`,
  );
});

test("content-length is corrected, or the driver hangs waiting for bytes", async () => {
  const res = await get("/cdp/pw-len/json/version");
  const declared = Buffer.byteLength(res.body, "utf8");
  assert.notEqual(
    declared,
    Buffer.byteLength(CHROME_JSON, "utf8"),
    "the rewrite changes the body length — the test is only meaningful if it does",
  );
  assert.equal(res.status, 200);
});

// --- guards -----------------------------------------------------------------

test("a rebinding Host is refused", async () => {
  const res = await get("/cdp/pw-one/json/version", { host: "attacker.test" });
  assert.equal(res.status, 403);
});

test("an Origin — any Origin, including our own — is refused", async () => {
  // A CDP driver never sends one; a web page always does. So this is the check
  // that keeps a page that has been tricked into loading from driving a
  // logged-in browser, and Chrome will not make it for us (--remote-allow-origins=*).
  const foreign = await get("/cdp/pw-one/json/version", { origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
  const ours = await get("/cdp/pw-one/json/version", { origin: `http://${SELF}` });
  assert.equal(ours.status, 403, "our own dashboard origin has no business on this lane either");
});

test("a request carrying Fetch Metadata is refused, Origin or no Origin", async () => {
  // The Origin check alone is not "is this a web page": Fetch attaches an
  // Origin only to CORS-tainted requests, non-GET methods and ws handshakes, so
  // `fetch(url, {mode:'no-cors'})`, an <img src> and a plain navigation all
  // arrive without one. They cannot arrive without Sec-Fetch-*, which the user
  // agent writes itself and script cannot strip.
  const before = ensured.length;
  const noCors = await get("/cdp/pw-sec/json/version", {
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "cross-site",
    "sec-fetch-dest": "empty",
  });
  assert.equal(noCors.status, 403);
  const navigation = await get("/cdp/pw-sec/json/version", {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  });
  assert.equal(navigation.status, 403, "a clicked link is a web page too");
  assert.equal(
    ensured.length,
    before,
    "reaching /json/* alone provisions a browser — a fleet slot and a seeded profile per name",
  );
});

test("an invalid browser name is refused before anything is provisioned", async () => {
  const before = ensured.length;
  const res = await get("/cdp/NOT_A_NAME/json/version");
  assert.equal(res.status, 400);
  assert.equal(ensured.length, before, "a bad name must never reach Docker");
});

test("a browser already driven over one lane refuses the other", async () => {
  registry.cdpOpened("pw-busy");
  try {
    const res = await get("/cdp/pw-busy/json/version");
    assert.equal(res.status, 409, "a second CDP driver is refused");
    assert.match(res.body, /CDP lane/);

    // ...and so is an MCP session, which is the direction that would otherwise
    // hand chrome-devtools-mcp a browser somebody else is already moving.
    const init = await initialize("pw-busy");
    assert.equal(init.status, 409, "MCP must not attach to a CDP-driven browser");
  } finally {
    registry.cdpClosed("pw-busy");
  }
});

test("a Name MCP has claimed but not yet promoted is already taken from this lane", async () => {
  // The initialize path claims a Name synchronously with reserve() and only
  // calls registry.add once the chrome-devtools-mcp child is up — tens to
  // hundreds of ms later (server.ts, bridge.ts). A lane that asks only
  // getByName reads that window as free, and a driver arriving inside it takes
  // the very Chrome the MCP session is about to attach to: both lanes on one
  // browser, which is the state that must be impossible.
  assert.equal(registry.reserve("pw-pending"), true);
  const before = ensured.length;
  try {
    const res = await get("/cdp/pw-pending/json/version");
    assert.equal(res.status, 409);
    assert.match(res.body, /MCP lane/);

    // The upgrade is the hop that would actually take the lane, so it has to
    // refuse on the same reading.
    const up = await upgrade("/cdp/pw-pending/devtools/browser/x");
    assert.equal(up.socket, null, "a reserved Name must not be spliced to a CDP driver");
    assert.equal(up.status, 409);
    assert.equal(registry.hasCdp("pw-pending"), false, "and the lane must not be marked held");
    assert.equal(ensured.length, before, "nor a browser built for a Name the other lane claimed");
  } finally {
    registry.release("pw-pending");
  }
});


// --- the websocket ----------------------------------------------------------

/** Open a raw upgrade against the gateway and resolve with what came back. */
function upgrade(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ socket: net.Socket | null; status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: gatewayPort,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) =>
      resolve({ socket: socket as net.Socket, status: res.statusCode ?? 0, body: "" }),
    );
    // A refusal answers the upgrade request with an ordinary response, which
    // is where the reason for it lives.
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ socket: null, status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ socket: null, status: 0, body: "" }));
    req.end();
  });
}

/** Poll until `done()`, or give up — release runs on socket events, not awaits. */
async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

test("the driver's websocket reaches the browser, and is counted while it is open", async () => {
  await get("/cdp/pw-ws/json/version"); // the handshake that hands over the URL
  const up = await upgrade("/cdp/pw-ws/devtools/browser/8f2c-abc");
  assert.ok(up.socket, "the upgrade must be proxied, not refused");
  try {
    assert.equal(up.status, 101);
    assert.ok(registry.hasCdp("pw-ws"), "an open CDP socket marks the browser as held");
    assert.deepEqual(
      chrome.upgrades,
      ["/devtools/browser/8f2c-abc"],
      "the /cdp/<name> prefix is stripped before the browser sees the path",
    );
    // Prove the splice actually carries traffic: the fake Chrome echoes.
    up.socket.write("ping");
    const [echo] = (await once(up.socket, "data")) as [Buffer];
    assert.equal(echo.toString(), "ping");
  } finally {
    up.socket.destroy();
  }
  // The counter has to come back down, or the browser is never reaped again.
  await waitFor(() => !registry.hasCdp("pw-ws"));
  assert.equal(registry.hasCdp("pw-ws"), false, "closing the socket releases the browser");
});

test("an upgrade carrying an Origin is refused", async () => {
  const up = await upgrade("/cdp/pw-ws2/devtools/browser/x", { origin: "http://evil.example" });
  assert.equal(up.socket, null, "a page-originated upgrade must never be spliced to a browser");
  assert.equal(up.status, 403);
  assert.equal(registry.hasCdp("pw-ws2"), false);
});

test("an upgrade carrying Fetch Metadata is refused", async () => {
  const up = await upgrade("/cdp/pw-ws3/devtools/browser/x", { "sec-fetch-dest": "websocket" });
  assert.equal(up.socket, null);
  assert.equal(up.status, 403);
  assert.equal(registry.hasCdp("pw-ws3"), false);
});

test("an upgrade for a browser somebody else is driving says so, and is not just dropped", async () => {
  registry.cdpOpened("pw-taken"); // held with no driver key recorded: not us
  try {
    const up = await upgrade("/cdp/pw-taken/devtools/browser/x");
    assert.equal(up.socket, null);
    assert.equal(up.status, 409, "a destroyed socket reaches the driver as 'socket hang up' and explains nothing");
    assert.match(up.body, /already being driven over the CDP lane/);
  } finally {
    registry.cdpClosed("pw-taken");
  }
});

test("the lane is held by the DRIVER, so the holder is not locked out of its own follow-ups", async () => {
  await get("/cdp/pw-solo/json/version");
  const first = await upgrade("/cdp/pw-solo/devtools/browser/8f2c-abc");
  assert.ok(first.socket, "the first socket takes the lane");
  try {
    const again = await get("/cdp/pw-solo/json/version");
    assert.equal(
      again.status,
      200,
      "enumerating targets mid-session is ordinary CDP; the holder must not 409 itself",
    );
    const second = await upgrade("/cdp/pw-solo/devtools/page/A1");
    assert.ok(second.socket, "one socket per target is a legitimate client shape (chrome-remote-interface)");
    second.socket.destroy();
    // One of the driver's two sockets going away is not the driver going away.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(registry.hasCdp("pw-solo"), true, "the lane is held until the LAST socket closes");
  } finally {
    first.socket.destroy();
  }
  await waitFor(() => !registry.hasCdp("pw-solo"));
  assert.equal(registry.hasCdp("pw-solo"), false);
});

test("reclaiming a stale MCP session must not hand over a Name a driver took meanwhile", async () => {
  // The stale-session reclaim is the one place the MCP lane claims a Name on
  // the far side of an await. `Session.close` frees it SYNCHRONOUSLY at its top
  // (onClose -> registry.remove, session.ts/bridge.ts) and only then awaits the
  // child's teardown — tens to hundreds of ms in which the Name reads as free
  // to the CDP lane as well. A driver still holding the websocket URL an
  // earlier handshake gave it (`bin/chikin-pw giard`, then connect) takes the
  // lane inside that window, and `reserve` knows nothing about the other lane.
  await get("/cdp/pw-reclaim/json/version");
  const drivers: net.Socket[] = [];
  const stale = {
    name: "pw-reclaim",
    isClosed: false,
    close: async (_reason: string): Promise<void> => {
      registry.remove(stale as never);
      const up = await upgrade("/cdp/pw-reclaim/devtools/browser/8f2c-abc");
      if (up.socket) drivers.push(up.socket);
    },
  };
  registry.add(stale as never);
  try {
    const init = await initialize("pw-reclaim");
    assert.equal(drivers.length, 1, "the driver has to win that window for this to be the race at all");
    assert.equal(registry.hasCdp("pw-reclaim"), true);
    assert.equal(init.status, 409, "the browser is being driven; a reclaim does not change that");
    assert.match(init.body, /CDP lane/);
    assert.equal(
      registry.has("pw-reclaim"),
      false,
      "and no session may be left reserved on a Name the other lane holds",
    );
  } finally {
    for (const s of drivers) s.destroy();
  }
  await waitFor(() => !registry.hasCdp("pw-reclaim"));
});

test("a holder's follow-up /json request never re-provisions the browser it is driving", async () => {
  // Every provision ends in waitHealthy, and a browser that fails it is stopped
  // and removed (provisionOnce -> recreateContainer). On a Name whose websocket
  // is open that tears down the container the driver's own live socket is
  // spliced to — the #73 wedge turned into a killed session. Enumerating
  // targets mid-session is ordinary CDP, so this is a normal request, not an
  // exotic one.
  await get("/cdp/pw-held/json/version");
  const up = await upgrade("/cdp/pw-held/devtools/browser/8f2c-abc");
  assert.ok(up.socket, "the driver has to be holding the lane for this to be about a holder");
  try {
    const before = ensured.filter((n) => n === "pw-held").length;
    const again = await get("/cdp/pw-held/json/version");
    assert.equal(again.status, 200, "the holder is still served — from the container that exists");
    assert.equal(
      ensured.filter((n) => n === "pw-held").length,
      before,
      "a held browser must be resolved, never re-ensured behind its own driver's back",
    );
  } finally {
    up.socket.destroy();
  }
  await waitFor(() => !registry.hasCdp("pw-held"));
});

test("a holder whose browser has vanished gets an honest error, not a silent new one", async () => {
  await get("/cdp/pw-gone/json/version");
  const up = await upgrade("/cdp/pw-gone/devtools/browser/8f2c-abc");
  assert.ok(up.socket);
  try {
    gone.add("pw-gone");
    const before = ensured.filter((n) => n === "pw-gone").length;
    const res = await get("/cdp/pw-gone/json/version");
    assert.equal(res.status, 502);
    assert.match(res.body, /no browser named 'pw-gone'/);
    assert.equal(
      res.body.trimStart().startsWith("{"),
      false,
      "a CDP client shows a human the status line of a failed fetch, not a JSON-RPC envelope",
    );
    assert.equal(
      ensured.filter((n) => n === "pw-gone").length,
      before,
      "building a second browser under a driver attached to the first is worse than failing",
    );
  } finally {
    gone.delete("pw-gone");
    up.socket.destroy();
  }
  await waitFor(() => !registry.hasCdp("pw-gone"));
});

test("a driver that gives up DURING the provision still releases the browser", async () => {
  // The bug this pins: the release listeners used to be registered inside the
  // `.then()` of the Docker hop. A driver that aborted while that promise was
  // in flight had already emitted `close`, so nothing ever fired — the name
  // answered 409 on both lanes and held a fleet slot until the attached tier
  // expired hours later (or never, with ATTACHED_IDLE_TTL_SEC=0).
  slow.set("pw-abort", 400);
  try {
    const sock = net.connect(gatewayPort, "127.0.0.1");
    sock.on("error", () => {});
    await once(sock, "connect");
    sock.write(
      "GET /cdp/pw-abort/devtools/browser/x HTTP/1.1\r\n" +
        `Host: ${SELF}\r\n` +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    // Well inside the 400ms Docker hop, and well past the ~1ms loopback trip.
    await new Promise((r) => setTimeout(r, 60));
    sock.destroy();
    // Asserted PAST the hop, not as soon as the counter reads zero: the bug is
    // a claim taken after the abort, so a reading from before the provision
    // finishes would pass against the broken version too.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      registry.hasCdp("pw-abort"),
      false,
      "an aborted upgrade must not leave the browser marked held by a driver that is gone",
    );
    // And the lane is genuinely free afterwards, not merely uncounted.
    const after = await get("/cdp/pw-abort/json/version");
    assert.equal(after.status, 200);
  } finally {
    slow.delete("pw-abort");
  }
});

// --- provisioning -----------------------------------------------------------

test("two handshakes for one cold browser share a single provision", async () => {
  // Without single-flight both reach createAndStart, and the loser gets
  // Docker's 409 name conflict — not a ProvisionError, so it lands on the
  // Express backstop as a JSON 500 in the middle of a plain-text lane.
  slow.set("pw-race", 150);
  try {
    const [a, b] = await Promise.all([
      get("/cdp/pw-race/json/version"),
      get("/cdp/pw-race/json/version"),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(
      ensured.filter((n) => n === "pw-race").length,
      1,
      "concurrent first requests must join one provision, the way bridge.ts shares `attaching`",
    );
  } finally {
    slow.delete("pw-race");
  }
});

// --- the CLI ----------------------------------------------------------------

test("bin/chikin-pw warms a browser and reports its Chrome version", async (t) => {
  // chikin-pw reads `"Browser"` straight off the wire, so it is the one thing
  // that sees the handshake's FORMATTING rather than its parsed shape.
  try {
    await run("curl", ["--version"]);
  } catch {
    t.skip("curl is not installed");
    return;
  }
  const script = fileURLToPath(new URL("../../../bin/chikin-pw", import.meta.url));
  const { stdout } = await run(script, ["pw-cli", "--json"], {
    env: { ...process.env, CHIKIN_GATEWAY: `http://${SELF}`, GATEWAY_TOKEN: "", CHIKIN_TOKEN: "" },
  });
  const out = JSON.parse(stdout) as { endpoint: string; browser: string; chrome: string };
  assert.equal(out.endpoint, `http://${SELF}/cdp/pw-cli/`);
  assert.equal(out.browser, "pw-cli");
  assert.equal(out.chrome, "Chrome/153.0.8010.36", "Chrome pretty-prints this field; the CLI must cope");
  assert.ok(ensured.includes("pw-cli"), "warming a browser is what the command is for");
});

// --- pure pieces ------------------------------------------------------------

test("rewriteCdpJson: every ws address in a payload comes back through this gateway", () => {
  const list = JSON.stringify([
    {
      id: "A1",
      type: "page",
      url: "https://www.ancestry.com/",
      webSocketDebuggerUrl: "ws://172.29.0.9:9222/devtools/page/A1",
      devtoolsFrontendUrl: "/devtools/inspector.html?ws=172.29.0.9:9222/devtools/page/A1",
    },
    {
      id: "B2",
      webSocketDebuggerUrl: "ws://172.29.0.9:9222/devtools/page/B2",
    },
  ]);
  const out = JSON.parse(rewriteCdpJson(list, "giard", SELF)) as {
    webSocketDebuggerUrl: string;
    devtoolsFrontendUrl?: string;
    url?: string;
  }[];
  assert.equal(out[0].webSocketDebuggerUrl, `ws://${SELF}/cdp/giard/devtools/page/A1`);
  assert.equal(out[1].webSocketDebuggerUrl, `ws://${SELF}/cdp/giard/devtools/page/B2`);
  assert.equal(
    out[0].devtoolsFrontendUrl,
    `/devtools/inspector.html?ws=${SELF}/cdp/giard/devtools/page/A1`,
    "the frontend URL carries the same unreachable address in a query parameter",
  );
  assert.equal(out[0].url, "https://www.ancestry.com/", "page URLs are none of our business");
});

test("rewriteCdpJson: a payload with nothing to rewrite is returned unchanged", () => {
  const body = JSON.stringify({ Browser: "Chrome/153.0.8010.36", "Protocol-Version": "1.3" });
  assert.equal(rewriteCdpJson(body, "giard", SELF), body);
});

test("matchCdpUpgrade: splits our paths and declines everybody else's", () => {
  assert.deepEqual(matchCdpUpgrade("/cdp/giard/devtools/browser/abc"), {
    name: "giard",
    rest: "/devtools/browser/abc",
  });
  assert.deepEqual(matchCdpUpgrade("/cdp/giard"), { name: "giard", rest: "/" });
  assert.equal(matchCdpUpgrade("/vnc/giard/websockify"), null, "the VNC handler owns that path");
  assert.equal(matchCdpUpgrade("/cdp/Bad_Name/devtools"), null, "names are charset-validated here too");
  assert.equal(matchCdpUpgrade("/cdp/../etc/passwd"), null);
});

test("cdpAccessOk: Host must be ours, and nothing a browser sent gets through", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
  assert.equal(cdpAccessOk(req({ host: SELF })), true);
  assert.equal(cdpAccessOk(req({ host: `localhost:${gatewayPort}` })), true);
  assert.equal(cdpAccessOk(req({ host: "attacker.test" })), false);
  assert.equal(cdpAccessOk(req({})), false, "a missing Host is not one of ours");
  assert.equal(cdpAccessOk(req({ host: SELF, origin: `http://${SELF}` })), false);
  for (const h of ["sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"]) {
    assert.equal(
      cdpAccessOk(req({ host: SELF, [h]: "whatever" })),
      false,
      `${h} is written by the user agent and cannot be stripped by script — it means a browser`,
    );
  }
});

test("trackCdpActivity: stamps on traffic, and stays quiet without it", async () => {
  const socket = { bytesRead: 0 };
  let stamps = 0;
  const stop = trackCdpActivity(socket, () => stamps++, 10);
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stamps, 0, "an idle socket must not refresh the clock — that is the keepalive lie of #57");
    socket.bytesRead = 512;
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(stamps >= 1, "a driver sending commands is real browser work");
    const after = stamps;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stamps, after, "the counter has to MOVE again; a stationary one stamps nothing");
  } finally {
    stop();
  }
});
