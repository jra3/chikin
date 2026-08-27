# itest — fleet integration tests

End-to-end checks against a running gateway (`docker compose up -d`). They use
the MCP SDK already installed under `../gateway/node_modules`, so symlink it:

```bash
ln -s ../gateway/node_modules node_modules     # gitignored
GATEWAY_TOKEN=<your token> node run.mjs         # checks: auth, provisioning,
                                                # identify gate + uniqueness, egress,
                                                # isolation, single-session, fleet cap,
                                                # dashboard, noVNC (+ handle title), reconnect
```

The fleet-cap section provisions at most 3 real Chrome containers, so run the
gateway with `MAX_FLEET` ≤ 3 to exercise it; at a larger cap the fleet is never
full and `run.mjs` prints a `SKIP` for the past-the-cap checks rather than
asserting something untrue.

`gateway-reachability.mjs` proves the network property the unit tests can't
(CHK-002 / #20): it provisions two real browsers and, from inside one, asserts
the gateway's `:8080` is **unreachable** while a peer browser's CDP `:9222` and
noVNC `:6080` **are** reachable — the residual [ADR 0003](../docs/adr/0003-accept-cross-browser-reachability-close-the-gateway.md)
knowingly accepts. Close that gap one day and the `EXPECTED_PEER_REACHABLE`
checks fail on purpose; flip them rather than deleting them.

```bash
GATEWAY_TOKEN=<your token> node gateway-reachability.mjs   # exits non-zero on any failed check
```

The probing page's **origin** is load-bearing: it runs from the browser's own
`http://<ip>:6080/`, because from an `https://` page every `http://` probe is
blocked as mixed content before a packet moves — which made an earlier version
report four confident, wrong answers. The self-`:6080` check is the control that
catches that class of breakage.

`reaper-helper.mjs` drives the live reaper test. Every mode calls
`chikin_identify` before touching a browser tool (the gate added in #54) and
exits non-zero the moment the gateway refuses a call. `hold` keeps one real
browser attached for N seconds: it makes a browser tool call first, because
since issue #63 connecting provisions nothing and the reaper skips names with no
container — a connect-only session holds no slot and blocks no reap.

```bash
# hold a real browser attached for 120s, then release it.
# Prints HELD, or HOLD FAILED + exit 1 if the gateway refused either call.
GATEWAY_TOKEN=<your token> node reaper-helper.mjs hold inst-hold1 120

# write a localStorage marker, then read it back after a reap to prove whether
# the profile survived. Prints SET ok / MARKER=<value>, or <MODE> FAILED + exit 1.
GATEWAY_TOKEN=<your token> node reaper-helper.mjs mark inst-mark1 hello
GATEWAY_TOKEN=<your token> node reaper-helper.mjs read inst-mark1
```

A refusal — the identify gate, fleet-full, a handle already claimed, a failed
provision — comes back as a normal tool result with `isError: true` rather than
as a thrown error, so every call here is checked. Until #66 that check was
missing from `mark`/`read` and they printed the gate's error text in place of
the marker, exiting 0: green, and asserting nothing.

Exit codes: **0** success, **1** a call failed — refused by the gateway, returned
no usable value, or wrote a marker that did not read back (`<MODE> FAILED` on
stderr) — **2** bad arguments, including a `hold` duration that is not a positive
number of seconds. Usage is checked before connecting, so a mistyped invocation
never opens a session or provisions a browser.

Every mode takes a browser name; use a disposable `inst-*` one. A reap discards
that name's profile volume, and only `inst-*` profiles are ever discarded — a
sticky name here would leave a volume behind. Run the gateway with a short
`IDLE_TTL_SEC` / `REAP_INTERVAL_SEC` to watch idle reclaim quickly. Add a short
`ATTACHED_IDLE_TTL_SEC` to watch the second tier — an *attached* session whose
browser has gone unused since its last tool call being evicted anyway, and the
client bridge reconnecting through it (issue #57).

`cdm-wire.mjs` asks what `chrome-devtools-mcp` actually puts **on the wire**
(issue #75), which is the one thing the unit tests structurally cannot: they
render replies through the vendored formatter, and the formatter returns a
`structuredContent.pages` that the child then never sends. Its `ToolHandler`
copies that object onto a tool result only when `--experimentalStructuredContent`
is set, and the `chrome-devtools-mcp` binary leaves the flag off (only the
sibling `chrome-devtools` CLI turns it on; the MCP SDK strips nothing). So under
the gateway's spawn flags the human-readable `## Pages` block is the only channel
the nav watchdog ever sees, and a suite can pass 154/154 while the watchdog is
blind in production — which is exactly what happened. This harness provisions a
real browser, drives the real binary against its CDP endpoint over stdio, and
runs the gateway's own `reportedPages` over the bytes that crossed.

```bash
cd ../gateway && npm run build && cd ../itest        # it imports gateway/dist
GATEWAY_TOKEN=<your token> node cdm-wire.mjs         # exits non-zero on any failed check
```

The load-bearing check is **"the parser marks a SELECTED page"**. Blindness, not
a false strike, is the failure mode that shipped: an unparsed selection makes
every verdict `unknown`, so the watchdog never strikes and reads as healthy.
Run this against any `chrome-devtools-mcp` bump before believing the bump is
safe — `CDM_BIN` points it at a candidate build without installing it:

```bash
CDM_BIN=/path/to/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js \
  node cdm-wire.mjs inst-cdmwire16
```

That is how the #75 fix was verified: 1.1.1 renders `1: https://example.com/
[selected]`, 1.6.0 renders `1: Example Domain (https://example.com/) [selected]`,
and only the second reaches the parser through this harness. The channel itself
can only be asserted here: seeing whether `structuredContent` rides a reply takes
a real tool call against a real browser. The browser-free CI twin,
`gateway/test/cdm-outputschema.test.ts`, watches upstream's tool declarations
instead, and names its own blind spot.
