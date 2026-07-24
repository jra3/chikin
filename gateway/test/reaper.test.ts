import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Registry } from "../src/registry.js";
import { Reaper } from "../src/reaper.js";
import { config } from "../src/config.js";

function fakeProvisioner(fleet: { name: string; state: string }[] = []) {
  const stopped: string[] = [];
  const removed: string[] = [];
  const volumesRemoved: string[] = [];
  const order: string[] = [];
  const provisioner = {
    listFleet: async () =>
      fleet.map((m) => ({ name: m.name, containerId: m.name, state: m.state, status: m.state })),
    stopContainer: async (n: string) => {
      stopped.push(n);
      order.push(`stop:${n}`);
    },
    removeContainer: async (n: string) => {
      removed.push(n);
      order.push(`rm-container:${n}`);
    },
    // Mirrors the real signature: name-scoped (only inst-* is disposable) and
    // guard-gated (a provision in flight calls the removal off).
    removeInstanceVolume: async (n: string, guard?: () => boolean) => {
      if (!n.startsWith("inst-") || n === "inst-") return false;
      if (guard && !guard()) return false;
      volumesRemoved.push(n);
      order.push(`rm-volume:${n}`);
      return true;
    },
  };
  return { provisioner, stopped, removed, volumesRemoved, order };
}

test("reaper reclaims idle browsers but spares attached ones", async () => {
  const reg = new Registry();
  // idle: last activity at t=0, no open stream
  reg.touch("idle", 0);
  // attached: an SSE stream is open -> never reap
  reg.streamOpened("attached", 0);

  const { provisioner, stopped, removed } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(config.idleTtlMs + 1000);

  assert.deepEqual(stopped, ["idle"], "only the idle, unattached browser is stopped");
  assert.deepEqual(removed, ["idle"], "reaped container is removed, not just stopped");
  assert.equal(reg.getActivity("idle"), undefined, "idle activity dropped after reap");
  assert.ok(reg.getActivity("attached"), "attached browser preserved");
});

test("a browser idle within the TTL is not reaped", async () => {
  const reg = new Registry();
  reg.touch("fresh", 1000);
  const { provisioner, stopped } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(1000 + config.idleTtlMs - 1);
  assert.deepEqual(stopped, [], "within TTL -> not reaped");
});

test("a mid-provision (pending) browser is not reaped even when idle past the TTL", async () => {
  const reg = new Registry();
  // reserve() stamps a reap-eligible activity record (streams=0) up front, but
  // the name stays pending until provisioning finishes — a slow cold start must
  // not be torn down mid-flight (CHK-015).
  reg.reserve("provisioning", 0);
  const { provisioner, stopped, removed } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);

  await reaper.sweep(config.idleTtlMs + 5000);

  assert.deepEqual(stopped, [], "pending name spared while mid-provision");
  assert.deepEqual(removed, [], "pending container not removed");
  assert.ok(reg.getActivity("provisioning"), "activity record preserved");

  // Once promoted to a live session (no longer pending) and left idle, it reaps.
  reg.release("provisioning"); // simulate provision resolving to no live session
  await reaper.sweep(config.idleTtlMs * 2 + 5000);
  assert.deepEqual(stopped, ["provisioning"], "reaped once no longer pending and idle");
});

// --- Two-tier idle TTL (issue #57) ------------------------------------------
// An attached client used to make a browser unreapable outright, so a fleet
// saturated at MAX_FLEET with every browser parked on about:blank had no
// reclaimable slot. Attachment now buys ATTACHED_IDLE_TTL_SEC (default 4h) of
// grace, measured against REAL browser work — never against `last`, which the
// client bridge's 120s keepalive ping keeps permanently fresh.

const HOUR = 3600_000;

test("an attached session past the attached TTL with no browser work is reclaimed", async () => {
  const reg = new Registry();
  const now = 8 * HOUR;
  reg.streamOpened("inst-3244808", 0); // client attached since t=0, never left
  reg.touch("inst-3244808", now - 30_000); // ...and its heartbeat ping just landed

  const { provisioner, stopped, removed } = fakeProvisioner();
  await new Reaper(reg, provisioner as never).sweep(now);

  assert.deepEqual(stopped, ["inst-3244808"], "8h attached with zero tool calls -> reclaimed");
  assert.deepEqual(removed, ["inst-3244808"], "container removed, so the slot is really freed");
  assert.equal(reg.getActivity("inst-3244808"), undefined);
});

test("the client heartbeat cannot keep an attached browser alive (the #57 mechanism)", async () => {
  const reg = new Registry();
  const now = 6 * HOUR;
  reg.streamOpened("inst-1", 0);
  // Simulate the measured 120s sawtooth right up to the sweep: `last` is never
  // more than a ping old, so the OLD single-tier clock could never fire.
  for (let t = 0; t <= now; t += 120_000) reg.touch("inst-1", t);
  assert.ok(now - reg.getActivity("inst-1")!.last < 120_000, "idle clock is fresh, as measured live");

  const { provisioner, stopped } = fakeProvisioner();
  await new Reaper(reg, provisioner as never).sweep(now);
  assert.deepEqual(stopped, ["inst-1"], "reaped on browser activity, not protocol traffic");
});

test("an attached session merely between tool calls is spared", async () => {
  const reg = new Registry();
  const now = 8 * HOUR;
  reg.streamOpened("inst-2", 0);
  // Last real browser work an hour ago: well past IDLE_TTL_SEC (900s) but
  // comfortably inside the 4h attached tier. A working session must not be
  // evicted just because it paused to think.
  reg.touchBrowserActivity("inst-2", now - HOUR);

  const { provisioner, stopped } = fakeProvisioner();
  await new Reaper(reg, provisioner as never).sweep(now);
  assert.deepEqual(stopped, [], "recent browser work protects an attached session");
});

test("a DETACHED session still reaps on the short TTL, against the plain idle clock", async () => {
  const reg = new Registry();
  // Recent browser work, but the client is gone: the detached tier is unchanged
  // and must not be widened to the attached grace period.
  reg.touch("inst-3", 0);
  reg.touchBrowserActivity("inst-3", 0);

  const { provisioner, stopped } = fakeProvisioner();
  await new Reaper(reg, provisioner as never).sweep(config.idleTtlMs + 1000);
  assert.deepEqual(stopped, ["inst-3"], "detached TTL unchanged");
});

test("evicting an attached disposable browser discards its profile volume", async () => {
  const reg = new Registry();
  const now = 8 * HOUR;
  reg.streamOpened("inst-77", 0);
  reg.touch("inst-77", now - 1000);

  const { provisioner, volumesRemoved, order } = fakeProvisioner();
  await new Reaper(reg, provisioner as never).sweep(now);

  // The captain accepted this consequence knowingly: since #58 an evicted
  // instance loses its profile, so the transparent reconnect starts from a
  // fresh seed clone. The reaper logs it explicitly for exactly that reason.
  assert.deepEqual(volumesRemoved, ["inst-77"]);
  assert.deepEqual(order, ["stop:inst-77", "rm-container:inst-77", "rm-volume:inst-77"]);
});

test("an attached name that is mid-provision is still spared (CHK-015)", async () => {
  const reg = new Registry();
  const now = 8 * HOUR;
  reg.reserve("inst-88", 0);
  reg.streamOpened("inst-88", 0);

  const { provisioner, stopped, volumesRemoved } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(now);
  assert.deepEqual(stopped, [], "the attached tier does not bypass the pending guard");
  assert.deepEqual(volumesRemoved, [], "and no volume is pulled out from under it");

  reg.release("inst-88");
  await reaper.sweep(now);
  assert.deepEqual(stopped, ["inst-88"], "reclaimed once the provision settled");
});

// config is read once at module load, so the knob is exercised in a fresh
// process (same pattern as provisioner.test.ts / runtime.test.ts). The scenario
// is the one above: attached for 8h, heartbeat fresh, zero browser work.
function sweepAttachedWithEnv(env: Record<string, string>): string[] {
  const reg = fileURLToPath(new URL("../src/registry.js", import.meta.url));
  const reap = fileURLToPath(new URL("../src/reaper.js", import.meta.url));
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `Promise.all([import(${JSON.stringify(reg)}), import(${JSON.stringify(reap)})]).then(([r, k]) => {
         const registry = new r.Registry();
         const now = 8 * 3600000;
         registry.streamOpened("inst-x", 0);
         registry.touch("inst-x", now - 30000);
         const stopped = [];
         const provisioner = {
           listFleet: async () => [],
           stopContainer: async (n) => { stopped.push(n); },
           removeContainer: async () => {},
           removeInstanceVolume: async () => false,
         };
         return new k.Reaper(registry, provisioner).sweep(now)
           .then(() => process.stdout.write("RESULT:" + JSON.stringify(stopped)));
       });`,
    ],
    // The reaper logs to stdout, so the result rides a marker line.
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return JSON.parse(out.slice(out.lastIndexOf("RESULT:") + "RESULT:".length)) as string[];
}

test("ATTACHED_IDLE_TTL_SEC=0 restores the old never-reap-attached behaviour", () => {
  assert.deepEqual(
    sweepAttachedWithEnv({ ATTACHED_IDLE_TTL_SEC: "0" }),
    [],
    "0 is the documented escape hatch",
  );
  // And a tuned-down value takes effect, so the knob is genuinely runtime-tunable.
  assert.deepEqual(sweepAttachedWithEnv({ ATTACHED_IDLE_TTL_SEC: "60" }), ["inst-x"]);
  // Default (4h) also evicts this 8h-idle session.
  assert.deepEqual(sweepAttachedWithEnv({}), ["inst-x"]);
});

// --- Instance profile volumes (issue #58) -----------------------------------
// Reaping a container used to leave chikin-profile-inst-<id> behind forever
// (~200 MB per browser ever provisioned; 222 orphans / ~47 GB on one host).

test("reaping a disposable browser removes its instance volume with the container", async () => {
  const reg = new Registry();
  reg.touch("inst-18051", 0);

  const { provisioner, removed, volumesRemoved, order } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(config.idleTtlMs + 1000);

  assert.deepEqual(removed, ["inst-18051"], "container removed");
  assert.deepEqual(volumesRemoved, ["inst-18051"], "instance volume removed too");
  // Volume removal comes after container removal, so the volume is never pulled
  // out from under a container that still mounts it.
  assert.deepEqual(order, [
    "stop:inst-18051",
    "rm-container:inst-18051",
    "rm-volume:inst-18051",
  ]);
});

test("reaping a named browser preserves its profile volume (golden/hermes/sticky)", async () => {
  const reg = new Registry();
  for (const name of ["golden", "hermes", "alice"]) reg.touch(name, 0);

  const { provisioner, removed, volumesRemoved } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(config.idleTtlMs + 1000);

  assert.deepEqual(removed, ["golden", "hermes", "alice"], "containers still reclaimed");
  assert.deepEqual(volumesRemoved, [], "saved logins survive the reap");
});

test("a mid-provision browser keeps its freshly-seeded volume (CHK-015)", async () => {
  const reg = new Registry();
  // Idle past the TTL AND pending: the sweep must skip it entirely. The guard
  // the reaper hands the provisioner is the second line of defence, re-checked
  // inside the create gate.
  reg.reserve("inst-99", 0);

  const { provisioner, volumesRemoved } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(config.idleTtlMs + 5000);
  assert.deepEqual(volumesRemoved, [], "no volume removed while provisioning");

  reg.release("inst-99");
  await reaper.sweep(config.idleTtlMs * 2 + 5000);
  assert.deepEqual(volumesRemoved, ["inst-99"], "removed once the provision settled");
});

test("orphan running containers are adopted, then reaped after the TTL", async () => {
  const reg = new Registry();
  const { provisioner, stopped } = fakeProvisioner([{ name: "orphan", state: "running" }]);
  const reaper = new Reaper(reg, provisioner as never);

  // First sweep adopts (stamps activity = now); not reaped yet.
  await reaper.sweep(1000);
  assert.deepEqual(stopped, [], "adopted, not immediately reaped");
  assert.ok(reg.getActivity("orphan"), "orphan now tracked");

  // A later sweep past the TTL reaps it.
  await reaper.sweep(1000 + config.idleTtlMs + 1);
  assert.deepEqual(stopped, ["orphan"], "orphan reaped after TTL");
});
