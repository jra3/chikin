import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.js";
import { Reaper } from "../src/reaper.js";
import { config } from "../src/config.js";

function fakeProvisioner(fleet: { name: string; state: string }[] = []) {
  const stopped: string[] = [];
  const provisioner = {
    listFleet: async () =>
      fleet.map((m) => ({ name: m.name, containerId: m.name, state: m.state, status: m.state })),
    stopContainer: async (n: string) => void stopped.push(n),
  };
  return { provisioner, stopped };
}

test("reaper reclaims idle browsers but spares attached ones", async () => {
  const reg = new Registry();
  // idle: last activity at t=0, no open stream
  reg.touch("idle", 0);
  // attached: an SSE stream is open -> never reap
  reg.streamOpened("attached", 0);

  const { provisioner, stopped } = fakeProvisioner();
  const reaper = new Reaper(reg, provisioner as never);
  await reaper.sweep(config.idleTtlMs + 1000);

  assert.deepEqual(stopped, ["idle"], "only the idle, unattached browser is stopped");
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
