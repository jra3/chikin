# chikin — Design

**Status:** Draft
**Date:** 2026-04-18
**License:** MIT

## Summary

A public Docker image + compose file that runs a real (non-headless) Google Chrome inside a virtual display, exposing the Chrome DevTools Protocol on port 9222. Distributed as a small shareable repo. The browser does **not** self-identify as headless, and the most common automation-detection tells are muted at the container level. Further stealth (fingerprint spoofing, plugin injection, WebGL vendor masking) is explicitly a client-side responsibility.

## Goals

- A browser that runs in a container with no physical display and does **not** advertise itself as headless.
- A turnkey experience: `docker compose up -d` and the CDP endpoint is live.
- A self-validating repo: a single `node verify.js` command proves the container's promises.
- A published prebuilt image on GHCR so users don't need to build locally.
- A clean, unopinionated CDP interface usable by any client (Puppeteer, Playwright, MCP servers, raw WebSocket).

## Non-goals

- Stealth patches beyond what flags can do. No `navigator.plugins` spoofing, no WebGL vendor masking, no `window.chrome` rebuild. These live client-side (e.g. `puppeteer-extra-plugin-stealth`, `playwright-extra`).
- Multi-arch. amd64 only in v1.
- Anti-detection against sophisticated fingerprinters (mouse entropy, TLS fingerprinting, timing analysis). This is a cat-and-mouse game; the container handles the obvious tells, not the sophisticated ones.
- An auth layer on CDP. CDP has no authentication by design. Exposure is restricted to `127.0.0.1` on the host; remote access is via SSH tunnel.

## Architecture

```
┌──────────────────────┐        ┌──────────────────────────────────────────┐
│  client machine      │        │  host machine                            │
│                      │        │                                          │
│  CDP client          │──SSH──▶│  127.0.0.1:9222                          │
│  (Puppeteer,         │ tunnel │         │                                │
│   Playwright,        │        │         ▼                                │
│   MCP server,        │        │  ┌────────────────────────────────────┐  │
│   raw WebSocket)     │        │  │ docker: chikin                     │  │
│                      │        │  │                                    │  │
│                      │        │  │  tini (PID 1)                      │  │
│                      │        │  │    └─ entrypoint.sh                │  │
│                      │        │  │         ├─ Xvfb :99 (background)   │  │
│                      │        │  │         └─ google-chrome (exec)    │  │
│                      │        │  │               DISPLAY=:99          │  │
│                      │        │  │               --remote-debugging-  │  │
│                      │        │  │                 port=9222          │  │
│                      │        │  └────────────────────────────────────┘  │
└──────────────────────┘        └──────────────────────────────────────────┘
```

**Key properties:**

- Chrome runs its full headed code path (no `--headless` flag).
- Xvfb provides a virtual framebuffer so Chrome has a "screen" to render to.
- `tini` is PID 1 for clean signal propagation on `docker stop`.
- CDP port is published on loopback only.

## Components

```
chikin/
├── Dockerfile
├── entrypoint.sh
├── docker-compose.yml
├── verify/
│   ├── package.json
│   └── verify.js
├── .github/workflows/
│   ├── build.yml                  # Build, verify, push on main/tags
│   └── sannysoft-canary.yml       # Weekly check against bot.sannysoft.com
├── .gitignore
├── LICENSE                        # MIT
└── README.md
```

### Dockerfile

- Base: `debian:bookworm-slim`.
- Installs: `google-chrome-stable` (from Google's apt repo, signed), `xvfb`, `tini`, font packages (`fonts-liberation`, `fonts-noto-color-emoji`), plus the shared-library deps Chrome needs on slim Debian.
- Creates a non-root `chrome` user; sets `WORKDIR /data` with ownership.
- Exposes 9222.
- `ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]`. No `CMD`.

### entrypoint.sh

~15 lines. Reads env vars with defaults:

- `CDP_PORT` (default `9222`)
- `WINDOW_SIZE` (default `1920,1080`)
- `DISPLAY_NUM` (default `99`)
- `EXTRA_CHROME_ARGS` (default empty)

Flow:
1. Derive Xvfb screen size from `WINDOW_SIZE` (comma → `x`).
2. Start `Xvfb :$DISPLAY_NUM -screen 0 ${XVFB_SIZE}x24 &`.
3. Wait for `/tmp/.X11-unix/X$DISPLAY_NUM` to exist (bounded loop, ~5s).
4. `export DISPLAY=:$DISPLAY_NUM`.
5. `exec google-chrome` with the flag set below.

**Chrome flag set:**

```
--remote-debugging-port=$CDP_PORT
--remote-debugging-address=0.0.0.0
--user-data-dir=/data
--no-first-run
--no-default-browser-check
--disable-dev-shm-usage
--no-sandbox
--disable-blink-features=AutomationControlled
--window-size=$WINDOW_SIZE
$EXTRA_CHROME_ARGS
about:blank
```

**Intentionally absent:**
- `--headless` / `--headless=new` — the whole point is that Chrome is **not** headless.
- `--disable-gpu` — removed vs the original spec; real headed Chrome has GPU. Chrome will fall back to SwiftShader in the container, which is itself a fingerprint leak but a client-stealth concern.

### docker-compose.yml

- Single service `chrome`.
- Builds from the local Dockerfile; also references `image:` so a prebuilt image can be swapped in by editing one line.
- `shm_size: 2gb`.
- `ports: ["127.0.0.1:9222:9222"]`. README warns never to change to `0.0.0.0`. Host-side port is separate from `CDP_PORT`; if a user changes `CDP_PORT`, they must also update the right-hand side of the mapping to match.
- Named volume `chikin-data:/data`.
- Healthcheck: `wget -qO- http://localhost:$CDP_PORT/json/version`, interval 10s, retries 5. Evaluates inside the container, so it follows `CDP_PORT`.
- Env vars passed through: `CDP_PORT`, `WINDOW_SIZE`, `DISPLAY_NUM`, `EXTRA_CHROME_ARGS`.
- `restart: unless-stopped`.

### verify/verify.js

Runs from the host. Single dep: `chrome-remote-interface`.

**CLI flags:**
- `--host <url>` — CDP endpoint, default `http://localhost:9222`
- `--json` — machine-readable output
- `--skip-sannysoft` — skip the third-party site check

**Procedure:**

1. Connect via `chrome-remote-interface`, open a fresh tab.
2. Run an in-page JS probe and collect:

| Check | Expected |
|---|---|
| `navigator.userAgent` does **not** include `HeadlessChrome` | ✓ |
| `navigator.webdriver` is `undefined` or `false` | ✓ |
| `navigator.plugins.length > 0` | ✓ |
| `navigator.languages` is non-empty array | ✓ |
| `window.chrome` defined with `runtime` key | ✓ |
| WebGL `UNMASKED_VENDOR_WEBGL` present | Informational — likely `SwiftShader`, flagged as expected leak |

3. Unless `--skip-sannysoft`: navigate to `https://bot.sannysoft.com`, wait for load + 2s settle, scrape the pass/fail table into structured data.
4. Print a report (pretty text or JSON).
5. Exit `0` if all "must-pass" checks pass; `1` otherwise. Sannysoft results are informational and do **not** gate exit code.

### .github/workflows/build.yml

One job. Triggers: push to `main`, tags matching `v*`, pull requests.

Steps:
1. `actions/checkout`
2. `docker/setup-buildx-action`
3. Build image locally with buildx, tagged `chikin:ci`, cache enabled.
4. `docker run -d --name chikin -p 127.0.0.1:9222:9222 chikin:ci`
5. Poll `http://localhost:9222/json/version` with timeout (~20s).
6. `actions/setup-node` → `cd verify && npm ci && node verify.js --skip-sannysoft`
7. If verify fails: job fails, nothing pushed.
8. If verify passes **and** event is **not** a PR:
   - `docker/login-action` to `ghcr.io` using `GITHUB_TOKEN`.
   - `docker/metadata-action` computes tags from git ref:
     - `main` → `:latest`, `:<short-sha>`
     - `v1.2.3` → `:v1.2.3`, `:latest` (if not prerelease)
   - `docker/build-push-action` with `push: true`, pulling from the earlier buildx cache (no rebuild).
9. Always: `docker logs chikin > chrome.log` and upload as a workflow artifact for debugging.

### .github/workflows/sannysoft-canary.yml

Scheduled weekly (`on: schedule: cron`). Same build-and-verify as above, but **with** sannysoft (no `--skip-sannysoft`). Does not push. Run failure = regression signal; GitHub's default failure notification is sufficient, no custom issue-opening logic.

## Data flow

1. Client calls `GET http://localhost:9222/json/version`.
2. Chrome returns JSON including a `webSocketDebuggerUrl`.
3. Client opens WebSocket to that URL; CDP session is live.
4. Client sends CDP commands (`Target.createTarget`, `Page.navigate`, `Runtime.evaluate`, etc.); Chrome executes and responds.
5. Pages render into Xvfb's framebuffer; screenshot commands capture from that framebuffer — looks identical to a real headed browser's output.

## Error handling

- **Xvfb fails to start:** entrypoint.sh's bounded wait loop exits non-zero → container exits → Docker's `restart: unless-stopped` retries → if persistent, `docker compose logs chrome` shows the wait-loop diagnostic.
- **Chrome crashes:** `tini` is PID 1 and propagates signals; entrypoint.sh `exec`s into `google-chrome`, so Chrome's exit code becomes the container's exit code; Docker's `restart: unless-stopped` retries.
- **Healthcheck flaps:** `docker compose ps` shows unhealthy; troubleshooting section in README covers the common causes (shm too small, X socket not ready, flag typo).
- **`verify.js` can't connect:** prints a clear "container not reachable at `<host>`, is it running?" error and exits non-zero.

## Testing

- **Local:** `docker compose up -d && cd verify && npm install && node verify.js` is documented as the "did it work?" step in the README's quickstart.
- **CI:** `build.yml` runs `verify.js --skip-sannysoft` as a push gate.
- **Upstream drift:** `sannysoft-canary.yml` runs weekly against the real site to catch detection changes from Google or sannysoft.

## Security

- CDP has no authentication. Port is published on `127.0.0.1` only. README explicitly warns not to change this to `0.0.0.0`.
- Remote access is via SSH tunnel, as in the original spec.
- `--no-sandbox` is used. The `chrome-data` volume is a fully untrusted browser profile. README says to treat it as compromised after any untrusted browsing and to `docker compose down -v` to wipe.
- GHCR package is public; no secrets in the image.

## Out of scope (explicitly deferred)

- Multi-arch images (arm64 via chromium).
- Stealth sidecar auto-injecting fingerprint patches.
- Image signing with cosign.
- Published npm package / CLI wrapper around compose.
- `verify.js` as its own installable npm package.

## References

- Existing spec: `../../headless-browser-debug-setup.md` (base material, to be superseded by this repo's README).
- Chrome DevTools Protocol: https://chromedevtools.github.io/devtools-protocol/
- `chrome-remote-interface`: https://github.com/cyrus-and/chrome-remote-interface
- `bot.sannysoft.com`: public fingerprint test page, used for canary checks only.
