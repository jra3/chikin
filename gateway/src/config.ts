function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env ${name}=${raw} is not a number`);
  }
  return n;
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? def : raw;
}

export const config = {
  // HTTP listener. Bound to loopback by default — CDP/MCP have a bearer, but
  // the dashboard and /vnc proxy are loopback-trusted.
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 8080),

  // Bearer token required on /b/<name>/. Empty disables auth (dev only).
  token: process.env.GATEWAY_TOKEN ?? "",

  // Docker access via the scoped tecnativa/docker-socket-proxy (HTTP, no TLS).
  dockerHost: str("DOCKER_PROXY_HOST", "docker-socket-proxy"),
  dockerPort: int("DOCKER_PROXY_PORT", 2375),

  // Fleet member image + network. The network name is forced (compose `name:`)
  // so the gateway and provisioned containers share one resolvable DNS domain.
  image: str("CHROME_IMAGE", "chikin:local"),
  // Optional golden-profile seed: a Docker volume whose contents are cloned into
  // every NEW per-name profile so browsers start already logged in. Populate it
  // with `bin/chikin-snapshot`. Empty = disabled (browsers start fresh).
  seedVolume: str("SEED_VOLUME", ""),
  // Control-plane network (internal: true): gateway <-> socket-proxy <-> chrome
  // CDP. Egress network gives the browsers actual internet access for browsing.
  network: str("CHIKIN_NETWORK", "chikin-net"),
  egressNetwork: str("CHIKIN_EGRESS_NETWORK", "chikin-egress"),

  // Per-browser limits and lifecycle.
  maxFleet: int("MAX_FLEET", 8),
  idleTtlMs: int("IDLE_TTL_SEC", 900) * 1000,
  reapIntervalMs: int("REAP_INTERVAL_SEC", 30) * 1000,
  provisionTimeoutMs: int("PROVISION_TIMEOUT_SEC", 90) * 1000,

  // Shared host scratch dir, mounted as ~/Downloads + the upload path on every
  // browser (issue #8). Resolved on the Docker host, not inside the gateway.
  sharedDir: str("SHARED_DIR", "/tmp/chikin-shared"),
  windowSize: str("WINDOW_SIZE", "1920,1080"),

  // Ports inside each chrome container.
  cdpPort: int("CHROME_CDP_PORT", 9222),
  vncPort: int("CHROME_VNC_PORT", 6080),

  // The per-browser MCP engine. One child process per browser, connecting to
  // the container's CDP endpoint over the internal network.
  cdmCommand: str("CDM_COMMAND", "/app/node_modules/.bin/chrome-devtools-mcp"),

  containerPrefix: "chikin-chrome-",
  volumePrefix: "chikin-profile-",
} as const;

export function containerName(name: string): string {
  return config.containerPrefix + name;
}

export function volumeName(name: string): string {
  return config.volumePrefix + name;
}

export function vncUrl(name: string): string {
  return `http://${containerName(name)}:${config.vncPort}`;
}
