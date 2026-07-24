import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { Registry } from "../src/registry.js";
import { Provisioner } from "../src/provisioner.js";

// node:http (not fetch) so we can set an explicit Host header — fetch treats
// Host as a forbidden header and strips it.
function get(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

// config.port defaults to 8080 in tests (no PORT env), so the trusted Host set
// is {127.0.0.1:8080, localhost:8080, [::1]:8080} regardless of the ephemeral
// port the test server actually listens on.
function getBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

// The gateway's own env — not the .env on disk — is the thing an operator can
// never otherwise see without `docker exec` (see runtime.ts).
test("/healthz reports the effective runtime config, secret-free", async () => {
  const app = createApp({ registry: new Registry(), provisioner: new Provisioner({} as never) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const body = JSON.parse(await getBody(port, "/healthz")) as {
      status: string;
      config: Record<string, unknown>;
      warnings: string[];
    };
    assert.equal(body.status, "ok", "compose healthcheck contract unchanged");
    assert.equal(body.config.seedVolume, "", "SEED_VOLUME readable without docker exec");
    assert.equal(body.config.seedingOn, false);
    assert.ok(body.config.chromeImage, "CHROME_IMAGE readable");
    // The lifecycle knobs an operator retunes when the fleet saturates (#57).
    assert.equal(body.config.idleTtlSec, 900);
    assert.equal(body.config.attachedIdleTtlSec, 14400, "the attached tier is readable too");
    assert.equal(typeof body.config.authEnabled, "boolean", "token as a boolean, never its value");
    assert.ok(Array.isArray(body.warnings));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dashboard: Host guard rejects DNS rebinding, passes our own Host", async () => {
  const app = createApp({
    registry: new Registry(),
    // Dummy docker client: the dashboard render may fail (-> 500), but the
    // guard runs first, which is all this test asserts.
    provisioner: new Provisioner({} as never),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(await get(port, "attacker.test"), 403, "rebinding Host rejected (issue #47)");
    const own = await get(port, "127.0.0.1:8080");
    assert.notEqual(own, 403, "our own Host passes the guard");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
