#!/bin/sh
set -eu

CDP_PORT="${CDP_PORT:-9222}"
WINDOW_SIZE="${WINDOW_SIZE:-1920,1080}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
EXTRA_CHROME_ARGS="${EXTRA_CHROME_ARGS:-}"

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

# shellcheck disable=SC2086
exec google-chrome \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/data \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --no-sandbox \
  --disable-blink-features=AutomationControlled \
  --window-size="$WINDOW_SIZE" \
  $EXTRA_CHROME_ARGS \
  about:blank
