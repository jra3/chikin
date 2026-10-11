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
process.env.CHIKIN_ANTHROPIC_API_KEY = "";
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
  marker: ["m"],
  page_key: ["k"],
  guards: { "1": ["g"] } as Record<string, unknown>,
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
// The fake page answers each in-page probe chikin_act sends by what it asks:
// the guard check (unchanged), the target resolve (a centre to click), the
// settle wait (nothing), and everything else is the snapshot script itself.
const answer = (params: Record<string, unknown>): unknown => {
  const expr = String(params.expression ?? "");
  if (expr.includes("c.guard(c.nodes.get(")) return [PAGE_STATE.page_key, PAGE_STATE.guards["1"]];
  if (expr.includes("elementFromPoint")) return { x: 40, y: 20 };
  if (expr.includes("requestAnimationFrame(ready)")) return undefined;
  return PAGE_STATE;
};
const chrome = await startFakeCdp(
  [{ id: "P1", url: "https://example.org/checkout", title: "Checkout", evaluate: answer }],
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
    assert.ok(!tools.tools.some((t) => t.name === "chikin_achieve"), "no decision model configured, so no chikin_achieve (#103)");

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
    // Nothing moved the child since that read, so the gateway stays on the tab
    // it read (#99) rather than hunting for the child's stale URL.
    const kept = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.notEqual(kept.isError, true, textOf(kept));
    assert.equal((kept.structuredContent as { page?: { id?: string } }).page?.id, "P1");

    // A child navigation hands the choice back to the child's report, which
    // names a URL no open page has: refused, never guessed between two pages.
    await client.callTool({ name: "navigate_page", arguments: { url: "https://example.org/gone" } });
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

test("chikin_act: gated, needs a read, executes the stored row and answers with the page after", async () => {
  const { client, close } = await connect("inst-act");
  try {
    const blocked = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /chikin_identify/, "gated like any browser tool");
    await client.callTool({ name: "chikin_identify", arguments: { handle: "act-test" } });

    const early = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.equal(early.isError, true);
    assert.match(textOf(early), /call chikin_snapshot first/);
    assert.ok(ensured.includes("inst-act"), "it is browser work, so it provisions like any browser tool");

    await client.callTool({ name: "chikin_snapshot", arguments: {} });
    const before = chrome.commands.length;
    const unknown = await client.callTool({ name: "chikin_act", arguments: { id: "e99" } });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No row 'e99'/);
    assert.equal(chrome.commands.length, before, "an unknown id never reaches the browser");

    const t0 = registry.getActivity("inst-act")?.lastBrowserActivity ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    const done = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.notEqual(done.isError, true, textOf(done));
    assert.match(textOf(done), /^Done: clicked e1 \(Continue\)\. The page now:\n\n# Checkout/);
    assert.equal((done.structuredContent as { executed?: string }).executed, "e1");
    const input = chrome.commands.slice(before).filter((c) => c.method === "Input.dispatchMouseEvent");
    assert.deepEqual(
      input.map((c) => [c.params.type, c.params.x, c.params.y]),
      [
        ["mousePressed", 40, 20],
        ["mouseReleased", 40, 20],
      ],
      "a real press and release at the centre the page resolved just now",
    );
    assert.ok((registry.getActivity("inst-act")?.lastBrowserActivity ?? 0) > t0, "stamped as browser activity");
  } finally {
    await close();
  }
});

test("chikin_act: a closed page is not retried blind; the next snapshot reads what is open", async () => {
  const { client, close } = await connect("inst-act-gone");
  const original = chrome.pages[0];
  try {
    await client.callTool({ name: "chikin_identify", arguments: { handle: "act-gone" } });
    const snap = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.notEqual(snap.isError, true, textOf(snap));

    chrome.pages[0] = { ...original, id: "P9" };
    const before = chrome.commands.length;
    const gone = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.equal(gone.isError, true);
    assert.match(textOf(gone), /gone/);
    assert.match(textOf(gone), /Call chikin_snapshot/);
    assert.doesNotMatch(textOf(gone), /retry/);
    assert.equal(chrome.commands.length, before, "nothing reached any page");

    const again = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.match(textOf(again), /call chikin_snapshot first/, "the dead tab is forgotten");

    const fresh = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.notEqual(fresh.isError, true, textOf(fresh));
    assert.equal((fresh.structuredContent as { page?: { id?: string } }).page?.id, "P9");
  } finally {
    chrome.pages[0] = original;
    await close();
  }
});

test("chikin_snapshot: a read that finishes after a reset is not remembered for the new browser", async () => {
  const { client, close } = await connect("inst-snap-swap");
  const page = chrome.pages[0];
  const original = page.evaluate;
  try {
    await client.callTool({ name: "chikin_identify", arguments: { handle: "snap-swap" } });
    const first = await client.callTool({ name: "chikin_snapshot", arguments: {} });
    assert.notEqual(first.isError, true, textOf(first));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    page.evaluate = (params) => {
      held = true;
      return gate.then(() => answer(params));
    };
    const pending = client.callTool({ name: "chikin_snapshot", arguments: {} });
    while (!held) await new Promise((r) => setTimeout(r, 10));
    page.evaluate = original;

    const reset = await client.callTool({ name: "chikin_reset", arguments: {} });
    assert.notEqual(reset.isError, true, textOf(reset));
    release();
    await pending;

    const before = chrome.commands.length;
    const act = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.equal(act.isError, true);
    assert.match(textOf(act), /call chikin_snapshot first/, "the replaced browser's read was dropped");
    assert.equal(chrome.commands.length, before);
  } finally {
    page.evaluate = original;
    await close();
  }
});
