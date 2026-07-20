# chikin

Real (non-headless) Google Chrome in Docker, for browser automation that should **not** self-identify as headless. Two ways to run it:

- **Fleet mode** (default `docker-compose.yml`) — a **multi-Chrome MCP gateway**. One gateway container fronts N per-client Chrome containers, each with its own sticky profile, and speaks [MCP](https://modelcontextprotocol.io/) over HTTP. Several Claude Code instances (or any MCP client) each drive their own isolated browser through a single bearer-protected endpoint.
- **Single-container mode** — one standalone Chrome exposing the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) on a loopback port. The original chikin; see [Single-container mode](#single-container-mode).

## What you get

- Full **headed** Chrome with no physical display (Xvfb). No `HeadlessChrome` in the User-Agent; `navigator.webdriver` is `undefined`; `navigator.plugins` populated.
- **Per-name sticky profiles**: connect as `alice` and you always get the same cookies/history; `bob` is fully isolated.
- **On-demand lifecycle**: browsers are provisioned on first connect and reaped when idle — nothing runs until someone asks for it.
- **noVNC** for every browser, so a human can watch or solve a captcha from one dashboard.
- A shared host directory wired into every browser as `~/Downloads` for file upload/download.

## What you do NOT get

- Deep stealth. `window.chrome.runtime` is missing, WebGL vendor/renderer report SwiftShader or null, and `navigator.plugins` is Chrome's default. That's a client-side concern — use [`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) or similar.
- Defense against sophisticated fingerprinters (mouse entropy, TLS fingerprinting).

---

## Architecture (fleet mode)

```
 Claude Code A (host) ─┐                         ┌─ chikin-chrome-alice  (CDP :9222, noVNC :6080,
 Claude Code B (host) ─┤  HTTP/MCP + bearer      │     vol chikin-profile-alice)
 Claude Code C (host) ─┼──► GATEWAY ─────────────┼─ chikin-chrome-bob    (…chikin-profile-bob…)
                       │   127.0.0.1:8080         │
                       └                          └─ (provisioned on demand, reaped when idle)
                              │ scoped docker API (tecnativa/docker-socket-proxy)
                              └─ create / start / stop chrome containers
```

- The gateway exposes **one MCP endpoint per browser** at `/b/<name>/`. `<name>` must match `[a-z0-9-]+` (1–32 chars). It maps to container `chikin-chrome-<name>` and volume `chikin-profile-<name>`.
- On first connect to a name, the gateway provisions the container (creating the profile volume if needed), waits for Chrome to come up, spawns **one** `chrome-devtools-mcp` child bound to that browser's CDP endpoint, and bridges the client's HTTP MCP session to the child's stdio.
- **Networks.** `chikin-net` is `internal: true` and carries the control plane (gateway ↔ socket-proxy ↔ Chrome CDP). `chikin-egress` is a normal bridge that gives the browsers internet access. No Chrome ports are published to the host.
- The gateway talks to Docker **only** through `tecnativa/docker-socket-proxy`, scoped to containers + volumes + images (+ POST). No `exec`, no host `info`, no swarm/secrets.

---

## Quickstart (fleet)

Prerequisites: Docker 20.10+ with Compose v2, and ~1.5 GB disk for the images (the first pull takes a few minutes).

```bash
# 1. Pull the pinned gateway + fleet browser images from ghcr (builds nothing).
cp .env.example .env
# Optionally pin CHIKIN_VERSION in .env to a release tag; default is `latest`.
docker compose --profile build pull

# 2. Bring up the gateway + socket-proxy.
# The gateway binds 127.0.0.1 only, so a bearer is optional. Leave GATEWAY_TOKEN
# empty for no-auth local use, or set one to require it:
#   sed -i "s/^GATEWAY_TOKEN=.*/GATEWAY_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d

# 3. Sanity check.
curl -s http://localhost:8080/healthz        # {"status":"ok"}
open http://localhost:8080/                   # fleet dashboard
```

The gateway listens on `127.0.0.1:8080` only. Browsers are **not** compose services — they appear on demand when a client connects.

### Wire up a client

Install once, and **every** Claude Code instance automatically gets its own multiplexed browser — no per-window config. A small stdio↔HTTP bridge (`bin/chikin-mcp`) derives a unique name per instance (`inst-<pid>`, overridable) and registers as one user-scope MCP server:

```bash
# bridge deps + put the helpers on your PATH
( cd client && npm install --omit=dev )
ln -s "$PWD/bin/chikin-mcp"    ~/.local/bin/chikin-mcp
ln -s "$PWD/bin/chikin-claude" ~/.local/bin/chikin-claude

# register the gateway once, for all projects
claude mcp add --scope user chikin -- ~/.local/bin/chikin-mcp
```

Now any `claude` instance — even several in the same directory — connects to its own isolated browser, and the gateway multiplexes them (up to `MAX_FLEET`). The default name `inst-<pid>` is unique per running instance; **pin a sticky, persistent browser** by name with the wrapper (it just exports `CHIKIN_NAME`):

```bash
chikin-claude giard            # this instance drives the sticky "giard" profile
chikin-claude carey --continue # another instance, isolated "carey"
```

Env (read by `chikin-mcp`): `CHIKIN_GATEWAY` (default `http://localhost:8080`), `CHIKIN_NAME` (explicit browser name), `CHIKIN_TOKEN` (bearer, only if `GATEWAY_TOKEN` is set).

The first tool call provisions and starts the browser (a few seconds). A named browser (`giard`) always gets the same profile. Disconnect and the browser stays warm for a fast reconnect; leave it idle past `IDLE_TTL_SEC` with no client attached and it's stopped (the profile volume is preserved, so reconnecting restores everything).

#### Direct HTTP transport (pin a browser, or non–Claude-Code clients)

The stdio bridge above is the easy path — it auto-assigns each Claude Code instance its own browser. If instead you want to **pin a client to a specific named browser**, or wire up any MCP client that speaks streamable HTTP directly, point it at the gateway's per-browser endpoint `http://localhost:8080/b/<name>/` (`<name>` is `[a-z0-9-]+`, 1–32 chars). To configure two isolated browsers:

```bash
# Two MCP servers, two isolated profiles. Drop --header if GATEWAY_TOKEN is empty.
claude mcp add --transport http alice http://localhost:8080/b/alice/ \
  --header "Authorization: Bearer $GATEWAY_TOKEN"
claude mcp add --transport http bob   http://localhost:8080/b/bob/ \
  --header "Authorization: Bearer $GATEWAY_TOKEN"
```

`alice` and `bob` get fully isolated profiles (volumes `chikin-profile-alice`, `chikin-profile-bob`); the gateway provisions each browser on first use. Only one client may hold a given name at a time — a second concurrent connect to `alice` is rejected with `409`. This is exactly the form any streamable-HTTP MCP client uses; `chikin-mcp` is just a convenience wrapper that fills in the name (and the bearer) for you.

### Watch a browser / solve a captcha

Open the dashboard at <http://localhost:8080/> and click **open noVNC** next to any running browser, or go straight to `http://localhost:8080/vnc/<name>/`. You can drive that Chrome window by hand — useful for logging in or clearing a captcha while the MCP client keeps the session.

### Pre-authenticated browsers (golden profile)

Each browser starts with a fresh profile, so you'd normally have to log into sites every time. Instead, seed every new browser from a **golden** profile you log into once:

```bash
# 1. enable seeding (gateway env) and restart
echo 'SEED_VOLUME=chikin-seed' >> .env && docker compose up -d gateway

# 2. log into your sites by hand, once
chikin-claude golden                       # launch the golden browser
#  -> open http://localhost:8080/vnc/golden/ and sign in to your sites

# 3. freeze it as the seed
chikin-snapshot                            # clones golden's profile -> chikin-seed
```

From then on **every new browser is cloned from the seed and starts logged in** — and the MCP automation sees those cookies (it shares the persistent profile context). Re-run `chikin-snapshot` whenever sessions expire. It works because every container uses Chrome's keyring-less `basic` cookie store, so the encryption key travels in the copied `Local State` and decrypts in the clones. Caveat: all seeded browsers share one identity, so sites that forbid concurrent sessions may re-challenge.

### Shared files

Everything dropped in `/tmp/chikin-shared` on the host appears inside **every** browser as `~/Downloads` (and at the same `/tmp/chikin-shared` path, which is what `upload_file` expects). Downloads triggered in any browser land back in that host directory. Scratch files are shared across clients; only cookies/profile are per-name isolated.

---

## Configuration (fleet)

Set in `.env` (see `.env.example`) or the environment.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_TOKEN` | *(empty)* | Bearer token clients must present. **Empty disables auth** — safe because the port is bound to `127.0.0.1`. Set one (`openssl rand -hex 32`) to require it. |
| `MAX_FLEET` | `8` | Max concurrent browsers. Provisioning past the cap is rejected with HTTP 429 instead of OOMing the host. |
| `SEED_VOLUME` | *(empty)* | Docker volume cloned into every new profile so browsers start logged in. Empty = off. Populate with `bin/chikin-snapshot` (see [Pre-authenticated browsers](#pre-authenticated-browsers-golden-profile)). |
| `IDLE_TTL_SEC` | `900` | Idle seconds (no attached client stream) before a browser is reaped. |
| `REAP_INTERVAL_SEC` | `30` | How often the reaper sweeps. |
| `PROVISION_TIMEOUT_SEC` | `90` | How long to wait for a new browser's CDP to come up before failing the connect. |
| `WINDOW_SIZE` | `1920,1080` | Chrome window / Xvfb screen size for provisioned browsers. |
| `CDM_EXTRA_ARGS` | *(empty)* | Extra flags for every `chrome-devtools-mcp` child, whitespace-separated. E.g. `--experimentalPageIdRouting` routes page-scoped tools by explicit `pageId` instead of the sticky selected-page binding (sidesteps the stale-target wedge, but changes tool schemas). |
| `NAV_VERIFY_DELAY_MS` | `2500` | How long after a "successful" navigation the wedge watchdog waits before checking the browser's real CDP page list. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

### Wedge self-healing (issue #15)

`chrome-devtools-mcp` (≤1.1.1) can bind to a stale page target after an SPA route change or cross-origin navigation: navigation tools then return success but silently no-op while Chrome itself is healthy. The gateway defends in three layers:

1. **Nav watchdog** — after the child reports a navigation succeeded, the gateway checks the container's CDP `/json/list` (ground truth). Two consecutive navs that provably went nowhere force a transparent child respawn, which re-binds the browser's real current target. Repeated CDP connection failures on the child's stderr (e.g. the container was removed out-of-band) trigger the same respawn.
2. **`chikin_reset` tool** — injected into every `tools/list`, so the model itself can hard-reset a wedged browser (container recreated, profile/logins preserved) without human help.
3. **Self-healing transports** — both the client bridge and the gateway replay the cached `initialize` over a rebuilt link, so none of the above ever drops the client's MCP session.

Gateway responses use JSON-RPC error envelopes with these HTTP statuses: `401` (bad/missing token), `400` (invalid name or non-initialize without a session), `409` (a name already has an active session), `429` (fleet full), `503` (provisioning failed).

---

## Single-container mode

If you just want one standalone Chrome on a loopback CDP port (the original chikin), skip the gateway:

```yaml
# docker-compose.standalone.yml
services:
  chrome:
    image: ghcr.io/jra3/chikin:latest   # or: build: .
    container_name: chikin
    restart: unless-stopped
    shm_size: "2gb"
    ports:
      - "127.0.0.1:9322:9222"   # loopback only — never 0.0.0.0
    volumes:
      - chikin-data:/data
volumes:
  chikin-data:
```

```bash
docker compose -f docker-compose.standalone.yml up -d
curl -s http://localhost:9322/json/version   # should NOT say HeadlessChrome
cd verify && npm install && node verify.js --host http://localhost:9322
```

Environment variables read by `entrypoint.sh` in either mode:

| Variable | Default | Meaning |
|---|---|---|
| `CDP_PORT` | `9222` | Port inside the container clients reach via socat. |
| `WINDOW_SIZE` | `1920,1080` | `--window-size` for Chrome; also drives the Xvfb screen dimensions. |
| `DISPLAY_NUM` | `99` | Which `:N` display Xvfb creates. |
| `ENABLE_VNC` | `0` | `1` to start x11vnc + noVNC on `VNC_PORT`. The fleet sets this automatically. |
| `VNC_PORT` | `6080` | noVNC/websockify port inside the container. |
| `EXTRA_CHROME_ARGS` | *(empty)* | Appended to Chrome's argv. |

### Why the port shuffle

Chrome (since ~v111) ignores `--remote-debugging-address=0.0.0.0` and always binds CDP to `127.0.0.1` inside the container. `entrypoint.sh` runs Chrome on a private loopback port (9223) and uses `socat` to forward `CDP_PORT` to it.

### Connecting chrome-devtools-mcp directly (single-container)

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://localhost:9322"]
    }
  }
}
```

If `--browserUrl` doesn't fit, the only other connect flag is **`--wsEndpoint`** (alias `-w`), which takes a full WebSocket URL. There is no `--cdp-endpoint` or `--browserWSEndpoint` — those flags do not exist. Fetch the WebSocket URL with:

```bash
curl -s http://localhost:9322/json/version | jq -r .webSocketDebuggerUrl
# then: chrome-devtools-mcp --wsEndpoint ws://localhost:9322/devtools/browser/<id>
```

---

## Architecture & platforms

The image is multi-arch:

- **linux/amd64** — Google Chrome stable.
- **linux/arm64** — Debian's Chromium (Google ships no `google-chrome-stable` for Linux arm64). The User-Agent says `Chromium/<ver>`, and Google's proprietary codecs (H.264, AAC) are absent. The anti-detection signals chikin targets are upstream Blink and behave identically.

On Apple Silicon / Linux ARM, `docker compose` pulls the arm64 image natively.

The container starts as **root** only long enough for `entrypoint.sh` to chown the `/data` profile volume (the fleet creates fresh, root-owned volumes), then drops to the unprivileged `chrome` user (UID 1100) via `setpriv` before launching anything.

---

## Security

- **CDP has no authentication.** chikin never publishes a Chrome port to the host. In fleet mode the only host-exposed surface is the gateway on `127.0.0.1:8080`, and `/b/<name>/` requires a bearer token; the control-plane network is `internal: true`.
- **Linux caveat:** on a Linux host you can still reach a container's CDP by its *container IP* (e.g. `http://172.x.x.x:9222`) because the host routes to Docker bridges directly — `internal: true` does not change this. The boundary chikin provides is "not reachable from other machines and not on any host port," matching the single-container model. If you need to block host-local access too, add a `DOCKER-USER` iptables rule; that's outside chikin's scope.
- **Scoped Docker access.** The gateway reaches Docker only through `tecnativa/docker-socket-proxy` with a read-only socket mount, scoped to containers/volumes/images (+POST). `exec`, `info`, swarm, and secrets are denied — verify with the proxy returning `403` on `/info` and `/exec/...`.
- `--no-sandbox` is in use. Treat a profile volume as a fully compromised browser profile after visiting untrusted content.
- Never change the gateway's host port binding from `127.0.0.1`.

---

## Verify script

`verify/verify.js` is a host-side Node (≥20) tool that proves a chikin Chrome is non-headless. Point it at any reachable CDP endpoint:

```bash
cd verify && npm install
node verify.js --host http://localhost:9322        # single-container
node verify.js --json                              # machine-readable
node verify.js --skip-sannysoft                    # probe only (offline / CI)
```

Exit codes: `0` all required checks passed · `1` a required check failed · `2` couldn't connect · `3` unexpected error.

## Gateway development

```bash
cd gateway
npm install
npm run build        # tsc -> dist/
npm test             # unit tests (names, registry, reaper)
```

The gateway is TypeScript on the official MCP SDK (`StreamableHTTPServerTransport` facing clients, `StdioClientTransport` to each `chrome-devtools-mcp` child) with `dockerode` for provisioning and `http-proxy` for the noVNC reverse proxy. See `gateway/src/` — `server.ts` (routing/auth), `provisioner.ts` (Docker lifecycle), `bridge.ts` (MCP↔stdio pump), `reaper.ts` (idle reclaim).

## Troubleshooting

**Gateway healthy but `curl localhost:8080` refuses from the host.** The gateway must bind `0.0.0.0` *inside* the container for Docker's port-forward to reach it (compose sets `HOST=0.0.0.0`); loopback-only safety comes from the `127.0.0.1:8080:8080` host mapping.

**A connect hangs then fails with "provisioning failed".** Chrome didn't come up within `PROVISION_TIMEOUT_SEC`. Check `docker logs chikin-chrome-<name>`; most often `/dev/shm` pressure (the fleet sets `shm_size` 2 GB per browser).

**"browser '<name>' already has an active session" (409).** That name is in use by another client. Pick a different name, or have the other client disconnect (MCP `DELETE`/terminate frees the name immediately).

**"fleet is full" (429).** Raise `MAX_FLEET` or let an idle browser get reaped.

**`verify.js` says UA contains `HeadlessChrome`.** A `--headless` flag snuck into `entrypoint.sh`.

## License

MIT. See [LICENSE](LICENSE).
