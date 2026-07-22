# Isolate the Docker control plane on its own network; defer cross-Browser isolation

The socket-proxy (the gateway's scoped door to the Docker API, and therefore an
effective root-on-host primitive) will move onto a dedicated **`chikin-control`**
internal network shared only with the gateway. `chikin-net` keeps the gateway and
the Browsers but now carries **only CDP** (and VNC); Browsers lose any route to
the proxy. This is a compose-only change — no provisioner or reaper code. It
closes the Browser → socket-proxy → host-root escalation (audit CHK-001).

We deliberately do **not** isolate Browsers from each other in this change.

## Considered options

- **Minimal control-plane split (chosen).** New `chikin-control` (internal) =
  gateway + socket-proxy only. `chikin-net` (internal) = gateway + Browsers, CDP
  only. `chikin-egress` unchanged. The gateway still resolves
  `docker-socket-proxy` via Docker DNS because it shares `chikin-control` with
  it. Fixes the Critical (host root) with the smallest possible blast radius.
- **Per-name networks now (deferred).** One network per Browser, shared only
  with the gateway, would *additionally* isolate Browsers from each other. It
  requires the gateway to create/attach/tear down a network per provision, plus
  Docker address-pool management. Rejected *for now* as disproportionate to a
  single-trusted-user tool — but see below, it is the intended CHK-002 fix.

## Consequences

- **Cross-Browser isolation is a known, deliberately-deferred gap (CHK-002).**
  Because Browsers still share `chikin-net` and `chikin-egress`, a compromised
  Browser (Chrome runs `--no-sandbox`) can still reach another Browser's
  `0.0.0.0`-bound ports. That scope is **both CDP (9222) and VNC/websockify
  (6080)** — the audit named only CDP, but VNC has the identical root cause
  (shared network + a `0.0.0.0`-bound port). The gateway's own `:8080` is
  likewise still reachable by Browsers over the shared CDP net. All three
  collapse together once Browsers each get their own network; that is the
  planned CHK-002 effort.
- The CHK-006 Origin/Host guard on the gateway's `/vnc/<name>/` proxy protects
  the *host-facing* proxy path only; it does not protect a Browser's raw
  `:6080`/`:9222` from a co-resident Browser. That is CHK-002, not this ADR.
- `chikin-net` is no longer accurately "the control plane" — after this change
  it is the gateway↔Browser CDP/VNC plane, and `chikin-control` is the true
  control plane. The name is kept to avoid churning `CHIKIN_NETWORK` /
  `config.network` for no security gain.
