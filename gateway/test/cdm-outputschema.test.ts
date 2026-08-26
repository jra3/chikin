import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The wire-level guard issue #75 asked for.
 *
 * `cdm-format.test.ts` renders replies through the vendored formatter, and the
 * formatter genuinely returns `structuredContent.pages` — which is exactly what
 * made #72 believe structured output was the watchdog's authoritative channel.
 * It is not. The MCP SDK strips `structuredContent` from a tool result whose
 * tool registered no `outputSchema`, and chrome-devtools-mcp registers none, so
 * the object dies inside the child and the gateway only ever sees
 * `content[].text`. Nothing that reads the formatter's return value can see
 * that; only the wire can.
 *
 * So this test talks to the real binary over stdio and asserts the property the
 * stripping follows from. It deliberately does NOT need a browser:
 * chrome-devtools-mcp resolves its browser connection inside the tool handler,
 * so `initialize` and `tools/list` are served against a dead `--browserUrl` —
 * the same property the gateway's lazy provisioning relies on (issue #63).
 *
 * If upstream ever registers an `outputSchema`, this fails. That is the point:
 * the inert structured branch in `bridge.ts` would become live, and the failure
 * is the notification.
 */

const require = createRequire(import.meta.url);
const BIN = path.join(
  path.dirname(require.resolve("chrome-devtools-mcp/package.json")),
  "build/src/bin/chrome-devtools-mcp.js",
);

// Unroutable on purpose: no browser is needed, and a black-holed address would
// hang instead of failing fast if a handler ever did try to connect.
const DEAD_BROWSER_URL = "http://127.0.0.1:1";

interface ToolsListResult {
  tools: Array<{ name: string; outputSchema?: unknown }>;
}

/** Drive a real chrome-devtools-mcp over stdio and return its `tools/list`. */
async function toolsListOverStdio(): Promise<ToolsListResult> {
  const child = spawn(process.execPath, [BIN, "--browserUrl", DEAD_BROWSER_URL], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));

  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  const replies = new Map<number, unknown>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += String(d);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      let msg: { id?: number; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // the child logs non-JSON on stdout in some versions
      }
      if (typeof msg.id === "number") replies.set(msg.id, msg.result);
    }
  });

  const waitFor = async (id: number, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!replies.has(id)) {
      if (child.exitCode !== null)
        throw new Error(`child exited (${child.exitCode}) before ${what}: ${stderr.join("")}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
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
        clientInfo: { name: "chikin-wire-probe", version: "0.0.0" },
      },
    });
    await waitFor(1, "initialize");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    return (await waitFor(2, "tools/list")) as ToolsListResult;
  } finally {
    child.kill("SIGKILL");
  }
}

test("chrome-devtools-mcp registers no outputSchema, so structuredContent never reaches us", async () => {
  const result = await toolsListOverStdio();
  const tools = result?.tools;
  assert.ok(Array.isArray(tools) && tools.length > 0, "the child served a non-empty tool list");

  // Pin the tool the watchdog actually judges, so an upstream rename fails here
  // rather than quietly retiring the assertion below.
  assert.ok(
    tools.some((t) => t.name === "navigate_page"),
    `navigate_page is gone from the tool list: ${tools.map((t) => t.name).join(", ")}`,
  );

  const withSchema = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);
  assert.deepEqual(
    withSchema,
    [],
    "upstream now registers an outputSchema — structuredContent reaches the gateway, so the " +
      "structured branch in bridge.ts is live and should be promoted back over the text parse",
  );
});
