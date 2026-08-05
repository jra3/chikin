// Can a browser reach the gateway? (CHK-002 / issue #20)
//
// Usage: node gateway-reachability.mjs [browser-name]
//
// The unit tests in gateway/test/bind.test.ts prove the gateway *computed* a
// listen set that excludes the browser data plane. They cannot prove Chrome in
// a container can no longer open :8080 — that is a different claim, and it is
// the one that matters. This asserts it from INSIDE a real browser.
//
// It also asserts the residual we knowingly accepted (docs/adr/0003): peer
// browsers can still drive each other over CDP :9222 and noVNC :6080, because
// seeding clones the golden profile into every browser and they are therefore
// not separate identities. If someone later closes that gap with per-name
// networks, the EXPECTED_PEER_REACHABLE assertions below start failing — which
// is the point. Flip them, don't delete them.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "testtoken-abc123";
const NAME = process.argv[2] ?? "inst-reachcheck";
const NET = process.env.CHIKIN_NETWORK ?? "chikin-net";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

async function call(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  if (res?.isError) throw new Error(`${tool}: ${textOf(res).trim()}`);
  return res;
}

/**
 * Reachability, judged from inside the page. fetch() cannot read a cross-origin
 * response, but it does not need to: a reachable port RESOLVES (opaque under
 * no-cors, or a CORS error after a completed connection), while an unreachable
 * one REJECTS with a network error. That is a binary signal and it does not
 * depend on parsing anything. A short AbortController keeps a filtered/dropped
 * packet from hanging the whole run — a timeout counts as unreachable, which is
 * the correct reading for a DROP rule.
 */
const probe = (url) => `async () => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 4000);
  try {
    await fetch(${JSON.stringify(url)}, { mode: "no-cors", signal: c.signal });
    return "REACHABLE";
  } catch (e) {
    return e.name === "AbortError" ? "TIMEOUT" : "UNREACHABLE";
  } finally {
    clearTimeout(t);
  }
}`;

const PEER = `${NAME}-peer`.slice(0, 32).replace(/-+$/, "");

async function open(name, handle) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${name}/`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "itest-reach", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await call(client, "chikin_identify", { handle });
  // First browser tool call provisions the container (#63).
  await call(client, "new_page", { url: "https://example.com/" });
  return { client, transport };
}

/**
 * The probing page's ORIGIN decides whether the probes can run at all, and
 * getting this wrong makes the whole test lie. From an https://example.com page
 * every http:// probe is blocked as mixed content before a packet moves, so
 * EVERYTHING reads UNREACHABLE — including ports verifiably reachable by curl
 * from the host, which is how this was caught. Chrome's Private Network Access
 * rules bite the same way: a public-origin page may not reach private IPs.
 *
 * So probe from the browser's OWN noVNC endpoint on its own container IP: an
 * http origin on a private address. Private->private, no scheme downgrade.
 */
async function probeFrom(client, ownIp) {
  await call(client, "new_page", { url: `http://${ownIp}:6080/` });
}

const ipOf = (container) =>
  docker(
    "inspect",
    container,
    "--format",
    `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
  );

// Two REAL browsers: the peer assertions below are about what one browser can
// reach on ANOTHER, so probing a browser's own ports would prove the wrong
// thing (that a port is bound, not that a peer can cross to it).
const a = await open(NAME, "itest-reachcheck");
const b = await open(PEER, "itest-reachpeer");
const client = a.client;

try {
  const gwIp = ipOf("chikin-gateway");
  const peerIp = ipOf(`chikin-chrome-${PEER}`);
  const ownIp = ipOf(`chikin-chrome-${NAME}`);
  console.log(`gateway ${NET}=${gwIp}   prober ${NET}=${ownIp}   peer ${NET}=${peerIp}`);
  await probeFrom(client, ownIp);

  const reach = async (url) =>
    JSON.parse(
      textOf(await call(client, "evaluate_script", { function: probe(url) })).match(
        /```json\s*([\s\S]*?)```/,
      )[1],
    );

  // THE property: the gateway's MCP/dashboard port is not listening on the
  // interface this browser can reach. Unreachable OR timeout both mean closed.
  const gw = await reach(`http://${gwIp}:8080/healthz`);
  check("gateway :8080 is NOT reachable from inside a browser", gw !== "REACHABLE", gw);

  // Controls. Without these an UNREACHABLE above is meaningless — it could just
  // mean the probing page is not allowed to make the request at all, which is
  // exactly the bug that made the first version of this test report four
  // confident, wrong answers. The peer probes below double as the positive
  // control for private-IP http reachability.
  const own = await reach(`http://${ownIp}:6080/`);
  check("control: the prober can reach its own :6080 (probe mechanism works)", own === "REACHABLE", own);

  // The accepted residual (docs/adr/0003). Asserted as REACHABLE on purpose:
  // this is the gap we chose not to close, and it should fail loudly the day
  // someone closes it rather than silently drifting out of the docs.
  const cdp = await reach(`http://${peerIp}:9222/json/version`);
  check("EXPECTED_PEER_REACHABLE: a peer browser's CDP :9222 is reachable", cdp === "REACHABLE", cdp);
  const vnc = await reach(`http://${peerIp}:6080/`);
  check("EXPECTED_PEER_REACHABLE: a peer browser's noVNC :6080 is reachable", vnc === "REACHABLE", vnc);
} finally {
  for (const s of [a, b]) {
    try { await s.transport.terminateSession?.(); } catch {}
    try { await s.client.close(); } catch {}
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
