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
One provisioned Chrome container with its own sticky, isolated profile, addressed by a **Name**. Provisioned on a session's first browser tool call (not on connect), reaped when idle; the profile persists.
_Avoid_: tab, session, page (those are things *inside* a Browser)

**Name**:
The `[a-z0-9-]` identifier that picks a Browser. A stable Name (`giard`) is a sticky persistent profile; the default `inst-<pid>` gives each Claude Code instance its own throwaway-per-run Browser.

**Instance**:
A running Claude Code process. Each Instance automatically gets its own Browser, so one person running many Instances is the reason the Fleet exists.
_Avoid_: client, user (a single human runs many Instances)

**Profile Volume**:
The Docker volume holding one Browser's Chrome profile, named `chikin-profile-<name>`. Its disposability follows its Name: an `inst-*` Profile Volume is **disposable** and is destroyed with its Browser; every other one (`golden`, `hermes`, any sticky client name) is **sticky** and outlives the Browser so a reconnect restores cookies and logins. Only a disposable Profile Volume may ever be destroyed.
_Avoid_: profile dir, data volume

**Seed Volume**:
An operator-authored snapshot that new Profile Volumes are cloned *from* so a Browser starts logged in (`SEED_VOLUME`, populated by `bin/chikin-snapshot`). Source material the Fleet reads and never manages: it is not a Profile Volume, and its name follows no Fleet convention. Its protection from the destructive paths comes from that name, so pointing `SEED_VOLUME` at a `chikin-profile-inst-*` volume is not supported.
_Avoid_: golden (that's one particular sticky Profile Volume, and it is not the Seed Volume)
