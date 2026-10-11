import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * `chikin_achieve` through the real gateway (#103), with a scripted decider in
 * place of the model. (Harness shared in shape with snapshot-bridge.test.ts:
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

const tmp = mkdtempSync(join(tmpdir(), "chikin-achieve-"));
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
const { CallToolResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Two pages the fake Chrome serves in turn: a click on "Continue" moves it
// from the first to the second, so the loop sees its action change the page.
const page = (n: number) => ({
  url: "https://example.org/checkout",
  title: n === 1 ? "Checkout" : "Confirm",
  w: 1120,
  h: 780,
  text: n === 1 ? "Cart total: $10" : "Ready to pay",
  scroll: { y: 0, height: 780 },
  actions:
    n === 1
      ? [{ id: "e1", node: 1, kind: "click", role: "button", label: "Continue", value: "" }]
      : [{ id: "e1", node: 2, kind: "click", role: "button", label: "Pay $10", value: "" }],
  marker: [`m${n}`],
  page_key: [`k${n}`],
  guards: { [String(n)]: [`g${n}`] } as Record<string, unknown>,
  omitted_actions: 0,
});
// Which page the fake shows: the test's starting page, advanced by every click
// that landed since the test began, computed at the moment it is asked.
let start = 1;
let startClicks = 0;
const shown = () => Math.min(2, start + (clicks() - startClicks));
const begin = (n: number) => {
  start = n;
  startClicks = clicks();
};
const answer = (params: Record<string, unknown>): unknown => {
  const expr = String(params.expression ?? "");
  const current = shown();
  const st = page(current);
  if (expr.includes("c.guard(c.nodes.get(")) return [st.page_key, st.guards[String(current)]];
  if (expr.includes("return state?.marker ?? null")) return st.marker;
  if (expr.includes("elementFromPoint")) return { x: 40, y: 20 };
  if (expr.includes("requestAnimationFrame(ready)")) return undefined;
  return st;
};

// The decider plays whatever the current test queued.
type Answer = { choice: string; text?: string | null; consequential?: boolean; reason?: string } | ((signal?: AbortSignal) => Promise<{ choice: string }>);
const script: Answer[] = [];
const decider = {
  async decide(_input: unknown, signal?: AbortSignal) {
    const next = script.shift();
    if (!next) throw new Error("script ran out");
    const d = typeof next === "function" ? await next(signal) : next;
    return { text: null, consequential: false, reason: "scripted", ms: 1, ...d };
  },
};

const provisioner = {
  ensureContainer: async () => "127.0.0.1",
  recreateContainer: async () => {},
  listFleet: async () => [],
};
const registry = new Registry();
const app = createApp({ registry, provisioner: provisioner as never, decider });
let server: Server;
const chrome = await startFakeCdp([{ id: "P1", url: "https://example.org/checkout", title: "Checkout", evaluate: answer }], chromePort);
// A click moves the page on, as a real one would.
const origInput = chrome.commands;
function clicks(): number {
  return origInput.filter((c) => c.params.type === "mouseReleased").length;
}
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
  const client = new Client({ name: "achieve-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await client.callTool({ name: "chikin_identify", arguments: { handle: name.replace("inst-", "h-") } });
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
const textOf = (r: unknown) => ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");

test("chikin_achieve: listed with a decider, runs to DONE in one call, reports progress and a trace", async () => {
  begin(1);
  const { client, close } = await connect("inst-achieve");
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "chikin_achieve"));

    const missing = await client.callTool({ name: "chikin_achieve", arguments: { goal: "  " } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /`goal` is required/);

    script.push({ choice: "e1", reason: "continue to confirm" }, { choice: "DONE", reason: "confirm page shown" });
    const progress: string[] = [];
    const t0 = registry.getActivity("inst-achieve")?.lastBrowserActivity ?? 0;
    const r = await client.callTool({ name: "chikin_achieve", arguments: { goal: "get to the confirm page" } }, CallToolResultSchema, {
      onprogress: (p) => progress.push(String(p.message)),
    });
    assert.notEqual(r.isError, true, textOf(r));
    assert.match(textOf(r), /^DONE after 2 step\(s\)/);
    assert.match(textOf(r), /1\. click e1 "Continue" -> executed, page changed/);
    assert.match(textOf(r), /The page now:\n\n# Confirm/);
    const sc = r.structuredContent as { status?: string; steps?: unknown[] };
    assert.equal(sc.status, "done");
    assert.equal(sc.steps?.length, 2);
    assert.equal(clicks(), 1, "exactly one click reached the page");
    assert.equal(progress.length, 2, "one progress notification per step");
    assert.match(progress[0], /^1\. click e1 "Continue"/);
    assert.ok((registry.getActivity("inst-achieve")?.lastBrowserActivity ?? 0) >= t0, "stamped as browser activity");
  } finally {
    await close();
  }
});

test("chikin_achieve: a consequential row stops for confirmation, and chikin_act can then do it by id", async () => {
  begin(2);
  const before = clicks();
  const { client, close } = await connect("inst-confirm");
  try {
    script.push({ choice: "e1", consequential: true, reason: "pays" });
    const r = await client.callTool({ name: "chikin_achieve", arguments: { goal: "pay" } });
    assert.notEqual(r.isError, true, textOf(r));
    const sc = r.structuredContent as { status?: string; proposed?: { id: string } };
    assert.equal(sc.status, "needs_confirmation");
    assert.equal(sc.proposed?.id, "e1");
    assert.equal(clicks(), before, "nothing was paid");
    const confirm = await client.callTool({ name: "chikin_act", arguments: { id: "e1" } });
    assert.notEqual(confirm.isError, true, textOf(confirm));
    assert.equal(clicks(), before + 1, "the caller's chikin_act did it");
  } finally {
    await close();
  }
});

test("chikin_achieve: a client cancel stops the loop between steps", async () => {
  begin(1);
  const before = clicks();
  const { client, close } = await connect("inst-cancel");
  try {
    let sawAbort!: (v: boolean) => void;
    const aborted = new Promise<boolean>((r) => (sawAbort = r));
    const ctl = new AbortController();
    script.push(
      { choice: "e1" },
      (signal) =>
        new Promise((resolve) => {
          ctl.abort(); // the client gives up while the second decision is in flight
          signal?.addEventListener("abort", () => {
            sawAbort(true);
            resolve({ choice: "e1" });
          });
          setTimeout(() => {
            sawAbort(false);
            resolve({ choice: "e1" });
          }, 3000);
        }),
    );
    await assert.rejects(
      client.callTool({ name: "chikin_achieve", arguments: { goal: "loop" } }, CallToolResultSchema, { signal: ctl.signal }),
    );
    assert.equal(await aborted, true, "notifications/cancelled reached the loop");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(clicks(), before + 1, "the in-flight decision was not executed");
    script.length = 0;
  } finally {
    await close();
  }
});
