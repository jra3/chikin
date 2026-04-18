# Dockerized Headless Chrome for DevTools / CDP Debugging

A containerized Chrome exposing the DevTools Protocol on port 9222, driven remotely via CDP (e.g. the `chrome-devtools` MCP server). No display server, no VNC.

Tested on Ubuntu 22.04/24.04 hosts.

---

## Architecture

```
┌──────────────────────┐        ┌──────────────────────────────┐
│  your laptop         │        │  ubuntu server               │
│                      │        │                              │
│  chrome-devtools MCP │──SSH──▶│  127.0.0.1:9222              │
│         │            │ tunnel │         │                    │
│         ▼            │        │         ▼                    │
│  CDP client          │        │  ┌────────────────────────┐  │
│                      │        │  │ docker: headless chrome│  │
│                      │        │  │   :9222 inside         │  │
│                      │        │  └────────────────────────┘  │
└──────────────────────┘        └──────────────────────────────┘
```

---

## Host prerequisites

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"
newgrp docker   # or log out/in
```

---

## Dockerfile

Save as `~/chrome-debug/Dockerfile`:

```dockerfile
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
      libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
      libxrender1 libxss1 libxtst6 xdg-utils tini \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r chrome && useradd -r -g chrome -G audio,video chrome \
 && mkdir -p /data && chown -R chrome:chrome /data

USER chrome
WORKDIR /data

EXPOSE 9222

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/google-chrome"]
CMD ["--headless=new", \
     "--remote-debugging-port=9222", \
     "--remote-debugging-address=0.0.0.0", \
     "--user-data-dir=/data", \
     "--no-first-run", \
     "--no-default-browser-check", \
     "--disable-gpu", \
     "--disable-dev-shm-usage", \
     "--no-sandbox", \
     "--window-size=1920,1080", \
     "about:blank"]
```

### Why these flags

- `--remote-debugging-address=0.0.0.0` — binds to all *container* interfaces. Docker's port publishing below restricts it to the host's loopback.
- `--disable-dev-shm-usage` — Chrome writes large shared-memory chunks; default Docker `/dev/shm` is 64 MB and crashes Chrome. Alternative: run with `--shm-size=2g`.
- `--no-sandbox` — Chrome's setuid sandbox needs capabilities Docker strips. Safe for a disposable debug container; **never use this for real browsing**.
- `tini` — PID 1 signal handling so `docker stop` cleanly kills Chrome.

---

## docker-compose.yml

Save as `~/chrome-debug/docker-compose.yml`:

```yaml
services:
  chrome:
    build: .
    image: chrome-debug:latest
    container_name: chrome-debug
    restart: unless-stopped
    shm_size: "2gb"
    ports:
      - "127.0.0.1:9222:9222"   # loopback only — never 0.0.0.0
    volumes:
      - chrome-data:/data
    healthcheck:
      test: ["CMD", "sh", "-c", "wget -qO- http://localhost:9222/json/version >/dev/null"]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  chrome-data:
```

---

## Build and run

```bash
cd ~/chrome-debug
docker compose build
docker compose up -d
docker compose logs -f   # verify it started
```

Sanity check (on the server):

```bash
curl -s http://localhost:9222/json/version
# {"Browser":"HeadlessChrome/...","webSocketDebuggerUrl":"ws://..."}
```

---

## Connect from your laptop

### SSH tunnel

```bash
ssh -N -L 9222:localhost:9222 user@your-server
```

Leave this running. Now `http://localhost:9222` on your laptop hits the container.

**One catch.** Chrome's DevTools protocol returns WebSocket URLs using the `Host` header it saw when you hit `/json`. When you connect via a tunnel, that host is `localhost:9222`, which is what CDP clients expect — so this works correctly. If you front it with a reverse proxy that rewrites the host, you'll need to either preserve the host header or use the `webSocketDebuggerUrl` from `/json/version` and rewrite it client-side.

Verify from laptop:

```bash
curl -s http://localhost:9222/json/version
```

---

## Wire up `chrome-devtools` MCP

Add to your Claude Code MCP config (`~/.claude/mcp.json` or project-level equivalent):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browserUrl",
        "http://localhost:9222"
      ]
    }
  }
}
```

The exact flag name varies by MCP implementation — check `npx chrome-devtools-mcp --help`. Look for one of: `--browserUrl`, `--cdp-endpoint`, `--browserWSEndpoint`. If it wants the WebSocket URL directly, fetch it:

```bash
curl -s http://localhost:9222/json/version | jq -r .webSocketDebuggerUrl
```

Restart Claude Code so it picks up the MCP server, then ask it to navigate/screenshot — it'll drive the container.

---

## Common operations

```bash
# Restart Chrome (clears state if you're not using the volume)
docker compose restart

# Nuke profile and start fresh
docker compose down -v && docker compose up -d

# Follow logs
docker compose logs -f chrome

# Shell into container
docker compose exec chrome bash

# List open targets (tabs) via CDP
curl -s http://localhost:9222/json | jq '.[] | {title, url, webSocketDebuggerUrl}'

# Open a new tab via CDP
curl -s -X PUT "http://localhost:9222/json/new?https://example.com"
```

---

## Troubleshooting

**Container exits immediately.** Check `docker compose logs chrome`. Most common: missing `--no-sandbox` or `/dev/shm` too small. The Dockerfile above handles both.

**`curl localhost:9222` hangs or refuses.** Container may still be starting — wait ~2s. Or the port isn't published: check `docker compose ps` shows `127.0.0.1:9222->9222/tcp`.

**CDP client connects but WebSocket upgrades fail.** Firewall or proxy between your laptop and the server is stripping upgrade headers. Use a plain SSH tunnel (shown above), not an HTTP proxy.

**Chrome crashes under load.** Increase shared memory: in `docker-compose.yml` bump `shm_size` to `4gb`, or remove `--disable-dev-shm-usage` and rely purely on the larger shm.

**Screenshots are blank.** You may need to explicitly set a viewport before capturing. Chrome in `--headless=new` mode supports real rendering, but some MCP tools default to a 0×0 viewport until `Emulation.setDeviceMetricsOverride` is called.

**Fonts render as boxes.** Install more font packages in the Dockerfile: `fonts-noto fonts-noto-cjk fonts-noto-color-emoji`.

---

## Security notes

- Port 9222 is published on `127.0.0.1` only. **Do not change this to `0.0.0.0`.** The DevTools protocol has zero authentication — anyone on the network who can reach it can execute arbitrary JavaScript and exfiltrate cookies.
- The container runs as a non-root `chrome` user, but with `--no-sandbox`. Treat the browser profile as fully compromised if it visits untrusted content.
- The `chrome-data` volume persists cookies and history across restarts. Delete it (`docker compose down -v`) if you want a clean slate.

---

## Optional: multiple Chrome instances

Duplicate the service in `docker-compose.yml` with different published ports:

```yaml
  chrome-alt:
    extends: chrome
    container_name: chrome-debug-alt
    ports:
      - "127.0.0.1:9223:9222"
    volumes:
      - chrome-data-alt:/data
```

Now you have `:9222` and `:9223` for parallel sessions.
