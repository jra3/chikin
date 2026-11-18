import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cdmSpawnParams } from "../src/cdm-spawn.js";
import { withCdmStdio } from "./cdm-stdio.js";

/**
 * A chrome-devtools-mcp child started the gateway's way forks nothing (#128).
 *
 * Upstream's telemetry forks a watchdog (~90 MiB PSS) for the life of every
 * session, and its update check forks a detached npm-registry probe. On the
 * live fleet the watchdog was a second process per session that nobody had
 * noticed. This test asserts the PROCESS TREE, not the argv, because the argv
 * check passes just as well when upstream renames the flag or adds a new
 * default-on fork.
 *
 * `CI` is removed from the env first: upstream treats it as a telemetry
 * opt-out, so without this the test would pass on CI for the wrong reason.
 * HOME is an empty directory, because the update check skips itself for 24h
 * after the last one it ran under the same HOME. Its forked probe exits too
 * fast to catch in the process tree, so the test looks for the cache file
 * upstream writes just before forking it.
 */

const DEAD_BROWSER_URL = "http://127.0.0.1:1";

/** Live children of `pid`, read from /proc (Linux, which is all CI runs). */
function childrenOf(pid: number): string[] {
  const out: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // exited while we looked
    }
    // `pid (comm) state ppid ...`; comm may contain spaces and parens.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[1]) !== pid || fields[0] === "Z") continue;
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      /* gone */
    }
    out.push(`${entry}: ${cmd}`);
  }
  return out;
}

test("the gateway's spawn params turn telemetry off and keep operator args last", () => {
  const { args, env } = cdmSpawnParams("http://10.0.0.5:9222", ["--usage-statistics"]);
  assert.deepEqual(args, [
    "--browserUrl",
    "http://10.0.0.5:9222",
    "--no-usage-statistics",
    "--usage-statistics",
  ]);
  assert.equal(env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, "1");
});

test("a child spawned the gateway's way forks no watchdog and no update check", async () => {
  const savedCi = process.env.CI;
  const savedHome = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), "cdm-spawn-home-"));
  delete process.env.CI;
  process.env.HOME = home;
  try {
    const forked = await withCdmStdio(
      { browserUrl: DEAD_BROWSER_URL, clientName: "chikin-spawn-probe", timeoutMs: 30_000 },
      async (session) => {
        await session.call("tools/list");
        // The watchdog is forked during server construction, before the
        // initialize reply; the update check right after startup. A second
        // round trip plus a short wait covers both without racing either.
        await new Promise((r) => setTimeout(r, 1_000));
        return childrenOf(session.pid);
      },
    );
    assert.deepEqual(forked, [], `the child forked:\n${forked.join("\n")}`);
    assert.ok(
      !existsSync(path.join(home, ".cache", "chrome-devtools-mcp")),
      "the child ran its npm update check",
    );
  } finally {
    if (savedCi !== undefined) process.env.CI = savedCi;
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
