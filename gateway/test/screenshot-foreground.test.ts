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
 * hangs a session the way the bug did.
 */
const FAKE_CDM = `#!/usr/bin/env node
import { appendFileSync, existsSync, rmSync } from "node:fs";

appendFileSync("__PIDFILE__", process.pid + "\\n");
const WEDGE = "__WEDGEFILE__"; // while this exists, no capture EVER returns
const SHIFT = "__SHIFTFILE__"; // one-shot: the next select_page finds ids moved
const trace = (line) => appendFileSync("__TRACEFILE__", line + "\\n");

// The browser. Only ONE tab is composited — \`front\` — and it is not the tab
// the tools act on (\`selected\`), which is the whole of the bug.
let pages = ["https://example.com/", "https://example.org/", "https://iana.org/"];
let selected = 1;
let front = 0;

const block = () =>
  ["## Pages", ...pages.map((u, i) => i + ": " + u + (i === selected ? " [selected]" : ""))].join("\\n");
const said = (line) => ({ content: [{ type: "text", text: line + "\\n" + block() }] });
const never = () => new Promise(() => {});

async function tool(name, args) {
  trace(name);
  if (name === "list_pages") return said("Listed pages.");
  if (name === "select_page") {
    // A page closing renumbers every id after it — upstream's ids are positions
    // in its own page list. This is the race the gateway checks for.
    if (existsSync(SHIFT)) {
      rmSync(SHIFT);
      pages.shift();
      if (selected > 0) selected--;
      if (front > 0) front--;
    }
    if (args.pageId < 0 || args.pageId >= pages.length)
      return { content: [{ type: "text", text: "No such page." }], isError: true };
    selected = args.pageId;
    if (args.bringToFront) front = args.pageId;
    return said("Selected page " + args.pageId + ".");
  }
  if (name === "new_page") {
    // The documented trap: \`background\` SELECTS the new page while leaving
    // another tab in front.
    pages.push(args.url);
    selected = pages.length - 1;
    if (!args.background) front = selected;
    return said("Opened " + args.url + ".");
  }
  if (name === "take_screenshot") {
    if (existsSync(WEDGE)) return never();
    // No compositor frame for a tab that is not in front: this is the hang.
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
      tools: ["list_pages", "select_page", "new_page", "take_screenshot"].map((name) => ({
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
const shiftFile = join(tmp, "shift-ids");
const traceFile = join(tmp, "calls.trace");
// Paths are baked into the script rather than passed as env vars:
// StdioClientTransport spawns children with a curated default environment, so
// nothing the test sets in `process.env` would reach them.
writeFileSync(
  fakeCdm,
  FAKE_CDM.replace("__PIDFILE__", pidFile)
    .replace("__WEDGEFILE__", wedgeFile)
    .replace("__SHIFTFILE__", shiftFile)
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

test("a selection that moves under the activation is put back", async () => {
  const { lines, stop } = await tapLines();
  const { client, close } = await connect("inst-shot4", "shot-race");
  try {
    const before = await client.callTool({ name: "list_pages", arguments: {} });
    const wanted = selectedUrl(before);
    // A page closes between the gateway reading the ids and using one — a
    // client that pipelines close_page alongside its screenshot. The id it read
    // now names a DIFFERENT page.
    writeFileSync(shiftFile, "");
    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    assert.equal((shot.content as { type: string }[])[0]?.type, "image", textOf(shot));

    const after = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(
      selectedUrl(after),
      wanted,
      "the client is left on the page it had selected, not the one the stale id named",
    );
  } finally {
    stop();
    await close();
  }
  assert.ok(
    lines.some((l) => /selected page changed while bringing it to the front/.test(l)),
    `the swap is said out loud, not silently corrected: ${lines.join(" | ")}`,
  );
});

test("a capture that never returns replaces the child, instead of freezing the session", async () => {
  // The blast radius half of #89: the child holds its tool mutex for the whole
  // of Puppeteer's 180s protocolTimeout, so failing the client's request would
  // leave every other call on the session queued behind it. Only a fresh child
  // frees it.
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
