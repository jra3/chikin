import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { HaikuDecider, DeciderError, DeciderRefusedError, RULES, type MessagesClient } from "../src/loop/decider.js";

/**
 * The decider's request and its handling of what comes back (#103), against a
 * stand-in for the SDK's `messages.parse`. No network: whether Haiku answers
 * well is a live question for `itest/achieve.mjs`; whether we ASK it the way
 * the docs say, and read the answer safely, is this file's.
 */

type Params = Record<string, unknown>;

function stub(reply: (params: Params) => unknown) {
  const calls: { params: Params; options: Record<string, unknown> }[] = [];
  const client = {
    messages: {
      parse: async (params: Params, options: Record<string, unknown>) => {
        calls.push({ params, options });
        return reply(params);
      },
    },
  } as unknown as MessagesClient;
  return { client, calls };
}

const input = { goal: "find socks", table: "# Shop\nurl: https://shop.example/\n\n## Actions\ne1 [button] Go", recent: [] };

test("the request: the configured model, thinking disabled, low effort, a schema, the rules cached as system", async () => {
  const { client, calls } = stub(() => ({
    stop_reason: "end_turn",
    parsed_output: { choice: "e1", text: null, consequential: false, reason: "go" },
  }));
  const d = new HaikuDecider({ client, model: "claude-haiku-5-5", timeoutMs: 9000 });
  const out = await d.decide(input);
  assert.equal(out.choice, "e1");
  assert.equal(typeof out.ms, "number");
  const p = calls[0].params as any;
  assert.equal(p.model, "claude-haiku-5-5");
  assert.deepEqual(p.thinking, { type: "disabled" });
  assert.equal(p.output_config.effort, "low");
  assert.equal(p.output_config.format.type, "json_schema", "structured output, not a forced tool");
  assert.deepEqual(Object.keys(p.output_config.format.schema.properties).sort(), ["choice", "consequential", "reason", "text"]);
  assert.equal(p.system[0].text, RULES);
  assert.deepEqual(p.system[0].cache_control, { type: "ephemeral" });
  assert.equal(p.messages.length, 1);
  assert.match(p.messages[0].content, /^Goal:\nfind socks\n/);
  assert.match(p.messages[0].content, /e1 \[button\] Go/);
  assert.ok(!("tools" in p) && !("tool_choice" in p));
  assert.equal(calls[0].options.timeout, 9000);
  assert.equal(calls[0].options.maxRetries, 1);
});

test("a refusal is DeciderRefusedError, naming the category when there is one", async () => {
  const { client } = stub(() => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null }));
  await assert.rejects(new HaikuDecider({ client, model: "m" }).decide(input), (e: unknown) => e instanceof DeciderRefusedError && /\(cyber\)/.test(e.message));
});

test("an answer that did not parse is DeciderError, never a guess", async () => {
  const { client } = stub(() => ({ stop_reason: "max_tokens", parsed_output: null }));
  await assert.rejects(new HaikuDecider({ client, model: "m" }).decide(input), (e: unknown) => e instanceof DeciderError && /max_tokens/.test(e.message));
});

test("an API error is DeciderError with its status, by class not by message", async () => {
  const { client } = stub(() => {
    throw new Anthropic.APIError(529, undefined, "Overloaded", undefined);
  });
  await assert.rejects(new HaikuDecider({ client, model: "m" }).decide(input), (e: unknown) => e instanceof DeciderError && /\(529\)/.test(e.message));
});

test("the prompt carries recent actions with their outcomes", async () => {
  const { client, calls } = stub(() => ({ stop_reason: "end_turn", parsed_output: { choice: "DONE", text: null, consequential: false, reason: "x" } }));
  await new HaikuDecider({ client, model: "m" }).decide({
    ...input,
    recent: [{ action: "Search", kind: "fill", text: "socks", outcome: "done", page_changed: true }],
  });
  assert.match((calls[0].params as any).messages[0].content, /1\. fill "Search" text="socks" -> done, page changed/);
});
