import { connect } from "node:net";

/**
 * Can a container on the egress network reach a service on the HOST?
 *
 * The one destination a coding agent wants its browser for most is the dev
 * server it just started on the same machine — and on a host whose firewall
 * denies inbound by default (Omarchy ships ufw with
 * `DEFAULT_INPUT_POLICY="DROP"`, and it is on), that is the one destination a
 * chikin browser cannot reach. Every host address behaves the same way:
 * `http://172.28.0.1:5173/`, the LAN address, the tailnet address, docker0's
 * gateway — all time out. Only the container's own loopback answers, with a
 * refusal, because inside the container 127.0.0.1 IS the container.
 *
 * Nothing about that is chikin's network options. Container->host traffic is
 * INPUT on the host, where Docker installs no rules and the host firewall's
 * default policy has the last word — unlike published-port ingress and
 * container->internet egress, which ride FORWARD/NAT through Docker's own
 * chains and therefore keep working. `enable_icc=false` on the egress network
 * is not involved either; that rule is bridge->bridge on FORWARD.
 *
 * Read the other way this is chikin's posture working as designed: a
 * compromised browser cannot reach a host service. So the cure is a narrow
 * per-port opt-in (`bin/chikin-allow-host <port>`), never a blanket allow —
 * and this module's job is only to tell the operator, because the symptom
 * ("Navigation timeout of 10000 ms exceeded") reads like a slow server and
 * costs a session an hour of bind-address guessing otherwise.
 *
 * The gateway shares `chikin-egress` with every browser, so its own probe is
 * representative: a rule scoped to that subnet covers both.
 */

/** What the probe concluded. Only "blocked" is worth warning about. */
export type HostReach = "reachable" | "blocked" | "unknown";

/** How one TCP connect attempt ended. */
export type ProbeOutcome =
  | { kind: "connected" }
  | { kind: "refused"; code: string }
  | { kind: "timeout" }
  | { kind: "error"; code: string };

/**
 * A port nothing listens on, so the expected answer is an RST. Any listener
 * that happens to be there is equally good evidence — "something answered" is
 * the whole question — so the choice cannot produce a false "blocked".
 *
 * What the probe measures is the host's DEFAULT inbound policy, not any
 * particular service: the cure is per-port (`bin/chikin-allow-host 5173`),
 * and a host with exactly the ports the operator needs allowed still drops
 * port 1, so the probe still reads "blocked" there. The warning therefore
 * describes the policy and points at `--status` for the per-port record,
 * rather than claiming nothing on the host is reachable.
 */
export const PROBE_PORT = 1;

/** Long enough to rule out a slow RST, short enough to not stall startup. */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * An answer of any kind means the packet reached the host, so the path is
 * open; silence is the default-deny signature. "Answer" is broader than an
 * RST: the ICMP port-unreachable a REJECT-mode firewall sends also surfaces
 * as ECONNREFUSED, and Node cannot tell the two apart, so a host with
 * DEFAULT_INPUT_POLICY="REJECT" reads as "reachable" and fires no warning
 * even though browsers cannot reach its services. That is acceptable, not
 * papered over: in that mode the browser fails fast with
 * ERR_CONNECTION_REFUSED instead of the misleading timeout this warning
 * exists for. Anything else — no route, an error that is not a refusal — is a
 * different fault, and is reported as "unknown" rather than dressed up as a
 * firewall diagnosis we cannot support.
 */
export function classifyProbe(outcome: ProbeOutcome): HostReach {
  switch (outcome.kind) {
    case "connected":
    case "refused":
      return "reachable";
    case "timeout":
      return "blocked";
    default:
      return "unknown";
  }
}

/** Error codes that mean the host answered, refusing. */
const REFUSALS = new Set(["ECONNREFUSED", "ECONNRESET"]);

/** One TCP connect attempt. Never throws; the outcome IS the result. */
export function probeConnect(
  host: string,
  port: number = PROBE_PORT,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => done({ kind: "timeout" }));
    socket.on("connect", () => done({ kind: "connected" }));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "UNKNOWN";
      done(REFUSALS.has(code) ? { kind: "refused", code } : { kind: "error", code });
    });
  });
}

/** Probe the host and classify the result in one step. */
export async function probeHostReach(
  host: string,
  port: number = PROBE_PORT,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<HostReach> {
  return classifyProbe(await probeConnect(host, port, timeoutMs));
}

/**
 * The operator-facing warning, for /healthz and the dashboard.
 *
 * Names the symptom first, because the operator meets the symptom before they
 * meet this text, and names one command as the cure.
 */
export function hostReachWarning(hostAddr: string): string {
  return (
    `This host drops inbound traffic from browsers by default: a TCP probe to ${hostAddr} was ` +
    `dropped (silently, not refused), which is what a host firewall denying inbound by default ` +
    `does — ufw with DEFAULT_INPUT_POLICY="DROP" is Omarchy's default. So no port on this host ` +
    `is reachable from a browser unless it was explicitly allowed: a browser asked to open a dev ` +
    `server on the host at a port that was not allowed will report a navigation timeout, at every ` +
    `host address (bridge gateway, LAN, tailnet) — binding the server to 0.0.0.0 does not help, ` +
    `because the packets are dropped on arrival. Allow the ports you actually want reachable, ` +
    `one at a time: bin/chikin-allow-host <port>. The probe reads the default policy, not ` +
    `per-port rules, so this warning is expected once the ports you need are allowed — ` +
    `bin/chikin-allow-host --status lists them. Internet access and published ports are unaffected.`
  );
}
