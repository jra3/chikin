/**
 * `chikin_achieve` (#103): read, decide, act, until the goal is DONE or
 * BLOCKED or a budget runs out.
 *
 * A port of jev-ultrafast's `Agent` loop (`jev_ultrafast/agent.py`, MIT) over
 * chikin's own pieces: the page is read with the `chikin_snapshot` script,
 * each row is done with `chikin_act`'s guarded path, and the decision comes
 * from a `Decider`. This module owns only the ORDER and the STOPPING; it never
 * touches a socket itself, so every stop condition is unit-tested with a fake
 * driver and a scripted decider.
 *
 * Rules carried from jev-ultrafast and from chikin_act:
 * - a decision is consumed once; a refusal re-reads and re-decides, never
 *   re-sends;
 * - an input that landed is never retried, even when the read after it fails;
 * - three consecutive non-wait actions that left the page unchanged is a stall;
 * - DONE is the model's claim, returned with the page it rests on.
 */

import { renderSnapshot, type PageState, type SnapshotAction } from "../snapshot/index.js";
import type { ActOutcome } from "../snapshot/act.js";
import { DeciderError, DeciderRefusedError, type Decider, type RecentAction } from "./decider.js";

/** How the loop reads and acts on its one page. */
export interface LoopDriver {
  read(): Promise<PageState>;
  act(state: PageState, row: SnapshotAction, text?: string): Promise<ActOutcome>;
}

export type LoopStatus =
  | "done"
  | "blocked"
  | "needs_confirmation"
  | "budget"
  | "stalled"
  | "cancelled"
  | "error";

export interface TraceStep {
  step: number;
  url: string;
  choice: string;
  label?: string;
  kind?: string;
  text?: string | null;
  reason: string;
  consequential: boolean;
  /** What happened to the choice. */
  outcome: "executed" | "sent-unconfirmed" | "refused" | "invalid" | "stopped" | "failed";
  page_changed: boolean | null;
  decide_ms: number;
  act_ms: number;
  /** The model that made this decision, when the provider reports it. */
  model?: string;
  note?: string;
}

export interface LoopResult {
  status: LoopStatus;
  message: string;
  steps: TraceStep[];
  /** The page as it was when the loop stopped, when it could be read. */
  state: PageState | null;
  /** For needs_confirmation: the row the model wanted, still valid in `state`. */
  proposed?: { id: string; label: string; kind: string; text: string | null };
}

export interface LoopOptions {
  goal: string;
  maxSteps: number;
  deadlineMs: number;
  allowedOrigins?: string[];
  allowConsequential: boolean;
  decider: Decider;
  driver: LoopDriver;
  /** The first read, when the caller already has it. */
  initial?: PageState;
  signal?: AbortSignal;
  /** Checked with `signal` between steps: a reason the loop must stop now (the session closed, the browser restarted). */
  halted?: () => string | null;
  onStep?: (step: TraceStep) => void;
  now?: () => number;
}

const markerOf = (s: PageState | null) => (s ? JSON.stringify(s.marker) : null);
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** Normalise `allowed_origins` entries to origins; throws on one that is not a URL. */
export function normaliseOrigins(list: unknown): string[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string"))
    throw new TypeError("`allowed_origins` must be an array of origins, e.g. [\"https://example.com\"].");
  return (list as string[]).map((x) => {
    const o = originOf(x);
    if (!o) throw new TypeError(`\`allowed_origins\` entry ${JSON.stringify(x)} is not an http(s) origin.`);
    return o;
  });
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + opts.deadlineMs;
  const steps: TraceStep[] = [];
  let state: PageState | null = opts.initial ?? null;
  let invalidStreak = 0;

  const stop = (status: LoopStatus, message: string, extra: Partial<LoopResult> = {}): LoopResult => ({
    status,
    message,
    steps,
    state,
    ...extra,
  });
  const record = (s: TraceStep) => {
    steps.push(s);
    opts.onStep?.(s);
  };
  const recent = (): RecentAction[] =>
    steps
      .filter((s) => s.outcome !== "invalid")
      .slice(-8)
      .map((s) => ({
        action: s.label ?? s.choice,
        kind: s.kind ?? s.choice,
        text: s.text ?? null,
        outcome: s.outcome === "executed" ? "done" : s.outcome === "sent-unconfirmed" ? "sent, unconfirmed" : s.outcome,
        page_changed: s.page_changed,
      }));

  const interrupted = (): LoopResult | null => {
    const why = opts.halted?.();
    if (why) return stop("cancelled", `Stopped after ${steps.length} step(s): ${why}.`);
    return opts.signal?.aborted ? stop("cancelled", `Cancelled after ${steps.length} step(s).`) : null;
  };

  for (let step = 1; ; step++) {
    const early = interrupted();
    if (early) return early;
    if (step > opts.maxSteps) return stop("budget", `Stopped at the ${opts.maxSteps}-step budget without DONE.`);
    if (now() >= deadline)
      return stop("budget", `Stopped at the ${Math.round(opts.deadlineMs / 1000)}s time budget without DONE.`);

    if (!state) {
      try {
        state = await opts.driver.read();
      } catch (e) {
        return stop("error", `The page could not be read: ${String(e instanceof Error ? e.message : e)}`);
      }
    }

    if (opts.allowedOrigins) {
      const here = originOf(state.url);
      if (!here || !opts.allowedOrigins.includes(here))
        return stop("blocked", `The page is on ${here ?? state.url}, outside allowed_origins; nothing more was done.`);
    }

    let decision;
    try {
      decision = await opts.decider.decide({ goal: opts.goal, table: renderSnapshot(state), recent: recent() }, opts.signal);
    } catch (e) {
      const halt = interrupted();
      if (halt) return halt;
      if (e instanceof DeciderRefusedError) return stop("blocked", `${e.message}; nothing more was done.`);
      if (e instanceof DeciderError) return stop("error", `${e.message}; nothing more was done.`);
      throw e;
    }
    const base = {
      step,
      url: state.url,
      choice: decision.choice,
      reason: decision.reason,
      consequential: decision.consequential,
      decide_ms: decision.ms,
      act_ms: 0,
      ...(decision.model ? { model: decision.model } : {}),
      page_changed: null,
    };

    if (decision.choice === "DONE" || decision.choice === "BLOCKED") {
      record({ ...base, outcome: "stopped" });
      return decision.choice === "DONE"
        ? stop("done", `The model reports the goal done: ${decision.reason}`)
        : stop("blocked", `The model reports no row can make progress: ${decision.reason}`);
    }

    const row = state.actions.find((a) => a.id === decision.choice);
    if (!row) {
      invalidStreak++;
      record({ ...base, outcome: "invalid", note: `'${decision.choice}' is not a row on this page` });
      if (invalidStreak >= 2) return stop("error", "The decision model named rows that are not on the page twice in a row.");
      continue;
    }
    invalidStreak = 0;
    const label = oneLine(row.label);
    const text = row.kind === "fill" ? decision.text : null;
    if (row.kind === "fill" && (text === null || text === "")) {
      record({ ...base, label, kind: row.kind, text: null, outcome: "stopped" });
      return stop("blocked", `The goal does not say what to type into "${label}"; call again with that value in the goal.`);
    }
    if (decision.consequential && !opts.allowConsequential) {
      record({ ...base, label, kind: row.kind, text, outcome: "stopped", note: "consequential; awaiting confirmation" });
      return stop(
        "needs_confirmation",
        `The next step, ${row.kind} "${label}" (${row.id}), commits something hard to undo. ` +
          `To go ahead, call chikin_act with id "${row.id}"${text !== null ? ` and that text` : ""}, then chikin_achieve again.`,
        { proposed: { id: row.id, label, kind: row.kind, text } },
      );
    }
    const late = interrupted();
    if (late) return late;

    const before = markerOf(state);
    const t0 = performance.now();
    let outcome: ActOutcome;
    try {
      outcome = await opts.driver.act(state, row, text ?? undefined);
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e);
      record({ ...base, label, kind: row.kind, text, outcome: "failed", act_ms: Math.round(performance.now() - t0), note: why });
      state = null;
      return stop("error", `${row.kind} "${label}" (${row.id}) could not be done: ${why}. Nothing was input for that step; the page may be gone.`);
    }
    const act_ms = Math.round(performance.now() - t0);

    if (outcome.done) {
      state = outcome.state;
      const changed = state ? markerOf(state) !== before : null;
      record({
        ...base,
        label,
        kind: row.kind,
        text,
        outcome: outcome.reason ? "sent-unconfirmed" : "executed",
        page_changed: changed,
        act_ms,
        note: outcome.reason,
      });
      if (outcome.reason)
        return stop(
          "blocked",
          `${row.kind} "${label}" was sent but may not have completed (${outcome.reason}); a JavaScript dialog may be open. Not retried.`,
        );
      const last3 = steps.filter((s) => s.outcome === "executed").slice(-3);
      if (last3.length === 3 && last3.every((s) => s.page_changed === false && s.kind !== "wait"))
        return stop("stalled", "Three actions in a row left the page unchanged; stopping rather than repeating them.");
      continue;
    }

    state = outcome.state;
    record({ ...base, label, kind: row.kind, text, outcome: "refused", act_ms, note: outcome.error.message });
  }
}
