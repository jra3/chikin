import test from "node:test";
import assert from "node:assert/strict";
import { startFakeCdp, HANG } from "./fake-cdp.js";
import {
  choosePage,
  listPages,
  takeSnapshot,
  renderSnapshot,
  PageChoiceError,
  StalePageError,
  type CdpTarget,
  type Snapshot,
} from "../src/snapshot/index.js";
import { CdpClient, CdpError, CdpTransportError } from "../src/snapshot/cdp-client.js";
import { SNAPSHOT_JS } from "../src/snapshot/snapshot-script.js";

/**
 * `chikin_snapshot` (#96): the gateway's own CDP read, proven against a fake
 * Chrome that speaks real websocket frames (`fake-cdp.ts`). The page choice is
 * pure and tested as such; the read is tested on the wire, because the thing
 * this slice exists to prove is that a second CDP connection works at all.
 */

// What the in-page script returns on a small page, shaped as snapshot.js
// shapes it (ids stamped, scroll/wait rows appended, internals present).
const PAGE_STATE = {
  url: "https://example.org/checkout",
  title: "Checkout",
  w: 1120,
  h: 780,
  text: "Cart total: $10\nContinue\nCity",
  scroll: { y: 0, height: 2000 },
  actions: [
    { id: "e1", node: 1, kind: "click", role: "button", label: "Continue", value: "" },
    { id: "e2", node: 2, kind: "fill", role: "textbox", label: "City", value: "Zurich" },
    { id: "e3", node: 2, kind: "click", role: "textbox", label: "Open City", value: "Zurich" },
    { id: "e4", node: 3, kind: "select", role: "combobox", label: "Category → Design", value: "Design", current_value: "All" },
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ],
  marker: ["internal"],
  page_key: ["internal"],
  guards: { "1": ["internal"] },
  omitted_actions: 0,
};

const page = (id: string, url: string, title = ""): CdpTarget => ({ id, type: "page", url, title });

// --- choosePage: refuse by name, never guess ------------------------------

test("choosePage: an explicit url wins, matched on origin+path", () => {
  const pages = [page("a", "https://example.org/a?x=1"), page("b", "https://example.org/b#frag")];
  assert.equal(choosePage(pages, { url: "https://example.org/b", selected: "https://example.org/a" }).id, "b");
});

test("choosePage: the child's reported selection is used when no url is given", () => {
  const pages = [page("a", "https://example.org/a"), page("b", "https://example.org/b")];
  assert.equal(choosePage(pages, { selected: "https://example.org/a?q=2" }).id, "a");
});

test("choosePage: a lone page needs no hint", () => {
  assert.equal(choosePage([page("only", "about:blank")], {}).id, "only");
});

test("choosePage: two pages and no hint is refused, naming them", () => {
  const pages = [page("a", "https://example.org/a", "A"), page("b", "https://example.org/b")];
  assert.throws(() => choosePage(pages, {}), (e: unknown) => {
    assert.ok(e instanceof PageChoiceError);
    assert.match(e.message, /2 pages are open/);
    assert.match(e.message, /https:\/\/example\.org\/a \(A\)/);
    assert.match(e.message, /https:\/\/example\.org\/b/);
    return true;
  });
});

test("choosePage: two tabs on one document is the ADR 0006 ambiguity, refused", () => {
  const pages = [page("a", "https://example.org/x"), page("b", "https://example.org/x?tab=2")];
  assert.throws(() => choosePage(pages, { url: "https://example.org/x" }), /2 open pages match url/);
  assert.throws(() => choosePage(pages, { selected: "https://example.org/x" }), /match the selected page/);
});

test("choosePage: no match and no page are distinct refusals", () => {
  assert.throws(() => choosePage([page("a", "https://example.org/a")], { url: "https://other.test/" }), /No open page matches url/);
  assert.throws(() => choosePage([], {}), /No page is open/);
});

// --- the read, on the wire --------------------------------------------------

test("takeSnapshot: dials the page by id, evaluates the script once, strips the internals", async () => {
  const fake = await startFakeCdp([{ id: "P1", url: "https://example.org/checkout", title: "Checkout", evaluate: () => PAGE_STATE }]);
  try {
    const { page: read, snapshot } = await takeSnapshot({ ip: fake.ip, cdpPort: fake.port });
    assert.equal(read.id, "P1");
    assert.deepEqual(fake.upgrades, ["/devtools/page/P1"], "dialled by id, not by the printed ws url");
    assert.equal(fake.commands.length, 1, "one command: the whole read is one Runtime.evaluate");
    assert.equal(fake.commands[0].method, "Runtime.evaluate");
    assert.equal(fake.commands[0].params.expression, SNAPSHOT_JS);
    assert.equal(fake.commands[0].params.returnByValue, true);
    assert.equal(snapshot.actions.length, 6);
    assert.equal(snapshot.title, "Checkout");
    for (const k of ["marker", "page_key", "guards"]) assert.ok(!(k in snapshot), `${k} is for the act slice, not the caller`);
  } finally {
    await fake.close();
  }
});

test("takeSnapshot: only type:page targets are candidates", async () => {
  const fake = await startFakeCdp([
    { id: "W", url: "chrome-extension://abc/sw.js", type: "service_worker" },
    { id: "P", url: "https://example.org/", evaluate: () => PAGE_STATE },
  ]);
  try {
    const pages = await listPages(fake.ip, fake.port);
    assert.deepEqual(pages.map((p) => p.id), ["P"]);
    const { page: read } = await takeSnapshot({ ip: fake.ip, cdpPort: fake.port });
    assert.equal(read.id, "P");
  } finally {
    await fake.close();
  }
});

test("takeSnapshot: a thrown script is a stale page, not a crash; so is a null body", async () => {
  let answer: unknown = new Error("Cannot read properties of null");
  const fake = await startFakeCdp([{ id: "P", url: "https://example.org/", evaluate: () => answer }]);
  try {
    await assert.rejects(takeSnapshot({ ip: fake.ip, cdpPort: fake.port }), (e: unknown) => e instanceof StalePageError && /changed during/.test(e.message));
    answer = null;
    await assert.rejects(takeSnapshot({ ip: fake.ip, cdpPort: fake.port }), (e: unknown) => e instanceof StalePageError && /navigating/.test(e.message));
    assert.equal(fake.upgrades.length, 2, "each attempt opened and closed its own socket");
  } finally {
    await fake.close();
  }
});

test("takeSnapshot: an unanswered evaluate hits the client's own deadline, and the socket is closed", async () => {
  const fake = await startFakeCdp([{ id: "P", url: "https://example.org/", evaluate: () => HANG }]);
  try {
    await assert.rejects(
      takeSnapshot({ ip: fake.ip, cdpPort: fake.port, evaluateTimeoutMs: 100 }),
      (e: unknown) => e instanceof CdpTransportError && /timed out after 100ms/.test(e.message),
    );
  } finally {
    await fake.close();
  }
});

test("CdpClient: a protocol error carries the method and Chrome's message", async () => {
  const fake = await startFakeCdp([{ id: "P", url: "https://example.org/" }]);
  try {
    const c = await CdpClient.connect(`ws://${fake.ip}:${fake.port}/devtools/page/P`);
    await assert.rejects(c.send("Page.noSuchThing"), (e: unknown) => e instanceof CdpError && e.method === "Page.noSuchThing" && /wasn't found/.test(e.message));
    c.close();
    await assert.rejects(c.send("Runtime.evaluate"), CdpTransportError);
  } finally {
    await fake.close();
  }
});

test("CdpClient: connect to nothing fails rather than hangs", async () => {
  await assert.rejects(CdpClient.connect("ws://127.0.0.1:1/devtools/page/x", 2000), CdpTransportError);
});

// --- rendering -----------------------------------------------------------

test("renderSnapshot: ids first, kinds and values visible, text last", () => {
  const s: Snapshot = { ...PAGE_STATE, actions: PAGE_STATE.actions as Snapshot["actions"] };
  const text = renderSnapshot(s);
  const lines = text.split("\n");
  assert.equal(lines[0], "# Checkout");
  assert.ok(lines.includes("e1 [button] Continue"));
  assert.ok(lines.includes('e2 [fill textbox] City = "Zurich"'));
  assert.ok(lines.includes("e4 [select combobox] Category → Design (now: All)"));
  assert.ok(lines.includes("scroll_down Scroll down"));
  assert.match(text, /1220px more below/);
  assert.ok(text.indexOf("## Actions") < text.indexOf("## Visible text"), "controls before prose");
  assert.ok(text.endsWith("Cart total: $10\nContinue\nCity"));
});

test("renderSnapshot: a label keeps to its row, however the page wrapped it", () => {
  const s: Snapshot = {
    ...PAGE_STATE,
    actions: [{ id: "e1", kind: "click", role: "link", label: "Wikipedia \n\t\t The Free Encyclopedia" }],
  };
  assert.ok(renderSnapshot(s).split("\n").includes("e1 [link] Wikipedia The Free Encyclopedia"));
});

test("renderSnapshot: says when the table was cut", () => {
  const s: Snapshot = { ...PAGE_STATE, actions: [], omitted_actions: 12 };
  assert.match(renderSnapshot(s), /12 more controls not listed/);
});
