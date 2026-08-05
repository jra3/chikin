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
# the profile survived. Print SET ok / MARKER=<value>, or <MODE> FAILED + exit 1.
GATEWAY_TOKEN=<your token> node reaper-helper.mjs mark inst-mark1 hello
GATEWAY_TOKEN=<your token> node reaper-helper.mjs read inst-mark1
```

A refusal — the identify gate, fleet-full, a handle already claimed, a failed
provision — comes back as a normal tool result with `isError: true` rather than
as a thrown error, so every call here is checked. Until #66 that check was
missing from `mark`/`read` and they printed the gate's error text in place of
the marker, exiting 0: green, and asserting nothing.

Every mode takes a browser name; use a disposable `inst-*` one. A reap discards
that name's profile volume, and only `inst-*` profiles are ever discarded — a
sticky name here would leave a volume behind. Run the gateway with a short
`IDLE_TTL_SEC` / `REAP_INTERVAL_SEC` to watch idle reclaim quickly. Add a short
`ATTACHED_IDLE_TTL_SEC` to watch the second tier — an *attached* session whose
browser has gone unused since its last tool call being evicted anyway, and the
client bridge reconnecting through it (issue #57).
