import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveCdmBin } from "./cdm-stdio.js";

/**
 * Since #129 a session whose `initialize` the gateway has seen before is
 * answered with no child at all: the handshake and `tools/list` come from what
 * an earlier child said. The other suites prove that against a fake child; this
 * one runs the REAL chrome-devtools-mcp, because "identical" is a claim about
 * upstream's actual replies (outputSchemas, annotations, instructions), and a
 * fake only ever agrees with itself.
 *
 * No browser is needed: upstream resolves its browser connection inside the
 * tool handler, so `initialize` and `tools/list` are served against
 * NO_BROWSER_URL (see cdm-outputschema.test.ts).
 */

const port = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});
// config is frozen at import, so the env goes in first. node:test runs each
// test file in its own process.
process.env.PORT = String(port);
process.env.CDM_COMMAND = resolveCdmBin();
process.env.GATEWAY_TOKEN = "";

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { liveChildren } = await import("../src/children.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const registry = new Registry();
const provisioner = {
  listFleet: async () => [],
  ensureContainer: async () => {
    throw new Error("no test here drives a browser");
  },
};
const app = createApp({ registry, provisioner: provisioner as never });
let server: Server;
test.before(async () => {
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
test.after(async () => {
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function connect(name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/b/${name}/`));
  const client = new Client({ name: "handshake-cache-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}

test("real chrome-devtools-mcp: a session answered from the cache sees exactly what the child said", { timeout: 60_000 }, async () => {
  const a = await connect("inst-real-a");
  const b = { close: async () => {} } as Awaited<ReturnType<typeof connect>>;
  try {
    const aTools = await a.client.listTools();
    assert.ok(aTools.tools.length > 10, "the real child served its tool list");
    const childrenWithA = liveChildren();
    assert.equal(childrenWithA, 1, "the first session was answered by a real child");

    Object.assign(b, await connect("inst-real-b"));
    const bTools = await b.client.listTools();
    await b.client.ping();
    assert.equal(liveChildren(), childrenWithA, "the second session started no child");

    assert.deepEqual(bTools, aTools);
    assert.deepEqual(b.client.getServerVersion(), a.client.getServerVersion());
    assert.deepEqual(b.client.getServerCapabilities(), a.client.getServerCapabilities());
    assert.equal(b.client.getInstructions(), a.client.getInstructions());
  } finally {
    await a.close();
    await b.close();
  }
});
