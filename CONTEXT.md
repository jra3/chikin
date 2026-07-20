# chikin

Real (non-headless) Chrome in Docker for browser automation, run as a **fleet**: one host, many containers, driven over MCP. Everything runs on a single local machine — never remote.

## Language

**Fleet**:
The whole chikin system on one host — a gateway fronting N on-demand, per-name Chrome containers. This is the *only* topology; there is no standalone/single-container product.
_Avoid_: cluster, swarm, server (implies remote)

**Host**:
The single machine the entire fleet runs on. The gateway is bound to loopback and never reachable from another machine. There is no remote execution — one host, multiple containers.
_Avoid_: node, remote host, server

**Gateway**:
The one container clients connect to; it provisions/reaps Browsers and multiplexes each client onto its own. Speaks MCP over HTTP on `127.0.0.1` only.

**Browser**:
One provisioned Chrome container with its own sticky, isolated profile, addressed by a **Name**. Provisioned on first connect, reaped when idle; the profile persists.
_Avoid_: tab, session, page (those are things *inside* a Browser)

**Name**:
The `[a-z0-9-]` identifier that picks a Browser. A stable Name (`giard`) is a sticky persistent profile; the default `inst-<pid>` gives each Claude Code instance its own throwaway-per-run Browser.

**Instance**:
A running Claude Code process. Each Instance automatically gets its own Browser, so one person running many Instances is the reason the Fleet exists.
_Avoid_: client, user (a single human runs many Instances)
