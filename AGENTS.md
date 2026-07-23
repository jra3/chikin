# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges

- **Docker `createContainer` config must NOT ride the URL.** dockerode/docker-modem mirrors the entire create config into the request *query string* as well as the body. A large `HostConfig` (e.g. the ~10 KB inlined seccomp profile) URL-encodes past the socket-proxy's (haproxy) request-line buffer → a bare `400 Bad request`. In `gateway/src/provisioner.ts` the create goes through a wrapper that uses docker-modem's `_query`/`_body` split (name in the query, config in the body). Keep new large `HostConfig` fields going through that path.
- **Renderer sandbox is verified via `chrome://sandbox`, never `/proc/<pid>/status` `Seccomp:`** (that reads `2` even for the unsandboxed `--no-sandbox` baseline). Use `bin/chikin-sandbox-check <name>` or `verify/verify-fleet.js --expect-sandbox`. Sandbox policy is `CHIKIN_SANDBOX=auto|on|off`; the container `entrypoint.sh` probes host unprivileged-userns support and decides per-browser. Regenerate the seccomp profile with `node gateway/seccomp/generate.mjs` (moby default + the 5-syscall allow group).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
