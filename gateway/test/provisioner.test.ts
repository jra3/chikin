import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resourceLimits } from "../src/provisioner.js";
import { config } from "../src/config.js";

test("resourceLimits maps the default env config onto HostConfig caps (M3)", () => {
  const limits = resourceLimits();

  // Memory hard cap + swap pinned equal (no swap escape).
  assert.equal(limits.Memory, config.memoryMb * 1024 * 1024);
  assert.equal(limits.MemorySwap, limits.Memory, "swap pinned to Memory");
  // Must exceed the 2g ShmSize so a full /dev/shm can't OOM Chrome.
  assert.ok((limits.Memory ?? 0) > 2 * 1024 * 1024 * 1024, "memory leaves shm headroom");

  // Fork-bomb guard.
  assert.equal(limits.PidsLimit, config.pidsLimit);

  // CPU cap via NanoCpus (1 CPU == 1e9).
  assert.equal(limits.NanoCpus, Math.round(config.cpus * 1e9));

  // fd ceiling, soft == hard.
  assert.deepEqual(limits.Ulimits, [
    { Name: "nofile", Soft: config.nofile, Hard: config.nofile },
  ]);
});

test("shipped defaults keep the caps present and Chrome-viable", () => {
  const limits = resourceLimits();
  assert.equal(limits.Memory, 3072 * 1024 * 1024);
  assert.equal(limits.MemorySwap, 3072 * 1024 * 1024);
  assert.equal(limits.PidsLimit, 512);
  assert.equal(limits.NanoCpus, 2_000_000_000);
  assert.deepEqual(limits.Ulimits, [{ Name: "nofile", Soft: 8192, Hard: 8192 }]);
});

// config reads process.env once at module load, so env overrides are exercised
// in a fresh process. Import the built .js sibling of this test's src module.
function limitsWithEnv(env: Record<string, string>): Record<string, unknown> {
  const mod = fileURLToPath(new URL("../src/provisioner.js", import.meta.url));
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(mod)}).then(m => process.stdout.write(JSON.stringify(m.resourceLimits())));`,
    ],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return JSON.parse(out);
}

test("env overrides take effect", () => {
  const limits = limitsWithEnv({
    BROWSER_MEMORY_MB: "4096",
    BROWSER_PIDS_LIMIT: "256",
    BROWSER_CPUS: "1.5",
    BROWSER_NOFILE: "4096",
  });
  assert.equal(limits.Memory, 4096 * 1024 * 1024);
  assert.equal(limits.MemorySwap, 4096 * 1024 * 1024);
  assert.equal(limits.PidsLimit, 256);
  assert.equal(limits.NanoCpus, 1_500_000_000);
  assert.deepEqual(limits.Ulimits, [{ Name: "nofile", Soft: 4096, Hard: 4096 }]);
});

test("a limit set to 0 is omitted so operators can opt out", () => {
  const limits = limitsWithEnv({
    BROWSER_MEMORY_MB: "0",
    BROWSER_CPUS: "0",
    BROWSER_NOFILE: "0",
    BROWSER_PIDS_LIMIT: "0",
  });
  assert.equal(limits.Memory, undefined);
  assert.equal(limits.MemorySwap, undefined);
  assert.equal(limits.PidsLimit, undefined);
  assert.equal(limits.NanoCpus, undefined);
  assert.equal(limits.Ulimits, undefined);
});
