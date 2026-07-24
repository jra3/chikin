# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges

- **Docker `createContainer` config must NOT ride the URL.** dockerode/docker-modem mirrors the entire create config into the request *query string* as well as the body. A large `HostConfig` (e.g. the ~10 KB inlined seccomp profile) URL-encodes past the socket-proxy's (haproxy) request-line buffer → a bare `400 Bad request`. In `gateway/src/provisioner.ts` the create goes through a wrapper that uses docker-modem's `_query`/`_body` split (name in the query, config in the body). Keep new large `HostConfig` fields going through that path.
- **Renderer sandbox is verified via `chrome://sandbox`, never `/proc/<pid>/status` `Seccomp:`** (that reads `2` even for the unsandboxed `--no-sandbox` baseline). Use `bin/chikin-sandbox-check <name>` or `verify/verify-fleet.js --expect-sandbox`. Sandbox policy is `CHIKIN_SANDBOX=auto|on|off`; the container `entrypoint.sh` probes host unprivileged-userns support and decides per-browser. Regenerate the seccomp profile with `node gateway/seccomp/generate.mjs` (moby default + the 5-syscall allow group).

- **A dev checkout must be brought up with the dev override.** `docker-compose.yml` hardcodes `CHROME_IMAGE: ghcr.io/jra3/chikin:${CHIKIN_VERSION}` (only the tag is variable — a `CHROME_IMAGE` line in `.env` is inert), so the base file alone points the gateway at a ghcr image a local-only checkout may not have, and it crash-loops on its startup image check. Use `make dev-up` / `make dev-build` (= `-f docker-compose.yml -f docker-compose.dev.yml`). `bin/chikin-preflight` gates both make targets and `bin/chikin-up` selects the file set automatically.
- **The gateway's env is frozen at container-create time, and `.env` on disk is not evidence of it.** A gateway created from a directory where compose never read that `.env` runs with different values forever; `docker restart` cannot fix it — only `docker compose up -d --force-recreate gateway` from the repo dir. This silently disabled profile seeding for ~7 weeks. Read the *effective* config from `/healthz`, the dashboard's "runtime config" panel, or the startup banner (`gateway/src/runtime.ts`) — never from `.env`.

- **A chikin profile volume is disposable by NAME, never by label.** Only `chikin-profile-inst-*` may be deleted; `golden`, `hermes` and named client profiles hold hand-authenticated logins that cannot be cheaply recreated. Docker volume labels are **immutable after creation**, so `chikin.role=instance` (added for humans to prune against) is absent on every volume predating it — including the operator's golden. Every destructive volume path in the gateway therefore tests the name (`isInstanceName`/`isInstanceVolume` in `gateway/src/config.ts`). Never run `docker volume prune --all --filter label=chikin.fleet=1`: golden carries that label and dangles, so it destroys every saved login. Exercise destructive Docker paths against a stub Docker HTTP API, never the live fleet.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
