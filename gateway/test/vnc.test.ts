import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  vncUpgradeAllowed,
  hostOk,
  buildSelfHosts,
  rewriteVncTitle,
  createVncProxy,
  VNC_PROXY_TIMEOUT_MS,
} from "../src/vnc.js";
import { config, containerName, vncUrl } from "../src/config.js";

// config.port defaults to 8080 in tests (no PORT env), so the trusted set is
// {127.0.0.1:8080, localhost:8080, [::1]:8080}.
function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("vnc upgrade: allows same-origin loopback handshakes", () => {
  assert.equal(
    vncUpgradeAllowed(req({ origin: "http://127.0.0.1:8080", host: "127.0.0.1:8080" })),
    true,
  );
  assert.equal(
    vncUpgradeAllowed(req({ origin: "http://localhost:8080", host: "localhost:8080" })),
    true,
  );
});

test("vnc upgrade: rejects a cross-origin page", () => {
  assert.equal(
    vncUpgradeAllowed(req({ origin: "http://evil.example", host: "127.0.0.1:8080" })),
    false,
    "foreign Origin must be rejected even with a valid Host",
  );
});

test("vnc upgrade: rejects a missing Origin (non-browser / stripped)", () => {
  assert.equal(vncUpgradeAllowed(req({ host: "127.0.0.1:8080" })), false);
});

test("vnc upgrade: rejects a DNS-rebinding Host", () => {
  assert.equal(
    vncUpgradeAllowed(req({ origin: "http://127.0.0.1:8080", host: "attacker.test" })),
    false,
    "a Host that isn't one of ours must be rejected (DNS-rebinding guard)",
  );
});

test("vnc upgrade: rejects a wrong port", () => {
  assert.equal(
    vncUpgradeAllowed(req({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:9999" })),
    false,
  );
});

// hostOk also backs the MCP endpoint's DNS-rebinding guard (CHK-006a).
test("hostOk: accepts our own loopback Host", () => {
  assert.equal(hostOk(req({ host: "127.0.0.1:8080" })), true);
  assert.equal(hostOk(req({ host: "localhost:8080" })), true);
});

test("hostOk: rejects a rebinding Host and a missing Host", () => {
  assert.equal(hostOk(req({ host: "attacker.test" })), false, "foreign Host (DNS-rebinding) rejected");
  assert.equal(hostOk(req({ host: "127.0.0.1:9999" })), false, "wrong port rejected");
  assert.equal(hostOk(req({})), false, "missing Host rejected");
});

test("rewriteVncTitle: injects the handle, HTML-escaped, leaves rest intact", () => {
  const html = "<html><head><title>noVNC</title></head><body>x</body></html>";
  const out = rewriteVncTitle(html, "mulm-login-fix");
  assert.match(out, /<title>mulm-login-fix · chikin<\/title>/);
  assert.match(out, /<body>x<\/body>/, "body untouched");
  // A handle can only be a slug, but escape defensively anyway.
  assert.match(rewriteVncTitle("<title>x</title>", "a<b&c"), /<title>a&lt;b&amp;c · chikin<\/title>/);
});

test("rewriteVncTitle: no <title> present -> returns html unchanged", () => {
  const html = "<html><body>no title here</body></html>";
  assert.equal(rewriteVncTitle(html, "handle"), html);
});

test("buildSelfHosts: loopback-only by default", () => {
  assert.deepEqual(
    buildSelfHosts(8080, ""),
    new Set(["127.0.0.1:8080", "localhost:8080", "[::1]:8080"]),
  );
});

test("buildSelfHosts: GATEWAY_EXTRA_ORIGINS extends the set; garbage is ignored", () => {
  const hosts = buildSelfHosts(8080, " https://tunnel.example:9443 , not a url , http://box.lan:8080 ,");
  assert.ok(hosts.has("tunnel.example:9443"), "valid extra origin trusted");
  assert.ok(hosts.has("box.lan:8080"), "second extra origin trusted");
  assert.ok(hosts.has("127.0.0.1:8080"), "loopback set retained");
  assert.equal(hosts.size, 5, "unparseable and empty entries dropped");
});

// #79: the /vnc proxy dialed the browser by BARE container name. A fleet member
// shares two networks with the gateway, Docker's embedded DNS picks between them
// with no ordering guarantee, and the chikin-egress answer is a black hole —
// enable_icc=false (CHK-002) DROPS the SYN rather than refusing it, so every
// noVNC request hung for the OS connect timeout. Pin the lookup to the data
// plane, the same network provisioner.resolveIp dials CDP on.
test("vncUrl: pins the lookup to the browser data-plane network", () => {
  assert.equal(vncUrl("inst-772912"), `http://chikin-chrome-inst-772912.${config.network}:6080`);
  assert.notEqual(
    vncUrl("inst-772912"),
    `http://${containerName("inst-772912")}:6080`,
    "a bare container name can resolve to the egress address, whose SYN is dropped (#79)",
  );
});

test("vncUrl: never targets the egress network", () => {
  assert.ok(
    !vncUrl("inst-1").includes(config.egressNetwork),
    "the egress bridge has inter-container forwarding off; VNC there is a black hole",
  );
});

async function listenLoopback(server: http.Server | net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

// An upstream whose connect never completes AND never errors: the observable
// shape of the #79 black hole, where chikin-egress (enable_icc=false, CHK-002)
// swallows the SYN instead of refusing it. The socket's DNS lookup is a stub
// that never calls back, so it sits in `connecting` forever — the same state a
// dropped SYN leaves it in, but instant, hermetic, and independent of how the
// host routes a blackholed address.
function stalledUpstream(): { agent: http.Agent; close: () => void } {
  const opened: net.Socket[] = [];
  const agent = new http.Agent();
  agent.createConnection = () => {
    const sock = net.connect({ host: "stalled.invalid", port: 6080, lookup: () => {} });
    opened.push(sock);
    return sock;
  };
  return {
    agent,
    close: () => {
      for (const sock of opened) sock.destroy();
      agent.destroy();
    },
  };
}

// The bound has to arm during the CONNECT. http-proxy's own proxyTimeout uses
// ClientRequest.setTimeout, which Node defers to a "connect" event that a
// dropped SYN never delivers — so armed that way this test never gets a
// response and fails on its own timeout.
test("vnc proxy: a connect that never completes becomes the 502, not a hang", { timeout: 15_000 }, async () => {
  const proxy = createVncProxy();
  const upstream = stalledUpstream();
  const server = http.createServer((req, res) => {
    proxy.web(req, res, { target: "http://stalled.invalid:6080", agent: upstream.agent, proxyTimeout: 250 });
  });
  const port = await listenLoopback(server);
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/vnc.html`, { signal: AbortSignal.timeout(5_000) });
    const body = await res.text();
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502, "a stuck connect must surface as the upstream 502");
    assert.equal(body, "vnc upstream unavailable");
    assert.ok(elapsed >= 250, `must not fail before the bound (${elapsed}ms)`);
    assert.ok(elapsed < 4_000, `must fail on the bound, not the OS connect timeout (${elapsed}ms)`);
  } finally {
    upstream.close();
    server.close();
  }
});

// The other half of the guarantee: an upstream that accepts the connection and
// then says nothing (a wedged websockify) must not hold the tab open either.
test("vnc proxy: an upstream that connects and then goes silent also 502s", { timeout: 15_000 }, async () => {
  const proxy = createVncProxy();
  const accepted: net.Socket[] = [];
  const mute = net.createServer((sock) => accepted.push(sock));
  const mutePort = await listenLoopback(mute);
  const server = http.createServer((req, res) => {
    proxy.web(req, res, { target: `http://127.0.0.1:${mutePort}`, proxyTimeout: 250 });
  });
  const port = await listenLoopback(server);
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/vnc.html`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 502);
    assert.equal(await res.text(), "vnc upstream unavailable");
    assert.ok(Date.now() - started < 4_000, "a silent upstream must not hold the request open");
  } finally {
    for (const sock of accepted) sock.destroy();
    mute.close();
    server.close();
  }
});

// The shipped default, exercised on a real request rather than range-checked:
// it must be on the socket while that socket is still connecting.
test("vnc proxy: the shipped default arms while the socket is still connecting", { timeout: 15_000 }, async () => {
  const proxy = createVncProxy();
  const upstream = stalledUpstream();
  const armed = new Promise<net.Socket | null>((resolve) => {
    // Registered after the proxy's own arming listener, so it observes the socket
    // as that listener left it.
    proxy.on("proxyReq", (proxyReq) => resolve(proxyReq.socket));
  });
  const server = http.createServer((req, res) => {
    // No per-call proxyTimeout: this is the value the gateway ships with.
    proxy.web(req, res, { target: "http://stalled.invalid:6080", agent: upstream.agent });
  });
  const port = await listenLoopback(server);
  const pending = fetch(`http://127.0.0.1:${port}/vnc.html`).catch(() => undefined);
  try {
    const sock = await armed;
    assert.ok(sock, "the outgoing request has a socket by the time proxyReq fires");
    assert.equal(sock.connecting, true, "the socket has not connected yet");
    assert.equal(
      sock.timeout,
      VNC_PROXY_TIMEOUT_MS,
      "the bound must already be on the connecting socket, not deferred to a 'connect' a dropped SYN never fires",
    );
  } finally {
    upstream.close();
    await pending;
    server.close();
  }
});

// The asymmetry is deliberate: a VNC websocket is legitimately silent for as
// long as nobody touches the mouse, so bounding the upgrade path would kill
// live sessions — a worse regression than the hang being fixed.
test("vnc proxy: the websocket pass is left unbounded", { timeout: 15_000 }, async () => {
  const proxy = createVncProxy();
  const upstream = stalledUpstream();
  const errors: unknown[] = [];
  proxy.on("error", (err) => errors.push(err));
  const serverSockets: Duplex[] = [];
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    serverSockets.push(socket);
    proxy.ws(req, socket, head, { target: "http://stalled.invalid:6080", agent: upstream.agent, proxyTimeout: 50 });
  });
  const port = await listenLoopback(server);
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: "/websockify",
    headers: { connection: "Upgrade", upgrade: "websocket" },
  });
  req.on("error", () => {}); // the teardown below resets this socket on purpose
  req.end();
  const [clientSocket] = (await once(req, "socket")) as [net.Socket];
  await delay(500); // 10x the bound the web pass would have applied
  try {
    assert.deepEqual(errors, [], "no bound may fire on the upgrade path");
    assert.equal(clientSocket.destroyed, false, "the operator's socket must survive an idle VNC session");
  } finally {
    req.destroy();
    for (const sock of serverSockets) sock.destroy();
    upstream.close();
    server.close();
    await delay(50); // let the teardown's own resets land inside this test
  }
});
