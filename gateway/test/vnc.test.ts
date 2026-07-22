import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { vncUpgradeAllowed, hostOk, buildSelfHosts, rewriteVncTitle } from "../src/vnc.js";

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
