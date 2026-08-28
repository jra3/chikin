/**
 * The one shared tap over the gateway's log, replacing the three private
 * copies of a process.std{err,out}.write monkey-patch that volumes,
 * nav-watchdog and canary-legibility each hand-rolled (and each filtered
 * differently, so a log.ts format change would have emptied their captures
 * independently and silently). It rides log.ts's tapLog seam, so that format
 * is owned in exactly one place — and because the seam observes emit() BEFORE
 * the LOG_LEVEL threshold, these captures do not change meaning when the
 * environment exports LOG_LEVEL=error.
 *
 * log.js is imported lazily on purpose: config freezes its values at first
 * import, and several tests set process.env before dynamically importing the
 * gateway. A top-level import here would drag config in early through any
 * test that imports this helper at the top.
 */

type Level = "debug" | "info" | "warn" | "error";

const logModule = () => import("../src/log.js");

/** Run fn while capturing `[warn] ` lines; resolves to [result, warnings]. */
export async function withWarnings<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const { tapLog } = await logModule();
  const warnings: string[] = [];
  const untap = tapLog((level: Level, line: string) => {
    if (level === "warn") warnings.push(line);
  });
  try {
    return [await fn(), warnings];
  } finally {
    untap();
  }
}

/** Start capturing every emitted line, all levels; stop() detaches the tap. */
export async function tapLines(): Promise<{ lines: string[]; stop: () => void }> {
  const { tapLog } = await logModule();
  const lines: string[] = [];
  const stop = tapLog((_level: Level, line: string) => void lines.push(line));
  return { lines, stop };
}
