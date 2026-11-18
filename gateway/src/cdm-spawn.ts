/**
 * How the gateway starts a chrome-devtools-mcp child: argv and the env added on
 * top of the MCP SDK's default (sudo-style) inherited set.
 *
 * Upstream does two things on startup that we turn off (#128):
 *
 * - Usage statistics are ON unless `--no-usage-statistics`, `CI` or
 *   `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` is set. When on, its Clearcut
 *   logger forks a watchdog process, ~90 MiB PSS, for the life of every
 *   session, and posts tool usage to Google. Nobody here opted into either.
 * - Once a day per HOME, it spawns a DETACHED process that queries the npm
 *   registry for a newer version. A gateway pins its version; the answer is
 *   never acted on.
 *
 * The flag and the env var both go in, because they are read in different
 * places: the flag by yargs, the env var by `checkForUpdates`, which has no flag.
 *
 * `gateway/test/cdm-stdio.ts` spawns through this too, so the test harness is
 * hermetic for the same reason the gateway is, and
 * `cdm-spawn.test.ts` fails if a real child started this way forks anything.
 */
export function cdmSpawnParams(
  browserUrl: string,
  extraArgs: readonly string[] = [],
): { args: string[]; env: Record<string, string> } {
  return {
    // Operator args go last so CDM_EXTRA_ARGS=--usage-statistics can still
    // opt back in: yargs takes the last occurrence of a boolean.
    args: ["--browserUrl", browserUrl, "--no-usage-statistics", ...extraArgs],
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
  };
}
