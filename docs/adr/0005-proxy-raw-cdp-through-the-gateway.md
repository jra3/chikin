# Proxy raw CDP through the gateway; never publish a Browser's 9222

A driver that speaks the DevTools Protocol instead of MCP reaches a Browser at
`/cdp/<name>/` on the gateway's one published port. No Chrome port is published
to the host and `chikin-net` stays `internal: true`, so the lane is a route on
the gateway rather than a second door into the fleet. It provisions lazily from
the Seed Volume exactly as the MCP lane does (#63), spends a `MAX_FLEET` slot
like any other Browser, and is mutually exclusive with MCP on one Name.
`CHIKIN_CDP_LANE=0` turns it off and `/cdp/<name>/` then answers 404. Issue #87.

The need is simple: a client with no MCP support could not use the fleet at all,
and therefore could not reach the golden profile. Nothing about the Browser had
to change to serve it. Only the way in.

## Considered options

- **Reverse-proxy `/cdp/<name>/` through the gateway (chosen).** One published
  port, one set of guards, and the Browser stays where ADR 0002/0003 put it.
  The cost is that the gateway now stands in the middle of a protocol it does
  not parse, which the consequences below spell out.
- **Publish each container's `:9222` on `127.0.0.1` (rejected).** It reverses
  ADR 0002/0003. Those decisions spent a network split and a bind rule getting
  the Browser plane off anything host-reachable; a per-Browser host port puts it
  back, and puts it back *unauthenticated*: Chrome's DevTools endpoint has no
  auth of any kind, so `GATEWAY_TOKEN` could not cover it and every local
  process would hold a full control channel into a browser logged in as the
  operator. It also needs a free host port chosen at provision time and some new
  way to tell a caller which one it got, which is a second lifecycle for a
  worse posture.
- **A lease API (rejected).** `POST /lease` handing back a Name and an endpoint
  would make provisioning explicit rather than lazy. It invents a lifecycle the
  reaper, the fleet cap and the dashboard would each have to learn, and the MCP
  lane already showed that lazy-on-first-request works (#63). The handshake the
  driver has to make anyway is a perfectly good trigger.

ADR 0001's rejection of standalone loopback-CDP mode is not reopened by this.
That rejection was about a topology, one Chrome on a host port with no fleet
around it. This lane is per-Name, provisioned by the same Provisioner, reaped by
the same Reaper, and local-only like everything else.

## Consequences

- **The lane inherits the gateway's guards, and one of them finally bites.**
  Host check as everywhere else, plus `GATEWAY_TOKEN` when it is set. The token
  is real protection here in a way it never was for noVNC, because a CDP driver
  can attach headers to both the HTTP hop and the upgrade while a browser
  navigation cannot.
- **The lane must refuse anything a web browser sent, and an `Origin` only
  catches half of them.** Browsers run `--remote-allow-origins=*` (CHK-002), so
  Chrome accepts whatever the gateway forwards and only the gateway decides.
  Fetch omits `Origin` on a `no-cors` GET, an `<img src>` and a plain
  navigation, and reaching `/json/*` alone provisions a Browser and exposes
  `/json/close/<id>`. Fetch Metadata covers the rest: a user agent writes
  `Sec-Fetch-*` on every request it makes and script cannot strip it. Both
  checks live in `cdpAccessOk` (`gateway/src/cdp.ts`); AGENTS.md carries the
  sharp edge.
- **The gateway has to rewrite the addresses Chrome advertises.**
  `/json/version` answers with a `chikin-net` IP that no driver can route to,
  and `connectOverCDP` dials that field verbatim. So `webSocketDebuggerUrl` and
  `devtoolsFrontendUrl` are rewritten back through `/cdp/<name>/`. Publishing
  `:9222` would not have needed this. It is the price of the choice, and it is
  the reason the lane buffers a JSON body at all.
- **The dial is pinned to a resolved IP.** Chrome's DevTools endpoint refuses a
  Host header that is not an IP or `localhost`, its own rebinding defence, so
  the proxy sends `changeOrigin` at a `provisioner.resolveIp` address and never
  the `<container>.<network>` DNS form the VNC proxy can afford.
- **One driver per Browser, refused from the first request.** MCP and CDP answer
  409 for each other. The claim is taken when the handshake arrives, not when
  the websocket opens, because a cold provision runs for up to
  `PROVISION_TIMEOUT_SEC` and the Name would read as free for all of it.
- **The attached reap tier is measured, not assumed.** An open CDP socket counts
  as attached, and the tier reads `lastBrowserActivity` sampled from the
  driver's own `bytesRead`. A timer that stamped unconditionally would rebuild
  the exact lie #57 split the two clocks to escape.
- **A page that got onto this lane would be worse than one that got onto the
  dashboard**, which is why the guard is stricter here than anywhere else in the
  gateway. With an empty `GATEWAY_TOKEN` the residual is the one ADR 0003
  already accepts: any non-browser process that can reach `127.0.0.1:8080` can
  drive a logged-in Browser, the same trust the MCP endpoint assumes.
- **The lane is proven twice.** `gateway/test/cdp.test.ts` holds the wiring
  against a fake Chrome (rewrite, guards, upgrade, bookkeeping);
  `itest/cdp-playwright.mjs` drives a real Playwright against a real fleet
  Browser, because a fake Chrome cannot show that the protocol survives the hop.
