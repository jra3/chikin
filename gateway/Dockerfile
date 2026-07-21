# --- build stage: compile TypeScript -----------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# chrome-devtools-mcp pulls puppeteer-core; never fetch a browser (we connect
# to the fleet over CDP via --browserUrl).
ENV PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
# Install from the committed lockfile so the published image is reproducible
# (npm ci fails if package.json and package-lock.json drift). See CHK-004.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# --- runtime stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
# Production deps only — this also lands the chrome-devtools-mcp binary at
# /app/node_modules/.bin/chrome-devtools-mcp (the per-browser MCP engine).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Drop root: the gateway needs no privileges at runtime (it reaches Docker only
# over TCP to the socket-proxy, and binds 8080 which is unprivileged). Run as the
# stock non-root `node` user (uid 1000). See CHK-012.
RUN chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "dist/src/index.js"]
