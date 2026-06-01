type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const line = `[${level}] ${msg}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (extra !== undefined) {
    stream.write(`${line} ${typeof extra === "string" ? extra : JSON.stringify(extra)}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
