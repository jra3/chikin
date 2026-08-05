# Close the gateway to Browsers by binding; accept cross-Browser reachability

The gateway stops listening on `0.0.0.0`. It binds loopback plus its own
`chikin-egress` address only — never the `chikin-net` interface Browsers can
reach — so a Browser can no longer reach the gateway's MCP endpoint, dashboard
or noVNC proxy. Cross-Browser reachability on `chikin-net` (CDP `:9222`, noVNC
`:6080`) is **knowingly accepted and will not be fixed**.

This supersedes ADR 0002's plan. 0002 deferred cross-Browser isolation and named
per-name networks "the intended CHK-002 fix", with all three legs — peer CDP,
peer VNC, and the gateway's own `:8080` — "collapsing together once Browsers each
get their own network". We are not building per-name networks, and the `:8080`
leg is closed by a different mechanism, so that collapse no longer happens.

## Why not per-name networks

**Seeding makes cross-Browser isolation a boundary this product does not have.**
`SEED_VOLUME` clones the golden profile into every new Browser, so every Browser
starts holding the same hand-authenticated session. A compromised Browser
already has those credentials locally; reaching a peer adds only that peer's
post-seed divergence and live observation. Segmenting the network to protect
identities that were issued identical credentials at birth spends real
complexity — a network create/connect/teardown per provision, reaper and
orphan-sweep changes, `resolveIp` fallbacks, and Docker address-pool management
on a host already using 18 of ~31 assignable networks — to defend a boundary the
product deliberately erases. Seeding is a headline feature, not an accident, and
it is staying.

**The gateway leg was both cheaper and worse.** `:8080` was reachable from every
Browser with `authEnabled: false` by default; `hostOk` is a DNS-rebinding guard
an in-network caller simply spoofs, and `GATEWAY_TOKEN` covers the MCP endpoint
only — never the dashboard or the noVNC proxy (`server.ts`). So a compromised
Browser could POST MCP to `/b/<any-name>/` and drive the entire fleet without
touching CDP at all: strictly more power than the peer-CDP path, for less work.
That leg **survives** per-name networks, because the gateway must join every
per-name network by construction. It had to be closed on its own regardless.

## Considered options

- **Bind-time exclusion (chosen).** Resolve the gateway's egress address at
  startup and listen only there plus loopback. Nothing listens on the Browser
  plane, so there is no handler to reach and nothing to spoof; a scanning
  Browser finds a closed port rather than a 403. Covers the websocket upgrade
  path for free. Fails visibly: a wrong address breaks the host's access
  immediately rather than silently admitting traffic.
- **Per-request source check.** Keep `0.0.0.0`, compare `req.socket.localAddress`
  against an allowlist on every request and on upgrade. Sound, but a strictly
  larger attack surface for the same outcome, plus a second mechanism to keep
  correct in every new route forever.
- **`enable_icc=false` on `chikin-net`.** Does not work: the rule is symmetric
  and the gateway's own CDP connect rides that bridge, so it severs
  gateway→Browser exactly as it severs Browser→Browser. (It *is* applied to
  `chikin-egress`, where no bridge-internal traffic is legitimate — see #69.)
- **Default `GATEWAY_TOKEN` to non-empty.** Rejected. It protects MCP only, so it
  would read as a mitigation while leaving the dashboard and noVNC proxy open,
  and it breaks every existing client for a threat the loopback-trusted model
  already accepts.
- **Per-name networks.** Rejected above.

## Consequences

- **A Browser can still fully drive any other Browser** over CDP `:9222` and
  noVNC `:6080` on `chikin-net`. This is the accepted residual. It is asserted
  as `EXPECTED_PEER_REACHABLE` in `itest/gateway-reachability.mjs`, so the day
  someone does close it, the test fails and points here rather than the docs
  quietly going stale.
- **`HOST` changes meaning.** `0.0.0.0` is now "listen broadly *except* the
  Browser plane" rather than literally all interfaces. Any other value is
  honoured verbatim, so an operator can still pin one.
- **The listen address is resolved, never configured.** Docker reassigns it —
  it moved within `172.28.0.0/16` across a single `--force-recreate` — so it is
  read at startup from the gateway's own container inspect.
- **A resolution failure degrades to the old behaviour, loudly.** If the
  socket-proxy is unreachable the gateway falls back to `0.0.0.0` and records a
  warning on `/healthz` and the startup banner. It does not refuse to boot: a
  gateway that cannot reach the proxy cannot provision Browsers either, so
  exiting would convert a degraded posture into an outage. Binding loopback-only
  would be worse still — the in-container healthcheck curls `127.0.0.1` and
  would keep reporting healthy while the host lost access entirely.
- **This reopens if seeding is ever turned off.** An empty `SEED_VOLUME` means
  Browsers really are separate identities, and per-name networks become the
  right fix. That is the documented trigger to revisit CHK-002.
