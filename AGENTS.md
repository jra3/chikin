# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges

- **Docker `createContainer` config must NOT ride the URL.** dockerode/docker-modem mirrors the entire create config into the request *query string* as well as the body. A large `HostConfig` (e.g. the ~10 KB inlined seccomp profile) URL-encodes past the socket-proxy's (haproxy) request-line buffer → a bare `400 Bad request`. In `gateway/src/provisioner.ts` the create goes through a wrapper that uses docker-modem's `_query`/`_body` split (name in the query, config in the body). Keep new large `HostConfig` fields going through that path.
- **Renderer sandbox is verified via `chrome://sandbox`, never `/proc/<pid>/status` `Seccomp:`** (that reads `2` even for the unsandboxed `--no-sandbox` baseline). Use `bin/chikin-sandbox-check <name>` or `verify/verify-fleet.js --expect-sandbox`. Sandbox policy is `CHIKIN_SANDBOX=auto|on|off`; the container `entrypoint.sh` probes host unprivileged-userns support and decides per-browser. Regenerate the seccomp profile with `node gateway/seccomp/generate.mjs` (moby default + the 5-syscall allow group).

- **A dev checkout must be brought up with the dev override.** `docker-compose.yml` hardcodes `CHROME_IMAGE: ghcr.io/jra3/chikin:${CHIKIN_VERSION}` (only the tag is variable — a `CHROME_IMAGE` line in `.env` is inert), so the base file alone points the gateway at a ghcr image a local-only checkout may not have, and it crash-loops on its startup image check. Use `make dev-up` / `make dev-build` (= `-f docker-compose.yml -f docker-compose.dev.yml`). `bin/chikin-preflight` gates both make targets and `bin/chikin-up` selects the file set automatically.
- **The gateway's env is frozen at container-create time, and `.env` on disk is not evidence of it.** A gateway created from a directory where compose never read that `.env` runs with different values forever; `docker restart` cannot fix it — only `docker compose up -d --force-recreate gateway` from the repo dir. This silently disabled profile seeding for ~7 weeks. Read the *effective* config from `/healthz`, the dashboard's "runtime config" panel, or the startup banner (`gateway/src/runtime.ts`) — never from `.env`.

- **A chikin profile volume is disposable by NAME, never by label.** Only `chikin-profile-inst-*` may be deleted; `golden`, `hermes` and named client profiles hold hand-authenticated logins that cannot be cheaply recreated. Docker volume labels are **immutable after creation**, so `chikin.role=instance` (added for humans to prune against) is absent on every volume predating it — including the operator's golden. Every destructive volume path in the gateway therefore tests the name (`isInstanceName`/`isInstanceVolume` in `gateway/src/config.ts`). **No `docker volume prune --all` is safe here, filtered or not**: the label-scoped form takes golden (which carries `chikin.fleet=1` and dangles) plus every sticky profile, and the unfiltered form additionally takes `chikin-seed` — which `bin/chikin-snapshot` creates *unlabelled*, and which is golden's only second copy. Exercise destructive Docker paths against a stub Docker HTTP API, never the live fleet.

- **A new gateway env knob needs a line in `docker-compose.yml` too, or `.env` is inert.** Compose passes only the vars listed under the gateway service's `environment:`; `config.ts` reading one is not enough, and the failure is silent — the operator's `.env` line is simply ignored. `CHIKIN_VOLUME_GC` and all four `BROWSER_*` caps shipped that way. `gateway/test/compose-env.test.ts` now fails the build when a var documented in `README.md`'s config table or `.env.example` has no compose line, so add all three together. Pairs with the frozen-env note above: `/healthz` reports what the process actually has.
- **The gateway's idle clock is not a browser-activity clock.** `registry.touch()` fires on *any* MCP frame, and `client/bridge.mjs` sends a `ping` every 120s precisely to keep it warm, so `Activity.last` never ages out on an attached session. Real browser work is `Activity.lastBrowserActivity`, stamped only for a forwarded `tools/call` (`isBrowserWork` in `gateway/src/bridge.ts`) and shown as the dashboard's `browser idle` column. Any new lifecycle policy about "is this browser being used?" must read that field, not `last`.
- **`npm test` runs `dist/test/*.js`, not the TypeScript.** A test file deleted or renamed in `test/` leaves its compiled twin behind and it keeps running (and failing) forever. `rm -rf gateway/dist` when tests disappear or move.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
