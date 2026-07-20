# chikin is fleet-only and local-only

chikin is a **fleet** — a gateway fronting N on-demand, per-name Chrome containers — running entirely on **one host, in multiple containers, never remote**. The fleet exists so a single technical user can run many concurrent Claude Code instances, each multiplexed onto its own isolated browser. This is the only supported topology.

## Considered options

- **Single-container / standalone mode** (one Chrome on a loopback CDP port, the original chikin). *Rejected* — "there are simpler ways to do that," and it can't multiplex the many-Claude-Code-instances use case that is the whole point. Being removed, not just unsupported.
- **Remote / shared hosted gateway** (one gateway on a server, clients connect over the network; e.g. a proxmox box). *Rejected* — it would invalidate the loopback-only security model (the gateway is bound to `127.0.0.1` and must never leave it) and demand TLS + real auth. Everything runs on the local host.

## Consequences

- The gateway never binds anything but `127.0.0.1`; "not reachable from another machine" is a hard invariant, not a default.
- Packaging targets standing up the local fleet (Docker as a precondition), not distributing a server or a standalone binary.
- Any doc, memory, or design implying remoteness, a multi-user server, or a non-fleet standalone mode is wrong and should be corrected. (A stale memory claiming chikin ran on a remote "iris" box was deleted 2026-07-20.)
