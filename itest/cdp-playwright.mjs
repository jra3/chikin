// Does Playwright actually drive a fleet browser over the CDP lane? (#87)
//
// Usage: node cdp-playwright.mjs [browser-name]
//
// gateway/test/cdp.test.ts proves the lane's wiring against a fake Chrome: the
// rewrite, the guards, the upgrade, the bookkeeping. What it cannot prove is
// the claim the feature is actually for — that a real Playwright, speaking the
// real protocol to a real Chrome, gets a working browser through this gateway
// with the golden profile behind it. That claim needs all three, so it lives
// here.
//
// Run it against a SCRATCH gateway, not the live fleet (itest/README): it
// provisions one real browser and removes nothing that was already there.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "";
const NAME = process.argv[2] ?? "inst-pwcheck";
const ENDPOINT = `${BASE}/cdp/${NAME}/`;
const CONTAINER = `chikin-chrome-${NAME}`;
const VOLUME = `chikin-profile-${NAME}`;

// This script ends in `docker rm -f` and `docker volume rm -f`, so it may only
// ever be pointed at a disposable name. A chikin profile volume is disposable
// by NAME (isInstanceName in gateway/src/config.ts, issues #58/#59): `golden`,
// `hermes` and every named client profile hold hand-authenticated logins whose
// only other copy is an unlabelled snapshot volume. Refuse before provisioning,
// not before cleaning up — a sticky name has no business on this script at all.
if (!NAME.startsWith("inst-") || NAME === "inst-") {
  console.error(`FAIL  refusing to run against '${NAME}': this script only drives disposable inst-* names.`);
  console.error("      It removes the browser and profile volume it creates, and a sticky profile");
  console.error("      (golden, hermes, a named client) must never be a candidate for that.");
  process.exit(2);
}

// playwright-core is a devDependency of the GATEWAY (itest/ has no package.json
// of its own), and a bare specifier is resolved from this file's own directory
// upwards — which never reaches gateway/node_modules. Resolve from there
// explicitly, and after the name guard above, so a refusal never depends on a
// module being installed.
const fromGateway = createRequire(new URL("../gateway/", import.meta.url));
const { chromium } = fromGateway("playwright-core");

const docker = (args) => {
  try {
    execFileSync("docker", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Remove only what this run made. An inst-* name the operator is already using
// for something else is still somebody's browser.
const preexisting = {
  container: docker(["container", "inspect", CONTAINER]),
  volume: docker(["volume", "inspect", VOLUME]),
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined;

// A cold provision runs to PROVISION_TIMEOUT_SEC (90s by default), well past
// Playwright's 30s connect default — the same wait bin/chikin-pw absorbs.
const browser = await chromium.connectOverCDP(ENDPOINT, { timeout: 150_000, headers });

try {
  check("connectOverCDP reaches a fleet browser through /cdp/<name>/", true, browser.version());

  // The golden profile is the DEFAULT context. newContext() would hand back a
  // logged-out one, which is the single sharpest edge on this lane.
  const contexts = browser.contexts();
  check("the browser exposes its persistent context", contexts.length > 0, `${contexts.length} context(s)`);
  const context = contexts[0];

  const page = await context.newPage();
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const title = await page.title();
  check("a page navigates and reports its title", /example domain/i.test(title), title);

  // Real Chrome, not Playwright's bundled Chromium, and headful under Xvfb —
  // the posture the whole fleet exists for. A headless build says "HeadlessChrome".
  const ua = await page.evaluate(() => navigator.userAgent);
  check("the browser is real, headful Chrome", /Chrome\//.test(ua) && !/Headless/.test(ua), ua);

  // The lane is visible as a lane: the dashboard names the CDP driver rather
  // than showing the browser as unheld.
  const dash = await fetch(`${BASE}/`).then((r) => r.text());
  const row = dash.includes(`>${NAME}<`);
  check("the dashboard lists the browser", row);
  check("the dashboard marks it as CDP-driven", dash.includes("yes (cdp)"));

  // One driver at a time: MCP must refuse a browser this script is holding.
  const mcp = await fetch(`${BASE}/b/${NAME}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "itest-cdp", version: "0.0.0" },
      },
    }),
  });
  check("an MCP session is refused while a CDP driver holds the browser", mcp.status === 409, `HTTP ${mcp.status}`);

  await page.close();
} finally {
  await browser.close();
}

// Closing the driver must release the browser, or nothing ever reaps it. The
// gateway learns this from the socket, so give it a beat.
await new Promise((r) => setTimeout(r, 1000));
const dashAfter = await fetch(`${BASE}/`).then((r) => r.text());
const stillHeld = dashAfter.includes("yes (cdp)");
check(
  "closing the driver releases the browser",
  !stillHeld,
  stillHeld ? "the dashboard still shows a CDP driver attached" : "no CDP driver on the dashboard",
);

// Leave the fleet as we found it — which means removing what this run created
// and nothing else.
for (const [what, args, ours] of [
  [CONTAINER, ["rm", "-f", CONTAINER], !preexisting.container],
  [VOLUME, ["volume", "rm", "-f", VOLUME], !preexisting.volume],
]) {
  if (!ours) {
    console.log(`note: ${what} was already here before this run — leaving it alone`);
    continue;
  }
  if (!docker(args)) console.log(`note: could not remove ${what}; remove it by hand`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
