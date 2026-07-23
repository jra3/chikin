import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeConfig, seedingLine, configWarningsFor } from "../src/runtime.js";

// config reads process.env once at module load, so env overrides are exercised
// in a fresh process (same pattern as provisioner.test.ts).
function runtimeWithEnv(env: Record<string, string>): Record<string, unknown> {
  const mod = fileURLToPath(new URL("../src/runtime.js", import.meta.url));
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(mod)}).then(m => process.stdout.write(JSON.stringify({` +
        `cfg: m.runtimeConfig(), line: m.seedingLine()})));`,
    ],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test("runtimeConfig reports the env this process actually has, without secrets", () => {
  const rc = runtimeConfig();
  // Defaults (no env set in the test runner).
  assert.equal(rc.seedVolume, "");
  assert.equal(rc.seedingOn, false);
  assert.equal(rc.chromeImage, "chikin:local");
  assert.equal(rc.authEnabled, false);
  // /healthz and the dashboard are unauthenticated: never leak the token value.
  assert.ok(!JSON.stringify(rc).includes("GATEWAY_TOKEN"));
  assert.ok(!("token" in rc));
});

test("seeding state is stated unambiguously in both directions", () => {
  const off = seedingLine({ ...runtimeConfig(), seedVolume: "", seedingOn: false });
  assert.match(off, /seeding: OFF/);
  assert.match(off, /SEED_VOLUME/);
  assert.match(off, /blank profiles/);

  const on = seedingLine({ ...runtimeConfig(), seedVolume: "chikin-seed", seedingOn: true });
  assert.match(on, /seeding: ON/);
  assert.match(on, /chikin-seed/, "names the volume when on");
});

test("a set SEED_VOLUME flips the reported state (env is read at load)", () => {
  const { cfg, line } = runtimeWithEnv({ SEED_VOLUME: "chikin-seed", GATEWAY_TOKEN: "hunter2" }) as {
    cfg: Record<string, unknown>;
    line: string;
  };
  assert.equal(cfg.seedVolume, "chikin-seed");
  assert.equal(cfg.seedingOn, true);
  assert.equal(cfg.authEnabled, true, "auth reported as a boolean");
  assert.ok(!JSON.stringify(cfg).includes("hunter2"), "token value never surfaces");
  assert.match(line, /seeding: ON \(volume=chikin-seed\)/);
});

test("seed volume on the host + SEED_VOLUME unset is warned about", () => {
  const rc = { ...runtimeConfig(), seedVolume: "", seedingOn: false };
  const warnings = configWarningsFor(rc, ["chikin-seed"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /chikin-seed/);
  assert.match(warnings[0], /force-recreate/, "names the fix (restart is not enough)");

  // No seed volume on the host: "off" is plausibly deliberate, so stay quiet.
  assert.deepEqual(configWarningsFor(rc, []), []);
  // Seeding on: nothing to warn about.
  assert.deepEqual(
    configWarningsFor({ ...rc, seedVolume: "chikin-seed", seedingOn: true }, ["chikin-seed"]),
    [],
  );
});
