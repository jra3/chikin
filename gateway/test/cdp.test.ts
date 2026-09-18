import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

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
const CHROME_JSON = JSON.stringify({
  Browser: "Chrome/153.0.8010.36",
  webSocketDebuggerUrl: "ws://172.29.0.9:9222/devtools/browser/8f2c-abc",
  "V8-Version": "15.3",
});

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

/** Docker, stubbed: every browser is "already running" on loopback. */
function stubProvisioner() {
  const ensured: string[] = [];
  const provisioner = {
    ensureContainer: async (name: string) => {
      ensured.push(name);
      return "127.0.0.1";
    },
    resolveIp: async () => "127.0.0.1",
    recreateContainer: async () => {},
    listFleet: async () => [],
  };
  return { provisioner, ensured };
}

const registry = new Registry();
const { provisioner, ensured } = stubProvisioner();
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
    const init = await new Promise<{ status: number; body: string }>((resolve, reject) => {
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
          path: "/b/pw-busy/",
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
    assert.equal(init.status, 409, "MCP must not attach to a CDP-driven browser");
  } finally {
    registry.cdpClosed("pw-busy");
  }
});

// --- the websocket ----------------------------------------------------------

/** Open a raw upgrade against the gateway and resolve with what came back. */
function upgrade(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ socket: net.Socket | null; status: number }> {
  return new Promise((resolve, reject) => {
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
    req.on("upgrade", (res, socket) => resolve({ socket: socket as net.Socket, status: res.statusCode ?? 0 }));
    req.on("response", (res) => resolve({ socket: null, status: res.statusCode ?? 0 }));
    // A refused upgrade is a destroyed socket, which surfaces here.
    req.on("error", () => resolve({ socket: null, status: 0 }));
    req.end();
  });
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
  const deadline = Date.now() + 2000;
  while (registry.hasCdp("pw-ws") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(registry.hasCdp("pw-ws"), false, "closing the socket releases the browser");
});

test("an upgrade carrying an Origin is dropped", async () => {
  const up = await upgrade("/cdp/pw-ws2/devtools/browser/x", { origin: "http://evil.example" });
  assert.equal(up.socket, null, "a page-originated upgrade must never be spliced to a browser");
  assert.equal(registry.hasCdp("pw-ws2"), false);
});

test("an upgrade for a browser somebody else is driving is dropped", async () => {
  registry.cdpOpened("pw-taken");
  try {
    const up = await upgrade("/cdp/pw-taken/devtools/browser/x");
    assert.equal(up.socket, null);
  } finally {
    registry.cdpClosed("pw-taken");
  }
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

test("cdpAccessOk: Host must be ours, Origin must be absent", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
  assert.equal(cdpAccessOk(req({ host: SELF })), true);
  assert.equal(cdpAccessOk(req({ host: `localhost:${gatewayPort}` })), true);
  assert.equal(cdpAccessOk(req({ host: "attacker.test" })), false);
  assert.equal(cdpAccessOk(req({})), false, "a missing Host is not one of ours");
  assert.equal(cdpAccessOk(req({ host: SELF, origin: `http://${SELF}` })), false);
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
