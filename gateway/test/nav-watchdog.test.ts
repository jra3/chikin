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
 * End-to-end proof of the nav watchdog's two halves (issue #15), run through
 * the real gateway over real HTTP with a real child PROCESS and only Docker
 * stubbed:
 *
 *   1. a nav that REDIRECTS ONTO THE PAGE ALREADY OPEN must take no strike —
 *      the false positive that bounced a healthy 2-hour session mid-task;
 *   2. a genuinely WEDGED child (bound to a target the browser no longer has,
 *      replying success while doing nothing) must still escalate 1/2 -> 2/2 ->
 *      respawn, after which the fresh child binds the browser's REAL page.
 *
 * The two look identical to the old "did the page set move?" test: neither
 * moves the page set, and in neither does the requested URL appear in it. What
 * separates them is the CHILD'S OWN reported view, which is what this exercises
 * end to end — the child renders its replies with the REAL vendored
 * chrome-devtools-mcp formatter, so the watchdog parses exactly what upstream
 * emits (see also cdm-format.test.ts).
 */

// The stand-in for chrome-devtools-mcp reproduces the ONE behaviour issue #15
// is about: the child resolves its page target ONCE and holds a sticky
// reference to it. While that target is really open it drives the browser
// normally; once the target is gone it keeps reporting success and rendering
// its stale cached view — the silent wedge, verbatim. A FRESH child re-reads
// reality, which is why a respawn is the cure.
const FAKE_CDM = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { McpResponse } from "__MCPRESPONSE__";

appendFileSync("__PIDFILE__", process.pid + "\\n");
const i = process.argv.indexOf("--browserUrl");
const browserUrl = i >= 0 ? process.argv[i + 1] : "";

let sticky = null; // the page target this child is bound to
let cached = [];   // the child's OWN view of the page set

const realPages = async () => {
  const res = await fetch(browserUrl + "/json/list");
  return (await res.json()).filter((t) => t.type === "page").map((t) => t.url);
};

// Render through the REAL upstream formatter: same "## Pages" text block and
// same structuredContent.pages the gateway sees in production. \`includePages\`
// off is how this fake stands in for an upstream version that stopped reporting
// the page list at all — the case the watchdog must call BLIND, not healthy.
const render = (line, includePages = true) => {
  const pages = cached.map((url) => ({ url: () => url }));
  const context = {
    getPages: () => pages,
    getPageId: (p) => pages.indexOf(p),
    isPageSelected: (p) => p.url() === sticky,
    getIsolatedContextName: () => undefined,
    getExtensionServiceWorkers: () => [],
  };
  const r = new McpResponse({});
  r.setIncludePages(includePages);
  r.appendResponseLine(line);
  return r.format("navigate_page", context, {});
};

// What a fresh child does on first use: read the browser as it actually is.
const bind = async () => {
  cached = await realPages();
  sticky = cached[0] ?? null;
};

async function navigate(url) {
  if (sticky === null) await bind();
  if (!(await realPages()).includes(sticky)) {
    // WEDGED: the target this child holds is a zombie. Upstream <=1.1.1 does
    // not re-resolve — it reports success and renders its stale cached view.
    return render("Navigated page to " + url + ".");
  }
  const res = await fetch(browserUrl + "/chikin/navigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: sticky, url }),
  });
  const out = await res.json();
  cached = out.pages;
  sticky = out.selected;
  return render("Navigated page to " + url + ".", !url.includes("nopages"));
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
    if (m.id === undefined) continue; // notification
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

// The Host guard trusts 127.0.0.1:<config.port>, and config is frozen at import
// time — so claim both ports first and hand them to the config below.
const port = await freePort();
const cdpPort = await freePort();

const tmp = mkdtempSync(join(tmpdir(), "chikin-navwd-"));
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

/** The browser, as CDP sees it: the ground truth the watchdog reads. */
const browser = {
  pages: [] as string[],
  // url asked for -> url actually landed on, i.e. a server-side redirect
  redirects: {} as Record<string, string>,
  navs: [] as string[],
};

const cdp = createServer((req, res) => {
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
      const landed = browser.redirects[url] ?? url;
      const at = browser.pages.indexOf(target);
      if (at >= 0) browser.pages[at] = landed; // the target navigates in place
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ pages: [...browser.pages], selected: landed }));
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
process.env.GATEWAY_TOKEN = ""; // auth off; this test is about the watchdog

const { createApp } = await import("../src/server.js");
const { Registry } = await import("../src/registry.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

// Docker, stubbed: every browser is the fake CDP server above.
const ensured: string[] = [];
const provisioner = {
  ensureContainer: async (name: string) => {
    ensured.push(name);
    return "127.0.0.1";
  },
  recreateContainer: async () => {},
  listFleet: async () => [],
};

const registry = new Registry();
const app = createApp({ registry, provisioner: provisioner as never });
let server: Server;

// The gateway logs strikes and respawns on stderr; that log IS the operator's
// view of this watchdog, so assert on it rather than on internals.
const gatewayLog: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);

test.before(async () => {
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    gatewayLog.push(String(chunk));
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  cdp.listen(cdpPort, "127.0.0.1");
  await new Promise((r) => cdp.once("listening", r));
});

test.after(async () => {
  process.stderr.write = realWrite;
  await Promise.all(registry.all().map((s) => s.close("test teardown")));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  cdp.closeAllConnections?.();
  await new Promise((r) => cdp.close(r));
});

async function connect(name: string, handle: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/b/${name}/`));
  const client = new Client({ name: "navwd-test", version: "0.0.0" }, { capabilities: {} });
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

/** The "## Pages" line the child marked selected — the child's own view. */
const childSelected = (r: unknown): string | undefined =>
  /^\d+: (\S+) \[selected\]$/m.exec(
    (((r as { content?: { text?: string }[] }).content ?? []) as { text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n"),
  )?.[1];

const strikes = () => gatewayLog.filter((l) => /nav verify failed/.test(l));
const respawns = () => gatewayLog.filter((l) => /respawning/.test(l));
const blind = () => gatewayLog.filter((l) => /wedge detection is blind/.test(l));
/** Long enough for a scheduled verification to have run and been judged. */
const settle = () => new Promise((r) => setTimeout(r, VERIFY_MS + 400));

test("a nav that redirects onto the page already open takes NO strike (issue #15)", async () => {
  // The live false positive, reduced: the browser is already on the canonical
  // page, and the client navigates to a form of it that redirects there. The
  // page set does not move and the requested URL appears NOWHERE in it — the
  // old watchdog struck for exactly that, twice in a row, and respawned a
  // perfectly healthy child mid-task.
  const canonical = "https://www.iana.org/help/example-domains";
  const legacy = "http://www.iana.org/help/example-domains";
  browser.pages = [canonical];
  browser.redirects = { [legacy]: canonical };
  gatewayLog.length = 0;

  const { client, close } = await connect("inst-redirect", "navwd-redirect");
  try {
    await client.callTool({ name: "list_pages", arguments: {} }); // attach the browser
    const childrenBefore = childCount();
    const before = [...browser.pages];

    for (const attempt of [1, 2, 3]) {
      const r = await client.callTool({ name: "navigate_page", arguments: { url: legacy } });
      assert.notEqual(r.isError, true, "the nav itself succeeds");
      console.log(
        `[redirect] nav ${attempt}: requested ${legacy} -> child reports ${childSelected(r)}; ` +
          `browser real pages [${browser.pages.join(", ")}]`,
      );
      // The two properties that made this a false positive under the old test.
      assert.deepEqual(browser.pages, before, "the page set really does not move");
      assert.equal(browser.pages.includes(legacy), false, "the requested URL is nowhere in it");
      // And the property that makes it healthy: the child's view is correct.
      assert.equal(childSelected(r), canonical, "the child reports the page it is really on");
      await settle();
    }

    console.log(
      `[redirect] strikes=${strikes().length} respawns=${respawns().length} ` +
        `children=${childCount()} (was ${childrenBefore})`,
    );
    assert.deepEqual(strikes(), [], "a redirect onto the current page must not strike");
    assert.deepEqual(respawns(), [], "and must never respawn the child");
    assert.equal(childCount(), childrenBefore, "the same child process serves throughout");
  } finally {
    await close();
  }
});

test("a genuinely wedged child still escalates 1/2 -> 2/2 -> respawn (issue #15)", async () => {
  const start = "https://app.example/start";
  const moved = "https://app.example/after-target-swap";
  browser.pages = [start];
  browser.redirects = {};
  gatewayLog.length = 0;

  const { client, close } = await connect("inst-wedge", "navwd-wedge");
  try {
    const first = await client.callTool({ name: "navigate_page", arguments: { url: start } });
    assert.equal(childSelected(first), start, "healthy: the child is on the page it navigated to");
    const childrenBefore = childCount();
    const ensuredBefore = ensured.length;
    await settle();
    assert.deepEqual(strikes(), [], "a healthy nav takes no strike");

    // THE WEDGE: the target the child holds is swapped out from under it — the
    // browser is now on a page the child has never heard of, and the child
    // keeps its sticky reference to the old one.
    browser.pages = [moved];
    const navsBefore = browser.navs.length;

    for (const attempt of [1, 2]) {
      const r = await client.callTool({ name: "navigate_page", arguments: { url: `${start}?try=${attempt}` } });
      assert.notEqual(r.isError, true, "the wedge is SILENT: the child still reports success");
      console.log(
        `[wedge] nav ${attempt}: child reports ${childSelected(r)}; ` +
          `browser real pages [${browser.pages.join(", ")}]`,
      );
      assert.equal(childSelected(r), start, "...while naming a page the browser does not have");
      await settle();
    }
    assert.equal(browser.navs.length, navsBefore, "and drove the browser nowhere at all");

    console.log(`[wedge] ${strikes().join("").trimEnd()}`);
    assert.equal(strikes().length, 2, "two navs, two strikes");
    assert.match(strikes()[0], /nav verify failed \(1\/2\)/);
    assert.match(strikes()[1], /nav verify failed \(2\/2\)/);
    assert.equal(respawns().length, 1, "the second strike respawns the child");
    assert.match(respawns()[0], /navigation wedge detected/);
    console.log(`[wedge] ${respawns()[0].trimEnd()}`);

    // The cure: a fresh child binds the browser's REAL current page.
    const deadline = Date.now() + 10_000;
    while (childCount() === childrenBefore && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(childCount(), childrenBefore + 1, "a new child process was spawned");
    assert.equal(ensured.length, ensuredBefore + 1, "against a re-ensured container");

    const after = await client.callTool({ name: "list_pages", arguments: {} });
    console.log(`[wedge] after respawn the fresh child reports ${childSelected(after)}`);
    assert.equal(childSelected(after), moved, "the fresh child is on the browser's real page");

    // And it is not wedged: navigation drives the browser again.
    gatewayLog.length = 0;
    const next = await client.callTool({
      name: "navigate_page",
      arguments: { url: "https://app.example/next" },
    });
    assert.equal(childSelected(next), "https://app.example/next");
    assert.deepEqual(browser.pages, ["https://app.example/next"], "the browser really moved");
    await settle();
    assert.deepEqual(strikes(), [], "and the recovered session takes no strike");
  } finally {
    await close();
  }
});

test("a reply with no page list is called BLIND in the log, and never struck", async () => {
  // What an upstream bump that stops reporting pages would do to this watchdog.
  // Reading it as healthy is how the whole mechanism would rot unnoticed, so the
  // session says out loud that it can no longer see.
  browser.pages = ["https://app.example/blind"];
  browser.redirects = {};
  gatewayLog.length = 0;

  const { client, close } = await connect("inst-blind", "navwd-blind");
  try {
    const r = await client.callTool({
      name: "navigate_page",
      arguments: { url: "https://app.example/blind?nopages=1" },
    });
    assert.equal(childSelected(r), undefined, "the reply carries no page list at all");
    await settle();

    console.log(`[blind] ${blind()[0]?.trimEnd()}`);
    console.log(`[blind] strikes=${strikes().length} respawns=${respawns().length}`);
    assert.equal(blind().length, 1, "the gateway says detection has gone blind");
    assert.deepEqual(strikes(), [], "'unknown' must never strike");
    assert.deepEqual(respawns(), [], "and never respawn");
  } finally {
    await close();
  }
});

test("a client navigating FASTER than the verify delay is still watched", async () => {
  // A wedged child no-ops in milliseconds, so its replies land well inside the
  // verify delay. Dropping every superseded verification outright would leave
  // exactly the sessions that need this watchdog running without one.
  const stale = "https://fast.example/stale";
  browser.pages = [stale];
  browser.redirects = {};
  gatewayLog.length = 0;

  const { client, close } = await connect("inst-fast", "navwd-fast");
  try {
    await client.callTool({ name: "list_pages", arguments: {} }); // bind the child to `stale`
    browser.pages = ["https://fast.example/moved"]; // ...then swap it out from under it
    const childrenBefore = childCount();

    // Back-to-back navs, no pause: every verification but the last is superseded.
    for (const attempt of [1, 2, 3])
      await client.callTool({ name: "navigate_page", arguments: { url: `${stale}?try=${attempt}` } });
    await settle();

    console.log(`[fast] strikes=${strikes().length} respawns=${respawns().length}`);
    console.log(`[fast] ${respawns()[0]?.trimEnd()}`);
    assert.ok(strikes().length >= 2, "the repeated stale page is judged, not silently dropped");
    assert.equal(respawns().length, 1, "so the wedge is still cured");
    const deadline = Date.now() + 10_000;
    while (childCount() === childrenBefore && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    const after = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(childSelected(after), "https://fast.example/moved", "fresh child, real page");
  } finally {
    await close();
  }
});
