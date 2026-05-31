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
  # Hand off to the unprivileged user, preserving env and supplementary groups.
  exec setpriv --reuid="$CHROME_UID" --regid="$CHROME_GID" --init-groups -- "$0" "$@"
fi

# Force HOME to the chrome user's home. After the setpriv re-exec, HOME is still
# whatever root had (/root), which uid 1100 can't write — Chrome's crashpad and
# config dirs would fail. /home/chrome is created+owned by the user in the image.
export HOME=/home/chrome

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

# shellcheck disable=SC2086
exec google-chrome \
  --remote-debugging-port="$CHROME_LOOPBACK_PORT" \
  --remote-allow-origins=* \
  --user-data-dir=/data \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --no-sandbox \
  --disable-blink-features=AutomationControlled \
  --window-size="$WINDOW_SIZE" \
  $EXTRA_CHROME_ARGS \
  about:blank
