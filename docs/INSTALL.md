# Installing chikin

chikin is a **fleet**: one gateway plus on-demand, per-name Chrome containers, all on **one host** (never remote — see [ADR-0001](adr/0001-fleet-only-local-only.md)). It exists so you can run **many Claude Code instances at once**, each driving its own isolated browser.

This guide covers macOS and Linux. Windows is out of scope for now (run it inside WSL2 if you must).

---

## Prerequisites (the installer detects these; it never installs them)

| | What | How |
|---|---|---|
| **Docker + Compose v2** | the whole fleet runs in containers | **macOS:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (enable *Start Docker Desktop at login*). **Linux:** your package manager (`pacman -S docker` / `apt install docker.io` / `dnf install docker`), then start the daemon and add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then re-login). |
| **Node.js ≥ 20** | the per-instance client bridge runs on the host | **macOS:** `brew install node`. **Linux:** your package manager or [nvm](https://github.com/nvm-sh/nvm). |
| **Claude Code** (`claude`) | to register the MCP server | [claude.com/claude-code](https://claude.com/claude-code) |

Docker is a hard precondition — the installer checks for it and, if it's missing or the daemon isn't running, prints what to do and exits. It will not install Docker for you (on macOS that's a GUI app; on Linux it needs `sudo`).

---

## Install

```bash
git clone https://github.com/jra3/chikin.git
cd chikin
./install.sh
```

That single command:

1. **Checks** Docker + Compose v2 + Node ≥ 20 + `claude` (exits with guidance if any is missing).
2. **Creates `.env`** from `.env.example` if you don't have one (no auth, no seed — see [Configuration](#configuration)).
3. **Pulls** the pinned images from ghcr (`docker compose --profile build pull`) and **starts** the gateway + socket-proxy.
4. **Installs** the client bridge deps and **symlinks** `chikin-mcp` / `chikin-claude` / `chikin-snapshot` into `~/.local/bin` (adding it to your `PATH` if needed).
5. **Registers** the user-scope MCP server (`claude mcp add --scope user chikin -- …`) so every Claude Code instance gets its own browser.
6. **Installs login autostart** (default — see below).
7. **Waits for `/healthz`** and prints a success banner.

### Flags

- `./install.sh --no-autostart` — install everything except the login autostart unit.
- `./install.sh --uninstall` — reverse the install; **keeps** your profile volumes (logged-in sessions).
- `./install.sh --purge` — uninstall **and** wipe profile volumes, the seed, `/tmp/chikin-shared`, and pulled images (asks for confirmation).

---

## Using it

Just run `claude` — every instance automatically connects to its own isolated browser (the fleet multiplexes them). Pin a **sticky, persistent** browser by name:

```bash
chikin-claude giard            # this instance always drives the "giard" profile
chikin-claude carey --continue # another instance, isolated "carey"
```

Watch any browser live (or solve a captcha) at the dashboard: <http://localhost:8080/>.

Prove a browser is genuinely non-headless (drives one through the gateway):

```bash
make verify
```

---

## Autostart

Autostart is **on by default** and needs no `sudo`. The installer generates a **login-scoped** unit that runs `bin/chikin-up` (wait for Docker → `docker compose up -d`):

- **Linux:** a systemd **user** unit at `~/.config/systemd/user/chikin.service` (`systemctl --user`).
- **macOS:** a launchd **LaunchAgent** at `~/Library/LaunchAgents/com.chikin.fleet.plist`. Also turn on **Start Docker Desktop when you log in** in Docker Desktop's settings, or the daemon won't be up for the agent to use.

Skip it with `./install.sh --no-autostart`; remove it later with `./install.sh --uninstall`.

Why login-scoped and not boot-time? An interactive Claude Code user is logged in when they use it, and a login-time `docker compose up` conveniently socket-activates a disabled Docker daemon (e.g. on Arch) all by itself.

---

## Updating

```bash
git pull
make update      # re-pull pinned images, restart, refresh the client bridge
```

### Pinning a version

`CHIKIN_VERSION` in `.env` selects the image tag (`ghcr.io/jra3/chikin{,-gateway}:<tag>`). Pin it to a release for a reproducible install:

```bash
# .env
CHIKIN_VERSION=v0.1.0
```

`latest` (the shipped default) tracks the newest build on `main`.

---

## Configuration

Everything lives in `.env` (see [`.env.example`](../.env.example) and the README's Configuration table). Defaults for a fresh install:

- **`GATEWAY_TOKEN`** empty — no auth. Safe because the gateway is bound to `127.0.0.1` only. Set one (`openssl rand -hex 32`) if you want a bearer.
- **`SEED_VOLUME`** empty — the golden-profile seed (browsers start logged in) is off. It's an optional power feature; see the README's *Pre-authenticated browsers* section to enable it.

---

## Doing it by hand

Prefer to see each step? The `Makefile` targets map to what `install.sh` orchestrates:

```bash
make pull        # fetch pinned images from ghcr
make up          # start the control plane
make verify      # prove a browser is non-headless
make down        # stop (keeps volumes)
make update      # pull newer images + restart + refresh client
make uninstall   # reverse install (keeps volumes)
make purge       # uninstall + wipe volumes/seed/shared/images
```

### Developers

Build the images locally instead of pulling:

```bash
make dev-build   # build ghcr images locally as chikin{,-gateway}:local
make dev-up      # bring the fleet up from the local builds
```

---

## Troubleshooting

See the [README's Troubleshooting section](../README.md#troubleshooting). Quick hits:

- **Install exits "Docker … not reachable"** — start Docker (Desktop) and re-run `./install.sh`.
- **`/healthz` never goes green** — `docker compose logs gateway`.
- **`chikin-claude` not found (macOS)** — `~/.local/bin` wasn't on your `PATH`; open a new terminal or `source` your shell rc (the installer adds it and tells you).
- **`make verify` says the UA contains `HeadlessChrome`** — a `--headless` flag snuck into `entrypoint.sh`.
