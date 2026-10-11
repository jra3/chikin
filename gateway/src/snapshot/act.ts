/**
 * `chikin_act` (#99, second slice of #95): execute one row of the last
 * `chikin_snapshot` on the page it was read from, over the gateway's own CDP
 * connection, and read the page again for the reply.
 *
 * A port of Browser Use's jev-ultrafast `Browser.fresh`/`Browser.act`/
 * `browser_operation` (`jev_ultrafast/browser.py`, https://github.com/browser-use/jev-ultrafast,
 * MIT, Copyright (c) 2026 Browser Use). The in-page expressions are theirs
 * verbatim, so the guard semantics stay the ones `scripts/check_guards.py`
 * exercises; `itest/act-guards.mjs` runs those cases against a real fleet
 * browser.
 *
 * The caller never names a node. It names a row id; the row it gets is the one
 * the gateway stored when the snapshot was taken, and the node in that row is
 * the page's own identity for an element it observed (`window.__jevFast`), never
 * a selector a model wrote.
 */

import { CdpClient, CdpError, CdpTransportError } from "./cdp-client.js";
import { SNAPSHOT_JS } from "./snapshot-script.js";
import { pageSocketUrl, readState, StalePageError, type CdpTarget, type PageState, type SnapshotAction } from "./index.js";

/** The page no longer matches the snapshot the row came from, or the target is covered. Nothing was input. */
export class ActRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActRefusedError";
  }
}

/**
 * A `select` was interrupted after the page may already have changed its value.
 * Unlike a refusal, retrying blind could apply it twice; look first.
 */
export class ActUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActUnconfirmedError";
  }
}

/** The page the row was read from could not be reached (closed, or the browser was swapped). Nothing was input. */
export class ActPageGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActPageGoneError";
  }
}

/** The row id or the arguments do not describe an act this snapshot offers. */
export class ActRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActRequestError";
  }
}

// `(() => { const state=<snapshot>; return state?.marker ?? null; })()` — the
// whole-page marker, recomputed. browser.py's MARKER.
const MARKER_JS = `(() => { const state=${SNAPSHOT_JS}; return state?.marker ?? null; })()`;

/** browser.py `fresh` for click/select: the page key and this node's guard, now. */
const guardJs = (node: number): string =>
  `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`;

/**
 * browser.py `browser_operation` act: resolve the observed node, refuse it if it
 * is gone, disabled, hidden, read-only (fill), off-screen or covered, apply a
 * native select in page, and return the centre to click at.
 */
const targetJs = (action: SnapshotAction): string =>
  String.raw`(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})(` +
  JSON.stringify(action) +
  ")";

/**
 * browser.py `observe` preamble: let the page answer the input. A combobox gets
 * up to 200 ms for visible options; anything else two animation frames or
 * 50 ms, whichever first (a background tab gets no frames, so the 50 ms wins).
 */
const settleJs = (action: SnapshotAction): string =>
  String.raw`(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(` +
  JSON.stringify(action) +
  ")";

/**
 * Deadline for each input command and each read after one. Short, because a
 * click that opens alert()/confirm() leaves its mouseReleased unanswered until
 * the dialog is dismissed, and the caller should hear that in seconds.
 */
const INPUT_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function evaluate(client: CdpClient, expression: string, awaitPromise = false): Promise<{ value: unknown; threw: boolean }> {
  const r = (await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  return { value: r.result?.value, threw: r.exceptionDetails !== undefined };
}

/** Look a row up in the stored snapshot and check the arguments it needs. */
export function resolveRow(state: PageState, id: unknown, text: unknown): SnapshotAction {
  if (typeof id !== "string" || !id)
    throw new ActRequestError("`id` is required: a row id from the last chikin_snapshot, e.g. \"e3\".");
  const row = state.actions.find((a) => a.id === id);
  if (!row)
    throw new ActRequestError(
      `No row '${id}' in the last snapshot. Ids are renumbered on every read; use one from the most recent chikin_snapshot or chikin_act reply.`,
    );
  if (row.kind === "fill" && typeof text !== "string")
    throw new ActRequestError(`Row '${id}' is a fill; pass the text to type as \`text\`.`);
  if (row.kind !== "fill" && text !== undefined)
    throw new ActRequestError(`Row '${id}' is a ${row.kind}; \`text\` only applies to fill rows.`);
  if (row.kind !== "scroll" && row.kind !== "wait" && typeof row.node !== "number")
    throw new ActRequestError(`Row '${id}' carries no observed node.`);
  return row;
}

/** browser.py `fresh`: does the row still mean what it meant when it was read? */
async function isFresh(client: CdpClient, state: PageState, row: SnapshotAction): Promise<boolean> {
  if (row.kind === "click" || row.kind === "select") {
    const now = await evaluate(client, guardJs(row.node as number));
    if (now.threw) return false;
    return same(now.value, [state.page_key, state.guards[String(row.node)] ?? null]);
  }
  const now = await evaluate(client, MARKER_JS);
  if (now.threw) return false;
  return same(now.value, state.marker);
}

/**
 * Read the page after an input. A click that navigates leaves a window where
 * the old context is gone and the new one has no body; that is retried for up
 * to `ms`, and anything still unreadable after it is reported as it is.
 */
export async function observeAfter(client: CdpClient, ms = 3000, readTimeoutMs?: number): Promise<PageState> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await readState(client, readTimeoutMs);
    } catch (e) {
      const transient = e instanceof StalePageError || e instanceof CdpError;
      if (!transient || Date.now() >= deadline) throw e;
      await sleep(50);
    }
  }
}

export interface ActOptions {
  ip: string;
  cdpPort: number;
  page: CdpTarget;
  state: PageState;
  row: SnapshotAction;
  text?: string;
}

export type ActOutcome =
  // `state: null`: the input happened but the page was not readable in time
  // (still loading). It must still read as DONE — a caller told to retry
  // would click twice.
  // `reason`: the input itself was interrupted after it was sent, so it may
  // not have completed (a JavaScript dialog is the usual cause).
  | { done: true; state: PageState | null; reason?: string }
  | { done: false; error: ActRefusedError | ActUnconfirmedError; state: PageState | null };

/**
 * Check, input, settle, observe. Never throws for a refusal: it returns the
 * page as it is now, so the caller re-decides without another round trip.
 * Once input has been sent it never throws either, whatever the read after it
 * does: an error there would look retryable, and a retried click is a second
 * click. Before any input, transport failures throw; a page that cannot be
 * reached at all throws `ActPageGoneError`.
 */
export async function act(opts: ActOptions): Promise<ActOutcome> {
  const { row } = opts;
  let client: CdpClient;
  try {
    client = await CdpClient.connect(pageSocketUrl(opts.ip, opts.cdpPort, opts.page.id));
  } catch (e) {
    if (e instanceof CdpTransportError)
      throw new ActPageGoneError(`The page row '${row.id}' was read from is gone (closed, or the browser was replaced); nothing was done.`);
    throw e;
  }
  let inputSent = false;
  const input = (method: string, params: Record<string, unknown>) => {
    inputSent = true;
    return client.send(method, params, INPUT_TIMEOUT_MS);
  };
  const refuse = async (error: ActRefusedError | ActUnconfirmedError): Promise<ActOutcome> => {
    let state: PageState | null = null;
    try {
      state = await observeAfter(client);
    } catch {
      /* the refusal is the answer; a fresh read is a courtesy */
    }
    return { done: false, error, state };
  };
  try {
    if (!(await isFresh(client, opts.state, row)))
      return await refuse(new ActRefusedError(`The page changed since row '${row.id}' was read; nothing was done.`));

    if (row.kind === "wait") {
      await sleep(100);
    } else if (row.kind === "scroll") {
      await input("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(opts.state.w / 2),
        y: Math.round(opts.state.h / 2),
        deltaX: 0,
        deltaY: row.delta ?? 0,
      });
    } else {
      if (row.kind === "select") inputSent = true;
      let target;
      try {
        target = await evaluate(client, targetJs(row));
      } catch (e) {
        if (row.kind === "select")
          return { done: false, error: new ActUnconfirmedError(`The select on row '${row.id}' was interrupted; read the page before retrying.`), state: null };
        throw e;
      }
      if (target.threw) {
        if (row.kind === "select")
          return await refuse(new ActUnconfirmedError(`The select on row '${row.id}' was interrupted; read the page before retrying.`));
        return await refuse(new ActRefusedError(`The page changed while resolving row '${row.id}'; nothing was done.`));
      }
      if (target.value === null || target.value === undefined)
        return await refuse(
          new ActRefusedError(`Row '${row.id}' is gone, disabled, hidden, off-screen or covered; nothing was done.`),
        );
      if (row.kind !== "select") {
        const { x, y } = target.value as { x: number; y: number };
        for (const type of ["mousePressed", "mouseReleased"])
          await input("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        if (row.kind === "fill") {
          // The browsers are Linux containers: select-all is Ctrl (modifier 2).
          await input("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            modifiers: 2,
            commands: ["selectAll"],
          });
          await input("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
          await input("Input.insertText", { text: opts.text ?? "" });
        }
      }
    }

    if (row.kind !== "wait") {
      // Read-only and best effort, as in browser.py: a navigation can tear the
      // context down under it, which is exactly when there is nothing to wait for.
      // A dead socket is not swallowed for good: the read below sends on the
      // same client and throws the transport error there.
      try {
        await client.send("Runtime.evaluate", { expression: settleJs(row), awaitPromise: true, returnByValue: true }, 2000);
      } catch {
        /* see above */
      }
    }
    try {
      return { done: true, state: await observeAfter(client, 3000, INPUT_TIMEOUT_MS) };
    } catch {
      return { done: true, state: null };
    }
  } catch (e) {
    if (!inputSent) throw e;
    return { done: true, state: null, reason: String(e instanceof Error ? e.message : e) };
  } finally {
    client.close();
  }
}
