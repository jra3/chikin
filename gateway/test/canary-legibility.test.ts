import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The wedge watchdog is a CANARY on an unpinned dependency (#73), so what it
 * writes down has to be readable by a human hours later. This runs the real
 * gateway over real HTTP with a real child PROCESS (Docker stubbed) and checks
 * the three surfaces an operator actually reads:
 *
 *   1. the LOG — a strike/respawn line names the Chrome it happened on, and a
 *      respawn re-reads that Chrome (the container can be recreated from a
 *      floating image tag, so the browser after a swap need not be the one
 *      measured before it);
 *   2. `/healthz` — the fleet rollup, with `chromeVersions` a SET so a mixed
 *      fleet is visible while reading strike counts;
 *   3. the dashboard — `strikes`/`respawns`/`chrome` columns.
 *
 * The counters are deliberately TWO numbers, and the tests below produce all
 * three interesting shapes: a suspicion with no action (strike, no respawn),
 * an action with no suspicion (`chikin_reset`), and a real escalation.
 */

// Same sticky-target fake as nav-watchdog.test.ts: the child resolves its page
// once and keeps reporting success against it after the browser has moved on.
const FAKE_CDM = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { McpResponse } from "__MCPRESPONSE__";

appendFileSync("__PIDFILE__", process.pid + "\\n");
const i = process.argv.indexOf("--browserUrl");
const browserUrl = i >= 0 ? process.argv[i + 1] : "";

let sticky = null;
let cached = [];

const realPages = async () => {
  const res = await fetch(browserUrl + "/json/list");
  return (await res.json()).filter((t) => t.type === "page").map((t) => t.url);
};

const render = (line) => {
  const pages = cached.map((url) => ({ url: () => url }));
  const context = {
    getPages: () => pages,
    getPageId: (p) => pages.indexOf(p),
    isPageSelected: (p) => p.url() === sticky,
    getIsolatedContextName: () => undefined,
    getExtensionServiceWorkers: () => [],
  };
  const r = new McpResponse({});
  r.setIncludePages(true);
  r.appendResponseLine(line);
  return r.format("navigate_page", context, {});
};

const bind = async () => {
  cached = await realPages();
  sticky = cached[0] ?? null;
};

async function navigate(url) {
  if (sticky === null) await bind();
  if (!(await realPages()).includes(sticky)) return render("Navigated page to " + url + ".");
  const res = await fetch(browserUrl + "/chikin/navigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: sticky, url }),
  });
  const out = await res.json();
  cached = out.pages;
  sticky = out.selected;
  return render("Navigated page to " + url + ".");
}

async function handle(m) {
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") {
    reply({
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "chrome_devtools", version: "1.1.1" },
      instructions: "UPSTREAM DOC",
    });
  } else if (m.method === "tools/list") {
    reply({
      tools: [
        { name: "navigate_page", description: "fake", inputSchema: { type: "object" } },
        { name: "list_pages", description: "fake", inputSchema: { type: "object" } },
      ],
    });
  } else if (m.method === "tools/call") {
    if (m.params.name === "navigate_page") reply(await navigate(m.params.arguments.url));
    else {
      if (sticky === null) await bind();
      reply(render("Listed pages."));
    }
  } else reply({});
}

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
    if (m.id === undefined) continue;
    queue = queue.then(() => handle(m));
  }
});
`;

const freePort = async (): Promise<number> =>
  await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const port = await freePort();
const cdpPort = await freePort();

const tmp = mkdtempSync(join(tmpdir(), "chikin-canary-"));
const fakeCdm = join(tmp, "fake-cdm.mjs");
const pidFile = join(tmp, "children.pids");
writeFileSync(
  fakeCdm,
  FAKE_CDM.replace("__PIDFILE__", pidFile).replace(
    "__MCPRESPONSE__",
    pathToFileURL(
      createRequire(import.meta.url).resolve("chrome-devtools-mcp/build/src/McpResponse.js"),
    ).href,
  ),
  { mode: 0o755 },
);
const childCount = (): number =>
  existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).length : 0;

const OLD_CHROME = "Chrome/147.0.7727.101"; // wedges readily (the #15 report)
const NEW_CHROME = "Chrome/150.0.7871.181"; // does not reproduce the wedge

/** The browser as CDP sees it, including the version the canary reads. */
const browser = {
  pages: [] as string[],
  chrome: OLD_CHROME as string | null,
  navs: [] as string[],
};

const cdp = createServer((req, res) => {
  if (req.url === "/json/version") {
    if (browser.chrome === null) {
      res.statusCode = 500;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: browser.chrome, "Protocol-Version": "1.3" }));
    return;
  }
  if (req.url === "/json/list") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(browser.pages.map((url, n) => ({ id: `T${n}`, type: "page", url, title: url }))),
    );
    return;
  }
  if (req.url === "/chikin/navigate" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { target, url } = JSON.parse(body) as { target: string; url: string };
      browser.navs.push(url);
      const at = browser.pages.indexOf(target);
      if (at >= 0) browser.pages[at] = url;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ pages: [...browser.pages], selected: url }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

const VERIFY_MS = 250;
process.env.PORT = String(port);
process.env.CHROME_CDP_PORT = String(cdpPort);
process.env.NAV_VERIFY_DELAY_MS = String(VERIFY_MS);
process.env.CDM_COMMAND = fakeCdm;
process.env.GATEWAY_TOKEN = "";

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { renderDashboard } = await import("../src/dashboard.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const recreated: string[] = [];
const provisioner = {
  ensureContainer: async () => "127.0.0.1",
  recreateContainer: async (name: string) => {
    recreated.push(name);
  },
  listFleet: async () =>
    live.map((name) => ({ name, containerId: name, state: "running", status: "Up 3 minutes" })),
  sandboxStatus: async () => "sandboxed" as const,
};
const live: string[] = [];

const registry = new Registry();
const app = createApp({ registry, provisioner: provisioner as never });
let server: Server;

// The gateway splits its log across both streams (warn/error -> stderr, info ->
// stdout), and the canary spans both: a strike is a warn, the respawn that
// re-reads Chrome is an info. Tap both, or the evidence is half the story.
const gatewayLog: string[] = [];
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);
const tap =
  (real: (...a: unknown[]) => boolean) =>
  (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = String(chunk);
    if (/^\[(info|warn|error|debug)\] /.test(s)) gatewayLog.push(s);
    return real(chunk, ...rest);
  };

test.before(async () => {
  process.stderr.write = tap(realErr as (...a: unknown[]) => boolean) as typeof process.stderr.write;
  process.stdout.write = tap(realOut as (...a: unknown[]) => boolean) as typeof process.stdout.write;
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  cdp.listen(cdpPort, "127.0.0.1");
  await new Promise((r) => cdp.once("listening", r));
});

test.after(async () => {
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  cdp.closeAllConnections?.();
  await new Promise((r) => cdp.close(r));
});

async function connect(name: string, handle: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/b/${name}/`));
  const client = new Client({ name: "canary-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await client.callTool({ name: "chikin_identify", arguments: { handle } });
  live.push(name);
  return client;
}

const lines = (re: RegExp) => gatewayLog.filter((l) => re.test(l));
const settle = () => new Promise((r) => setTimeout(r, VERIFY_MS + 400));
const act = (name: string) => registry.getActivity(name)!;

// --- 1. a suspicion that never becomes an action ----------------------------
// One strike, then the child recovers on its own: cumulative navStrikes keeps
// the suspicion, childRespawns stays 0. This gap is the whole reason there are
// two counters — it is the shape of a detector firing on a non-wedge.
test("a strike with no respawn keeps the suspicion visible", async () => {
  browser.pages = ["https://app.example/suspect"];
  const client = await connect("inst-suspect", "canary-suspect");
  await client.callTool({ name: "navigate_page", arguments: { url: "https://app.example/suspect" } });
  await settle();

  browser.pages = ["https://app.example/elsewhere"]; // the child's target vanishes
  await client.callTool({ name: "navigate_page", arguments: { url: "https://app.example/again" } });
  await settle();
  assert.equal(act("inst-suspect").navStrikes, 1, "the suspicion is recorded");
  assert.equal(act("inst-suspect").childRespawns, 0, "and nothing was replaced");

  browser.pages = ["https://app.example/suspect"]; // the child's target is back
  await client.callTool({ name: "navigate_page", arguments: { url: "https://app.example/ok" } });
  await settle();
  assert.equal(act("inst-suspect").navStrikes, 1, "cumulative: recovery does not erase it");
  assert.equal(act("inst-suspect").childRespawns, 0);
  assert.equal(act("inst-suspect").chromeVersion, OLD_CHROME, "attributable to a Chrome");
});

// --- 2. an action with no suspicion -----------------------------------------
// childRespawns counts a child being replaced for ANY cause, not just a wedge
// verdict — here the model calling chikin_reset itself.
test("chikin_reset counts as a respawn with no strike behind it", async () => {
  browser.pages = ["https://app.example/reset"];
  const client = await connect("inst-reset", "canary-reset");
  await client.callTool({ name: "list_pages", arguments: {} });
  const before = childCount();

  const r = await client.callTool({ name: "chikin_reset", arguments: {} });
  assert.notEqual(r.isError, true, "the reset succeeded");
  assert.deepEqual(recreated, ["inst-reset"], "the container really was recreated");
  assert.ok(childCount() > before, "a fresh child process took over");
  assert.equal(act("inst-reset").childRespawns, 1, "an action with no suspicion behind it");
  assert.equal(act("inst-reset").navStrikes, 0);
});

// --- 3. the log names the Chrome, and re-reads it across the swap ------------
test("a strike names its Chrome and a respawn re-reads the browser's version", async () => {
  browser.pages = ["https://app.example/start"];
  browser.chrome = OLD_CHROME;
  const client = await connect("inst-wedge", "canary-wedge");
  await client.callTool({ name: "navigate_page", arguments: { url: "https://app.example/start" } });
  await settle();
  assert.equal(act("inst-wedge").navStrikes, 0, "a healthy nav takes no strike");

  browser.pages = ["https://app.example/after-target-swap"]; // THE WEDGE
  for (const n of [1, 2])
    await client.callTool({
      name: "navigate_page",
      arguments: { url: `https://app.example/start?try=${n}` },
    });
  // The container is recreated from a floating image tag on the way back up:
  // the Chrome after the swap is not the one that took the strikes.
  browser.chrome = NEW_CHROME;
  await settle();
  await settle();

  const strikes = lines(/session\[inst-wedge\].*nav verify failed/);
  assert.equal(strikes.length, 2, "two navs, two strikes");
  for (const s of strikes)
    assert.match(
      s,
      new RegExp(`session\\[inst-wedge\\] \\(${OLD_CHROME.replace(/\./g, "\\.")}\\): nav verify failed`),
      "every strike names the Chrome it happened on",
    );
  const gone = lines(/session\[inst-wedge\].*child gone \(navigation wedge detected/);
  assert.equal(gone.length, 1);
  assert.match(gone[0], new RegExp(OLD_CHROME.replace(/\./g, "\\.")), "so does the respawn decision");

  const back = lines(/session\[inst-wedge\].*child respawned/);
  assert.match(back.at(-1)!, new RegExp(NEW_CHROME.replace(/\./g, "\\.")), "the swap re-read Chrome");
  assert.equal(act("inst-wedge").chromeVersion, NEW_CHROME, "and cached the new one");
  assert.equal(act("inst-wedge").navStrikes, 2);
  assert.equal(act("inst-wedge").childRespawns, 1);
});

// --- 4. the two operator surfaces -------------------------------------------
test("/healthz and the dashboard show the fleet canary", async () => {
  const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
    canary: { navStrikes: number; childRespawns: number; chromeVersions: string[] };
  };
  assert.equal(health.canary.navStrikes, 3, "1 suspect + 2 wedge");
  assert.equal(health.canary.childRespawns, 2, "1 reset + 1 wedge verdict");
  assert.deepEqual(
    health.canary.chromeVersions,
    [OLD_CHROME, NEW_CHROME],
    "a set, so a fleet on mixed Chrome is visible while reading strike counts",
  );

  const html = await renderDashboard(provisioner as never, registry);
  assert.match(html, /<th[^>]*>strikes<\/th>/);
  assert.match(html, /<th[^>]*>respawns<\/th>/);
  assert.match(html, /<th[^>]*>chrome<\/th>/);
  assert.match(html, new RegExp(`<code>${NEW_CHROME.replace(/\./g, "\\.")}</code>`));
  assert.match(html, new RegExp(`<code>${OLD_CHROME.replace(/\./g, "\\.")}</code>`));

  // Evidence dump for a reviewer (off unless asked for).
  const dir = process.env.CHIKIN_EVIDENCE_DIR;
  if (dir) {
    const { writeFileSync: w } = await import("node:fs");
    w(join(dir, "dashboard.html"), html);
    w(join(dir, "healthz-canary.json"), JSON.stringify(health, null, 2) + "\n");
    w(
      join(dir, "canary-gateway.log"),
      gatewayLog.filter((l) => /nav verify failed|child gone|child respawned|browser attached|chikin_reset/.test(l)).join(""),
    );
  }
});
