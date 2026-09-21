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
const WEDGE = "__WEDGEFILE__"; // while this exists: no tab can be fronted, no capture returns
const SLOW = "__SLOWFILE__"; //  while this exists: a capture takes its time, but DOES return
const CLOSE = "__CLOSEFILE__"; // one-shot: the selected tab closes under the next select_page
const DELAY = "__DELAYFILE__"; // list_pages dawdles for the ms this file names
const SELDELAY = "__SELDELAYFILE__"; // select_page dawdles AFTER acting, for the ms it names
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
    if (existsSync(WEDGE)) return threw("No page found");
    const page = pages.find((p) => p.id === args.pageId);
    if (!page) return threw("No page found");
    selected = page.id;
    if (args.bringToFront) front = page.id;
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
    if (existsSync(WEDGE)) return never();
    // With --experimentalPageIdRouting upstream captures the page the CALLER
    // named, not the selected one — so that is the tab needing a frame.
    const shot = typeof args.pageId === "number" ? args.pageId : selected;
    // No compositor frame for a tab that is not in front: this is the hang.
    if (shot !== front) return never();
    // A real capture of a huge fullPage document: slow, and not stuck.
    if (existsSync(SLOW)) await sleep(3500);
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
const wedgeFile = join(tmp, "wedge-capture");
const slowFile = join(tmp, "slow-capture");
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
    .replace("__WEDGEFILE__", wedgeFile)
    .replace("__SLOWFILE__", slowFile)
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
// Short enough to assert on, far longer than the fake needs to answer.
process.env.SCREENSHOT_DEADLINE_MS = "2000";
// Likewise: long enough that an unobstructed child always answers inside it,
// short enough that a test can afford to let it expire.
process.env.SCREENSHOT_ACTIVATE_TIMEOUT_MS = "1500";
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
 * Retry a call the gateway answers with its retryable "browser restarting"
 * error. That reply is the contract during a child swap — the point of the
 * assertion is that the session comes BACK, not that it never blinks.
 */
async function callWhenReady(
  client: { callTool: (a: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> },
  name: string,
  ms = 15_000,
): Promise<unknown> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await client.callTool({ name, arguments: {} });
    } catch (e) {
      if (Date.now() > deadline || !/restarting/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
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

const textOf = (r: unknown) =>
  (((r as { content?: { text?: string }[] }).content ?? []) as { text?: string }[])
    .map((c) => c.text ?? "")
    .join("");
/** The URL the child says its tools are acting on, read from its page block. */
const selectedUrl = (r: unknown) => /^\d+: (\S+) \[selected\]$/m.exec(textOf(r))?.[1];

test("a capture of a tab that is not in front is taken, not hung (issue #89)", async () => {
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

test("the client's own selection survives the activation, and it never sees the extra calls", async () => {
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

test("new_page(background: true) — the documented trap — no longer hangs the next capture", async () => {
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

test("an id that has been retired under the activation is re-read, not given up on", async () => {
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
    lines.some((l) => /to the front failed.*re-reading the page list once/.test(l)),
    `the failed activation is said out loud, not swallowed: ${lines.join(" | ")}`,
  );
});

test("a page the client itself picked during the activation is not put back", async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot6", "shot-client-picks");
  try {
    await client.callTool({ name: "list_pages", arguments: {} }); // attach the browser
    // The client does not wait for its screenshot before asking for a different
    // tab. Re-selecting the page the activation read first would revert a
    // choice the client has already been told succeeded.
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
    `standing down is said out loud: ${lines.join(" | ")}`,
  );
});

test("a capture the gateway DID bring to the front is allowed to be slow", async () => {
  // The deadline replaces the child, which costs the session its page ids,
  // snapshot uids and console history — so a client retrying a legitimately
  // slow fullPage capture would degrade it on every attempt and never get it.
  // A capture whose tab is demonstrably in front is not stuck, just slow: it
  // rides Puppeteer's own 180s protocolTimeout, as it did before #89.
  writeFileSync(slowFile, "");
  const { client, close } = await connect("inst-shot7", "shot-slow");
  try {
    const started = Date.now();
    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    assert.equal((shot.content as { type: string }[])[0]?.type, "image", textOf(shot));
    assert.ok(
      Date.now() - started > 2000,
      "the capture really did outlast SCREENSHOT_DEADLINE_MS without being cut short",
    );
  } finally {
    rmSync(slowFile, { force: true });
    await close();
  }
});

test("a capture that never returns replaces the child, instead of freezing the session", async () => {
  // The blast radius half of #89: the child holds its tool mutex for the whole
  // of Puppeteer's 180s protocolTimeout, so failing the client's request would
  // leave every other call on the session queued behind it. Only a fresh child
  // frees it. The wedged child below cannot bring a tab to the front either,
  // which is what makes this capture one the gateway never managed to protect
  // — the only kind the deadline is armed for.
  writeFileSync(wedgeFile, "");
  const { client, close } = await connect("inst-shot5", "shot-wedged");
  try {
    const started = Date.now();
    const err = await client
      .callTool({ name: "take_screenshot", arguments: {} })
      .then(() => null, (e: unknown) => e);
    assert.ok(err, "a capture that never returns must not be waited on forever");
    assert.match(String(err), /restart/i, `caller told to retry: ${String(err)}`);
    assert.ok(
      Date.now() - started < 20_000,
      "the client is unblocked on the gateway's deadline, not Puppeteer's 180s one",
    );

    // ...and the session comes back, on a child whose mutex is free.
    rmSync(wedgeFile, { force: true });
    const after = await callWhenReady(client, "list_pages");
    assert.ok(selectedUrl(after), `session still serves calls: ${textOf(after)}`);
    const shot = await callWhenReady(client, "take_screenshot");
    assert.equal(
      ((shot as { content: { type: string }[] }).content ?? [])[0]?.type,
      "image",
      "and captures work again on the fresh child",
    );
  } finally {
    rmSync(wedgeFile, { force: true });
    await close();
  }
});

test("a page the client picks AFTER the injected select_page still leaves a deadline", async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot8", "shot-late-pick");
  try {
    await client.callTool({ name: "list_pages", arguments: {} }); // attach the browser
    // The client's frame arrives while the injected select_page is in flight,
    // so the child runs it AFTER: the tab the gateway fronted is not the tab
    // the capture ends up being taken of. Reporting that activation as a
    // success is the #89 hang with its own rescue disarmed.
    writeFileSync(selDelayFile, "400");
    const shot = client.callTool({ name: "take_screenshot", arguments: {} });
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({
      name: "new_page",
      arguments: { url: "https://late.example/", background: true },
    });
    rmSync(selDelayFile, { force: true });

    const outcome = await outcomeWithin(shot, 15_000);
    assert.match(
      outcome,
      /restart/i,
      `the capture was still treated as unprotected, so the deadline rescued it: ${outcome}`,
    );
  } finally {
    rmSync(selDelayFile, { force: true });
    stop();
    await close();
  }
  assert.ok(
    lines.some((l) => /picked a page itself while this capture was being set up/.test(l)),
    `the gateway says it stood down: ${lines.join(" | ")}`,
  );
});

test("a long call holding the mutex does not have a sibling capture's deadline kill it", async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot9", "shot-mutex-sibling");
  try {
    // Put the capture's own tab in front first, so the only thing between it
    // and an answer is the mutex the call ahead of it is holding. That same
    // held mutex is what times the activation out, which is why the two always
    // turn up together.
    await client.callTool({ name: "select_page", arguments: { pageId: 2, bringToFront: true } });
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
    assert.equal(outcome, "returned", `a queued capture is not a stuck one: ${outcome}`);
    assert.equal((shot as { content: { type: string }[] }).content[0]?.type, "image");
    assert.match(
      await nav,
      /Navigated to slow:4000/,
      "and the call it was queued behind was not failed out from under the client either",
    );
  } finally {
    stop();
    await close();
  }
  // The injected list_pages timed out and then replied anyway, late. A frame
  // the gateway issued must never reach the client transport, which has no
  // stream for its id and says so in a line that reads like a broken link.
  assert.ok(
    !lines.some((l) => /http send failed/.test(l)),
    `no reply of the gateway's own leaked at the client: ${lines.join(" | ")}`,
  );
});

test("a capture that names its own page fronts THAT page, not the selected one", async () => {
  // CDM_EXTRA_ARGS=--experimentalPageIdRouting is a supported opt-in, and under
  // it upstream captures the page the CALLER named. Fronting the selected page
  // instead leaves the named one uncomposited — the #89 hang again, and
  // reported as a protected capture so nothing rescues it.
  const { client, close } = await connect("inst-shot10", "shot-routed-id");
  try {
    const before = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(selectedUrl(before), "https://example.org/", "and page 1 is not it");
    let shot: unknown;
    const capture = client
      .callTool({ name: "take_screenshot", arguments: { pageId: 1 } })
      .then((r) => {
        shot = r;
        return r;
      });
    const outcome = await outcomeWithin(capture, 15_000);
    assert.equal(outcome, "returned", `the page the capture names was fronted: ${outcome}`);
    assert.equal((shot as { content: { type: string }[] }).content[0]?.type, "image");
  } finally {
    await close();
  }
});
