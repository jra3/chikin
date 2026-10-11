import test from "node:test";
import assert from "node:assert/strict";
import { runLoop, normaliseOrigins, type LoopDriver, type LoopOptions } from "../src/loop/achieve.js";
import { DeciderError, DeciderRefusedError, type Decider, type Decision, type DecisionInput } from "../src/loop/decider.js";
import { ActRefusedError, type ActOutcome } from "../src/snapshot/act.js";
import type { PageState, SnapshotAction } from "../src/snapshot/index.js";

/**
 * chikin_achieve's loop (#103) with no browser and no model: a fake driver that
 * hands out page states and records what it was asked to do, and a decider that
 * plays a script. What is under test is the ORDER and every way the loop stops.
 */

const row = (id: string, kind: SnapshotAction["kind"], label: string, node?: number): SnapshotAction => ({
  id,
  kind,
  label,
  role: kind === "fill" ? "textbox" : "button",
  ...(node !== undefined ? { node } : {}),
});

function page(n: number, url = "https://shop.example/", actions?: SnapshotAction[]): PageState {
  return {
    url,
    title: `Page ${n}`,
    w: 1000,
    h: 800,
    text: `page ${n}`,
    scroll: { y: 0, height: 800 },
    actions: actions ?? [
      row("e1", "fill", "Search", 1),
      row("e2", "click", "Go", 2),
      row("e3", "click", "Buy now", 3),
      row("wait", "wait", "Wait"),
    ],
    omitted_actions: 0,
    marker: [`m${n}`],
    page_key: [`k${n}`],
    guards: {},
  };
}

/** A decider that answers from a list and records what it was shown. */
function scripted(answers: (Partial<Decision> | Error | ((input: DecisionInput, signal?: AbortSignal) => Promise<Partial<Decision>>))[]) {
  const seen: DecisionInput[] = [];
  const decider: Decider = {
    async decide(input, signal) {
      seen.push(input);
      const next = answers.shift();
      if (next === undefined) throw new Error("decider script ran out");
      if (next instanceof Error) throw next;
      const d = typeof next === "function" ? await next(input, signal) : next;
      return { choice: "BLOCKED", text: null, consequential: false, reason: "r", ms: 5, ...d };
    },
  };
  return { decider, seen };
}

/** A driver whose every act succeeds onto the next page, unless told otherwise. */
function driver(outcomes: ((n: number) => ActOutcome)[] = []) {
  const acted: { id: string; text?: string; from: string }[] = [];
  let n = 1;
  const d: LoopDriver = {
    read: async () => page(n),
    act: async (state, r, text) => {
      acted.push({ id: r.id, text, from: String(state.marker) });
      const custom = outcomes.shift();
      if (custom) return custom(n);
      n++;
      return { done: true, state: page(n) };
    },
  };
  return { driver: d, acted };
}

const base = (o: Partial<LoopOptions> & Pick<LoopOptions, "decider" | "driver">): LoopOptions => ({
  goal: "search for socks and stop",
  maxSteps: 10,
  deadlineMs: 60_000,
  allowConsequential: false,
  initial: page(1),
  ...o,
});

test("a goal reaches DONE: each chosen row is done once, with the fill's text, then the model's claim comes back", async () => {
  const { decider, seen } = scripted([
    { choice: "e1", text: "socks" },
    { choice: "e2" },
    { choice: "DONE", reason: "results for socks are shown" },
  ]);
  const { driver: d, acted } = driver();
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "done");
  assert.match(r.message, /results for socks are shown/);
  assert.deepEqual(acted.map((a) => [a.id, a.text]), [["e1", "socks"], ["e2", undefined]]);
  assert.deepEqual(r.steps.map((s) => s.outcome), ["executed", "executed", "stopped"]);
  assert.equal(r.state?.title, "Page 3", "the page DONE rests on comes back");
  assert.match(seen[0].table, /e1 \[fill textbox\] Search/, "the model sees the rendered table");
  assert.deepEqual(seen[2].recent.map((x) => [x.action, x.outcome, x.page_changed]), [
    ["Search", "done", true],
    ["Go", "done", true],
  ]);
});

test("BLOCKED from the model stops the loop with its reason", async () => {
  const { decider } = scripted([{ choice: "BLOCKED", reason: "no search box" }]);
  const r = await runLoop(base({ decider, driver: driver().driver }));
  assert.equal(r.status, "blocked");
  assert.match(r.message, /no search box/);
});

test("the step budget stops a loop that never finishes", async () => {
  const { decider } = scripted(Array.from({ length: 5 }, () => ({ choice: "e2" })));
  const r = await runLoop(base({ decider, driver: driver().driver, maxSteps: 3 }));
  assert.equal(r.status, "budget");
  assert.equal(r.steps.length, 3);
});

test("the time budget is checked before every decision", async () => {
  let t = 0;
  const { decider } = scripted([{ choice: "e2" }, { choice: "e2" }]);
  const d = driver().driver;
  const slow: LoopDriver = { read: d.read, act: async (s, r, x) => ((t += 40_000), d.act(s, r, x)) };
  const r = await runLoop(base({ decider, driver: slow, deadlineMs: 60_000, now: () => t }));
  assert.equal(r.status, "budget");
  assert.match(r.message, /60s time budget/);
  assert.equal(r.steps.length, 2);
});

test("three non-wait actions that leave the page unchanged is a stall, not a fourth click", async () => {
  const same = (): ActOutcome => ({ done: true, state: page(1) });
  const { decider } = scripted([{ choice: "e2" }, { choice: "e2" }, { choice: "e2" }, { choice: "e2" }]);
  const { driver: d, acted } = driver([same, same, same]);
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "stalled");
  assert.equal(acted.length, 3);
});

test("waits do not count toward a stall", async () => {
  const same = (): ActOutcome => ({ done: true, state: page(1) });
  const { decider } = scripted([{ choice: "wait" }, { choice: "wait" }, { choice: "wait" }, { choice: "DONE" }]);
  const r = await runLoop(base({ decider, driver: driver([same, same, same]).driver }));
  assert.equal(r.status, "done");
});

test("a row that is not on the page inputs nothing; twice in a row is an error", async () => {
  const { decider } = scripted([{ choice: "e99" }, { choice: "e2" }, { choice: "e42" }, { choice: "nope" }]);
  const { driver: d, acted } = driver();
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "error");
  assert.deepEqual(acted.map((a) => a.id), ["e2"], "only the valid choice reached the page");
  assert.deepEqual(r.steps.map((s) => s.outcome), ["invalid", "executed", "invalid", "invalid"]);
});

test("a refused act re-decides on the page as it is now, without re-sending", async () => {
  const refused = (): ActOutcome => ({ done: false, error: new ActRefusedError("changed"), state: page(7) });
  const { decider, seen } = scripted([{ choice: "e2" }, { choice: "DONE" }]);
  const { driver: d, acted } = driver([refused]);
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "done");
  assert.equal(acted.length, 1);
  assert.match(seen[1].table, /# Page 7/, "the second decision saw the fresh page");
  assert.equal(r.steps[0].outcome, "refused");
});

test("an input that may not have completed (a dialog) stops the loop and is never retried", async () => {
  const sent = (): ActOutcome => ({ done: true, state: null, reason: "Input.dispatchMouseEvent timed out" });
  const { decider } = scripted([{ choice: "e2" }, { choice: "e2" }]);
  const { driver: d, acted } = driver([sent]);
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "blocked");
  assert.match(r.message, /dialog may be open. Not retried/);
  assert.equal(acted.length, 1);
});

test("a consequential row stops with needs_confirmation and names the row to confirm", async () => {
  const { decider } = scripted([{ choice: "e3", consequential: true, reason: "buys the socks" }]);
  const { driver: d, acted } = driver();
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "needs_confirmation");
  assert.deepEqual(r.proposed, { id: "e3", label: "Buy now", kind: "click", text: null });
  assert.match(r.message, /call chikin_act with id "e3"/);
  assert.equal(acted.length, 0, "nothing consequential was done");
});

test("allow_consequential lets that row through", async () => {
  const { decider } = scripted([{ choice: "e3", consequential: true }, { choice: "DONE" }]);
  const { driver: d, acted } = driver();
  const r = await runLoop(base({ decider, driver: d, allowConsequential: true }));
  assert.equal(r.status, "done");
  assert.deepEqual(acted.map((a) => a.id), ["e3"]);
});

test("a fill whose text the goal does not give stops; nothing is invented", async () => {
  const { decider } = scripted([{ choice: "e1", text: null }]);
  const { driver: d, acted } = driver();
  const r = await runLoop(base({ decider, driver: d }));
  assert.equal(r.status, "blocked");
  assert.match(r.message, /does not say what to type into "Search"/);
  assert.equal(acted.length, 0);
});

test("text the model attaches to a non-fill row is dropped", async () => {
  const { decider } = scripted([{ choice: "e2", text: "stray" }, { choice: "DONE" }]);
  const { driver: d, acted } = driver();
  await runLoop(base({ decider, driver: d }));
  assert.equal(acted[0].text, undefined);
});

test("allowed_origins stops before a decision on a page outside the list", async () => {
  const { decider, seen } = scripted([{ choice: "DONE" }]);
  const r = await runLoop(
    base({ decider, driver: driver().driver, initial: page(1, "https://evil.example/x"), allowedOrigins: ["https://shop.example"] }),
  );
  assert.equal(r.status, "blocked");
  assert.match(r.message, /evil\.example, outside allowed_origins/);
  assert.equal(seen.length, 0, "no model call is spent on a page we will not act on");
});

test("normaliseOrigins keeps origins and refuses what is not one", () => {
  assert.deepEqual(normaliseOrigins(["https://a.example/path?q", "http://b.example:8080"]), ["https://a.example", "http://b.example:8080"]);
  assert.equal(normaliseOrigins(undefined), undefined);
  assert.throws(() => normaliseOrigins("https://a.example"), /must be an array/);
  assert.throws(() => normaliseOrigins(["not a url"]), /not an http\(s\) origin/);
});

test("a model refusal is BLOCKED; a model failure is an error; neither inputs anything", async () => {
  for (const [err, status] of [
    [new DeciderRefusedError("the decision model declined (cyber)"), "blocked"],
    [new DeciderError("decision model call failed (529)"), "error"],
  ] as const) {
    const { decider } = scripted([err]);
    const { driver: d, acted } = driver();
    const r = await runLoop(base({ decider, driver: d }));
    assert.equal(r.status, status);
    assert.equal(acted.length, 0);
  }
});

test("cancellation stops between steps and keeps the partial trace", async () => {
  const abort = new AbortController();
  const { decider } = scripted([
    { choice: "e2" },
    async () => {
      abort.abort();
      return { choice: "e2" };
    },
  ]);
  const { driver: d, acted } = driver();
  const r = await runLoop(base({ decider, driver: d, signal: abort.signal }));
  assert.equal(r.status, "cancelled");
  assert.equal(acted.length, 1, "the decision that was in flight at cancel is not executed");
  assert.equal(r.steps.length, 1);
});

test("a page that cannot be read after an unreadable act is read again before the next decision", async () => {
  const unreadable = (): ActOutcome => ({ done: true, state: null });
  const { decider, seen } = scripted([{ choice: "e2" }, { choice: "DONE" }]);
  const r = await runLoop(base({ decider, driver: driver([unreadable]).driver }));
  assert.equal(r.status, "done");
  assert.match(seen[1].table, /# Page 1/, "driver.read() supplied the page");
});

test("onStep sees every step as it happens", async () => {
  const seenSteps: number[] = [];
  const { decider } = scripted([{ choice: "e2" }, { choice: "DONE" }]);
  await runLoop(base({ decider, driver: driver().driver, onStep: (s) => seenSteps.push(s.step) }));
  assert.deepEqual(seenSteps, [1, 2]);
});
