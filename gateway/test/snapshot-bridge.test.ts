import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * `chikin_snapshot` through the real gateway (#96): the acceptance criteria
 * that are about the BRIDGE, not the read. The tool is gated by identity,
 * provisions lazily on first use and counts as browser activity — the same
 * three things a forwarded browser tool does — while never reaching the child.
 *
 * Real HTTP, a real (fake) child process, Docker stubbed to point at a fake
 * Chrome on loopback. The fake child records every tools/call it is handed,
 * which is how "never reaches the child" is asserted rather than assumed.
 */

// A chrome-devtools-mcp stand-in that logs each tools/call name to its stdout
// reply, so the test can see which calls the gateway forwarded.
const FAKE_CDM = `#!/usr/bin/env node
const seen = [];
function handle(m) {
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize")
    reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "chrome_devtools", version: "0.0.0" }, instructions: "UPSTREAM DOC" });
  else if (m.method === "tools/list")
    reply({ tools: [{ name: "list_pages", description: "fake", inputSchema: { type: "object" } }] });
  else if (m.method === "tools/call") {
    seen.push(m.params.name);
    const result = { content: [{ type: "text", text: "forwarded:" + seen.join(",") }] };
    if (m.params.name === "navigate_page") result.structuredContent = { pages: [{ id: 1, url: "https://example.org/gone", selected: true }] };
    reply(result);
  }
  else reply({});
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, n).trim(); buf = buf.slice(n + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined) handle(m);
  }
});
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const port = await freePort();
const chromePort = await freePort();

const tmp = mkdtempSync(join(tmpdir(), "chikin-snap-"));
const fakeCdm = join(tmp, "fake-cdm.mjs");
writeFileSync(fakeCdm, FAKE_CDM, { mode: 0o755 });

// config is frozen at import time: everything under src/ loads after this.
process.env.PORT = String(port);
process.env.CHROME_CDP_PORT = String(chromePort);
process.env.CDM_COMMAND = fakeCdm;
process.env.GATEWAY_TOKEN = "";
process.env.NAV_VERIFY_DELAY_MS = "600000";

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { startFakeCdp } = await import("./fake-cdp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const PAGE_STATE = {
  url: "https://example.org/checkout",
  title: "Checkout",
  w: 1120,
  h: 780,
  text: "Cart total: $10",
  scroll: { y: 0, height: 780 },
  actions: [{ id: "e1", node: 1, kind: "click", role: "button", label: "Continue", value: "" }],
  marker: [],
  page_key: [],
  guards: {},
  omitted_actions: 0,
};

const ensured: string[] = [];
const provisioner = {
  ensureContainer: async (name: string) => {
    ensured.push(name);
    return "127.0.0.1"; // where the fake Chrome listens
  },
  recreateContainer: async () => {},
  listFleet: async () => [],
};
const registry = new Registry();
const app = createApp({ registry, provisioner: provisioner as never });
let server: Server;
const chrome = await startFakeCdp(
  [{ id: "P1", url: "https://example.org/checkout", title: "Checkout", evaluate: () => PAGE_STATE }],
  chromePort,
);
test.before(async () => {
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
test.after(async () => {
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await chrome.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/b/${name}/`));
  const client = new Client({ name: "snap-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
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
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");

test("chikin_snapshot: listed, gated, lazily provisioning, browser-active, and never the child's", async () => {
  const { client, close } = await connect("inst-snap");
  try {
    // Stamped at registration, so "not browser activity" means "unchanged".
    const t0 = registry.getActivity("inst-snap")?.lastBrowserActivity;
    assert.ok(t0 !== undefined);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "chikin_snapshot"), "appended to tools/list beside chikin_identify");

    const blocked = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /chikin_identify/, "blocked with the identify instruction");
    assert.deepEqual(ensured, [], "a gated snapshot claims no fleet slot");
    assert.equal(registry.getActivity("inst-snap")?.lastBrowserActivity, t0, "and is not browser activity");

    const ident = await client.callTool({ name: "chikin_identify", arguments: { handle: "snap-test" } });
    assert.notEqual(ident.isError, true, textOf(ident));

    await new Promise((r) => setTimeout(r, 5)); // so a stamp is distinguishable from t0
    const snap = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.notEqual(snap.isError, true, textOf(snap));
    assert.deepEqual(ensured, ["inst-snap"], "the first snapshot on a browserless session provisions (#63 holds)");
    const stamped = registry.getActivity("inst-snap")?.lastBrowserActivity;
    assert.ok(stamped !== undefined && stamped > t0, "stamped as browser activity, so the reaper sees it");
    assert.match(textOf(snap), /^# Checkout\n/, "the text rendering the model reads");
    assert.ok(textOf(snap).includes("e1 [button] Continue"));
    const sc = snap.structuredContent as { page?: { id?: string; url?: string }; actions?: unknown[] };
    assert.equal(sc.page?.id, "P1", "structuredContent names the page it read");
    assert.equal(sc.actions?.length, 1);
    assert.deepEqual(chrome.upgrades, ["/devtools/page/P1"], "read over the gateway's OWN CDP socket");

    // The child saw the identify-gated list_pages? No — nothing. Prove it by
    // forwarding one real call now and reading the child's own log of calls.
    const forwarded = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(textOf(forwarded), "forwarded:list_pages", "the child never received chikin_snapshot");

    const wrong = await client.callTool({ name: "chikin_snapshot", arguments: { url: "https://other.test/" } });
    assert.equal(wrong.isError, true);
    assert.match(textOf(wrong), /No open page matches url https:\/\/other\.test\//);
    assert.match(textOf(wrong), /https:\/\/example\.org\/checkout \(Checkout\)/, "the refusal lists what is open");

    const bad = await client.callTool({ name: "chikin_snapshot", arguments: { url: 7 } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /`url` must be a string/);
  } finally {
    await close();
  }
});

test("chikin_snapshot: a reset forgets the replaced child's selection; a stale one falls back to a lone page", async () => {
  const { client, close } = await connect("inst-snap-reset");
  try {
    const ident = await client.callTool({ name: "chikin_identify", arguments: { handle: "snap-reset" } });
    assert.notEqual(ident.isError, true, textOf(ident));
    const nav = await client.callTool({ name: "navigate_page", arguments: { url: "https://example.org/gone" } });
    assert.notEqual(nav.isError, true, textOf(nav));

    const lone = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.notEqual(lone.isError, true, textOf(lone));
    assert.equal((lone.structuredContent as { page?: { id?: string } }).page?.id, "P1");

    chrome.pages.push({ id: "P2", url: "https://example.org/other", title: "Other" });
    const stale = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.equal(stale.isError, true);
    assert.match(textOf(stale), /No open page matches the selected page https:\/\/example\.org\/gone/);

    const reset = await client.callTool({ name: "chikin_reset", arguments: {} });
    assert.notEqual(reset.isError, true, textOf(reset));
    const after = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.equal(after.isError, true);
    assert.match(textOf(after), /no page is selected yet/, "the replaced child's selection is forgotten");
  } finally {
    chrome.pages.splice(1);
    await close();
  }
});
