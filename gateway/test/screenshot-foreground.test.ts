import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tapLines } from "./log-tap.js";

/**
 * End-to-end proof that the gateway brings a capture's page to the front
 * (issue #89), run through the real gateway over real HTTP with a real child
 * PROCESS and only Docker stubbed.
 *
 * The reported failure: Chrome runs headful under Xvfb, so only the ACTIVE tab
 * of a window is composited, and `Page.captureScreenshot` waits on a compositor
 * frame. chrome-devtools-mcp never activates the tab it captures, so a capture
 * aimed at any other tab blocked until Puppeteer's 180s protocolTimeout — AND
 * held the child's per-session tool mutex for the whole wait, so `list_pages`
 * and everything else queued behind it. One background screenshot froze the
 * session for three minutes; the symptom at the client was "chikin hangs".
 *
 * The stand-in below reproduces exactly that rule and nothing else: it tracks
 * which tab is `front`, answers a capture only when the selected tab IS that
 * tab, and otherwise never replies at all — while serializing every call on one
 * queue, the way upstream's tool mutex does. So a test that gets its screenshot
 * back is a test in which the gateway really did activate the tab first, and a
 * regression does not fail an assertion about an implementation detail, it
 * hangs a session the way the bug did. Its page ids follow McpContext's: a
 * counter stamped once per page and never reused, so a closed tab retires a
 * number rather than renumbering its neighbours.
 */
const FAKE_CDM = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";

appendFileSync("__PIDFILE__", process.pid + "\\n");
const CLOSE = "__CLOSEFILE__"; // one-shot: the selected tab closes under the next select_page
const DELAY = "__DELAYFILE__"; // list_pages dawdles for the ms this file names
const SELDELAY = "__SELDELAYFILE__"; // and so does select_page, AFTER it has acted
const trace = (line) => appendFileSync("__TRACEFILE__", line + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A dawdle file's contents are its duration; an empty one means 300ms.
const dawdle = (f) => (existsSync(f) ? sleep(Number(readFileSync(f, "utf8").trim()) || 300) : null);

// The browser. Only ONE tab is composited — \`front\` — and it is not the tab
// the tools act on (\`selected\`), which is the whole of the bug.
//
// Page ids follow McpContext: a counter stamped once per page object, from 1,
// never renumbered and never reused. So a tab that closes retires its number,
// and upstream re-selects its first remaining page rather than shuffling
// anyone up.
let nextId = 1;
let pages = ["https://example.com/", "https://example.org/", "https://iana.org/"].map((url) => ({
  id: nextId++,
  url,
}));
let selected = 2;
let front = 3;

const block = () =>
  [
    "## Pages",
    ...pages.map((p) => p.id + ": " + p.url + (p.id === selected ? " [selected]" : "")),
  ].join("\\n");
const said = (line) => ({ content: [{ type: "text", text: line + "\\n" + block() }] });
// A handler that throws answers with its message and nothing else: upstream
// throws before asking for a page block, so an error reply names no selection.
const threw = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const never = () => new Promise(() => {});

async function tool(name, args) {
  trace(name);
  if (name === "list_pages") {
    await dawdle(DELAY);
    return said("Listed pages.");
  }
  if (name === "navigate_page") {
    // A long tool call is ordinary, not a fault: it just holds the one mutex.
    // "slow:<ms>" is how this file asks for one.
    const held = /^slow:(\\d+)$/.exec(args.url ?? "");
    if (held) await sleep(Number(held[1]));
    return said("Navigated to " + args.url + ".");
  }
  if (name === "select_page") {
    // A tab closing on its own — window.close(), a popup finishing its hop —
    // retires its id for good. This is the race the activation has to survive:
    // the id it just read now resolves to nothing.
    if (existsSync(CLOSE)) {
      rmSync(CLOSE);
      pages = pages.filter((p) => p.id !== selected);
      selected = pages[0].id;
    }
    const page = pages.find((p) => p.id === args.pageId);
    if (!page) return threw("No page found");
    selected = page.id;
    if (args.bringToFront) front = page.id;
    // On a live child this is where Page.bringToFront's CDP round trip sits, so
    // it is a window a client frame can be queued behind just like the other.
    await dawdle(SELDELAY);
    return said("Selected page " + page.id + ".");
  }
  if (name === "new_page") {
    // The documented trap: \`background\` SELECTS the new page while leaving
    // another tab in front.
    const page = { id: nextId++, url: args.url };
    pages.push(page);
    selected = page.id;
    if (!args.background) front = page.id;
    return said("Opened " + args.url + ".");
  }
  if (name === "take_screenshot") {
    // No compositor frame for a tab that is not in front: this is the hang,
    // and nothing in the gateway rescues it — so every test that takes one
    // carries its own node:test timeout.
    if (selected !== front) return never();
    return { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] };
  }
  return said("ok");
}

async function handle(m) {
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize")
    reply({
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "chrome_devtools", version: "0.0.0" },
    });
  else if (m.method === "tools/list")
    reply({
      tools: ["list_pages", "select_page", "new_page", "navigate_page", "take_screenshot"].map((name) => ({
        name,
        description: "fake",
        inputSchema: { type: "object" },
      })),
    });
  else if (m.method === "tools/call") reply(await tool(m.params.name, m.params.arguments ?? {}));
  else reply({});
}

// One queue for every call: upstream holds a per-session tool mutex, which is
// what turns one stuck capture into a frozen session.
let queue = Promise.resolve();
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
    queue = queue.then(() => handle(m));
  }
});
`;

// The Host guard trusts 127.0.0.1:<config.port>, and config.port is frozen at
// import time — so claim a free port first and hand it to the config as PORT.
const port = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

const tmp = mkdtempSync(join(tmpdir(), "chikin-shot-"));
const fakeCdm = join(tmp, "fake-cdm.mjs");
const pidFile = join(tmp, "children.pids");
const closeFile = join(tmp, "close-selected");
const delayFile = join(tmp, "delay-list-pages");
const selDelayFile = join(tmp, "delay-select-page");
const traceFile = join(tmp, "calls.trace");
// Paths are baked into the script rather than passed as env vars:
// StdioClientTransport spawns children with a curated default environment, so
// nothing the test sets in `process.env` would reach them.
writeFileSync(
  fakeCdm,
  FAKE_CDM.replace("__PIDFILE__", pidFile)
    .replace("__CLOSEFILE__", closeFile)
    .replace("__DELAYFILE__", delayFile)
    .replace("__SELDELAYFILE__", selDelayFile)
    .replace("__TRACEFILE__", traceFile),
  { mode: 0o755 },
);

/** Every tool call the CHILD actually handled, in order. */
const trace = (): string[] =>
  existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean) : [];
const resetTrace = () => rmSync(traceFile, { force: true });

process.env.PORT = String(port);
process.env.CDM_COMMAND = fakeCdm;
process.env.GATEWAY_TOKEN = ""; // auth off; this test is about captures
// The nav watchdog would otherwise verify this file's new_page against a
// browser that does not exist. It has its own tests.
process.env.NAV_VERIFY_DELAY_MS = "600000";

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const BROWSER_IP = "10.99.0.7";
const registry = new Registry();
const provisioner = {
  ensureContainer: async () => BROWSER_IP,
  recreateContainer: async () => {},
  listFleet: async () => [],
};
const app = createApp({ registry, provisioner: provisioner as never });
let server: Server;
test.before(async () => {
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
test.after(async () => {
  // Each session owns a child PROCESS, and a leaked one keeps this file's event
  // loop alive forever.
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

/** A connected, identified session — browser tools are gated until then. */
async function connect(name: string, handle: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/b/${name}/`),
  );
  const client = new Client({ name: "shot-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await client.callTool({ name: "chikin_identify", arguments: { handle } });
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

/**
 * What a call that may never come back actually did: "returned", its error
 * text, or "still waiting". A regression in any of this HANGS a session rather
 * than failing an assertion, so every such call here is bounded.
 */
function outcomeWithin(call: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    call.then(
      () => "returned",
      (e: unknown) => `error: ${String(e)}`,
    ),
    new Promise<string>((r) => setTimeout(r, ms, "still waiting")),
  ]);
}

/**
 * Every test here takes a capture, and the fake child NEVER answers a capture
 * of a background tab — deliberately, since that is the bug. Nothing in the
 * gateway rescues such a call any more (docs/adr/0006), so each test carries
 * its own bound: a regression fails the suite instead of hanging CI.
 */
const CAPTURE_TIMEOUT_MS = 30_000;

const textOf = (r: unknown) =>
  (((r as { content?: { text?: string }[] }).content ?? []) as { text?: string }[])
    .map((c) => c.text ?? "")
    .join("");
/** The URL the child says its tools are acting on, read from its page block. */
const selectedUrl = (r: unknown) => /^\d+: (\S+) \[selected\]$/m.exec(textOf(r))?.[1];

test("a capture of a tab that is not in front is taken, not hung (issue #89)", { timeout: CAPTURE_TIMEOUT_MS }, async () => {
  const { client, close } = await connect("inst-shot", "shot-basic");
  try {
    const before = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(selectedUrl(before), "https://example.org/", "selected tab is not the front one");

    resetTrace();
    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    assert.notEqual(shot.isError, true, textOf(shot));
    assert.equal(
      (shot.content as { type: string }[])[0]?.type,
      "image",
      "the capture returned an image rather than blocking on a frame that never comes",
    );

    // The gateway put the tab in front on the child's own stdio, before the
    // capture — and in that order.
    assert.deepEqual(
      trace(),
      ["list_pages", "select_page", "take_screenshot"],
      "the capture is preceded by an activation the client never asked for",
    );
  } finally {
    await close();
  }
});

test("the client's own selection survives the activation, and it never sees the extra calls", { timeout: CAPTURE_TIMEOUT_MS }, async () => {
  const { client, close } = await connect("inst-shot2", "shot-selection");
  try {
    const before = await client.callTool({ name: "list_pages", arguments: {} });
    const wanted = selectedUrl(before);

    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    // The activation's own replies are answered to the gateway, not forwarded:
    // the client's result is the capture, nothing else.
    assert.equal((shot.content as unknown[]).length, 1, textOf(shot));
    assert.equal((shot.content as { type: string }[])[0].type, "image");

    const after = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(
      selectedUrl(after),
      wanted,
      "re-selecting the selected page is a no-op for the client's context",
    );
  } finally {
    await close();
  }
});

test("new_page(background: true) — the documented trap — no longer hangs the next capture", { timeout: CAPTURE_TIMEOUT_MS }, async () => {
  const { client, close } = await connect("inst-shot3", "shot-background");
  try {
    // This is the workflow from the report: `background` selects the new page
    // while leaving another tab in front, and nothing activates it afterwards.
    const opened = await client.callTool({
      name: "new_page",
      arguments: { url: "https://background.example/", background: true },
    });
    assert.equal(selectedUrl(opened), "https://background.example/");

    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    assert.equal((shot.content as { type: string }[])[0]?.type, "image", textOf(shot));
  } finally {
    await close();
  }
});

test("an id that has been retired under the activation is re-read, not given up on", { timeout: CAPTURE_TIMEOUT_MS }, async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot4", "shot-retired-id");
  try {
    const before = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(selectedUrl(before), "https://example.org/");
    // The selected tab goes away between the gateway reading its id and using
    // it — a page that closed itself, which needs no client call at all.
    // Upstream never reissues the number: `select_page` throws `No page found`,
    // and that error reply carries no page block to read a selection out of.
    resetTrace();
    writeFileSync(closeFile, "");
    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    assert.equal(
      (shot.content as { type: string }[])[0]?.type,
      "image",
      `the capture is retried against a fresh id rather than forwarded unactivated: ${textOf(shot)}`,
    );
    assert.deepEqual(
      trace(),
      ["list_pages", "select_page", "list_pages", "select_page", "take_screenshot"],
      "one re-read, and one only",
    );

    const after = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(
      selectedUrl(after),
      "https://example.com/",
      "the client is left on the page the child chose when its own went away",
    );
  } finally {
    rmSync(closeFile, { force: true });
    stop();
    await close();
  }
  assert.ok(
    lines.some((l) => /to the front failed.*reading the page list again/.test(l)),
    `the failed activation is said out loud, not swallowed: ${lines.join(" | ")}`,
  );
});

test("a page the client itself picked during the activation is not put back", { timeout: CAPTURE_TIMEOUT_MS }, async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot6", "shot-client-picks");
  try {
    await client.callTool({ name: "list_pages", arguments: {} }); // attach the browser
    // The client does not wait for its screenshot before asking for a different
    // tab. Re-selecting the page the activation read FIRST would revert a
    // choice the client has already been told succeeded, so the activation
    // reads the list again and fronts what the client actually picked.
    writeFileSync(delayFile, "");
    const shot = client.callTool({ name: "take_screenshot", arguments: {} });
    await new Promise((r) => setTimeout(r, 150));
    const picked = await client.callTool({
      name: "select_page",
      arguments: { pageId: 1, bringToFront: true },
    });
    rmSync(delayFile, { force: true });
    assert.equal(selectedUrl(picked), "https://example.com/");

    const done = await shot;
    assert.equal((done.content as { type: string }[])[0]?.type, "image", textOf(done));
    const after = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(
      selectedUrl(after),
      "https://example.com/",
      "the client is left on the page IT chose, not the one the activation read first",
    );
  } finally {
    rmSync(delayFile, { force: true });
    stop();
    await close();
  }
  assert.ok(
    lines.some((l) => /picked a page itself while this capture was being set up/.test(l)),
    `noticing the client's own choice is said out loud: ${lines.join(" | ")}`,
  );
});

// `new_page(background: true)` selects a tab nothing has composited — the
// workflow the issue names — and here it arrives DURING the activation, so the
// gateway learns of it only as a moved selection epoch. There are two windows
// it can land in, and standing down in either hands the capture the trap
// itself; the second is a real Page.bringToFront round trip on a live child.
for (const [window, dawdleFile, session] of [
  ["the injected list_pages", delayFile, "inst-shot11"],
  ["the injected select_page", selDelayFile, "inst-shot12"],
] as const) {
  test(`the documented trap pipelined into ${window} still gets its image`, {
    timeout: CAPTURE_TIMEOUT_MS,
  }, async () => {
    const { client, close } = await connect(session, `shot-trap-${session}`);
    try {
      await client.callTool({ name: "list_pages", arguments: {} }); // attach the browser
      writeFileSync(dawdleFile, "300");
      const shot = client.callTool({ name: "take_screenshot", arguments: {} });
      await new Promise((r) => setTimeout(r, 150));
      const opened = await client.callTool({
        name: "new_page",
        arguments: { url: "https://pipelined.example/", background: true },
      });
      rmSync(dawdleFile, { force: true });
      assert.equal(selectedUrl(opened), "https://pipelined.example/");

      const done = await shot;
      assert.equal((done.content as { type: string }[])[0]?.type, "image", textOf(done));
      const after = await client.callTool({ name: "list_pages", arguments: {} });
      assert.equal(
        selectedUrl(after),
        "https://pipelined.example/",
        "the capture was taken of the page the client had just opened, and left it selected",
      );
    } finally {
      rmSync(dawdleFile, { force: true });
      await close();
    }
  });
}

test("a capture queued behind a long call still returns, and no injected reply leaks", {
  timeout: CAPTURE_TIMEOUT_MS,
}, async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot9", "shot-mutex-sibling");
  const started = Date.now();
  try {
    // The capture's tab is NOT in front, so this only comes back if the
    // activation really happened. Its injected `list_pages` is queued behind a
    // call holding the child's tool mutex for four seconds, and it has to wait
    // that out: a clock on the injected call would expire against a child that
    // is perfectly healthy and merely busy, and forward the capture at the
    // hang this whole change exists to close.
    const nav = client
      .callTool({ name: "navigate_page", arguments: { url: "slow:4000" } })
      .then(textOf, (e: unknown) => `error: ${String(e)}`);
    await new Promise((r) => setTimeout(r, 100));
    let shot: unknown;
    const capture = client
      .callTool({ name: "take_screenshot", arguments: {} })
      .then((r) => {
        shot = r;
        return r;
      });

    const outcome = await outcomeWithin(capture, 20_000);
    assert.equal(outcome, "returned", `a queued capture is not a lost one: ${outcome}`);
    assert.equal((shot as { content: { type: string }[] }).content[0]?.type, "image");
    assert.ok(Date.now() - started > 4000, "and it really did wait the mutex out");
    assert.match(
      await nav,
      /Navigated to slow:4000/,
      "and the call it was queued behind was not disturbed either",
    );
  } finally {
    stop();
    await close();
  }
  // A frame the gateway issued must never reach the client transport, which
  // has no stream for its id and says so in a line that reads like a broken
  // client link.
  assert.ok(
    !lines.some((l) => /http send failed/.test(l)),
    `no reply of the gateway's own leaked at the client: ${lines.join(" | ")}`,
  );
});
