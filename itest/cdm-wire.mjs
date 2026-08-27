// What does chrome-devtools-mcp actually put ON THE WIRE? (issue #75)
//
// Usage: node cdm-wire.mjs [browser-name]
//
// The nav watchdog judges a wedge from the child's own reply, so it depends on
// that reply's shape. Every test that came before this one read the shape from
// the vendored formatter — and the formatter LIES about the channel: it returns
// `structuredContent.pages`, but the child's ToolHandler copies that onto the
// tool result only when `--experimentalStructuredContent` is set, and the
// `chrome-devtools-mcp` binary leaves that flag off (only the sibling
// `chrome-devtools` CLI turns it on; the MCP SDK strips nothing). So under the
// flags the gateway spawns with, it only ever sees `content[].text` and the text
// parse is the sole working channel. A whole suite passed 154/154 while the
// watchdog was blind in production because of that gap.
//
// This closes it end to end: a REAL browser, the REAL binary over stdio, a REAL
// navigation, and the gateway's own `reportedPages` run against the bytes that
// actually crossed. Only a live tool call can see whether structuredContent
// rides the reply, which is why the channel is asserted HERE;
// `gateway/test/cdm-outputschema.test.ts` is the browser-free CI tripwire on
// upstream's tool declarations.
//
// Requires a built gateway (`cd ../gateway && npm run build`) and a running
// fleet, like the other harnesses here.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { reportedPages } from "../gateway/dist/src/bridge.js";
import { resolveCdmBin, withCdmStdio } from "../gateway/dist/test/cdm-stdio.js";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "testtoken-abc123";
const NAME = process.argv[2] ?? "inst-cdmwire";
const NET = process.env.CHIKIN_NETWORK ?? "chikin-net";
const TARGET = "https://example.com/";

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

/** Provision a real browser through the gateway, the way a client would. */
async function open(name, handle) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${name}/`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "itest-cdmwire", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await call(client, "chikin_identify", { handle });
  // First browser tool call provisions the container (#63).
  await call(client, "new_page", { url: TARGET });
  return { client, transport };
}

// CDM_BIN points this at a build other than the pinned one, which is the whole
// point of the harness: run it against a candidate BEFORE taking the bump. The
// text block is the watchdog's only channel, so a version that restyles it
// blinds the watchdog, and that is invisible to every test that does not spawn
// the real binary. Nothing below may assume where that build keeps its files.
const BIN = resolveCdmBin(process.env.CDM_BIN);

/** Drive the real binary against a real browser and return the raw tool result. */
function navigateOverStdio(browserUrl) {
  return withCdmStdio(
    { bin: BIN, browserUrl, clientName: "itest-cdmwire", timeoutMs: 60_000 },
    async (cdm) => {
      // The build's own report of itself over the wire — the only version
      // string that stays true for a relocated or bundled candidate.
      console.log(`chrome-devtools-mcp/${cdm.serverInfo.version ?? "unknown"}  (${BIN})`);
      return cdm.call("tools/call", {
        name: "navigate_page",
        arguments: { type: "url", url: TARGET },
      });
    },
  );
}

const session = await open(NAME, "itest-cdmwire");

try {
  const ip = docker(
    "inspect",
    `chikin-chrome-${NAME}`,
    "--format",
    `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
  );
  const version = await (await fetch(`http://${ip}:9222/json/version`)).json();
  console.log(`browser ${NAME} ${NET}=${ip}  ${version["Browser"]}`);

  const result = await navigateOverStdio(`http://${ip}:9222`);
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log("--- reply text ---\n" + text + "\n------------------");

  // The #75 finding itself, asserted live rather than argued from source. This
  // spawns the child the way the gateway does, with no extra flags, so it reads
  // the DEFAULT channel: pass --experimentalStructuredContent (as CDM_EXTRA_ARGS
  // may) and the object arrives, which is the supported way to flip this. If it
  // ever arrives unasked, promote the structured branch in bridge.ts back over
  // the text parse — don't delete this check.
  check(
    "structuredContent stays off the wire without --experimentalStructuredContent",
    result?.structuredContent === undefined,
    result?.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent),
  );

  check("the reply carries a '## Pages' block", /^##\s+Pages\s*$/m.test(text));

  // THE assertion. Blindness is the failure mode that shipped: the parse
  // returned no selection, navVerdict read "unknown", and the watchdog never
  // struck while looking perfectly healthy.
  const reported = reportedPages(result);
  check("the gateway's parser finds pages in the real reply", Boolean(reported?.pages?.length),
    JSON.stringify(reported));
  check(
    "the gateway's parser marks a SELECTED page — the watchdog is not blind",
    Boolean(reported?.selected),
    `parsed ${JSON.stringify(reported)} from the block above`,
  );
  check(
    "the selected page is a URL, not a fragment of a page title",
    /^[a-z][a-z0-9+.-]*:/i.test(reported?.selected ?? ""),
    String(reported?.selected),
  );
} finally {
  try { await session.transport.terminateSession?.(); } catch {}
  try { await session.client.close(); } catch {}
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
