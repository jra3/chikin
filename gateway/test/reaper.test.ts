import test from "node:test";
import assert from "node:assert/strict";
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
