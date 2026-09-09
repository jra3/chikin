import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  classifyProbe,
  hostReachWarning,
  probeConnect,
  probeHostReach,
} from "../src/hostreach.js";
import { Provisioner } from "../src/provisioner.js";

/**
 * Can a browser reach a service on its own host?
 *
 * On a host that denies inbound by default it cannot, at any address, and the
 * client sees `Navigation timeout of 10000 ms exceeded` — which reads like a
 * slow server and sends a session hunting through bind addresses. The gateway
 * says so instead. See hostreach.ts for the mechanism.
 *
 * The load-bearing distinction is refused vs. dropped: any answer — an RST, or
 * the ICMP port-unreachable a REJECT-mode firewall sends, which Linux also
 * surfaces as ECONNREFUSED — proves the packet reached the host; silence is
 * the default-deny signature. (So a REJECT-mode host reads as reachable and
 * gets no warning, which is fine: there the browser fails fast with
 * ERR_CONNECTION_REFUSED rather than the misleading timeout.) That is the
 * classifier, and it is pure. The socket half is tested where the answer is
 * deterministic on any machine — loopback.
 */

test("an answer of any kind means the host is reachable", () => {
  assert.equal(classifyProbe({ kind: "connected" }), "reachable");
  assert.equal(classifyProbe({ kind: "refused", code: "ECONNREFUSED" }), "reachable");
  assert.equal(classifyProbe({ kind: "refused", code: "ECONNRESET" }), "reachable");
});

test("silence is the default-deny signature", () => {
  assert.equal(classifyProbe({ kind: "timeout" }), "blocked");
});

test("any other failure is 'unknown', not a firewall diagnosis", () => {
  // No route, or a REJECT that surfaces as something other than a refusal, is a
  // different fault. Reporting it as a blocked firewall would send the operator
  // to write a ufw rule that changes nothing.
  assert.equal(classifyProbe({ kind: "error", code: "EHOSTUNREACH" }), "unknown");
  assert.equal(classifyProbe({ kind: "error", code: "ENETUNREACH" }), "unknown");
  assert.equal(classifyProbe({ kind: "error", code: "EACCES" }), "unknown");
});

test("a closed port answers with a refusal, so the path counts as reachable", async () => {
  // The probe deliberately aims at a port nothing listens on: the expected
  // answer IS the refusal. Loopback gives that deterministically.
  const outcome = await probeConnect("127.0.0.1", 1, 1000);
  assert.equal(outcome.kind, "refused");
  assert.equal(await probeHostReach("127.0.0.1", 1, 1000), "reachable");
});

test("a listener is equally good evidence — the question is whether anything answers", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.deepEqual(await probeConnect("127.0.0.1", port, 1000), { kind: "connected" });
    assert.equal(await probeHostReach("127.0.0.1", port, 1000), "reachable");
  } finally {
    server.close();
  }
});

test("a blackholed address never comes back as reachable", async () => {
  // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) and is not routed. Whether this host
  // drops it (timeout) or has no route at all (ENETUNREACH) depends on the
  // network, so the assertion is the one that must hold either way: nothing
  // answered, so we must not claim the path is open.
  assert.notEqual(await probeHostReach("192.0.2.1", 1, 250), "reachable");
});

test("the warning names the symptom, the address, the cure, and what it cannot see", () => {
  const w = hostReachWarning("172.28.0.1");
  assert.match(w, /172\.28\.0\.1/);
  assert.match(w, /bin\/chikin-allow-host <port>/);
  // The operator meets the timeout before they meet this text.
  assert.match(w, /timeout/i);
  // The probe reads the host's DEFAULT policy. The cure it prescribes is
  // per-port, which leaves the probe port dropped, so on a correctly
  // configured host the warning still fires — it has to say it is expected
  // once the needed ports are allowed and name the record of which those
  // are, or it can never clear and gets ignored.
  assert.match(w, /default/i);
  assert.match(w, /bin\/chikin-allow-host --status/);
  // Never advertise the blanket rule: it hands every host service, sshd
  // included, to the least-trusted process on the machine.
  assert.doesNotMatch(w, /ufw allow from/);
});

// --- the Docker half --------------------------------------------------------

function fakeDocker(networks: Record<string, unknown> | null, throws = false) {
  return {
    getContainer: () => ({
      inspect: async () => {
        if (throws) throw new Error("connect ECONNREFUSED docker-socket-proxy:2375");
        return { NetworkSettings: networks ? { Networks: networks } : {} };
      },
    }),
  };
}

test("selfEgressGateway reads the HOST's address on the egress network", async () => {
  // Read, never assumed to be `.1` of the subnet: the address belongs to the
  // network, and this is what the probe aims at.
  const p = new Provisioner(
    fakeDocker({
      "chikin-net": { IPAddress: "172.29.0.5", Gateway: "172.29.0.1" },
      "chikin-egress": { IPAddress: "172.28.0.5", Gateway: "172.28.0.1" },
    }) as never,
  );
  assert.equal(await p.selfEgressGateway(), "172.28.0.1");
});

test("selfEgressGateway returns null rather than throwing when Docker is unreachable", async () => {
  // A gateway that cannot ask Docker still has to start; the probe is skipped.
  const p = new Provisioner(fakeDocker(null, true) as never);
  assert.equal(await p.selfEgressGateway(), null);
});

test("selfEgressGateway returns null when the egress network carries no gateway", async () => {
  const p = new Provisioner(fakeDocker({ "chikin-egress": { Gateway: "" } }) as never);
  assert.equal(await p.selfEgressGateway(), null);
  const q = new Provisioner(fakeDocker({ "chikin-net": { Gateway: "172.29.0.1" } }) as never);
  assert.equal(await q.selfEgressGateway(), null);
});
