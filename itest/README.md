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

`reaper-helper.mjs` drives the live reaper test (mark / read / hold a browser);
see the commands in the repo's test notes. Run the gateway with a short
`IDLE_TTL_SEC` / `REAP_INTERVAL_SEC` to watch idle reclaim quickly. Add a short
`ATTACHED_IDLE_TTL_SEC` to watch the second tier — an *attached* session with no
browser tool call being evicted, and the client bridge reconnecting through it
(issue #57).
