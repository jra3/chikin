import test from "node:test";
import assert from "node:assert/strict";
import { actionSpace, validateChoice, JevDecider, OpenRouterTextHelper, JEV_NEXT_ACTION, type SystemOneClient, type TextHelper } from "../src/loop/jev.js";
import { DeciderError } from "../src/loop/decider.js";
import type { PageState, SnapshotAction } from "../src/snapshot/index.js";

/**
 * Jev as the decider (#103): the action space, the questions asked, the
 * validation, and the two follow-ups (fill text, consequential) against a
 * stand-in for the SDK client. No network; the live run is itest/achieve.mjs.
 */

const a = (r: Partial<SnapshotAction> & Pick<SnapshotAction, "id" | "kind" | "label">): SnapshotAction => ({ ...r }) as SnapshotAction;
const PAGE: PageState = {
  url: "https://shop.example/",
  title: "Shop",
  w: 1000,
  h: 800,
  text: "Find socks",
  scroll: { y: 0, height: 2000 },
  actions: [
    a({ id: "e1", kind: "fill", label: "Search", node: 1, role: "searchbox", value: "" }),
    a({ id: "e2", kind: "click", label: "Open Search", node: 1, role: "searchbox", value: "" }),
    a({ id: "e3", kind: "click", label: "Buy now", node: 2, role: "button" }),
    a({ id: "e4", kind: "select", label: "Size → M", node: 3, role: "combobox", value: "m", current_value: "S" }),
    a({ id: "e5", kind: "select", label: "Size → L", node: 3, role: "combobox", value: "l", current_value: "S" }),
    a({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 }),
    a({ id: "wait", kind: "wait", label: "Wait for the page to update" }),
  ],
  omitted_actions: 0,
  marker: [],
  page_key: [],
  guards: {},
};

test("actionSpace: one index per element, per-operation targets, controls by name (jev-ultrafast action_space)", () => {
  const { elements, targets, controls } = actionSpace(PAGE.actions);
  assert.deepEqual(elements.map((e) => [e.index, e.label, e.operations]), [
    ["1", "Search", ["TYPE_TEXT", "CLICK"]],
    ["2", "Buy now", ["CLICK"]],
    ["3", "Size", ["SELECT"]],
  ]);
  assert.deepEqual(Object.keys(targets.CLICK), ["1", "2"]);
  assert.equal(targets.TYPE_TEXT["1"].id, "e1");
  assert.deepEqual(Object.keys(targets.SELECT), ["3:1", "3:2"]);
  assert.equal(targets.SELECT["3:2"].id, "e5");
  assert.deepEqual(Object.keys(controls), ["SCROLL_DOWN", "WAIT"]);
  assert.equal(elements[2].value, "S", "a select shows its current value");
});

test("validateChoice: the jev-ultrafast checks, each one refused", () => {
  const ok = { choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } };
  assert.equal(validateChoice(ok, ["a", "b"]).choice, "a");
  for (const bad of [
    { ...ok, choice: "c" },
    { ...ok, probabilities: { a: 0.9 } },
    { ...ok, probabilities: { a: 0.6, b: 0.6 } },
    { ...ok, choice: "b" },
    { ...ok, confidence: 1.5 },
    undefined,
  ])
    assert.throws(() => validateChoice(bad, ["a", "b"]), DeciderError);
});

/** A stand-in SDK client that answers by the questions it is asked. */
function client(answer: (questions: Record<string, unknown>, state: unknown) => Record<string, unknown>) {
  const calls: { state: unknown; questions: Record<string, any>; model?: string; options: any }[] = [];
  const c = {
    systemOne: async (req: any, options: any) => {
      calls.push({ state: req.state, questions: req.questions, model: req.model, options });
      return { model: "typesafe/jev-1.13-test", answers: answer(req.questions, req.state), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as SystemOneClient;
  return { c, calls };
}
// Exact distributions so validation passes: the pick gets 1, everything else 0.
const pick = (p: string, ids: string[]) => ({ type: "choice", choice: p, confidence: 0.8, probabilities: Object.fromEntries(ids.map((id) => [id, id === p ? 1 : 0])) });
const noText: TextHelper = { valueFor: async () => ({ text: "unused" }) };
const input = { goal: "buy size L socks", table: "(rendered)", recent: [], page: PAGE };

test("one request asks the operation and a target head per operation; only the chosen head is read", async () => {
  const { c, calls } = client((q) =>
    q.consequential
      ? { consequential: { type: "noul", noul: 0.97 } }
      : {
          operation: pick("CLICK", Object.keys((q.operation as any).criteria)),
          click_target: pick("2", ["1", "2"]),
          type_text_target: { type: "choice", choice: "garbage" }, // never read: CLICK was chosen
          select_target: pick("3:1", ["3:1", "3:2"]),
        },
  );
  const d = new JevDecider({ client: c, model: "jev-latest", text: noText });
  const out = await d.decide(input);
  assert.equal(out.choice, "e3");
  assert.equal(out.consequential, true, "a second Jev question flags Buy now");
  assert.equal(out.model, "typesafe/jev-1.13-test");
  const first = calls[0];
  assert.equal(first.model, "jev-latest");
  assert.deepEqual(Object.keys(first.questions).sort(), ["click_target", "operation", "select_target", "type_text_target"]);
  assert.deepEqual(Object.keys(first.questions.operation.criteria).sort(), ["BLOCKED", "CLICK", "DONE", "SCROLL_DOWN", "SELECT", "TYPE_TEXT", "WAIT"]);
  assert.equal(first.questions.operation.instructions.rules, JEV_NEXT_ACTION);
  assert.deepEqual((first.state as any).page, { url: PAGE.url, title: PAGE.title, text: PAGE.text });
  assert.deepEqual(Object.keys(calls[1].questions), ["consequential"]);
  assert.equal(calls[1].questions.consequential.type, "noul");
  assert.equal(first.options.retry.maxRetries, 1);
});

test("a fill asks the text model, with the field and the goal, and carries its answer (or its null)", async () => {
  const seen: Record<string, any>[] = [];
  for (const value of ["L socks", null]) {
    const text: TextHelper = { valueFor: async (ctx) => (seen.push(ctx), { text: value, model: "anthropic/claude-haiku-5.5" }) };
    const { c, calls } = client((q) => ({ operation: pick("TYPE_TEXT", Object.keys((q.operation as any).criteria)), type_text_target: pick("1", ["1"]), click_target: pick("1", ["1", "2"]), select_target: pick("3:1", ["3:1", "3:2"]) }));
    const out = await new JevDecider({ client: c, model: "jev-latest", text }).decide(input);
    assert.equal(out.choice, "e1");
    assert.equal(out.text, value);
    assert.equal(out.consequential, false);
    assert.equal(calls.length, 1, "no consequential question for a fill");
  }
  assert.equal(seen[0].goal, "buy size L socks");
  assert.equal(seen[0].field.label, "Search");
});

test("a control operation maps to its row; DONE and BLOCKED come back as themselves", async () => {
  for (const [op, expected] of [["SCROLL_DOWN", "scroll_down"], ["WAIT", "wait"], ["DONE", "DONE"], ["BLOCKED", "BLOCKED"]] as const) {
    const { c, calls } = client((q) => ({ operation: pick(op, Object.keys((q.operation as any).criteria)), click_target: pick("1", ["1", "2"]), type_text_target: pick("1", ["1"]), select_target: pick("3:1", ["3:1", "3:2"]) }));
    const out = await new JevDecider({ client: c, model: "jev-latest", text: noText }).decide(input);
    assert.equal(out.choice, expected);
    assert.equal(calls.length, 1);
  }
});

test("an invalid head for the chosen operation inputs nothing", async () => {
  const { c } = client((q) => ({ operation: pick("SELECT", Object.keys((q.operation as any).criteria)), select_target: { type: "choice", choice: "9:9", confidence: 1, probabilities: { "9:9": 1 } }, click_target: pick("1", ["1", "2"]), type_text_target: pick("1", ["1"]) }));
  await assert.rejects(new JevDecider({ client: c, model: "jev-latest", text: noText }).decide(input), DeciderError);
});

test("without the page as data, Jev refuses rather than guessing from text", async () => {
  const { c } = client(() => ({}));
  await assert.rejects(new JevDecider({ client: c, model: "jev-latest", text: noText }).decide({ ...input, page: undefined }), /needs the page as data/);
});

test("OpenRouterTextHelper: exactly {text}, null allowed, anything else refused", async () => {
  const reply = (content: string) =>
    (async () => new Response(JSON.stringify({ model: "m", choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;
  const helper = (content: string) => new OpenRouterTextHelper({ apiKey: "k", model: "m", fetch: reply(content) });
  assert.deepEqual(await helper('{"text":"Zurich"}').valueFor({}), { text: "Zurich", model: "m" });
  assert.deepEqual(await helper('{"text":null}').valueFor({}), { text: null, model: "m" });
  for (const bad of ['{"text":""}', '{"text":"x","why":"y"}', '"Zurich"', "not json"])
    await assert.rejects(helper(bad).valueFor({}), DeciderError);
});

test("a refused step reaches Jev and the text model with its outcome, so it does not read as done", async () => {
  const recent = [{ action: "e1", kind: "fill", text: "socks", outcome: "refused", page_changed: null }];
  const seen: Record<string, any>[] = [];
  const text: TextHelper = { valueFor: async (ctx) => (seen.push(ctx), { text: "socks" }) };
  const { c, calls } = client((q) => ({ operation: pick("TYPE_TEXT", Object.keys((q.operation as any).criteria)), type_text_target: pick("1", ["1"]), click_target: pick("1", ["1", "2"]), select_target: pick("3:1", ["3:1", "3:2"]) }));
  await new JevDecider({ client: c, model: "jev-latest", text }).decide({ ...input, recent });
  assert.deepEqual((calls[0].state as any).recent_actions, [{ action: "e1", kind: "fill", text: "socks", outcome: "refused", page_changed: null }]);
  assert.deepEqual(seen[0].recent_actions, [{ action: "e1", text: "socks", outcome: "refused" }]);
});
