import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  HaikuDecider,
  OpenRouterDecider,
  EscalatingDecider,
  ESCALATE_BELOW,
  DeciderError,
  DeciderRefusedError,
  RULES,
  type Decider,
  type Decision,
  type MessagesClient,
} from "../src/loop/decider.js";

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

// --- OpenRouter -------------------------------------------------------------

function fakeFetch(replies: ({ status: number; body: unknown } | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error("fake fetch ran out");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, statusText: "x" });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (content: string, model = "openai/gpt-6-luna") => ({
  status: 200,
  body: { model, choices: [{ finish_reason: "stop", message: { content } }] },
});

test("OpenRouter: the request carries the rules, the prompt and a strict schema; the served model is reported", async () => {
  const { f, calls } = fakeFetch([ok('{"choice":"e2","text":"Alan Turing","consequential":false,"reason":"type it"}')]);
  const d = new OpenRouterDecider({ apiKey: "sk-or-test", model: "typesafe/jev-router", fetch: f });
  const out = await d.decide(input);
  assert.deepEqual([out.choice, out.text, out.model], ["e2", "Alan Turing", "openai/gpt-6-luna"]);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-or-test");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "typesafe/jev-router");
  assert.equal(body.messages[0].content, RULES);
  assert.match(body.messages[1].content, /^Goal:\nfind socks\n/);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.ok(body.max_tokens >= 2048, "room for a routed reasoning model to reason AND answer");
});

test("OpenRouter: an answer outside the schema, or not JSON, is DeciderError", async () => {
  for (const content of ['{"choice":"e2"}', "click e2 please"]) {
    const { f } = fakeFetch([ok(content)]);
    await assert.rejects(new OpenRouterDecider({ apiKey: "k", model: "m", fetch: f }).decide(input), DeciderError);
  }
});

test("OpenRouter: a refusal or content filter is DeciderRefusedError", async () => {
  const { f } = fakeFetch([{ status: 200, body: { choices: [{ finish_reason: "content_filter", message: { content: null } }] } }]);
  await assert.rejects(new OpenRouterDecider({ apiKey: "k", model: "m", fetch: f }).decide(input), DeciderRefusedError);
});

test("OpenRouter: one retry on 429/5xx, then the status is reported; a 401 is not retried", async () => {
  const twice = fakeFetch([{ status: 503, body: {} }, { status: 503, body: { error: { message: "down" } } }]);
  await assert.rejects(
    new OpenRouterDecider({ apiKey: "k", model: "m", fetch: twice.f }).decide(input),
    (e: unknown) => e instanceof DeciderError && /\(503\): down/.test(e.message),
  );
  assert.equal(twice.calls.length, 2);
  const retryThenOk = fakeFetch([{ status: 429, body: {} }, ok('{"choice":"DONE","text":null,"consequential":false,"reason":"x"}')]);
  assert.equal((await new OpenRouterDecider({ apiKey: "k", model: "m", fetch: retryThenOk.f }).decide(input)).choice, "DONE");
  const auth = fakeFetch([{ status: 401, body: { error: { message: "No auth" } } }]);
  await assert.rejects(new OpenRouterDecider({ apiKey: "k", model: "m", fetch: auth.f }).decide(input), /\(401\): No auth/);
  assert.equal(auth.calls.length, 1);
});

// --- escalation (#109) ------------------------------------------------------


function fixed(d: Partial<Decision>, calls: string[], name: string): Decider {
  return {
    decide: async () => {
      calls.push(name);
      return { choice: "e1", text: null, consequential: false, reason: name, ms: 100, ...d };
    },
  };
}

test("a sure first decision stands; the fallback is never asked", async () => {
  const calls: string[] = [];
  const out = await new EscalatingDecider(fixed({ choice: "e2", confidence: 0.9 }, calls, "jev"), fixed({}, calls, "haiku")).decide(input);
  assert.equal(out.choice, "e2");
  assert.deepEqual(calls, ["jev"]);
});

test("below the threshold the step goes to the fallback, and the trace says why", async () => {
  const calls: string[] = [];
  const out = await new EscalatingDecider(
    fixed({ choice: "e9", confidence: 0.48 }, calls, "jev"),
    fixed({ choice: "wait", reason: "the list is still loading", model: "anthropic/claude-haiku-5.5" }, calls, "haiku"),
  ).decide(input);
  assert.deepEqual(calls, ["jev", "haiku"]);
  assert.equal(out.choice, "wait", "the fallback's choice is the one taken");
  assert.equal(out.model, "anthropic/claude-haiku-5.5");
  assert.equal(out.ms, 200, "both calls are counted");
  assert.match(out.reason, /^escalated \(e9 at p=0\.48 < 0\.6\): the list is still loading$/);
});

test("low-confidence DONE and BLOCKED are escalated too; a decision without confidence never is", async () => {
  for (const choice of ["DONE", "BLOCKED"]) {
    const calls: string[] = [];
    await new EscalatingDecider(fixed({ choice, confidence: 0.51 }, calls, "jev"), fixed({}, calls, "haiku")).decide(input);
    assert.deepEqual(calls, ["jev", "haiku"], choice);
  }
  const calls: string[] = [];
  await new EscalatingDecider(fixed({ choice: "e1" }, calls, "haiku-first"), fixed({}, calls, "other")).decide(input);
  assert.deepEqual(calls, ["haiku-first"]);
  assert.equal(ESCALATE_BELOW, 0.6);
});
