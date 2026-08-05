import test from "node:test";
import assert from "node:assert/strict";
import { planBind, WILDCARD } from "../src/bind.js";
import { Provisioner } from "../src/provisioner.js";

/**
 * Listen-set selection (CHK-002 / issue #20).
 *
 * The property under test is "the gateway never listens on the interface
 * browsers can reach". These tests can only prove we *computed* that set —
 * proving Chrome-in-a-container actually cannot open :8080 needs a real
 * browser, which is `itest/gateway-reachability.mjs`. Both halves matter; this
 * one is the cheap one.
 */

test("an explicit HOST is honoured verbatim", () => {
  // An operator who pinned an address is not asking us to second-guess it, and
  // the wildcard is the only value that silently includes the browser plane.
  assert.deepEqual(planBind("127.0.0.1", "172.28.0.5").hosts, ["127.0.0.1"]);
  assert.deepEqual(planBind("10.0.0.9", null).hosts, ["10.0.0.9"]);
  assert.equal(planBind("127.0.0.1", null).warning, undefined);
});

test("the wildcard is narrowed to loopback + the egress address", () => {
  const plan = planBind(WILDCARD, "172.28.0.5");
  assert.deepEqual(plan.hosts, ["127.0.0.1", "172.28.0.5"]);
  assert.equal(plan.warning, undefined);
  // The browser data plane address must never appear in the listen set. The
  // point of the whole change: chikin-net is where browsers live.
  assert.ok(!plan.hosts.includes("172.29.0.5"));
  assert.ok(!plan.hosts.includes(WILDCARD));
});

test("loopback stays in the set so the in-container healthcheck still passes", () => {
  // docker-compose.yml's healthcheck runs `fetch('http://127.0.0.1:8080/healthz')`
  // INSIDE the container. Dropping loopback would fail the container health
  // check while the gateway looked fine from the host.
  assert.ok(planBind(WILDCARD, "172.28.0.5").hosts.includes("127.0.0.1"));
});

test("an unresolvable egress address falls back to the wildcard, loudly", () => {
  const plan = planBind(WILDCARD, null);
  assert.deepEqual(plan.hosts, [WILDCARD]);
  assert.match(plan.warning ?? "", /CHK-002/);
  assert.match(plan.warning ?? "", /ALL interfaces/);
});

// --- the Docker half of it --------------------------------------------------

function fakeDocker(networks: Record<string, { IPAddress?: string }> | null, throws = false) {
  return {
    getContainer: () => ({
      inspect: async () => {
        if (throws) throw new Error("connect ECONNREFUSED docker-socket-proxy:2375");
        return { NetworkSettings: networks ? { Networks: networks } : {} };
      },
    }),
  };
}

test("selfEgressIp reads this container's address on the egress network", async () => {
  const p = new Provisioner(
    fakeDocker({
      "chikin-control": { IPAddress: "192.168.112.3" },
      "chikin-net": { IPAddress: "172.29.0.5" },
      "chikin-egress": { IPAddress: "172.28.0.5" },
    }) as never,
  );
  assert.equal(await p.selfEgressIp(), "172.28.0.5");
});

test("selfEgressIp returns null rather than throwing when Docker is unreachable", async () => {
  // Degrade to the warned fallback instead of taking the whole fleet down: a
  // gateway that cannot reach the socket-proxy cannot provision anyway.
  const p = new Provisioner(fakeDocker(null, true) as never);
  assert.equal(await p.selfEgressIp(), null);
});

test("selfEgressIp returns null when the gateway is not on the egress network", async () => {
  const p = new Provisioner(fakeDocker({ "chikin-net": { IPAddress: "172.29.0.5" } }) as never);
  assert.equal(await p.selfEgressIp(), null);
});

test("selfEgressIp returns null when the network exists but carries no address", async () => {
  const p = new Provisioner(fakeDocker({ "chikin-egress": { IPAddress: "" } }) as never);
  assert.equal(await p.selfEgressIp(), null);
});
