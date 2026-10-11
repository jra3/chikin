/**
 * `chikin_snapshot`: an indexed action table read over the gateway's own CDP
 * connection (#96, first slice of #95).
 *
 * What comes back is what Browser Use's jev-ultrafast runtime feeds its
 * decision model each step: every visible, enabled control in the viewport as
 * a numbered row (`e1`, `e2`, …) with its role, label, current value and the
 * kind of act it admits, plus the visible text, in one `Runtime.evaluate`.
 * A caller can read it instead of upstream's `take_snapshot` and then act with
 * upstream's `click{uid}` — and the measured difference in tokens and latency
 * on real pages is the evidence that decides whether the act and loop slices
 * of #95 get built.
 *
 * This slice only READS. The script leaves `window.__jevFast` (node identity,
 * guards) behind in the page's main world for the act slice to use; nothing
 * here dispatches input, so sharing the tab with the chrome-devtools-mcp
 * child costs nothing.
 */

import { CdpClient } from "./cdp-client.js";
import { SNAPSHOT_JS } from "./snapshot-script.js";

/** One row of Chrome's `/json/list`. */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
}

/** A control the page offers, as the script observed it. */
export interface SnapshotAction {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  rect?: { x: number; y: number; w: number; h: number };
  delta?: number;
}

/** What the tool returns: the script's output minus its freshness internals. */
export interface Snapshot {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  actions: SnapshotAction[];
  omitted_actions: number;
}

/**
 * Everything the in-page script returned, internals included. `marker`,
 * `page_key` and `guards` never reach the caller: they are what `chikin_act`
 * compares against to decide whether a row still means what it meant when it
 * was read (./act.ts).
 */
export interface PageState extends Snapshot {
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
}

/** More than one open page fits, or none does; the message lists what is open. */
export class PageChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageChoiceError";
  }
}

/** The document moved under the read (navigating, or no body yet). */
export class StalePageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StalePageError";
  }
}

/** The open pages, straight from Chrome. Only `type: "page"` targets count. */
export async function listPages(ip: string, cdpPort: number, timeoutMs = 2000): Promise<CdpTarget[]> {
  const res = await fetch(`http://${ip}:${cdpPort}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`/json/list answered ${res.status}`);
  const all = (await res.json()) as Partial<CdpTarget>[];
  return all
    .filter((t): t is CdpTarget => typeof t.id === "string" && typeof t.url === "string" && t.type === "page")
    .map((t) => ({ id: t.id, type: t.type, url: t.url, title: typeof t.title === "string" ? t.title : "" }));
}

/** Origin + path, so a hash or query drift does not make two reads of one tab disagree. */
export function sameDoc(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

/**
 * Which open page to read. Pure, so the ways it refuses are unit-tested.
 *
 * Order: the caller's explicit `url`; else the tab the gateway itself last read
 * (`targetId`), while it is still open — the bridge only offers it when the
 * child has neither navigated nor changed its selection since, so a click of
 * ours that navigated keeps us on that tab instead of hunting for its old URL;
 * else the page the child last reported selected (the nav watchdog's
 * `navNewest`, only as fresh as the last nav reply); else the only page open.
 * Anything that leaves more than one candidate, or none, is refused by name
 * rather than guessed — `/json/activate` was rejected for the same ambiguity
 * in ADR 0006, and a snapshot of the wrong tab is worse than no snapshot.
 */
export function choosePage(
  pages: CdpTarget[],
  prefer: { url?: string; targetId?: string; selected?: string },
): CdpTarget {
  const open = () => pages.map((p) => `  ${p.url}${p.title ? ` (${p.title})` : ""}`).join("\n") || "  (none)";
  const pick = (want: string, how: string): CdpTarget => {
    const hits = pages.filter((p) => sameDoc(p.url, want));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) throw new PageChoiceError(`No open page matches ${how} ${want}. Open pages:\n${open()}`);
    throw new PageChoiceError(
      `${hits.length} open pages match ${how} ${want}; pass a \`url\` that names exactly one, or close the others. Open pages:\n${open()}`,
    );
  };
  if (prefer.url) return pick(prefer.url, "url");
  if (prefer.targetId) {
    const same = pages.find((p) => p.id === prefer.targetId);
    if (same) return same;
  }
  if (prefer.selected && (pages.length !== 1 || pages.some((p) => sameDoc(p.url, prefer.selected!)))) {
    return pick(prefer.selected, "the selected page");
  }
  if (pages.length === 1) return pages[0];
  if (pages.length === 0) throw new PageChoiceError("No page is open; navigate somewhere first.");
  throw new PageChoiceError(
    `${pages.length} pages are open and no page is selected yet; pass \`url\` to name one. Open pages:\n${open()}`,
  );
}

export interface TakeSnapshotOptions {
  ip: string;
  cdpPort: number;
  /** Explicit page, by URL (origin + path). */
  url?: string;
  /** The tab the gateway last read, when nothing has moved the child since. */
  targetId?: string;
  /** The child's last reported selected page, when the caller has one. */
  selected?: string;
  /** Per-call deadline for the in-page read. Jev's harness allows 25s. */
  evaluateTimeoutMs?: number;
}

/** The websocket for one page target, built from its id. */
export function pageSocketUrl(ip: string, cdpPort: number, targetId: string): string {
  // Built from the id, not from the `webSocketDebuggerUrl` Chrome printed: that
  // URL echoes whatever Host header reached it, and the CDP lane rewrites the
  // same field for drivers on the far side of the network split.
  return `ws://${ip}:${cdpPort}/devtools/page/${targetId}`;
}

/**
 * Run the snapshot script once on an open connection. Throws `StalePageError`
 * when the document moved under the read, which a caller that just caused a
 * navigation may retry.
 */
export async function readState(client: CdpClient, timeoutMs = 25_000): Promise<PageState> {
  const r = (await client.send("Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true }, timeoutMs)) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (r.exceptionDetails) throw new StalePageError("Document changed during the read; try again.");
  const value = r.result?.value;
  if (value === null || value === undefined) throw new StalePageError("Document is navigating; try again.");
  const o = value as Record<string, unknown>;
  return {
    ...publicSnapshot(value),
    marker: o.marker ?? null,
    page_key: o.page_key ?? null,
    guards: (o.guards && typeof o.guards === "object" ? o.guards : {}) as Record<string, unknown>,
  };
}

/** Read one page. Throws `PageChoiceError`, `StalePageError`, or a CDP/transport error. */
export async function takeSnapshot(
  opts: TakeSnapshotOptions,
): Promise<{ page: CdpTarget; snapshot: Snapshot; state: PageState }> {
  const page = choosePage(await listPages(opts.ip, opts.cdpPort), opts);
  const client = await CdpClient.connect(pageSocketUrl(opts.ip, opts.cdpPort, page.id));
  try {
    const state = await readState(client, opts.evaluateTimeoutMs);
    return { page, snapshot: publicSnapshot(state), state };
  } finally {
    client.close();
  }
}

/** Drop the freshness internals (`marker`, `page_key`, `guards`): they are for `chikin_act`, not the caller. */
export function publicSnapshot(v: unknown): Snapshot {
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  const scroll = (o.scroll ?? {}) as { y?: number; height?: number };
  return {
    url: str("url"),
    title: str("title"),
    w: num("w"),
    h: num("h"),
    text: str("text"),
    scroll: { y: scroll.y ?? 0, height: scroll.height ?? 0 },
    actions: Array.isArray(o.actions) ? (o.actions as SnapshotAction[]) : [],
    omitted_actions: num("omitted_actions"),
  };
}

/**
 * The text a model reads. One line per action, the id first because the id is
 * what it will hand back; the visible text last because it is the long part.
 */
export function renderSnapshot(s: Snapshot): string {
  const lines: string[] = [`# ${s.title || "(untitled)"}`, `url: ${s.url}`];
  const below = Math.max(0, s.scroll.height - s.scroll.y - s.h);
  lines.push(`viewport: ${s.w}x${s.h}, scrolled ${s.scroll.y}px, ${below}px more below`);
  lines.push("", "## Actions");
  // A label is whatever text the control carried, newlines and all; one row
  // per line is the contract, so inner whitespace collapses to a space.
  const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
  for (const a of s.actions) {
    let line = `${a.id}`;
    if (a.role) line += ` [${a.kind === "click" ? a.role : `${a.kind} ${a.role}`}]`;
    line += ` ${oneLine(a.label)}`;
    if (a.kind === "fill" && a.value) line += ` = ${JSON.stringify(a.value)}`;
    if (a.kind === "select" && a.current_value) line += ` (now: ${a.current_value})`;
    for (const k of ["checked", "selected", "expanded"] as const) if (a[k] !== undefined) line += ` ${k}=${a[k]}`;
    lines.push(line);
  }
  if (s.omitted_actions > 0) lines.push(`… ${s.omitted_actions} more controls not listed; scroll or narrow the page.`);
  lines.push("", "## Visible text", s.text || "(none)");
  return lines.join("\n");
}
