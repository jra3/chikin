#!/usr/bin/env bash
# install.sh — stand up the chikin fleet on this host and wire it into Claude
# Code. Fleet-only, local-only: everything runs on this one machine in
# containers (see docs/adr/0001-fleet-only-local-only.md).
#
# Usage:
#   ./install.sh                 full install (images, client, MCP, autostart)
#   ./install.sh --no-autostart  install but don't add the login autostart unit
#   ./install.sh --uninstall     reverse the install; PRESERVES profile volumes
#   ./install.sh --purge         uninstall AND wipe volumes/seed/shared/images
#   ./install.sh -h              this help
#
# Preconditions (the installer DETECTS these; it never installs them):
#   - Docker 20.10+ with Compose v2   (Docker Desktop on macOS)
#   - Node.js >= 20                    (for the per-instance client bridge)
#   - Claude Code (`claude`) on PATH   (to register the MCP server)
set -euo pipefail

# ---------------------------------------------------------------------------
# Setup / helpers
# ---------------------------------------------------------------------------
REPO="$(cd -P "$(dirname "$0")" >/dev/null && pwd)"
BIN_TARGET="$HOME/.local/bin"
TOOLS=(chikin-mcp chikin-claude chikin-snapshot)
GATEWAY_URL="http://localhost:8080"

# tput colors only when stdout is a tty
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; X=$'\033[0m'
else B=; G=; Y=; R=; X=; fi
say()  { printf '%s\n' "${B}==>${X} $*"; }
ok()   { printf '%s\n' "  ${G}ok${X} $*"; }
warn() { printf '%s\n' "  ${Y}!${X}  $*" >&2; }
die()  { printf '%s\n' "${R}error:${X} $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=mac ;;
  *) die "unsupported OS '$(uname -s)' — chikin packaging targets Linux and macOS." ;;
esac

DOCKER_BIN=""   # resolved absolute docker path, filled by check_prereqs

# ---------------------------------------------------------------------------
# Prerequisite detection (detect-and-guide; never install)
# ---------------------------------------------------------------------------
check_prereqs() {
  say "Checking preconditions"

  if ! command -v docker >/dev/null 2>&1; then
    if [ "$OS" = mac ]; then
      die "Docker not found. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ , start it, then re-run me."
    else
      die "Docker not found. Install it with your package manager (e.g. 'sudo pacman -S docker' / 'sudo apt install docker.io'), enable the daemon and add yourself to the 'docker' group, then re-run me."
    fi
  fi
  DOCKER_BIN="$(command -v docker)"

  if ! docker info >/dev/null 2>&1; then
    [ "$OS" = mac ] \
      && die "Docker is installed but the daemon isn't reachable. Start Docker Desktop and re-run me." \
      || die "Docker is installed but the daemon isn't reachable. Start it ('sudo systemctl start docker') and make sure you're in the 'docker' group, then re-run me."
  fi

  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 not found ('docker compose'). Update Docker / Docker Desktop to a version that bundles Compose v2."
  fi

  if ! command -v node >/dev/null 2>&1; then
    die "Node.js not found. Install Node >= 20 (macOS: 'brew install node'; Linux: your package manager or nvm), then re-run me."
  fi
  local nodemajor
  nodemajor="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$nodemajor" -ge 20 ] 2>/dev/null || die "Node.js >= 20 required (found $(node --version)). Upgrade, then re-run me."

  command -v claude >/dev/null 2>&1 \
    || warn "Claude Code ('claude') not on PATH — I'll skip MCP registration. Install it and run: claude mcp add --scope user chikin -- $BIN_TARGET/chikin-mcp"

  command -v curl >/dev/null 2>&1 || warn "curl not found — I'll skip the final /healthz smoke test."

  ok "docker $(docker --version | awk '{print $3}' | tr -d ,), compose v2, node $(node --version)"
}

# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------
setup_env() {
  say "Configuring .env"
  if [ -f "$REPO/.env" ]; then
    ok ".env already present — leaving it untouched"
  else
    cp "$REPO/.env.example" "$REPO/.env"
    ok "created .env from .env.example (no auth, no seed, CHIKIN_VERSION=latest)"
  fi
}

bring_up() {
  say "Pulling pinned images from ghcr (building nothing)"
  ( cd "$REPO" && docker compose --profile build pull )
  ok "images present"
  say "Starting the gateway + socket-proxy"
  ( cd "$REPO" && docker compose up -d )
  ok "control plane up"
}

install_client() {
  say "Installing the client bridge deps"
  ( cd "$REPO/client" && npm install --omit=dev --silent )
  ok "client bridge ready"
}

link_tools() {
  say "Linking helpers onto PATH ($BIN_TARGET)"
  mkdir -p "$BIN_TARGET"
  local t
  for t in "${TOOLS[@]}"; do
    ln -sf "$REPO/bin/$t" "$BIN_TARGET/$t"
  done
  ok "linked: ${TOOLS[*]}"

  case ":$PATH:" in
    *":$BIN_TARGET:"*) ok "$BIN_TARGET is already on PATH" ;;
    *)
      local rc
      case "${SHELL##*/}" in
        zsh)  rc="$HOME/.zshrc" ;;
        bash) [ "$OS" = mac ] && rc="$HOME/.bash_profile" || rc="$HOME/.bashrc" ;;
        *)    rc="$HOME/.profile" ;;
      esac
      if ! grep -qs 'chikin: add ~/.local/bin' "$rc" 2>/dev/null; then
        {
          echo ''
          echo '# chikin: add ~/.local/bin to PATH'
          echo 'export PATH="$HOME/.local/bin:$PATH"'
        } >> "$rc"
        warn "added ~/.local/bin to PATH in $rc — run 'source $rc' or open a new terminal"
      fi
      ;;
  esac
}

register_mcp() {
  command -v claude >/dev/null 2>&1 || return 0
  say "Registering the user-scope MCP server"
  if claude mcp get chikin >/dev/null 2>&1; then
    ok "MCP server 'chikin' already registered — leaving it"
  else
    claude mcp add --scope user chikin -- "$BIN_TARGET/chikin-mcp"
    ok "registered 'chikin' (every Claude instance now gets its own browser)"
  fi
}

# --- autostart -------------------------------------------------------------
install_autostart() {
  say "Installing login autostart (default; --no-autostart to skip)"
  if [ "$OS" = linux ]; then
    local dir="$HOME/.config/systemd/user" unit
    unit="$dir/chikin.service"
    mkdir -p "$dir"
    cat > "$unit" <<EOF
[Unit]
Description=chikin fleet (browser MCP) — local-only, one host
After=default.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=DOCKER=$DOCKER_BIN
WorkingDirectory=$REPO
ExecStart=$REPO/bin/chikin-up
ExecStop=$DOCKER_BIN compose stop

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now chikin.service
    ok "systemd --user unit enabled (starts at login: chikin.service)"
  else
    local plist="$HOME/Library/LaunchAgents/com.chikin.fleet.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chikin.fleet</string>
  <key>ProgramArguments</key>
  <array><string>$REPO/bin/chikin-up</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>DOCKER</key><string>$DOCKER_BIN</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/chikin-fleet.log</string>
  <key>StandardErrorPath</key><string>/tmp/chikin-fleet.log</string>
</dict>
</plist>
EOF
    launchctl unload "$plist" >/dev/null 2>&1 || true
    launchctl load -w "$plist"
    ok "launchd LaunchAgent loaded (starts at login: com.chikin.fleet)"
    warn "enable 'Start Docker Desktop when you log in' in Docker Desktop settings, or the fleet can't come up at login"
  fi
}

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------
remove_autostart() {
  if [ "$OS" = linux ]; then
    if systemctl --user list-unit-files chikin.service >/dev/null 2>&1; then
      systemctl --user disable --now chikin.service >/dev/null 2>&1 || true
    fi
    rm -f "$HOME/.config/systemd/user/chikin.service"
    systemctl --user daemon-reload 2>/dev/null || true
  else
    local plist="$HOME/Library/LaunchAgents/com.chikin.fleet.plist"
    [ -f "$plist" ] && launchctl unload "$plist" >/dev/null 2>&1 || true
    rm -f "$plist"
  fi
  ok "autostart removed"
}

unlink_tools() {
  local t
  for t in "${TOOLS[@]}"; do
    # only remove links that point back into this repo
    if [ -L "$BIN_TARGET/$t" ] && [ "$(readlink "$BIN_TARGET/$t")" = "$REPO/bin/$t" ]; then
      rm -f "$BIN_TARGET/$t"
    fi
  done
  ok "helpers unlinked"
}

do_uninstall() {
  say "Uninstalling (profile volumes are PRESERVED)"
  remove_autostart
  command -v claude >/dev/null 2>&1 && { claude mcp remove chikin >/dev/null 2>&1 || true; ok "MCP server deregistered"; }
  unlink_tools
  ( cd "$REPO" && docker compose down ) || true
  ok "stack stopped; volumes kept. Reinstall restores every logged-in browser."
  echo "To also wipe profile volumes/seed/shared/images: ./install.sh --purge"
}

do_purge() {
  warn "PURGE destroys all chikin profile volumes (logged-in sessions), the seed, /tmp/chikin-shared, and pulled images."
  printf 'Type "yes" to continue: '
  local reply; read -r reply
  [ "$reply" = yes ] || die "aborted."
  do_uninstall
  say "Purging data and images"
  ( cd "$REPO" && docker compose --profile build down -v ) || true
  docker volume ls -q --filter 'name=chikin-profile-' | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker volume rm chikin-seed >/dev/null 2>&1 || true
  rm -rf /tmp/chikin-shared 2>/dev/null || true
  local ver; ver="$(grep -E '^CHIKIN_VERSION=' "$REPO/.env" 2>/dev/null | cut -d= -f2)"; ver="${ver:-latest}"
  docker image rm "ghcr.io/jra3/chikin:$ver" "ghcr.io/jra3/chikin-gateway:$ver" >/dev/null 2>&1 || true
  ok "purged."
}

# ---------------------------------------------------------------------------
# Smoke test + final banner
# ---------------------------------------------------------------------------
smoke_test() {
  command -v curl >/dev/null 2>&1 || return 0
  say "Verifying the gateway is live (/healthz)"
  local i
  for i in $(seq 1 60); do
    if curl -fs "$GATEWAY_URL/healthz" >/dev/null 2>&1; then
      ok "gateway healthy at $GATEWAY_URL"
      return 0
    fi
    sleep 2
  done
  die "gateway did not report healthy within 2 min. Check: (cd $REPO && docker compose logs gateway)"
}

banner() {
  printf '\n%s\n' "${G}${B}chikin is installed and running.${X}"
  cat <<EOF

  Dashboard:  $GATEWAY_URL/     (watch any browser live over noVNC)

  Just run 'claude' — every instance automatically gets its own isolated
  browser. Pin a sticky, persistent one by name:  chikin-claude <name>

  Update later:   git pull && make update
  Remove:         ./install.sh --uninstall     (keeps your logged-in profiles)
EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
install.sh — stand up the chikin fleet on this host and wire it into Claude Code.

  ./install.sh                 full install (images, client, MCP, autostart)
  ./install.sh --no-autostart  install but don't add the login autostart unit
  ./install.sh --uninstall     reverse the install; PRESERVES profile volumes
  ./install.sh --purge         uninstall AND wipe volumes/seed/shared/images
  ./install.sh -h              this help

Preconditions (detected, never installed): Docker 20.10+ with Compose v2,
Node.js >= 20, and Claude Code ('claude') on PATH.
EOF
}

main() {
  local AUTOSTART=1
  case "${1:-}" in
    -h|--help)   usage; return 0 ;;
    --uninstall) do_uninstall; return 0 ;;
    --purge)     do_purge; return 0 ;;
    --no-autostart) AUTOSTART=0 ;;
    "") ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac

  check_prereqs
  setup_env
  bring_up
  install_client
  link_tools
  register_mcp
  [ "$AUTOSTART" = 1 ] && install_autostart || warn "skipping autostart (--no-autostart)"
  smoke_test
  banner
}

# Run main only when executed directly; sourcing exposes the functions for tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
