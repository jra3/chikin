// Does chikin_achieve reach real goals on real pages, and how fast? (#103)
//
// Run it once per decider (CHIKIN_DECIDER_MODEL on the scratch gateway) to
// compare them: jev-latest, anthropic/claude-haiku-5.5, typesafe/jev-router.
//
// Usage: BASE=http://localhost:18096 node achieve.mjs [browser-name] [--suite basic|hard] [--only <name part>]
//
// The unit tests drive the loop with a scripted decider. Only a real decision
// model on real pages can say whether a fast model picking rows from the table
// gets there, so this needs a scratch gateway started WITH a key
// (-e CHIKIN_ANTHROPIC_API_KEY or CHIKIN_OPENROUTER_API_KEY; see README.md
// in this directory). It skips cleanly, exit 0, when the gateway reports
// `achieve: false`.
//
// Each goal starts from a navigate_page and makes ONE chikin_achieve call. It
// prints the trace, with decision and act time per step, and checks the outcome
// the goal should produce. The pizza form ends at a final submit, so it must
// come back needs_confirmation, which is the policy check, not a failure.
//
// Same cleanup rules as snapshot.mjs: inst-* names only, and only what this run
// created is removed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { SUITES } from "./achieve-goals.mjs";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "";
const NAME = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !["--suite", "--only"].includes(all[i - 1])) ?? "inst-achieve";
if (!/^inst-[a-z0-9-]+$/.test(NAME)) {
  console.error(`refusing to run against '${NAME}': only an inst-* name may be created and removed here`);
  process.exit(2);
}

const health = await (await fetch(`${BASE}/healthz`)).json();
if (!health.config?.achieve) {
  console.log(`SKIP  ${BASE} reports achieve: false (no CHIKIN_ANTHROPIC_API_KEY); nothing to measure`);
  process.exit(0);
}
console.log(`decision model: ${health.config.deciderModel}`);

const suiteArg = process.argv.indexOf("--suite");
const SUITE = suiteArg >= 0 ? process.argv[suiteArg + 1] : "basic";
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg >= 0 ? process.argv[onlyArg + 1] : null;
const GOALS = SUITES[SUITE]?.filter((g) => !ONLY || g.name.includes(ONLY));
if (!GOALS) {
  console.error(`unknown suite '${SUITE}'; known: ${Object.keys(SUITES).join(", ")}`);
  process.exit(2);
}
if (!GOALS.length) {
  console.error(`no goal in suite '${SUITE}' matches --only '${ONLY}'`);
  process.exit(2);
}

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
/** One fresh browser per goal, so one goal's side effects (a tab a link opened) never reach the next. */
async function openBrowser(name) {
  const existed = docker("ps", "-a", "--format", "{{.Names}}").split("\n").includes(`chikin-chrome-${name}`);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${name}/`), {
    requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
  });
  const client = new Client({ name: "itest-achieve", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await client.callTool({ name: "chikin_identify", arguments: { handle: name.replace(/^inst-/, "itest-") } });
  const close = async () => {
    try { await transport.terminateSession(); } catch {}
    try { await client.close(); } catch {}
    if (existed) return 0;
    let removed = 0;
    try { docker("rm", "-f", `chikin-chrome-${name}`); removed++; } catch {}
    try { docker("volume", "rm", `chikin-profile-${name}`); removed++; } catch {}
    return removed;
  };
  return { client, close };
}

let failures = 0;
const rows = [];
let n = 0;
let removed = 0;
{
  let client;
  const probe = async (body) => {
    const r = await client.callTool({ name: "evaluate_script", arguments: { function: `() => { ${body} }` } });
    const m = /```json\n([\s\S]*?)\n```/.exec(textOf(r));
    return m ? JSON.parse(m[1]) : undefined;
  };
  const call = (name, args) => client.callTool({ name, arguments: args });
  for (const g of GOALS) {
    console.log(`\n=== ${g.name}${g.limit ? `  (expected limit: ${g.limit})` : ""}`);
    let browser;
    let sc = {};
    let steps = [];
    let ms = 0;
    let ok = false;
    try {
      browser = await openBrowser(`${NAME}-${++n}`);
      client = browser.client;
      await call("navigate_page", { type: "url", url: g.start });
      // A slow site (the-internet on Heroku took ~30 s cold) can outlast
      // navigate_page's own 10 s timeout. Wait for a readable page before the
      // goal's clock starts, so a goal measures the loop, not the site's
      // cold start.
      for (const t0 = Date.now(); Date.now() - t0 < 45_000; ) {
        const s = await call("chikin_snapshot", {});
        if (!s.isError && (await probe("return document.readyState;")) === "complete") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (g.setup) {
        await g.setup({ probe, call });
        await new Promise((r) => setTimeout(r, 1500));
      }
      const t0 = performance.now();
      const r = await client.callTool(
        { name: "chikin_achieve", arguments: { goal: g.goal, max_steps: 25, max_seconds: 180 } },
        CallToolResultSchema,
        { timeout: 200_000, resetTimeoutOnProgress: true, onprogress: (p) => console.log(`      ${p.message}`) },
      );
      ms = Math.round(performance.now() - t0);
      sc = r.structuredContent ?? {};
      steps = sc.steps ?? [];
      console.log(`      -> ${textOf(r).split("\n")[0]}`);
      const verified = await g.check({ url: sc.url ?? "", status: sc.status, proposed: sc.proposed, probe }).catch(() => false);
      ok = sc.status === g.want && verified;
      if (g.cleanup) await g.cleanup({ probe, call });
    } catch (e) {
      console.log(`      !! ${String(e?.message ?? e).slice(0, 200)}`);
    } finally {
      if (browser) removed += await browser.close();
    }
    const verdict = ok ? "PASS" : g.limit ? "LIMIT" : "FAIL";
    if (verdict === "FAIL") failures++;
    console.log(`${verdict}  ${g.name}: ${sc.status ?? "no result"} (wanted ${g.want}), final url ${sc.url ?? "?"}`);
    const decide = steps.map((s) => s.decide_ms).filter((x) => x > 0).sort((a, b) => a - b);
    rows.push({
      goal: g.name,
      verdict,
      status: sc.status ?? "-",
      steps: steps.length,
      "total ms": ms,
      "median decide ms": decide.length ? decide[Math.floor(decide.length / 2)] : null,
    });
  }
  console.table(rows);
  console.log(`removed ${removed} browser container(s) and profile volume(s) this run created`);
}
console.log(failures ? `\n${failures} goal(s) missed (expected limits excluded)` : "\nall goals reached their expected outcome (expected limits excluded)");
process.exit(failures ? 1 : 0);
