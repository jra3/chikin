# --- build stage: compile TypeScript -----------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# chrome-devtools-mcp pulls puppeteer-core; never fetch a browser (we connect
# to the fleet over CDP via --browserUrl).
ENV PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
COPY package.json ./
RUN npm install --include=dev
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
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/src/index.js"]
