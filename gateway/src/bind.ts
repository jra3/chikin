/**
 * Which interfaces the gateway may listen on (CHK-002 / issue #20).
 *
 * The gateway sits on three networks: `chikin-control` (socket-proxy),
 * `chikin-net` (the browser data plane) and `chikin-egress` (which carries
 * ingress from the published 127.0.0.1:8080 port — internal networks can't).
 * With `HOST=0.0.0.0` it listened on all of them, so **every browser could
 * reach the gateway's own MCP endpoint over `chikin-net`**. `hostOk` is a
 * DNS-rebinding guard, not authentication — an in-network caller just sets the
 * Host header — and `GATEWAY_TOKEN` is empty by default and never covers the
 * dashboard or the noVNC proxy anyway (server.ts). So a compromised browser
 * could POST MCP to /b/<any-other-name>/ and drive the whole fleet, without
 * touching CDP.
 *
 * Binding, rather than a per-request check, is what closes this: a browser
 * scanning `chikin-net` finds a closed port, there is no handler to reach and
 * nothing to spoof, and the websocket upgrade path is covered for free.
 *
 * NOTE this is deliberately NOT cross-browser isolation. Browsers still share
 * `chikin-net` and can still drive each other over CDP :9222 and noVNC :6080.
 * That residual is accepted (docs/adr/0003): seeding clones the golden profile
 * into every new browser, so they are not separate identities to begin with.
 */

/** Loopback, for the in-container healthcheck (`node -e fetch(127.0.0.1:8080)`). */
const LOOPBACK = "127.0.0.1";
/** The wildcard we refuse to pass through, because it includes chikin-net. */
export const WILDCARD = "0.0.0.0";

export interface BindPlan {
  /** One listener per address. */
  hosts: string[];
  /** Non-empty when we could not narrow the wildcard and fell back to it. */
  warning?: string;
}

/**
 * Decide the listen set. Pure — `egressIp` is whatever the Docker lookup found
 * (see Provisioner.selfEgressIp), or null if it could not be determined.
 *
 * An explicit HOST is honoured verbatim: an operator who pinned one is not
 * asking us to second-guess it, and the wildcard is the only value that
 * silently includes the browser plane.
 */
export function planBind(host: string, egressIp: string | null): BindPlan {
  if (host !== WILDCARD) return { hosts: [host] };
  if (egressIp) return { hosts: [LOOPBACK, egressIp] };
  return {
    hosts: [WILDCARD],
    warning:
      `HOST=0.0.0.0 and this gateway's address on the egress network could not be resolved, ` +
      `so it is listening on ALL interfaces — including the browser data plane. A compromised ` +
      `browser can reach the MCP endpoint and drive every other browser in the fleet (CHK-002). ` +
      `This usually means the Docker socket-proxy is unreachable, in which case the gateway ` +
      `cannot provision browsers either — check it and recreate the gateway.`,
  };
}
