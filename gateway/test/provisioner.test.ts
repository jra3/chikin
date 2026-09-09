import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resourceLimits,
  buildCreateOptions,
  securityOpt,
  dockerStatus,
  Provisioner,
} from "../src/provisioner.js";
import { startDockerStub } from "./docker-stub.js";
import { withWarnings } from "./log-tap.js";
import { config, volumeName } from "../src/config.js";

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

// --- Renderer sandbox: seccomp delivery (H1) --------------------------------
// Run provisioner.securityOpt() in a fresh process so CHIKIN_SANDBOX (read once
// at config load) can be varied. Returns the SecurityOpt string[].
function securityOptWithEnv(env: Record<string, string>): string[] {
  const mod = fileURLToPath(new URL("../src/provisioner.js", import.meta.url));
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(mod)}).then(m => process.stdout.write(JSON.stringify(m.securityOpt())));`,
    ],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return JSON.parse(out);
}

test("securityOpt: default (auto) keeps no-new-privileges AND inlines the seccomp profile", () => {
  // Default config.sandbox is auto in this process.
  const opt = securityOpt();
  assert.ok(opt.includes("no-new-privileges"), "no-new-privileges always on");
  const seccomp = opt.find((s) => s.startsWith("seccomp="));
  assert.ok(seccomp, "auto mode attaches a seccomp profile");
  // CRITICAL: over the Docker API the value must be inlined JSON CONTENT, not a
  // file path (the CLI reads a file; the API does not).
  const val = seccomp!.slice("seccomp=".length);
  assert.ok(val.startsWith("{"), "seccomp value is inlined JSON, not a path");
  const parsed = JSON.parse(val);
  assert.equal(parsed.defaultAction, "SCMP_ACT_ERRNO", "it is the moby-derived default profile");
  // The one widening: the 5 namespace/chroot syscalls are allowed unconditionally.
  const widened = parsed.syscalls[0];
  assert.equal(widened.action, "SCMP_ACT_ALLOW");
  assert.deepEqual(widened.names, ["clone", "clone3", "unshare", "setns", "chroot"]);
  assert.equal(widened.includes, undefined, "the allow group is unconditional (no cap gate)");
});

test("securityOpt: on also inlines the profile", () => {
  const opt = securityOptWithEnv({ CHIKIN_SANDBOX: "on" });
  assert.ok(opt.includes("no-new-privileges"));
  assert.ok(opt.some((s) => s.startsWith("seccomp={")), "on mode inlines the profile");
});

test("securityOpt: off is the pre-hardening posture — no-new-privileges only, no custom seccomp", () => {
  const opt = securityOptWithEnv({ CHIKIN_SANDBOX: "off" });
  assert.deepEqual(opt, ["no-new-privileges"]);
});

test("buildCreateOptions wires the sandbox: CHIKIN_SANDBOX env down + SecurityOpt, caps unchanged", () => {
  const opts = buildCreateOptions("bob");
  assert.ok(opts.Env?.includes(`CHIKIN_SANDBOX=${config.sandbox}`), "passes mode to the entrypoint");
  // Hardening invariants must remain: no cap added, no-new-privileges on.
  assert.deepEqual(opts.HostConfig?.CapDrop, ["ALL"]);
  assert.deepEqual(opts.HostConfig?.CapAdd, ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL"]);
  assert.ok(opts.HostConfig?.SecurityOpt?.includes("no-new-privileges"));
});

test("buildCreateOptions gives every browser one stable name for the host", () => {
  // Without it a browser told to open a dev server on the host has five
  // candidate addresses and no way to pick. The name resolves whether or not
  // the host firewall lets the packet through — it is a companion to
  // bin/chikin-allow-host, not a substitute. See hostreach.ts.
  const opts = buildCreateOptions("bob");
  assert.deepEqual(opts.HostConfig?.ExtraHosts, ["host.docker.internal:host-gateway"]);
});

// --- Per-name Downloads isolation (M2 / CHK-007 / issue #24) ----------------
// Each browser must mount only its own ${SHARED_DIR}/<name> subdir, never the
// bare shared root. Structural isolation: peers can't name each other's dirs.
test("buildCreateOptions scopes the shared scratch to a per-name subdir (M2)", () => {
  const opts = buildCreateOptions("alice");
  const binds = opts.HostConfig?.Binds ?? [];

  // ~/Downloads and the verbatim host-path mirror are both the per-name subdir.
  assert.ok(
    binds.includes(`${config.sharedDir}/alice:/home/chrome/Downloads:rw`),
    "Downloads bind is the per-name subdir",
  );
  assert.ok(
    binds.includes(`${config.sharedDir}/alice:${config.sharedDir}/alice:rw`),
    "verbatim host-path mirror is the per-name subdir (upload_file, issue #8)",
  );

  // Regression guard for the leak: no bind may reference the bare shared root.
  // The whole-dir mount (${SHARED_DIR}:...) is gone.
  for (const b of binds) {
    assert.ok(
      !b.startsWith(`${config.sharedDir}:`),
      `no bind references the bare shared root: ${b}`,
    );
  }

  // The /data profile bind is unchanged.
  assert.ok(
    binds.includes(`${volumeName("alice")}:/data`),
    "profile volume bind unchanged",
  );
});

// --- Seed-volume misconfiguration detection --------------------------------
// Startup asks Docker whether a seed volume exists so "seed on disk but
// SEED_VOLUME unset" (the ~7-week silent outage) can be warned about.
test("findSeedVolumes picks seed-looking volumes and ignores per-name profiles", async () => {
  const fake = {
    listVolumes: async () => ({
      Volumes: [
        { Name: "chikin-profile-alice" },
        { Name: "chikin-profile-seedy" }, // a browser literally named "seedy" is not a seed
        { Name: "chikin-seed" },
        { Name: "my-seed-backup" },
        { Name: "unrelated" },
      ],
    }),
  };
  const p = new Provisioner(fake as never);
  assert.deepEqual(await p.findSeedVolumes(), ["chikin-seed", "my-seed-backup"]);
});

test("findSeedVolumes tolerates a null volume list", async () => {
  const p = new Provisioner({ listVolumes: async () => ({ Volumes: null }) } as never);
  assert.deepEqual(await p.findSeedVolumes(), []);
});

// --- Container removal: failures stop being swallowed (SPY-161) -------------

// removeContainer carried the identical defect to removeInstanceVolume: it
// decided "already gone" by matching /no such container|404/i against an error
// message the daemon fills with the container's own name and id. So for a
// browser named inst-404 — or merely a container id containing 404, which is
// one hex digit's luck — every real removal failure went unlogged. Same fix,
// same wire, one function apart.

test("dockerStatus reads dockerode's numeric status and nothing else", () => {
  assert.equal(dockerStatus({ statusCode: 404 }), 404);
  assert.equal(dockerStatus({ statusCode: 0 }), 0, "0 is a status, not absence");
  // A transport error has none, and neither has anything that is not an error
  // object. Absence must stay distinguishable from a real code, because the
  // caller treats it as "may never have reached Docker".
  assert.equal(dockerStatus(new Error("ECONNREFUSED")), undefined);
  assert.equal(dockerStatus({ statusCode: "404" }), undefined, "a string is not a status");
  for (const junk of [null, undefined, "404", 404]) {
    assert.equal(dockerStatus(junk), undefined);
  }
});

test("a real failure removing a 404-NAMED container is reported, not swallowed", async (t) => {
  const name = "chikin-chrome-inst-404";
  const stub = await startDockerStub({
    containers: [{ Id: "a404bc", Names: [`/${name}`], State: "exited", Labels: {} }],
    removeContainerFailures: {
      [name]: { status: 500, message: `remove ${name}: driver "overlay2" failed` },
    },
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  const [, warnings] = await withWarnings(() => p.removeContainer("inst-404"));

  assert.equal(warnings.length, 1, "a 500 on inst-404 is a failure like any other");
  assert.match(warnings[0] ?? "", new RegExp(`remove ${name} failed`));
  assert.equal(stub.containers.length, 1, "and the container really did survive");
});

test("an already-gone container is quiet, and a live one is really removed", async (t) => {
  const stub = await startDockerStub({
    containers: [
      { Id: "a404bc", Names: ["/chikin-chrome-inst-404"], State: "running", Labels: {} },
    ],
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // force: true is what lets the gateway remove a still-running container —
  // real Docker answers 409 without it, which the stub models.
  const [, removedWarnings] = await withWarnings(() => p.removeContainer("inst-404"));
  assert.deepEqual(removedWarnings, [], "a successful force-remove says nothing");
  assert.deepEqual(stub.containers, [], "the running container was removed");
  assert.deepEqual(stub.requests, ["DELETE /containers/chikin-chrome-inst-404?force=true"]);

  // Now it is genuinely gone: a real 404, same 404-containing name.
  const [, goneWarnings] = await withWarnings(() => p.removeContainer("inst-404"));
  assert.deepEqual(goneWarnings, [], "already gone is nothing to do, whatever the name");
});

test("a stop failure on a 304-NAMED browser is reported, not swallowed", async (t) => {
  const name = "chikin-chrome-inst-304";
  const stub = await startDockerStub({
    containers: [{ Id: "c304ab", Names: [`/${name}`], State: "running", Labels: {} }],
    stopContainerFailures: {
      [name]: { status: 500, message: `stop ${name}: daemon failed` },
    },
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  const [, warnings] = await withWarnings(() => p.stopContainer("inst-304"));

  assert.equal(warnings.length, 1, "a 500 on inst-304 is a failure like any other");
  assert.match(warnings[0] ?? "", new RegExp(`stop ${name} failed`));
});

test("stopping an already-stopped or absent container is quiet", async (t) => {
  const stub = await startDockerStub({
    containers: [
      { Id: "c304ab", Names: ["/chikin-chrome-inst-304"], State: "running", Labels: {} },
    ],
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // Running -> stopped: the real thing, no warning.
  const [, first] = await withWarnings(() => p.stopContainer("inst-304"));
  assert.deepEqual(first, [], "a successful stop says nothing");
  assert.equal(stub.containers[0]?.State, "exited", "the container really stopped");

  // Already stopped: real Docker answers 304, which dockerode raises as an
  // error. It is the desired state, so it stays quiet — whatever the name.
  const [, again] = await withWarnings(() => p.stopContainer("inst-304"));
  assert.deepEqual(again, [], "304 already-stopped is nothing to do");

  // Gone entirely: 404. Not running is not running, and removeContainer —
  // which every caller runs next — already treats 404 the same way.
  stub.containers.splice(0, 1);
  const [, gone] = await withWarnings(() => p.stopContainer("inst-304"));
  assert.deepEqual(gone, [], "404 on a stop is the desired state too");
});
