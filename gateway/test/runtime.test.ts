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
  assert.equal(rc.idleTtlSec, 900, "detached idle tier");
  assert.equal(rc.attachedIdleTtlSec, 14400, "attached idle tier (issue #57), 4h by default");
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

test("ATTACHED_IDLE_TTL_SEC=0 is reported as-is (never-reap-attached escape hatch)", () => {
  const { cfg } = runtimeWithEnv({ ATTACHED_IDLE_TTL_SEC: "0" }) as {
    cfg: Record<string, unknown>;
  };
  assert.equal(cfg.attachedIdleTtlSec, 0, "0 must be visible, not defaulted away");
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

test("chikin_achieve's key is reported as present or absent, never as itself (#103)", () => {
  const secret = "sk-ant-test-0123456789abcdef";
  const on = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: secret, ANTHROPIC_API_KEY: "", CHIKIN_DECIDER_MODEL: "" });
  const cfg = on.cfg as Record<string, unknown>;
  assert.equal(cfg.achieve, true);
  assert.equal(cfg.deciderModel, "claude-haiku-5-5");
  assert.ok(!JSON.stringify(on).includes(secret), "/healthz and the dashboard are unauthenticated");
  const off = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "", CHIKIN_OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant-shell-key" }).cfg as Record<string, unknown>;
  assert.equal(off.achieve, false);
});

test("OpenRouter is the decider only without an Anthropic key, with its own default model", () => {
  const secret = "sk-or-v1-test-0123456789";
  const or = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "", CHIKIN_OPENROUTER_API_KEY: secret, CHIKIN_DECIDER_MODEL: "" });
  const cfg = or.cfg as Record<string, unknown>;
  assert.equal(cfg.achieve, true);
  assert.equal(cfg.deciderProvider, "openrouter");
  assert.equal(cfg.deciderModel, "jev-latest", "Jev is the OpenRouter default");
  assert.equal(cfg.textModel, "anthropic/claude-haiku-5.5");
  assert.ok(!JSON.stringify(or).includes(secret));

  const both = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "sk-ant-x", CHIKIN_OPENROUTER_API_KEY: secret, CHIKIN_DECIDER_MODEL: "" }).cfg as Record<string, unknown>;
  assert.equal(both.deciderProvider, "anthropic", "the direct key wins");
  assert.equal(both.deciderModel, "claude-haiku-5-5");

  const jev = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "", CHIKIN_OPENROUTER_API_KEY: secret, CHIKIN_DECIDER_MODEL: "typesafe/jev-router" }).cfg as Record<string, unknown>;
  assert.equal(jev.deciderModel, "typesafe/jev-router");

  const shell = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "", CHIKIN_OPENROUTER_API_KEY: "", OPENROUTER_API_KEY: secret }).cfg as Record<string, unknown>;
  assert.equal(shell.achieve, false, "a shell's own OPENROUTER_API_KEY does not switch it on");
  assert.equal(shell.deciderModel, null);
});

test("jev-* on the OpenRouter key means Jev decides, with a text model for fills", () => {
  const cfg = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "", CHIKIN_OPENROUTER_API_KEY: "sk-or-x", CHIKIN_DECIDER_MODEL: "jev-latest", CHIKIN_TEXT_MODEL: "" }).cfg as Record<string, unknown>;
  assert.equal(cfg.deciderModel, "jev-latest");
  assert.equal(cfg.textModel, "anthropic/claude-haiku-5.5");
  const router = runtimeWithEnv({ CHIKIN_ANTHROPIC_API_KEY: "", CHIKIN_OPENROUTER_API_KEY: "sk-or-x", CHIKIN_DECIDER_MODEL: "typesafe/jev-router" }).cfg as Record<string, unknown>;
  assert.equal(router.textModel, null, "the router is a chat model; it writes its own text");
});
