# chikin

Real (non-headless) Google Chrome in a Docker container, exposing the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) on host port 9322 (9222 inside the container). Suitable for automation where the browser should **not** self-identify as headless.

## What you get

- Full headed Chrome running in a container with no physical display (Xvfb).
- CDP endpoint on `127.0.0.1:9322`.
- No `HeadlessChrome` in the User-Agent.
- `navigator.webdriver` is `undefined` (not `true`) thanks to `--disable-blink-features=AutomationControlled`.
- `window.chrome` is defined (headless Chrome leaves it undefined).
- A `verify.js` script that proves the above.

## What you do NOT get

- Deep stealth. `window.chrome.runtime` is missing (real browsers populate it via the extension host); WebGL vendor/renderer report SwiftShader or null; `navigator.plugins` is Chrome's default without spoofed additions. That's a client-side concern — use [`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth), [`playwright-extra`](https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra), or your own `Page.addScriptToEvaluateOnNewDocument` injection.
- Multi-arch. amd64 only.
- Defense against sophisticated fingerprinters (mouse entropy, TLS fingerprinting). This is a cat-and-mouse game.

## Quickstart

```bash
docker compose up -d
curl -s http://localhost:9322/json/version  # should NOT say HeadlessChrome
cd verify && npm install && node verify.js
```

If the verify script exits `0`, the container is doing its job.

## Using the prebuilt image

```yaml
services:
  chrome:
    image: ghcr.io/<OWNER>/chikin:latest
    container_name: chikin
    restart: unless-stopped
    shm_size: "2gb"
    ports:
      - "127.0.0.1:9322:9222"
    volumes:
      - chikin-data:/data

volumes:
  chikin-data:
```

Replace `<OWNER>` with the GitHub user/org that publishes this repo.

## Configuration

Environment variables, read by `entrypoint.sh`:

| Variable | Default | Meaning |
|---|---|---|
| `CDP_PORT` | `9222` | Port inside the container that clients reach via socat. If you change this, also update the container-side of the `docker-compose.yml` port mapping. |
| `WINDOW_SIZE` | `1920,1080` | `--window-size` for Chrome; also drives the Xvfb screen dimensions. |
| `DISPLAY_NUM` | `99` | Which `:N` display Xvfb creates. Rarely useful to change. |
| `EXTRA_CHROME_ARGS` | *(empty)* | Appended to Chrome's argv. Escape hatch for flags we don't expose. |

Compose-level knobs (edit `docker-compose.yml`):

- `shm_size`: default `2gb`. Bump to `4gb` if Chrome crashes under load.
- Port publishing: default `127.0.0.1:9322:9222`. **Never change the host side to `0.0.0.0`** — CDP has no authentication.

### Why the port shuffle

Chrome (since ~version 111) ignores `--remote-debugging-address=0.0.0.0` and always binds CDP to 127.0.0.1 inside the container. Docker's port publishing can't reach a loopback-only bind, so `entrypoint.sh` runs Chrome on a private loopback port (9223) and uses `socat` to forward `CDP_PORT` (9222) to it. You don't need to care about this unless you're reading the entrypoint.

## Remote access (SSH tunnel)

The CDP endpoint is bound to loopback. To reach it from another machine:

```bash
ssh -N -L 9322:localhost:9322 user@your-server
```

Then on your local machine, `http://localhost:9322` hits the container.

## Using with the chrome-devtools MCP server

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

The flag name varies by implementation — if `--browserUrl` fails, try `--cdp-endpoint` or `--browserWSEndpoint`. You can fetch the WebSocket URL directly:

```bash
curl -s http://localhost:9322/json/version | jq -r .webSocketDebuggerUrl
```

## Using with Puppeteer / Playwright

```js
// Puppeteer
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9322" });

// Playwright
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9322");
```

For stealth, wrap these with `puppeteer-extra` / `playwright-extra` and their stealth plugins — `chikin` deliberately leaves that layer to you.

## Verify script

`verify/verify.js` is a tiny host-side Node (≥20) tool.

```bash
cd verify
npm install
node verify.js                    # pretty output, checks probe + sannysoft
node verify.js --json             # machine-readable
node verify.js --skip-sannysoft   # probe only (offline / CI)
node verify.js --host http://localhost:9999  # custom CDP endpoint
```

Exit codes:
- `0` — all required checks passed.
- `1` — one or more required checks failed.
- `2` — could not connect to CDP.
- `3` — unexpected error.

## Troubleshooting

**`curl localhost:9322` hangs or refuses.** Container still starting — wait a few seconds. Or the port isn't published: check `docker compose ps` shows `127.0.0.1:9322->9222/tcp`.

**Container exits immediately.** `docker compose logs chrome`. Most commonly: `/dev/shm` too small (use the compose file's `shm_size: 2gb`) or Chrome's sandbox conflicts.

**`verify.js` says UA contains `HeadlessChrome`.** A `--headless` flag has snuck in somewhere — check `entrypoint.sh`.

**`verify.js` says `navigator.webdriver` is `true`.** `--disable-blink-features=AutomationControlled` is missing — check `entrypoint.sh`.

**Chrome crashes under load.** Bump `shm_size` to `4gb` in `docker-compose.yml`.

**`verify.js` reports `sannysoft check failed: ... timed out`.** Some Docker host network configurations block outbound traffic from containers. The required probe checks still pass; sannysoft is informational. In CI this should work normally.

## Security

- CDP has **no authentication**. Port publishes to `127.0.0.1` only. Do not change to `0.0.0.0`.
- `--no-sandbox` is in use. Treat the `chikin-data` volume as a fully compromised browser profile after any visit to untrusted content; `docker compose down -v` wipes it.
- Container runs as non-root `chrome` user.
- Remote access: use SSH tunnel, not an HTTP proxy.

## License

MIT. See [LICENSE](LICENSE).
