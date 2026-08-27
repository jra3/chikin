import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * One stdio JSON-RPC driver for the REAL chrome-devtools-mcp binary.
 *
 * Two callers need it and must not drift apart: `cdm-outputschema.test.ts`,
 * which asks the binary what it registers with no browser in existence, and
 * `itest/cdm-wire.mjs`, which drives a real navigation against a real browser.
 * It lives under `gateway/test/` so the harness can import it from
 * `gateway/dist`, the way it already imports `bridge.js`.
 *
 * Nothing here may assume the pinned package's on-disk layout: CDM_BIN exists
 * precisely so a relocated or bundled candidate build can be checked before a
 * bump is taken.
 */

export interface CdmSession {
  /**
   * `serverInfo` from the initialize reply — the only version string that does
   * not require guessing where the running build's package.json lives.
   */
  serverInfo: { name?: string; version?: string };
  /** Send a request; resolve its `result`, or throw what its `error` said. */
  call(method: string, params?: unknown): Promise<unknown>;
}

export interface CdmStdioOptions {
  /** `--browserUrl` for the child. It need not be reachable for a handshake. */
  browserUrl: string;
  /** `clientInfo.name` sent in initialize. */
  clientName: string;
  /**
   * Defaults to the pinned package's binary. `CDM_BIN` is not read here — only
   * `itest/cdm-wire.mjs` forwards it — so `CDM_BIN=… npm test` still checks the
   * PINNED build. Point the harness, not the unit suite, at a candidate.
   */
  bin?: string;
  timeoutMs?: number;
}

/**
 * Absolute path to the binary, taken from the `bin` field of the package.json
 * being resolved rather than from a hardcoded `build/src/bin/...` subpath that
 * only the current release happens to use.
 *
 * It must be the `chrome-devtools-mcp` entry, the one the gateway spawns. The
 * package also ships a `chrome-devtools` CLI, which starts the same server with
 * `--experimentalStructuredContent` in its defaults — a different reply shape,
 * so probing it would answer a question nobody here is asking.
 */
export function resolveCdmBin(override?: string): string {
  if (override) return override;
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("chrome-devtools-mcp/package.json");
  const bin = (require(manifest) as { bin?: string | Record<string, string> }).bin;
  const rel = typeof bin === "string" ? bin : bin?.["chrome-devtools-mcp"];
  if (!rel) throw new Error(`no "chrome-devtools-mcp" bin declared in ${manifest}`);
  return path.resolve(path.dirname(manifest), rel);
}

interface Reply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Spawn the binary, complete the MCP handshake, run `body` against it, and kill
 * it however `body` ends.
 */
export async function withCdmStdio<T>(
  opts: CdmStdioOptions,
  body: (session: CdmSession) => Promise<T> | T,
): Promise<T> {
  const bin = opts.bin ?? resolveCdmBin();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const child = spawn(
    process.execPath,
    [bin, "--browserUrl", opts.browserUrl, "--no-usage-statistics"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Keep the spawn hermetic. Upstream defaults to posting usage statistics
      // to a third party and to spawning a detached npm-registry update check
      // that writes ~/.cache; neither belongs in a test run, and neither may be
      // left to the incidental `CI` opt-out, since the point is the LOCAL run.
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      },
    },
  );

  const stderr: string[] = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  const replies = new Map<number, Reply>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += String(d);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      let msg: Reply & { id?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // the child logs non-JSON on stdout in some versions
      }
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });

  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  let nextId = 0;

  const call = async (method: string, params: unknown = {}): Promise<unknown> => {
    const id = ++nextId;
    send({ jsonrpc: "2.0", id, method, params });
    const deadline = Date.now() + timeoutMs;
    while (!replies.has(id)) {
      if (spawnError) throw new Error(`could not spawn ${bin}: ${String(spawnError)}`);
      if (child.exitCode !== null)
        throw new Error(`child exited (${child.exitCode}) before ${method}: ${stderr.join("")}`);
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${method}: ${stderr.join("")}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const reply = replies.get(id) as Reply;
    // A JSON-RPC error reply carries no `result`. Keeping only `result` turns it
    // into `undefined`, which every caller then misreports as its own emptiness
    // ("empty tool list", "parser found no pages") instead of what actually went
    // wrong inside the child.
    if (reply.error)
      throw new Error(`${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply.result;
  };

  try {
    const init = (await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: opts.clientName, version: "0.0.0" },
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return await body({ serverInfo: init?.serverInfo ?? {}, call });
  } finally {
    child.kill("SIGKILL");
  }
}
