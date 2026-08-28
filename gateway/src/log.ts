import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = order[config.logLevel as Level] ?? order.info;

type LogTap = (level: Level, line: string) => void;
const taps = new Set<LogTap>();

/**
 * Test seam: observe every emitted line, BEFORE the LOG_LEVEL threshold and
 * without monkey-patching the process streams (test/log-tap.ts is the one
 * consumer). Pre-threshold is deliberate — a test asserting "the gateway
 * warned here" pins what the code emits, not what the operator's configured
 * verbosity lets through, so the assertion must not change meaning under
 * LOG_LEVEL=error. Returns the untap function.
 */
export function tapLog(tap: LogTap): () => void {
  taps.add(tap);
  return () => void taps.delete(tap);
}

function emit(level: Level, msg: string, extra?: unknown): void {
  const line =
    extra === undefined
      ? `[${level}] ${msg}`
      : `[${level}] ${msg} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  for (const tap of taps) tap(level, line);
  if (order[level] < threshold) return;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
