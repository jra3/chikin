# itest — fleet integration tests

End-to-end checks against a running gateway (`docker compose up -d`). They use
the MCP SDK already installed under `../gateway/node_modules`, so symlink it:

```bash
ln -s ../gateway/node_modules node_modules     # gitignored
GATEWAY_TOKEN=<your token> node run.mjs         # 20 checks: auth, provisioning,
                                                # egress, isolation, single-session,
                                                # fleet cap, dashboard, noVNC, reconnect
```

`reaper-helper.mjs` drives the live reaper test (mark / read / hold a browser);
see the commands in the repo's test notes. Run the gateway with a short
`IDLE_TTL_SEC` / `REAP_INTERVAL_SEC` to watch idle reclaim quickly.
