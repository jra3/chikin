import test from "node:test";
import assert from "node:assert/strict";
import { NAV_TOOLS } from "../src/bridge.js";
import { withCdmStdio } from "./cdm-stdio.js";

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
 * If upstream ever registers an `outputSchema` ON A TOOL THE WATCHDOG PARSES,
 * this fails. That is the point: the inert structured branch in `bridge.ts`
 * would become live, and the failure is the notification. A schema anywhere
 * else is reported and waved through — it changes nothing about the watchdog,
 * and must not block a version bump.
 */

// Unroutable on purpose: no browser is needed, and a black-holed address would
// hang instead of failing fast if a handler ever did try to connect.
const DEAD_BROWSER_URL = "http://127.0.0.1:1";

interface ToolsListResult {
  tools: Array<{ name: string; outputSchema?: unknown }>;
}

test("chrome-devtools-mcp registers no outputSchema on the tools the watchdog reads", async () => {
  const result = (await withCdmStdio(
    { browserUrl: DEAD_BROWSER_URL, clientName: "chikin-wire-probe", timeoutMs: 30_000 },
    (session) => session.call("tools/list"),
  )) as ToolsListResult;

  const tools = result?.tools;
  assert.ok(Array.isArray(tools) && tools.length > 0, "the child served a non-empty tool list");

  // Pin the tool the watchdog actually judges, so an upstream rename fails here
  // rather than quietly retiring the assertion below.
  assert.ok(
    tools.some((t) => t.name === "navigate_page"),
    `navigate_page is gone from the tool list: ${tools.map((t) => t.name).join(", ")}`,
  );

  const withSchema = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);

  // Everything outside NAV_TOOLS is reported, never failed: the watchdog never
  // parses those replies, so a schema on a performance or network tool says
  // nothing about the channel and must not stall a bump.
  const unrelated = withSchema.filter((n) => !NAV_TOOLS.has(n));
  if (unrelated.length)
    console.log(
      `note: chrome-devtools-mcp now registers an outputSchema on ${unrelated.join(", ")} — ` +
        "not a tool the nav watchdog parses, so its channel is unchanged",
    );

  assert.deepEqual(
    withSchema.filter((n) => NAV_TOOLS.has(n)),
    [],
    "upstream now registers an outputSchema on a tool the nav watchdog parses — structuredContent " +
      "reaches the gateway, so the structured branch in bridge.ts is live and should be promoted " +
      "back over the text parse",
  );
});
