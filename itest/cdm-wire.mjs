// What does chrome-devtools-mcp actually put ON THE WIRE? (issue #75)
//
// Usage: node cdm-wire.mjs [browser-name]
//
// The nav watchdog judges a wedge from the child's own reply, so it depends on
// that reply's shape. Every test that came before this one read the shape from
// the vendored formatter — and the formatter LIES about the channel: it returns
// `structuredContent.pages`, but the MCP SDK strips structuredContent from a
// tool result whose tool registered no `outputSchema`, and chrome-devtools-mcp
// registers none. So the gateway only ever sees `content[].text`, and the text
// parse is the sole working channel. A whole suite passed 154/154 while the
// watchdog was blind in production because of that gap.
//
// This closes it end to end: a REAL browser, the REAL binary over stdio, a REAL
// navigation, and the gateway's own `reportedPages` run against the bytes that
// actually crossed. `gateway/test/cdm-outputschema.test.ts` pins the cause
// (no outputSchema is registered) without needing a browser; this pins the
// consequence.
//
// Requires a built gateway (`cd ../gateway && npm run build`) and a running
// fleet, like the other harnesses here.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { reportedPages } from "../gateway/dist/src/bridge.js";

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

const require = createRequire(import.meta.url);
// CDM_BIN points this at a build other than the pinned one, which is the whole
// point of the harness: run it against a candidate BEFORE taking the bump. The
// text block is the watchdog's only channel, so a version that restyles it
// blinds the watchdog, and that is invisible to every test that does not spawn
// the real binary.
const BIN =
  process.env.CDM_BIN ??
  path.join(
    path.dirname(require.resolve("chrome-devtools-mcp/package.json")),
    "build/src/bin/chrome-devtools-mcp.js",
  );

/** Drive the real binary against a real browser and return the raw tool result. */
async function navigateOverStdio(browserUrl) {
  const child = spawn(process.execPath, [BIN, "--browserUrl", browserUrl], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));

  const replies = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += String(d);
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") replies.set(msg.id, msg.result);
      } catch {}
    }
  });

  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = async (id, what) => {
    const deadline = Date.now() + 60_000;
    while (!replies.has(id)) {
      if (child.exitCode !== null)
        throw new Error(`child exited (${child.exitCode}) before ${what}: ${stderr.join("")}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${stderr.join("")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return replies.get(id);
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "itest-cdmwire", version: "0.0.0" },
      },
    });
    await waitFor(1, "initialize");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "navigate_page", arguments: { type: "url", url: TARGET } },
    });
    return await waitFor(2, "navigate_page");
  } finally {
    child.kill("SIGKILL");
  }
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
  const cdmVersion = require(path.join(path.dirname(path.dirname(path.dirname(path.dirname(BIN)))), "package.json")).version;
  console.log(`browser ${NAME} ${NET}=${ip}  ${version["Browser"]}  chrome-devtools-mcp/${cdmVersion}`);

  const result = await navigateOverStdio(`http://${ip}:9222`);
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log("--- reply text ---\n" + text + "\n------------------");

  // The #75 finding itself, asserted live rather than argued from source. If
  // upstream registers an outputSchema this flips — promote the structured
  // branch in bridge.ts back over the text parse, don't delete this check.
  check(
    "structuredContent does NOT survive the wire (no outputSchema upstream)",
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
