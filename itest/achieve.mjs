// Does chikin_achieve reach real goals on real pages, and how fast? (#103)
//
// Usage: BASE=http://localhost:18096 node achieve.mjs [browser-name]
//
// The unit tests drive the loop with a scripted decider. Only a real decision
// model on real pages can say whether a fast model picking rows from the table
// gets there, so this needs a scratch gateway started WITH a key
// (-e CHIKIN_ANTHROPIC_API_KEY=...; see README.md in this directory). It skips
// cleanly, exit 0, when the gateway reports `achieve: false`.
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

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "";
const NAME = process.argv[2] ?? "inst-achieve";
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

const GOALS = [
  {
    start: "https://en.wikipedia.org/wiki/Main_Page",
    goal: 'Search Wikipedia for "Alan Turing" and open his article.',
    expect: (r) => r.status === "done" && /Alan_Turing/.test(r.url ?? ""),
  },
  {
    start: "https://news.ycombinator.com/",
    goal: 'Open the "past" page of Hacker News.',
    expect: (r) => r.status === "done" && /\/front/.test(r.url ?? ""),
  },
  {
    start: "https://httpbin.org/forms/post",
    goal: 'Order a pizza: customer name "Ada Test", telephone "555-0100", size Medium, topping Bacon, then submit the order.',
    expect: (r) => r.status === "needs_confirmation",
  },
];

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const existedBefore = docker("ps", "-a", "--format", "{{.Names}}").split("\n").includes(`chikin-chrome-${NAME}`);
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${NAME}/`), {
  requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
});
const client = new Client({ name: "itest-achieve", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

let failures = 0;
const rows = [];
try {
  await client.callTool({ name: "chikin_identify", arguments: { handle: "itest-achieve" } });
  for (const g of GOALS) {
    await client.callTool({ name: "navigate_page", arguments: { type: "url", url: g.start } });
    const t0 = performance.now();
    const r = await client.callTool(
      { name: "chikin_achieve", arguments: { goal: g.goal, max_steps: 20, max_seconds: 180 } },
      CallToolResultSchema,
      { timeout: 200_000, resetTimeoutOnProgress: true, onprogress: (p) => console.log(`      ${p.message}`) },
    );
    const ms = Math.round(performance.now() - t0);
    const sc = r.structuredContent ?? {};
    const steps = sc.steps ?? [];
    const decide = steps.map((s) => s.decide_ms).filter((x) => x > 0);
    const ok = g.expect({ status: sc.status, url: sc.url });
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${g.goal}\n      -> ${textOf(r).split("\n")[0]}\n      final url: ${sc.url}`);
    rows.push({
      goal: g.goal.slice(0, 40),
      status: sc.status,
      steps: steps.length,
      "total ms": ms,
      "median decide ms": decide.length ? decide.sort((a, b) => a - b)[Math.floor(decide.length / 2)] : null,
    });
  }
  console.table(rows);
} finally {
  try { await transport.terminateSession(); } catch {}
  try { await client.close(); } catch {}
  if (!existedBefore) {
    try { docker("rm", "-f", `chikin-chrome-${NAME}`); } catch {}
    try { docker("volume", "rm", `chikin-profile-${NAME}`); } catch {}
    console.log(`removed chikin-chrome-${NAME} and chikin-profile-${NAME} (created by this run)`);
  }
}
console.log(failures ? `\n${failures} goal(s) missed` : "\nall goals reached their expected outcome");
process.exit(failures ? 1 : 0);
