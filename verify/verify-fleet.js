#!/usr/bin/env node
// Fleet-native non-headless verification.
//
// The fleet never exposes Chrome's CDP to the host (by design), so the CDP path
// in verify.js can't reach a fleet browser. Instead we drive a browser THROUGH
// the gateway over MCP — provision a browser by name, navigate, and evaluate the
// SAME probe (probe.js) via the chrome-devtools-mcp `evaluate_script` tool. The
// pass/fail interpretation and output format are shared with the CDP path.
//
// Usage:
//   node verify-fleet.js [--gateway URL] [--name NAME] [--url PAGE] [--json]
//   CHIKIN_TOKEN=... node verify-fleet.js         # if the gateway requires auth
//
// Exit codes mirror verify.js: 0 all required pass · 1 a required check failed
// · 2 couldn't connect to the gateway · 3 unexpected error.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { interpretProbe, PROBE_EXPRESSION } from "./probe.js";
import { formatPretty, formatJson } from "./format.js";

const SANNYSOFT_URL = "https://bot.sannysoft.com";

// Scrapes the bot.sannysoft.com results table into [{label, result}] rows.
const SCRAPE_EXPRESSION = `
  (() => {
    const rows = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      if (cells.length >= 2) {
        rows.push({ label: cells[0].innerText.trim(), result: cells[1].innerText.trim() });
      }
    });
    return rows;
  })()
`;

function parseArgs(argv) {
  const a = {
    gateway: "http://localhost:8080",
    name: "verify",
    // A data: document needs no egress, so verify works offline. navigator.*,
    // plugins, and WebGL are all available on it.
    url: "data:text/html,<title>chikin%20verify</title>",
    json: false,
    sannysoft: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--json") a.json = true;
    else if (v === "--sannysoft") a.sannysoft = true;
    else if (v === "--gateway") a.gateway = argv[++i];
    else if (v === "--name") a.name = argv[++i];
    else if (v === "--url") a.url = argv[++i];
    else {
      console.error(`unknown argument: ${v}`);
      process.exit(3);
    }
  }
  return a;
}

// The MCP tool returns its result as text content. chrome-devtools-mcp wraps the
// evaluated value; pull the JSON object out of whatever prose surrounds it.
function extractJson(result) {
  const text = (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  // A tool that errored (e.g. the identify gate blocking a premature browser
  // call) can carry braces in its message — don't silently misparse that as the
  // probe value. Surface it so the failure is obvious, not undefined-everywhere.
  if (result?.isError) {
    throw new Error(`tool call returned an error result:\n${text}`);
  }
  // chrome-devtools-mcp wraps the value in a ```json … ``` fence; fall back to
  // brace/bracket matching. Handles both objects (probe) and arrays (scrape).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON in evaluate_script result:\n${text}`);
  }
  return JSON.parse(body.slice(start, end + 1));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.gateway.replace(/\/+$/, "");
  const url = new URL(`${base}/b/${args.name}/`);

  const token = process.env.CHIKIN_TOKEN;
  const opts = token
    ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
    : undefined;

  const client = new Client({ name: "chikin-verify-fleet", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, opts));
  } catch (e) {
    console.error(`could not connect to the gateway at ${url}: ${e.message}`);
    console.error("is the fleet up? try: docker compose ps  (and curl -s " + base + "/healthz)");
    process.exit(2);
  }

  try {
    // The gateway blocks every browser tool until the session identifies itself
    // (chikin_identify). Do that first, on THIS session, before any navigate.
    const ident = await client.callTool({
      name: "chikin_identify",
      arguments: { handle: args.name, description: "fleet non-headless verification" },
    });
    if (ident?.isError) {
      const text = (ident.content ?? []).map((c) => c.text ?? "").join("\n");
      console.error(`chikin_identify failed: ${text}`);
      process.exit(3);
    }

    // Provision + land on a real document so evaluate_script has a selected page.
    await client.callTool({ name: "navigate_page", arguments: { type: "url", url: args.url } });

    const raw = extractJson(
      await client.callTool({
        name: "evaluate_script",
        // Arrow implicit-return (not `return <expr>`): PROBE_EXPRESSION starts
        // with a newline, and `return\n(...)` would ASI to `return;` (undefined).
        arguments: { function: `() => (${PROBE_EXPRESSION})` },
      }),
    );

    const rows = interpretProbe(raw);

    let sannysoft = null;
    if (args.sannysoft) {
      await client.callTool({
        name: "navigate_page",
        arguments: { type: "url", url: SANNYSOFT_URL },
      });
      await new Promise((r) => setTimeout(r, 3000)); // let async fingerprint tests settle
      sannysoft = extractJson(
        await client.callTool({
          name: "evaluate_script",
          arguments: { function: `() => (${SCRAPE_EXPRESSION})` },
        }),
      );
    }

    const result = { rows, sannysoft };
    console.log(args.json ? formatJson(result) : formatPretty(result));

    const required = rows.filter((r) => r.required);
    process.exit(required.every((r) => r.status === "pass") ? 0 : 1);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(3);
});
