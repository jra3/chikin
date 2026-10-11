// Is chikin_snapshot smaller and faster than take_snapshot on a real page? (#96)
//
// Usage: GATEWAY_TOKEN=… node snapshot.mjs [browser-name] [url ...]
//        BASE=http://localhost:8081 node snapshot.mjs inst-snap1 https://news.ycombinator.com/
//
// The unit tests prove the read works against a fake Chrome. Only a real page
// can say whether the indexed table is worth reading INSTEAD of upstream's
// accessibility snapshot — which is the evidence #95 waits on before the act
// and loop slices are built. So this provisions one real browser through the
// gateway, navigates it to each URL, calls both tools several times each, and
// prints bytes, an approximate token count, and wall time per call.
//
// Tokens are approximated at 4 bytes per token; good enough for a ratio.
// Latency includes the MCP round trip for both, so they are comparable.
//
// Like cdp-playwright.mjs it refuses a name that is not `inst-*`, and removes
// the container and volume IT created, leaving anything already there alone.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "";
const NAME = process.argv[2] ?? "inst-snapmeasure";
const URLS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["https://example.com/", "https://news.ycombinator.com/", "https://en.wikipedia.org/wiki/Main_Page"];
const ROUNDS = Number(process.env.ROUNDS ?? 3);

if (!/^inst-[a-z0-9-]+$/.test(NAME)) {
  console.error(`refusing to run against '${NAME}': only an inst-* name may be created and removed here`);
  process.exit(2);
}

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const tokens = (s) => Math.round(Buffer.byteLength(s, "utf8") / 4);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function call(client, tool, args) {
  const t0 = performance.now();
  const res = await client.callTool({ name: tool, arguments: args });
  const ms = performance.now() - t0;
  if (res?.isError) throw new Error(`${tool}: ${textOf(res).trim()}`);
  return { res, ms, text: textOf(res) };
}

const existedBefore = docker("ps", "-a", "--format", "{{.Names}}").split("\n").includes(`chikin-chrome-${NAME}`);
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${NAME}/`), {
  requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
});
const client = new Client({ name: "itest-snapshot", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

let failures = 0;
try {
  await call(client, "chikin_identify", { handle: "itest-snapshot" });
  const rows = [];
  for (const url of URLS) {
    await call(client, "navigate_page", { type: "url", url });
    // Let the page settle once, outside the measurement, so neither tool pays for it.
    await new Promise((r) => setTimeout(r, 1500));
    const upstream = [];
    const ours = [];
    let snapshot;
    for (let i = 0; i < ROUNDS; i++) {
      const a = await call(client, "take_snapshot", {});
      upstream.push({ ms: a.ms, tokens: tokens(a.text) });
      const b = await call(client, "chikin_snapshot", {});
      ours.push({ ms: b.ms, tokens: tokens(b.text) });
      snapshot = b;
    }
    const sc = snapshot.res.structuredContent ?? {};
    const ok = Array.isArray(sc.actions) && sc.actions.length > 0 && sc.page?.url;
    if (!ok) failures++;
    rows.push({
      url,
      "page read": sc.page?.url === url || (sc.page?.url ?? "").startsWith(url) ? "ok" : `MISMATCH ${sc.page?.url}`,
      controls: sc.actions?.length ?? 0,
      "take_snapshot tok": median(upstream.map((x) => x.tokens)),
      "chikin_snapshot tok": median(ours.map((x) => x.tokens)),
      "take_snapshot ms": Math.round(median(upstream.map((x) => x.ms))),
      "chikin_snapshot ms": Math.round(median(ours.map((x) => x.ms))),
    });
    console.log(`\n--- chikin_snapshot on ${url} (first 25 lines) ---`);
    console.log(snapshot.text.split("\n").slice(0, 25).join("\n"));
  }
  console.log(`\nmedians over ${ROUNDS} rounds each (tokens ≈ bytes/4, ms = full MCP round trip)`);
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
console.log(failures ? `\n${failures} page(s) produced no action table` : "\nall pages produced an action table");
process.exit(failures ? 1 : 0);
