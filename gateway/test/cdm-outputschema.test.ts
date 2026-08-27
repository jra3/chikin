import test from "node:test";
import assert from "node:assert/strict";
import { NAV_TOOLS } from "../src/bridge.js";
import { withCdmStdio } from "./cdm-stdio.js";

/**
 * The CI-side tripwire issue #75 asked for.
 *
 * `cdm-format.test.ts` renders replies through the vendored formatter, and the
 * formatter genuinely returns `structuredContent.pages` — which is exactly what
 * made #72 believe structured output was the watchdog's authoritative channel.
 * It is not, and the reason is upstream rather than the SDK: `ToolHandler`
 * copies structuredContent onto a tool result ONLY when the child was started
 * with `--experimentalStructuredContent`, and the `chrome-devtools-mcp` binary
 * leaves that flag off (only the sibling `chrome-devtools` CLI puts it in its
 * defaults). The SDK strips nothing — it validates structuredContent when a tool
 * declares an `outputSchema`, and otherwise passes the handler's result through.
 *
 * THIS TEST IS A PROXY FOR THAT, not a reading of it. Whether structuredContent
 * rides a real reply is observable only on a real tool call against a real
 * browser — every `tools/call` resolves the browser before any reply body is
 * built, so a browser-free probe can never see one. `itest/cdm-wire.mjs`
 * asserts the property on the wire; this asserts what CI can reach without a
 * fleet: no tool the watchdog parses declares an `outputSchema`.
 *
 * It is still a real signal, because the SDK ties the two together in one
 * direction: a tool that declares an `outputSchema` and returns a non-error
 * reply carrying no structuredContent fails validation outright. So a schema
 * appearing on a nav tool means the reply shape changed under us.
 *
 * WHAT IT DOES NOT CATCH: upstream defaulting `--experimentalStructuredContent`
 * on, or dropping the gate, without ever declaring a schema. structuredContent
 * would start arriving, `pagesFromStructuredContent` would go live, and this
 * test would stay green. Run `itest/cdm-wire.mjs` against a candidate build
 * before taking a bump — that is the check that sees it.
 *
 * No browser is needed here: chrome-devtools-mcp resolves its browser
 * connection when a tool is CALLED, not at startup, so `initialize` and
 * `tools/list` are served against a dead `--browserUrl` — the same property the
 * gateway's lazy provisioning relies on (issue #63).
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
    "upstream now declares an outputSchema on a tool the nav watchdog parses. The SDK rejects a " +
      "reply from such a tool that carries no structuredContent, so the child must now be " +
      "attaching it: re-run itest/cdm-wire.mjs and promote the structured branch in bridge.ts " +
      "over the text parse. (This assertion is a proxy — it does NOT catch upstream turning " +
      "--experimentalStructuredContent on by default, which only the wire harness sees.)",
  );
});
