FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates tini xvfb socat \
      fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
      libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
      libxrender1 libxss1 libxtst6 xdg-utils \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r chrome \
 && useradd -r -m -d /home/chrome -g chrome -G audio,video chrome \
 && mkdir -p /data && chown -R chrome:chrome /data \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY --chmod=0755 entrypoint.sh /entrypoint.sh

USER chrome
WORKDIR /data

EXPOSE 9222

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
