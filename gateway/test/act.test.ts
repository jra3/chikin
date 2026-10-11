import test from "node:test";
import assert from "node:assert/strict";
import { HANG, startFakeCdp, type FakeCdp } from "./fake-cdp.js";
import { act, resolveRow, ActPageGoneError, ActRefusedError, ActRequestError, ActUnconfirmedError } from "../src/snapshot/act.js";
import type { CdpTarget, PageState, SnapshotAction } from "../src/snapshot/index.js";

/**
 * `chikin_act` (#99) against a fake Chrome that speaks real websocket frames.
 *
 * What this proves is the ORDER and the REFUSALS: nothing is input unless the
 * freshness check and the target resolve both pass, a fill is a click then a
 * select-all then insertText, a select never clicks, and a page that navigates
 * under the click is read again rather than reported as broken. Whether the
 * in-page guard script itself tells a changed page from an unchanged one is a
 * question only a real browser can answer — `itest/act-guards.mjs` asks it.
 */

const row = (r: Partial<SnapshotAction> & Pick<SnapshotAction, "id" | "kind">): SnapshotAction => ({
  label: r.id,
  ...r,
});

const STATE: PageState = {
  url: "https://example.org/form",
  title: "Form",
  w: 1000,
  h: 800,
  text: "Cart total: $10",
  scroll: { y: 0, height: 2000 },
  actions: [
    row({ id: "e1", node: 1, kind: "click", role: "button", label: "Continue" }),
    row({ id: "e2", node: 2, kind: "fill", role: "textbox", label: "City", value: "Zurich" }),
    row({ id: "e3", node: 3, kind: "select", role: "combobox", label: "Category → Design", value: "design" }),
    row({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 }),
    row({ id: "wait", kind: "wait", label: "Wait" }),
  ],
  omitted_actions: 0,
  marker: ["marker-1"],
  page_key: ["key-1"],
  guards: { "1": ["guard-1"], "3": ["guard-3"] },
};

const AFTER = { ...STATE, title: "After", marker: ["marker-2"], page_key: ["key-2"], guards: {} };

/**
 * One fake page whose answers a test can override per probe. The default page
 * is unchanged since the snapshot and every target is clickable at (50, 60).
 */
function scripted(over: { guard?: unknown; marker?: unknown; target?: unknown; reads?: unknown[] } = {}) {
  const reads = [...(over.reads ?? [AFTER])];
  return (params: Record<string, unknown>): unknown => {
    const expr = String(params.expression ?? "");
    if (expr.includes("c.guard(c.nodes.get(")) {
      const node = Number(/c\.nodes\.get\((\d+)\)/.exec(expr)?.[1]);
      return over.guard !== undefined ? over.guard : [STATE.page_key, STATE.guards[String(node)]];
    }
    if (expr.includes("return state?.marker ?? null")) return over.marker !== undefined ? over.marker : STATE.marker;
    if (expr.includes("elementFromPoint")) return over.target !== undefined ? over.target : { x: 50, y: 60 };
    if (expr.includes("requestAnimationFrame(ready)")) return undefined;
    return reads.length > 1 ? reads.shift() : reads[0];
  };
}

const PAGE: CdpTarget = { id: "P", type: "page", url: STATE.url, title: STATE.title };

async function withPage<T>(evaluate: (p: Record<string, unknown>) => unknown, fn: (fake: FakeCdp) => Promise<T>): Promise<T> {
  const fake = await startFakeCdp([{ id: "P", url: STATE.url, evaluate }]);
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

const inputs = (fake: FakeCdp) =>
  fake.commands.filter((c) => c.method.startsWith("Input.")).map((c) => [c.method, c.params.type ?? null]);

const run = (fake: FakeCdp, id: string, text?: string) =>
  act({ ip: fake.ip, cdpPort: fake.port, page: PAGE, state: STATE, row: resolveRow(STATE, id, text), text });

// --- resolveRow: the arguments are checked before the browser is touched ----

test("resolveRow: unknown ids, missing fill text and stray text are refused by name", () => {
  assert.throws(() => resolveRow(STATE, undefined, undefined), (e: unknown) => e instanceof ActRequestError && /`id` is required/.test(e.message));
  assert.throws(() => resolveRow(STATE, "e9", undefined), /No row 'e9'.*renumbered/);
  assert.throws(() => resolveRow(STATE, "e2", undefined), /is a fill; pass the text/);
  assert.throws(() => resolveRow(STATE, "e1", "hi"), /is a click; `text` only applies to fill/);
  assert.equal(resolveRow(STATE, "e2", "Bern").node, 2, "the row is the STORED one, node and all");
});

// --- the happy paths: what reaches Chrome, in what order ---------------------

test("click: guard checked, target resolved, pressed and released at the resolved centre, page read again", async () => {
  await withPage(scripted(), async (fake) => {
    const out = await run(fake, "e1");
    assert.equal(out.done, true);
    assert.equal(out.state?.title, "After", "the reply is the page after the click");
    assert.deepEqual(inputs(fake), [
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
    const press = fake.commands.find((c) => c.params.type === "mousePressed");
    assert.deepEqual([press?.params.x, press?.params.y, press?.params.button], [50, 60, "left"]);
    const order = fake.commands.map((c) => (c.method === "Runtime.evaluate" ? String(c.params.expression).slice(0, 30) : c.method));
    assert.ok(order.findIndex((m) => m.includes("window.__jevFast")) < order.indexOf("Input.dispatchMouseEvent"), "freshness before input");
  });
});

test("fill: click to focus, select-all with Ctrl, then insertText with the caller's text", async () => {
  await withPage(scripted(), async (fake) => {
    const out = await run(fake, "e2", "Bern");
    assert.equal(out.done, true);
    assert.deepEqual(inputs(fake), [
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.insertText", null],
    ]);
    const down = fake.commands.find((c) => c.params.type === "keyDown");
    assert.deepEqual([down?.params.modifiers, down?.params.commands], [2, ["selectAll"]]);
    assert.equal(fake.commands.find((c) => c.method === "Input.insertText")?.params.text, "Bern");
    assert.ok(
      fake.commands.some((c) => String(c.params.expression ?? "").includes("return state?.marker ?? null")),
      "a fill is checked against the whole-page marker, as in browser.py",
    );
  });
});

test("select: applied in page by the stored option value, never clicked", async () => {
  await withPage(scripted(), async (fake) => {
    const out = await run(fake, "e3");
    assert.equal(out.done, true);
    assert.deepEqual(inputs(fake), [], "a native select is set in page, not opened with the mouse");
    const resolve = fake.commands.find((c) => String(c.params.expression ?? "").includes("elementFromPoint"));
    assert.match(String(resolve?.params.expression), /"value":"design"/);
  });
});

test("scroll: a wheel event at the viewport centre with the row's delta", async () => {
  await withPage(scripted(), async (fake) => {
    await run(fake, "scroll_down");
    const wheel = fake.commands.find((c) => c.params.type === "mouseWheel");
    assert.deepEqual([wheel?.params.x, wheel?.params.y, wheel?.params.deltaY], [500, 400, 560]);
  });
});

test("wait: no input; returns as soon as the page changes", async () => {
  let markerReads = 0;
  const changesOnThirdLook = (params: Record<string, unknown>): unknown => {
    const expr = String(params.expression ?? "");
    // the freshness check is the first marker read; changes appear on the third
    if (expr.includes("return state?.marker ?? null")) return ++markerReads >= 3 ? ["marker-2"] : STATE.marker;
    return scripted()(params);
  };
  await withPage(changesOnThirdLook, async (fake) => {
    const t0 = Date.now();
    const out = await run(fake, "wait");
    assert.equal(out.done, true);
    assert.deepEqual(inputs(fake), []);
    assert.ok(Date.now() - t0 < 1000, "it stopped waiting when the page changed");
    assert.equal(markerReads, 3);
  });
});

test("wait: a page that never changes is waited on for the bound, then read", async () => {
  await withPage(scripted(), async (fake) => {
    const t0 = Date.now();
    const out = await run(fake, "wait");
    const took = Date.now() - t0;
    assert.equal(out.done, true);
    assert.ok(took >= 1900 && took < 3500, `bounded at about 2 s, took ${took} ms`);
  });
});

// --- refusals: nothing is input, and the page as it is comes back ------------

test("a changed guard refuses the click before any input, and answers with the page now", async () => {
  await withPage(scripted({ guard: [["key-1"], ["guard-CHANGED"]] }), async (fake) => {
    const out = await run(fake, "e1");
    assert.equal(out.done, false);
    assert.ok(!out.done && out.error instanceof ActRefusedError);
    assert.match(String(!out.done && out.error.message), /changed since row 'e1' was read; nothing was done/);
    assert.equal(out.state?.title, "After", "the refusal carries a fresh read");
    assert.deepEqual(inputs(fake), []);
  });
});

test("a changed marker refuses a fill", async () => {
  await withPage(scripted({ marker: ["marker-OTHER"] }), async (fake) => {
    const out = await run(fake, "e2", "Bern");
    assert.equal(out.done, false);
    assert.deepEqual(inputs(fake), []);
  });
});

test("a covered, hidden or off-screen target (resolve returns null) is refused with no input", async () => {
  await withPage(scripted({ target: null }), async (fake) => {
    const out = await run(fake, "e1");
    assert.ok(!out.done && out.error instanceof ActRefusedError);
    assert.match(String(!out.done && out.error.message), /gone, disabled, hidden, off-screen or covered/);
    assert.deepEqual(inputs(fake), []);
  });
});

test("a select interrupted mid-resolve is UNCONFIRMED, not refused: it may have applied", async () => {
  await withPage(scripted({ target: new Error("context destroyed") }), async (fake) => {
    const out = await run(fake, "e3");
    assert.ok(!out.done && out.error instanceof ActUnconfirmedError);
    assert.match(String(!out.done && out.error.message), /read the page before retrying/);
  });
});

// --- navigation under the click -------------------------------------------

test("a click that navigates: the unreadable moment is retried and the new page comes back", async () => {
  const NEXT = { ...AFTER, url: "https://example.org/next", title: "Next" };
  await withPage(scripted({ reads: [null, new Error("Execution context was destroyed"), NEXT] }), async (fake) => {
    const out = await run(fake, "e1");
    assert.equal(out.done, true);
    assert.equal(out.state?.title, "Next");
  });
});

test("input sent but the page never becomes readable: still DONE, never an error a caller would retry", async () => {
  await withPage(scripted({ reads: [null] }), async (fake) => {
    const out = await run(fake, "e1");
    assert.equal(out.done, true, "the click happened; reporting failure invites a second click");
    assert.equal(out.state, null);
    assert.equal(inputs(fake).length, 2);
  });
});

test("a click whose release is never answered (alert() opened) is DONE with no state, well inside the 25s default", async () => {
  const fake = await startFakeCdp([
    { id: "P", url: STATE.url, evaluate: scripted(), input: (_m, p) => (p.type === "mouseReleased" ? HANG : undefined) },
  ]);
  try {
    const t0 = Date.now();
    const out = await run(fake, "e1");
    const took = Date.now() - t0;
    assert.equal(out.done, true, "the press went out; a retry would be a second click");
    assert.equal(out.state, null);
    assert.match(String(out.done && out.reason), /mouseReleased|timed out/);
    assert.ok(took < 10_000, `answered in ${took}ms`);
  } finally {
    await fake.close();
  }
});

test("a page that cannot be reached is ActPageGoneError, before any input", async () => {
  await withPage(scripted(), async (fake) => {
    await assert.rejects(
      act({ ip: fake.ip, cdpPort: fake.port, page: { ...PAGE, id: "closed" }, state: STATE, row: resolveRow(STATE, "e1", undefined) }),
      (e: unknown) => e instanceof ActPageGoneError,
    );
    assert.deepEqual(inputs(fake), []);
  });
});
