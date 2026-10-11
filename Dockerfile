FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive

# Pin the chrome user to a fixed UID/GID so volumes created by the gateway
# provisioner can be chowned deterministically (see gateway provisioner and
# the self-chown fallback in entrypoint.sh).
ENV CHROME_UID=1100 CHROME_GID=1100

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates tini xvfb socat \
      x11vnc novnc websockify \
      fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
      libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
      libxrender1 libxss1 libxtst6 xdg-utils \
  && : "KNOWN RESIDUAL NON-REPRODUCIBILITY (CHK-009/M4): google-chrome-stable" \
  && : "below comes from Google's floating apt repo, which only serves the newest" \
  && : "version — so this layer is not pinned to an exact Chrome version. Exact" \
  && : "apt-version pinning is fragile here (old versions vanish and break builds)," \
  && : "so it is intentionally left unpinned. Base image + npm deps ARE pinned." \
  && if [ "$TARGETARCH" = "amd64" ]; then \
       wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
         | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
       echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
         > /etc/apt/sources.list.d/google-chrome.list && \
       apt-get update && apt-get install -y --no-install-recommends google-chrome-stable; \
     elif [ "$TARGETARCH" = "arm64" ]; then \
       apt-get install -y --no-install-recommends chromium && \
       ln -sf /usr/bin/chromium /usr/local/bin/google-chrome; \
     else \
       echo "chikin: unsupported TARGETARCH=$TARGETARCH" >&2 && exit 1; \
     fi \
  && rm -rf /var/lib/apt/lists/*

# Some novnc builds ship the client only as vnc.html; symlink an index so
# /vnc/<name>/ lands on a usable page without a query string.
RUN if [ -f /usr/share/novnc/vnc.html ] && [ ! -e /usr/share/novnc/index.html ]; then \
      ln -s vnc.html /usr/share/novnc/index.html; \
    fi

RUN groupadd -r -g "$CHROME_GID" chrome \
 && useradd -r -u "$CHROME_UID" -m -d /home/chrome -g chrome -G audio,video chrome \
 && mkdir -p /data && chown -R chrome:chrome /data \
 && mkdir -p /home/chrome/Downloads && chown -R chrome:chrome /home/chrome/Downloads \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY --chmod=0755 entrypoint.sh /entrypoint.sh

# Managed Chrome policy (#106). Password leak detection opens a "password found
# in a data breach" warning after a login with a leaked password, and in a
# fleet nobody sees, that warning swallows every synthetic click until it is
# dismissed: the page stays visible and focused but receives no input at all.
# Only leak detection is off; the password manager, and the golden profile's
# saved logins, are untouched. google-chrome reads /etc/opt/chrome, chromium
# (the arm64 build) reads /etc/chromium.
#
# The directories are made first, 0755, on purpose: `COPY --chmod` applies its
# mode to the parent directories it creates too, and a 0644 directory has no
# execute bit, so Chrome (running as the chrome user) cannot enter it and
# silently runs with no policy at all.
RUN install -d -m 0755 /etc/opt/chrome/policies/managed /etc/chromium/policies/managed
COPY --chmod=0644 chrome-policies/chikin.json /etc/opt/chrome/policies/managed/chikin.json
COPY --chmod=0644 chrome-policies/chikin.json /etc/chromium/policies/managed/chikin.json

# NOTE: the container starts as root so entrypoint.sh can self-chown the
# /data profile volume (the gateway may provision a fresh, root-owned volume),
# then drops to the unprivileged chrome user before launching anything.
WORKDIR /data

EXPOSE 9222 6080

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
