#!/bin/sh
set -eu

CDP_PORT="${CDP_PORT:-9222}"
WINDOW_SIZE="${WINDOW_SIZE:-1920,1080}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
EXTRA_CHROME_ARGS="${EXTRA_CHROME_ARGS:-}"
ENABLE_VNC="${ENABLE_VNC:-0}"
VNC_PORT="${VNC_PORT:-6080}"
CHROME_UID="${CHROME_UID:-1100}"
CHROME_GID="${CHROME_GID:-1100}"
# Renderer-sandbox policy (H1 hardening): auto|on|off. See README + the gateway's
# CHIKIN_SANDBOX config. The gateway passes this down and attaches the matching
# seccomp profile; this entrypoint makes the actual per-browser launch decision.
CHIKIN_SANDBOX="${CHIKIN_SANDBOX:-auto}"

# --- Privilege bootstrap -----------------------------------------------------
# The container may be launched with a freshly-created /data volume that Docker
# made root-owned (the gateway provisioner creates per-name profile volumes).
# Chrome runs unprivileged as CHROME_UID, so fix ownership while we still have
# root, then drop down and re-exec. This is the self-chown fallback that makes
# the volume writable even if no external chown sidecar ran (issues #2/#3).
if [ "$(id -u)" = "0" ]; then
  cur_owner="$(stat -c %u /data 2>/dev/null || echo "")"
  if [ "$cur_owner" != "$CHROME_UID" ]; then
    echo "entrypoint: chowning /data to $CHROME_UID:$CHROME_GID (was uid=$cur_owner)" >&2
    chown -R "$CHROME_UID:$CHROME_GID" /data || true
  fi
  # The per-name shared-scratch dir (~/Downloads + upload path, M2/CHK-007) is a
  # host bind Docker auto-creates as root:0755 on first mount. Chrome runs as
  # CHROME_UID, so ensure it can write downloads here. Non-recursive and guarded
  # so we don't churn a client's existing files on every restart.
  dl_owner="$(stat -c %u /home/chrome/Downloads 2>/dev/null || echo "")"
  if [ -n "$dl_owner" ] && [ "$dl_owner" != "$CHROME_UID" ]; then
    echo "entrypoint: chowning /home/chrome/Downloads to $CHROME_UID:$CHROME_GID (was uid=$dl_owner)" >&2
    chown "$CHROME_UID:$CHROME_GID" /home/chrome/Downloads || true
  fi
  # Hand off to the unprivileged user, preserving env and supplementary groups.
  exec setpriv --reuid="$CHROME_UID" --regid="$CHROME_GID" --init-groups -- "$0" "$@"
fi

# Force HOME to the chrome user's home. After the setpriv re-exec, HOME is still
# whatever root had (/root), which uid 1100 can't write — Chrome's crashpad and
# config dirs would fail. /home/chrome is created+owned by the user in the image.
export HOME=/home/chrome

# Clear stale single-instance locks before launching. Chrome removes these on a
# clean exit, but a reaped or crashed container (SIGKILL after the gateway's stop
# grace) leaves them in the *persistent* profile volume. They're symlinks keyed
# to the writing container's hostname, so a recreated container reusing the same
# volume sees a foreign hostname, decides the profile is "in use on another host"
# (liveness unprobeable across hosts), and refuses to start — which kills the
# chrome-devtools-mcp child and triggers a reap/recreate thrash. Single-session-
# per-name guarantees no other live container shares this volume, so removing
# them unconditionally on start is safe.
rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie

# Chrome (since ~111) ignores --remote-debugging-address=0.0.0.0 and always
# binds to loopback. We run Chrome on a private loopback-only port and use
# socat to bridge the publicly-advertised CDP_PORT to it.
CHROME_LOOPBACK_PORT=9223

# Xvfb wants WxHxD (e.g. 1920x1080x24). Chrome wants W,H.
XVFB_SIZE="$(echo "$WINDOW_SIZE" | tr ',' 'x')x24"

Xvfb ":$DISPLAY_NUM" -screen 0 "$XVFB_SIZE" -nolisten tcp &

# Wait up to 5s for the X socket to appear.
i=0
while [ ! -S "/tmp/.X11-unix/X$DISPLAY_NUM" ]; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    echo "entrypoint: Xvfb did not create /tmp/.X11-unix/X$DISPLAY_NUM after 5s" >&2
    exit 1
  fi
  sleep 0.1
done

export DISPLAY=":$DISPLAY_NUM"

# socat listens on every interface at CDP_PORT and forwards to Chrome's
# loopback bind. fork lets it handle concurrent CDP clients.
socat "TCP-LISTEN:$CDP_PORT,fork,reuseaddr" "TCP:127.0.0.1:$CHROME_LOOPBACK_PORT" &

# Optional noVNC: a human can watch/drive this browser (captcha solving) via
# the gateway's /vnc/<name>/ reverse proxy. x11vnc exposes the Xvfb display on
# 5900; websockify serves the noVNC web client + a websocket bridge on VNC_PORT.
if [ "$ENABLE_VNC" = "1" ]; then
  x11vnc -display ":$DISPLAY_NUM" -forever -shared -nopw -rfbport 5900 -quiet -bg \
    || echo "entrypoint: x11vnc failed to start" >&2
  websockify --web=/usr/share/novnc "$VNC_PORT" localhost:5900 &
fi

# --- Renderer sandbox decision (H1 hardening) --------------------------------
# Chrome's user-namespace sandbox turns a renderer exploit from immediate
# in-container code execution into something that ALSO needs a sandbox escape.
# It requires the *host* to permit unprivileged user namespaces AND the widened
# seccomp profile the gateway attaches. Where those hold we drop --no-sandbox;
# where they don't Chrome hard-fails to boot, so we probe the exact prerequisite
# (create an unprivileged user namespace, as the chrome user we already dropped
# to) and act on CHIKIN_SANDBOX. `unshare` ships with util-linux (same package
# as setpriv, used above), so it is present.
sandbox_supported() {
  command -v unshare >/dev/null 2>&1 || return 1
  # CLONE_NEWUSER is the gate Chrome's zygote needs; --map-root-user forces the
  # full userns setup path. Silent + throwaway: success (0) means the host+seccomp
  # allow it, so Chrome's namespace sandbox will build.
  unshare --user --map-root-user true >/dev/null 2>&1
}

SANDBOX_ARGS="--no-sandbox"   # default posture unless we decide to sandbox
case "$CHIKIN_SANDBOX" in
  off)
    echo "entrypoint: CHIKIN_SANDBOX=off — Chrome renderer sandbox DISABLED (--no-sandbox)" >&2
    echo "CHIKIN_SANDBOX_STATUS=disabled" >&2
    ;;
  on)
    if sandbox_supported; then
      SANDBOX_ARGS=""
      echo "entrypoint: CHIKIN_SANDBOX=on — Chrome renderer sandbox ENABLED (userns)" >&2
      echo "CHIKIN_SANDBOX_STATUS=sandboxed" >&2
    else
      echo "entrypoint: FATAL: CHIKIN_SANDBOX=on but this host does not permit unprivileged" >&2
      echo "  user namespaces (or the seccomp profile was not attached). Refusing to boot" >&2
      echo "  unsandboxed. Enable unprivileged userns on the host, or use CHIKIN_SANDBOX=auto." >&2
      echo "CHIKIN_SANDBOX_STATUS=failed" >&2
      exit 1
    fi
    ;;
  auto|*)
    if sandbox_supported; then
      SANDBOX_ARGS=""
      echo "entrypoint: CHIKIN_SANDBOX=auto — host supports userns; Chrome renderer sandbox ENABLED" >&2
      echo "CHIKIN_SANDBOX_STATUS=sandboxed" >&2
    else
      echo "entrypoint: WARNING: CHIKIN_SANDBOX=auto but this host does NOT permit unprivileged" >&2
      echo "  user namespaces. FALLING BACK to --no-sandbox — the renderer sandbox is DISABLED," >&2
      echo "  so a renderer exploit is immediate in-container code execution (H1). To fix, enable" >&2
      echo "  unprivileged user namespaces on the host; to silence, set CHIKIN_SANDBOX=off." >&2
      echo "CHIKIN_SANDBOX_STATUS=fell-back" >&2
    fi
    ;;
esac

# shellcheck disable=SC2086
exec google-chrome \
  --remote-debugging-port="$CHROME_LOOPBACK_PORT" \
  --remote-allow-origins=* \
  --user-data-dir=/data \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  $SANDBOX_ARGS \
  --disable-blink-features=AutomationControlled \
  --window-size="$WINDOW_SIZE" \
  $EXTRA_CHROME_ARGS \
  about:blank
