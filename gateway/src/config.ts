function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env ${name}=${raw} is not a number`);
  }
  return n;
}

function num(name: string, def: number): number {
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

function bool(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`env ${name}=${process.env[name]} must be a boolean (1/0, true/false, on/off)`);
}

export type SandboxMode = "auto" | "on" | "off";

function sandboxMode(name: string, def: SandboxMode): SandboxMode {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return def;
  if (raw === "auto" || raw === "on" || raw === "off") return raw;
  throw new Error(`env ${name}=${process.env[name]} must be one of auto|on|off`);
}

export const config = {
  // HTTP listener. Bound to loopback by default — CDP/MCP have a bearer, but
  // the dashboard and /vnc proxy are loopback-trusted.
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 8080),

  // Bearer token required on /b/<name>/. Empty disables auth (dev only).
  token: process.env.GATEWAY_TOKEN ?? "",

  // Extra browser Origins trusted by ALL the loopback Origin/Host guards —
  // dashboard (/), noVNC websocket (/vnc), and the MCP Host check (/b) —
  // comma-separated full origins, e.g. an SSH-tunnel hostname. Empty =
  // loopback-only. See CHK-006/CHK-006a.
  extraOrigins: str("GATEWAY_EXTRA_ORIGINS", ""),

  // Docker access via the scoped tecnativa/docker-socket-proxy (HTTP, no TLS).
  dockerHost: str("DOCKER_PROXY_HOST", "docker-socket-proxy"),
  dockerPort: int("DOCKER_PROXY_PORT", 2375),

  // Chrome renderer-sandbox policy (H1 hardening). Chrome's user-namespace
  // sandbox now runs in the hardened container (CapDrop:[ALL], no-new-privileges)
  // via a custom seccomp profile that allows only the 5 namespace/chroot
  // syscalls it needs. But the sandbox requires the *host* to permit unprivileged
  // user namespaces; where it doesn't, Chrome hard-fails to boot rather than
  // silently downgrading.
  //   auto (default): run sandboxed when the host supports it, else fall back to
  //                   --no-sandbox so the browser still boots (loud WARN log).
  //   on:             force sandboxed; fail loudly if the host can't support it.
  //   off:            force --no-sandbox (pre-hardening behavior).
  // The actual launch decision is made per-browser in the container entrypoint,
  // which probes the host prerequisite; the gateway passes this mode down and
  // attaches the seccomp profile for auto/on. See entrypoint.sh + provisioner.ts.
  sandbox: sandboxMode("CHIKIN_SANDBOX", "auto"),

  // Fleet member image + network. The network name is forced (compose `name:`)
  // so the gateway and provisioned containers share one resolvable DNS domain.
  image: str("CHROME_IMAGE", "chikin:local"),
  // Optional golden-profile seed: a Docker volume whose contents are cloned into
  // every NEW per-name profile so browsers start already logged in. Populate it
  // with `bin/chikin-snapshot`. Empty = disabled (browsers start fresh).
  seedVolume: str("SEED_VOLUME", ""),
  // Gateway <-> Browser data plane (internal: true): CDP + VNC. The Docker
  // control plane (socket-proxy) lives on the separate chikin-control network,
  // which browsers cannot reach (see docs/adr/0002). Egress network gives the
  // browsers actual internet access for browsing.
  network: str("CHIKIN_NETWORK", "chikin-net"),
  egressNetwork: str("CHIKIN_EGRESS_NETWORK", "chikin-egress"),

  // Per-browser limits and lifecycle.
  maxFleet: int("MAX_FLEET", 8),
  idleTtlMs: int("IDLE_TTL_SEC", 900) * 1000,
  reapIntervalMs: int("REAP_INTERVAL_SEC", 30) * 1000,
  provisionTimeoutMs: int("PROVISION_TIMEOUT_SEC", 90) * 1000,

  // Per-container resource caps (M3). MAX_FLEET bounds the *count* of browsers;
  // these bound what any *one* browser can consume, so a single hostile or
  // runaway page can't OOM, fork-bomb, or CPU-starve the host and take down
  // every other client's browser. Applied to each container's HostConfig.
  //
  // memoryMb: hard memory ceiling. Note the 2g ShmSize below is a tmpfs whose
  // usage is charged to the same memory cgroup, so this MUST exceed 2g to leave
  // Chrome room above a full /dev/shm — 3g gives ~1g of headroom. Swap is pinned
  // equal to Memory (MemorySwap=Memory) so a container can't escape the cap into
  // swap. 0 disables the memory cap.
  memoryMb: int("BROWSER_MEMORY_MB", 3072),
  // pidsLimit: max processes/threads — the fork-bomb guard. Chrome spawns a
  // process per tab/renderer plus threads; 512 is ample for typical use. 0/-1
  // = unlimited.
  pidsLimit: int("BROWSER_PIDS_LIMIT", 512),
  // cpus: CPU cap in whole/fractional cores, converted to Docker NanoCpus. 2.0
  // lets a browser use two cores flat-out but no more. 0 disables the CPU cap.
  cpus: num("BROWSER_CPUS", 2.0),
  // nofile: open-file-descriptor ceiling (soft=hard) to stop one browser
  // exhausting the host's fd table. Chrome is fd-hungry, so keep this generous;
  // 8192 bounds abuse while leaving real pages plenty. 0 disables the ulimit.
  nofile: int("BROWSER_NOFILE", 8192),

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
  // Extra flags appended to every chrome-devtools-mcp invocation, whitespace-
  // separated. E.g. CDM_EXTRA_ARGS="--experimentalPageIdRouting" routes every
  // page-scoped tool by explicit pageId instead of the sticky selected-page
  // binding that causes the stale-target wedge (issue #15) — opt-in because it
  // changes the tool schemas the client sees.
  cdmExtraArgs: str("CDM_EXTRA_ARGS", "").split(/\s+/).filter(Boolean),

  // Log verbosity (debug|info|warn|error). Read here too so the effective value
  // shows up alongside every other knob on /healthz and the dashboard.
  logLevel: str("LOG_LEVEL", "info"),

  // Reclaim `chikin-profile-inst-*` volumes orphaned before the reaper learned
  // to remove them (issue #58). Runs once at startup, name-scoped, and only for
  // volumes no container mounts — see Provisioner.sweepOrphanInstanceVolumes.
  // Set CHIKIN_VOLUME_GC=0 to leave every existing volume alone.
  volumeGc: bool("CHIKIN_VOLUME_GC", true),

  containerPrefix: "chikin-chrome-",
  volumePrefix: "chikin-profile-",
  // `bin/chikin-mcp` names each Claude Code instance `inst-<pid>`, so this
  // prefix is what makes a browser (and its profile volume) DISPOSABLE. Names
  // starting with it are reserved for throwaway-per-run browsers: their volumes
  // are removed with the container. Every other name — `golden`, `hermes`, any
  // named client profile — is sticky and never collected. See isInstanceName.
  instancePrefix: "inst-",
} as const;

export function containerName(name: string): string {
  return config.containerPrefix + name;
}

export function volumeName(name: string): string {
  return config.volumePrefix + name;
}

/**
 * Is this browser name a disposable per-run instance (`inst-<pid>`)?
 *
 * This is the AUTHORITATIVE safety rule for every destructive volume path in
 * the gateway (issues #58/#59). It is deliberately name-based rather than
 * label-based: Docker volume labels are immutable after creation, so the
 * `chikin.role=instance` label this build started writing is absent on every
 * volume that predates it — including the operator's `chikin-profile-golden`
 * full of hand-authenticated logins. A name test is correct against volumes of
 * any vintage; a label test is not.
 */
export function isInstanceName(name: string): boolean {
  return name.startsWith(config.instancePrefix) && name.length > config.instancePrefix.length;
}

/** The same rule applied to a Docker volume name (`chikin-profile-inst-<pid>`). */
export function isInstanceVolume(volume: string): boolean {
  const prefix = config.volumePrefix + config.instancePrefix;
  return volume.startsWith(prefix) && volume.length > prefix.length;
}

/**
 * Labels for a profile volume. `chikin.fleet=1` stays on everything so the
 * whole fleet remains one inventory, but `chikin.role` splits disposables from
 * profiles worth keeping, so `--filter label=chikin.role=instance` is a prune
 * scope that cannot reach the golden profile (issue #59, direction 1).
 *
 * Forward-looking only — labels can't be added to an existing volume, so this
 * protects nothing that already exists on an operator's host. The README
 * warning and the name-based rule above are what protect those.
 */
export function volumeLabels(name: string): Record<string, string> {
  return {
    "chikin.fleet": "1",
    "chikin.name": name,
    "chikin.role": isInstanceName(name) ? "instance" : "profile",
  };
}

export function vncUrl(name: string): string {
  return `http://${containerName(name)}:${config.vncPort}`;
}
