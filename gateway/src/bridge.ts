import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Session } from "./session.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";
import type { Provisioner } from "./provisioner.js";
import { ProvisionError } from "./provisioner.js";

export interface BridgeDeps {
  provisioner: Provisioner;
  registry: Registry;
}

// JSON-RPC frame shape we care about (id + method/params routing). The MCP SDK
// types the transport payload as `unknown`, so we narrow locally.
type Frame = {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
  result?: { tools?: unknown[]; isError?: boolean } & Record<string, unknown>;
  error?: unknown;
} & Record<string, unknown>;

const REPLAY_TIMEOUT_MS = 20_000;
const MAX_RESPAWN_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- App-level wedge detection (issue #15) ---------------------------------
// chrome-devtools-mcp (<=1.1.1) holds a sticky reference to its selected page;
// a target swap (SPA route change, cross-origin nav) can leave it bound to a
// zombie target: navigation tools then return success but silently no-op,
// while the underlying Chrome is perfectly healthy. None of that is a
// transport failure, so the respawn path would never trigger. Instead we
// verify navigations OUT OF BAND: after the child reports a nav succeeded, we
// ask the container's CDP /json/list (ground truth) whether the page set
// actually moved. Strikes on consecutive failures force a child respawn — a
// fresh child binds the browser's REAL current target.
const NAV_TOOLS = new Set(["navigate_page", "new_page", "navigate_page_history"]);
const NAV_VERIFY_DELAY_MS = Number(process.env.NAV_VERIFY_DELAY_MS || 2500);
const NAV_WEDGE_STRIKES = 2;
// Consecutive child-stderr CDP connection failures (e.g. the container was
// docker-rm'd out from under it and the child keeps fetching a dead IP) that
// force a respawn. Internal fetch errors never surface on the stdio transport.
const CDP_FAIL_LIMIT = 3;
const CDP_FAIL_RE = /fetch failed|ECONNREFUSED|ERR_CONNECTION_REFUSED|socket hang up/i;

// Two URLs point at the same document if origin+path match (query/hash differ
// across redirects too often to compare strictly).
function sameDoc(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

// Synthetic gateway-owned tool, appended to every tools/list reply. Lets the
// model itself recover a wedged browser instead of waiting for the watchdog.
const RESET_TOOL = {
  name: "chikin_reset",
  description:
    "Hard-reset this chikin browser when it is wedged — e.g. navigate_page/new_page " +
    "return success but the page never actually changes, or snapshots keep showing a " +
    "stale page. Recreates the browser container (profile, cookies and logins are " +
    "preserved) and reattaches devtools. Open tabs are lost. Use only when navigation " +
    "tools have stopped having any effect.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/**
 * Provision (or reuse) the named browser, spawn its chrome-devtools-mcp child,
 * and wire a transparent JSON-RPC pump between the client's HTTP MCP transport
 * and the child's stdio. Returns once both transports are started; the caller
 * then drives the initialize handshake via `session.http.handleRequest`.
 *
 * RESILIENCE (issue: a wedged Chrome / crashed child must not kill the client
 * session). The child is REPLACEABLE. If it exits or its send fails, we:
 *   1. fail any in-flight request with a retryable JSON-RPC error (its result
 *      is gone), so the client unblocks instead of hanging;
 *   2. re-provision the browser (recreating a container whose Chrome is wedged),
 *      spawn a fresh child, and REPLAY the cached `initialize` (+ initialized
 *      notification) to it, swallowing the replayed responses — the client
 *      already completed initialize once;
 *   3. keep the SAME `http` transport (and MCP session id) alive throughout.
 * The common case (child died, Chrome still healthy) reconnects to the very
 * same browser, so tabs/state survive. The client sees one retryable error at
 * most, never a dropped session.
 */
export async function createSession(name: string, deps: BridgeDeps): Promise<Session> {
  let session!: Session;
  let child: StdioClientTransport | null = null;
  let childGen = 0;
  let respawning = false;

  // The client's one-time `initialize` request, cached so it can be replayed to
  // a respawned child. Without it the fresh child has no MCP session.
  let initFrame: JSONRPCMessage | null = null;
  let initId: string | number | undefined;
  // Client requests forwarded to the child still awaiting a reply. Must be
  // failed on child loss or the client (Claude Code) hangs forever.
  const inflight = new Map<string | number, true>();

  // --- wedge-watchdog state ---
  let currentIp: string | null = null; // container IP of the live child's CDP
  // nav request id -> what was asked for + the real page set before the nav
  const pendingNavs = new Map<string | number, { url?: string; before: string[] | null }>();
  let navStrikes = 0;
  let cdpFailStreak = 0;
  // tools/list request ids whose replies need the synthetic chikin_reset appended
  const toolsListIds = new Set<string | number>();

  // Ground truth from the browser itself: the URLs of its real page targets.
  // null = unknown (CDP unreachable / no ip yet) — callers must not strike on it.
  async function realPages(): Promise<string[] | null> {
    if (!currentIp) return null;
    try {
      const res = await fetch(`http://${currentIp}:${config.cdpPort}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const targets = (await res.json()) as Array<{ type?: string; url?: string }>;
      return targets
        .filter((t) => t.type === "page")
        .map((t) => t.url ?? "")
        .sort();
    } catch {
      return null;
    }
  }

  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      session.sessionId = sid;
      deps.registry.bindSessionId(sid, session);
      log.info(`session[${name}]: initialized as ${sid}`);
    },
  });

  // -32001 = "link lost". Fail one pending client request so it unblocks.
  const failRequest = (id: string | number, message: string) => {
    inflight.delete(id);
    http
      .send({ jsonrpc: "2.0", id, error: { code: -32001, message } })
      .catch((e) => log.warn(`session[${name}]: ->client error send failed`, String(e)));
  };
  const failAllInflight = (message: string) => {
    for (const id of [...inflight.keys()]) failRequest(id, message);
  };

  // Provision the browser, recreating the container if its Chrome is wedged
  // (ensureContainer's health probe throws ProvisionError). The profile volume
  // survives a recreate, so cookies/login persist. Anything else — fleet cap,
  // docker API hiccups — must propagate untouched: destroying a healthy
  // container over a transient proxy error (or recreate-looping a slow cold
  // boot) would be worse than the failure itself.
  async function provision(): Promise<string> {
    try {
      return await deps.provisioner.ensureContainer(name);
    } catch (e) {
      if (!(e instanceof ProvisionError)) throw e;
      log.warn(`session[${name}]: container unhealthy, recreating`, String(e));
      await deps.provisioner.recreateContainer(name);
      return await deps.provisioner.ensureContainer(name);
    }
  }

  // Normal child->client pump for a given generation. Stale-generation frames
  // (from an already-discarded child) are ignored.
  function wireChild(c: StdioClientTransport, gen: number): void {
    c.onmessage = (msg) => {
      if (gen !== childGen) return;
      deps.registry.touch(name);
      cdpFailStreak = 0; // the child is demonstrably talking to Chrome again
      const f = msg as Frame;
      if (f && f.id !== undefined) {
        inflight.delete(f.id);
        // Append the gateway's synthetic tool to tools/list replies.
        if (toolsListIds.has(f.id)) {
          toolsListIds.delete(f.id);
          if (Array.isArray(f.result?.tools)) f.result.tools.push(RESET_TOOL);
        }
        // A nav tool replied: schedule out-of-band verification against the
        // browser's real CDP (the wedge reports success while doing nothing).
        const nav = pendingNavs.get(f.id);
        if (nav) {
          pendingNavs.delete(f.id);
          if (!f.error && !f.result?.isError) {
            setTimeout(() => void verifyNav(nav), NAV_VERIFY_DELAY_MS).unref?.();
          }
        }
      }
      http.send(msg).catch((e) => log.warn(`session[${name}]: http send failed`, String(e)));
    };
    c.onclose = () => {
      if (gen !== childGen || session?.isClosed) return;
      void respawnChild("child process exited");
    };
    c.onerror = (e) => log.warn(`session[${name}]: child transport error`, String(e));
  }

  // The child said the nav succeeded — did the browser actually move? Strike
  // when the real page set is byte-identical to the pre-nav snapshot AND the
  // requested URL is nowhere in it; two consecutive strikes = the stale-target
  // wedge, and a fresh child (which binds the REAL current target) clears it.
  // Redirects are safe: they change the page set, which resets the strikes.
  async function verifyNav(nav: { url?: string; before: string[] | null }): Promise<void> {
    if (session?.isClosed || respawning) return;
    const after = await realPages();
    if (!after || !nav.before) return; // no ground truth — never strike blind
    const changed = JSON.stringify(after) !== JSON.stringify(nav.before);
    const landed = nav.url !== undefined && after.some((u) => sameDoc(u, nav.url as string));
    if (changed || landed) {
      navStrikes = 0;
      return;
    }
    navStrikes++;
    log.warn(
      `session[${name}]: nav verify failed (${navStrikes}/${NAV_WEDGE_STRIKES}): ` +
        `requested ${nav.url ?? "(history)"} but real pages unchanged [${after.join(", ")}]`,
    );
    if (navStrikes >= NAV_WEDGE_STRIKES) {
      navStrikes = 0;
      void respawnChild("navigation wedge detected (child bound to stale target)");
    }
  }

  // Replay the cached initialize against a freshly-started child so it rebuilds
  // MCP session state. Replayed responses are swallowed (client already has
  // them). Resolves once the child has acked initialize.
  function replayInitialize(c: StdioClientTransport, gen: number): Promise<void> {
    const frame = initFrame;
    if (!frame) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("child initialize replay timed out")),
        REPLAY_TIMEOUT_MS,
      );
      c.onmessage = (msg) => {
        if (gen !== childGen) return;
        const f = msg as Frame;
        if (f && f.id === initId) {
          clearTimeout(timer);
          wireChild(c, gen); // restore normal pumping
          c.send({ jsonrpc: "2.0", method: "notifications/initialized" })
            .then(() => resolve())
            .catch(reject);
        }
        // swallow anything else arriving mid-replay
      };
      c.send(frame).catch(reject);
    });
  }

  // Spawn + start a chrome-devtools-mcp child bound to the browser's CDP.
  async function startChild(gen: number): Promise<StdioClientTransport> {
    const ip = await provision();
    currentIp = ip;
    cdpFailStreak = 0;
    // Connect by IP (not container name): Chrome's DevTools HTTP endpoint
    // rejects a DNS-name Host header but accepts an IP; socat in the container
    // bridges to Chrome's loopback CDP port.
    const c = new StdioClientTransport({
      command: config.cdmCommand,
      args: ["--browserUrl", `http://${ip}:${config.cdpPort}`, ...config.cdmExtraArgs],
      stderr: "pipe",
    });
    wireChild(c, gen);
    await c.start();
    c.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trimEnd();
      log.debug(`[cdm:${name}] ${line}`);
      // The child's CDP fetches fail INTERNALLY (e.g. the container was
      // docker-rm'd and it keeps hitting a dead IP) without ever closing the
      // stdio transport — count consecutive failures and respawn. Any
      // successful child reply resets the streak (see wireChild.onmessage).
      if (gen === childGen && CDP_FAIL_RE.test(line)) {
        cdpFailStreak++;
        if (cdpFailStreak >= CDP_FAIL_LIMIT && !respawning && !session?.isClosed) {
          cdpFailStreak = 0;
          void respawnChild(`child lost CDP connection (${CDP_FAIL_LIMIT} consecutive failures)`);
        }
      }
    });
    return c;
  }

  // Replace a dead child transparently, keeping the client http session alive.
  async function respawnChild(why: string): Promise<void> {
    if (session?.isClosed || respawning) return;
    respawning = true;
    log.warn(`session[${name}]: child gone (${why}); respawning`);
    failAllInflight(`chikin browser restarted (${why}); retry the request`);
    // Those requests got error replies; nothing left to verify or decorate.
    pendingNavs.clear();
    toolsListIds.clear();
    navStrikes = 0;
    try {
      await child?.close();
    } catch {
      /* already gone */
    }
    for (let attempt = 1; attempt <= MAX_RESPAWN_ATTEMPTS; attempt++) {
      if (session?.isClosed) return;
      const gen = ++childGen;
      try {
        const c = await startChild(gen);
        await replayInitialize(c, gen);
        child = c;
        respawning = false;
        log.info(`session[${name}]: child respawned (gen ${gen})`);
        return;
      } catch (e) {
        log.warn(`session[${name}]: respawn attempt ${attempt} failed`, String(e));
        await sleep(Math.min(500 * attempt, 5000));
      }
    }
    // Exhausted: fall back to dropping the session. The self-healing client
    // bridge will then reconnect from scratch.
    respawning = false;
    log.error(`session[${name}]: child respawn exhausted; closing session`);
    await session.close("child respawn exhausted");
  }

  // The model asked for a hard reset (it noticed the browser is wedged before
  // the watchdog did). Recreate the container outright — not just the child —
  // then respawn and reply on the gateway's own behalf. Never forwarded to the
  // child; never tracked in inflight (respawnChild would fail it mid-reset).
  async function handleReset(id: string | number | undefined): Promise<void> {
    log.warn(`session[${name}]: chikin_reset requested by client`);
    while (respawning) await sleep(250); // let any in-progress respawn settle first
    if (session?.isClosed) return;
    try {
      await deps.provisioner.recreateContainer(name);
      await respawnChild("chikin_reset");
    } catch (e) {
      log.error(`session[${name}]: chikin_reset failed`, String(e));
    }
    if (id === undefined || session?.isClosed) return;
    const ok = child != null && !respawning;
    http
      .send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: ok
                ? "Browser reset: container recreated and devtools reattached (profile/logins preserved; open tabs lost). Retry your navigation."
                : "Reset attempted but the browser did not come back; the session will reconnect from scratch.",
            },
          ],
          isError: !ok,
        },
      } as JSONRPCMessage)
      .catch((e) => log.warn(`session[${name}]: reset reply failed`, String(e)));
  }

  // Client -> child pump. Cache initialize; track requests; fail fast while a
  // respawn is in flight so the client retries instead of hanging.
  http.onmessage = (msg) => {
    deps.registry.touch(name);
    const f = msg as Frame;
    if (f && f.method === "initialize") {
      initFrame = msg;
      initId = f.id;
    }
    // Gateway-owned tool: handle here, never forward.
    if (f && f.method === "tools/call" && f.params?.name === RESET_TOOL.name) {
      void handleReset(f.id);
      return;
    }
    const tracked = f && f.method !== undefined && f.id !== undefined;
    if (tracked) {
      inflight.set(f.id as string | number, true);
      if (f.method === "tools/list") toolsListIds.add(f.id as string | number);
      // Record nav requests + the browser's REAL page set right now, so the
      // reply can be verified out-of-band (see verifyNav).
      if (f.method === "tools/call" && NAV_TOOLS.has(f.params?.name ?? "")) {
        const id = f.id as string | number;
        const url = typeof f.params?.arguments?.url === "string" ? f.params.arguments.url : undefined;
        const nav = { url, before: null as string[] | null };
        pendingNavs.set(id, nav);
        void realPages().then((p) => {
          nav.before = p;
        });
      }
    }

    if (respawning || !child) {
      if (tracked) failRequest(f.id as string | number, "chikin browser restarting; retry the request");
      return;
    }
    const gen = childGen; // bind this send to the child it used
    child.send(msg).catch((e) => {
      const why = String(e);
      log.warn(`session[${name}]: child send failed`, why);
      // Only fail if a respawn hasn't already failed it (no duplicate replies),
      // and never let a STALE rejection (child already replaced while this
      // send's failure was in flight) kill the freshly respawned child.
      if (tracked && inflight.has(f.id as string | number))
        failRequest(f.id as string | number, `chikin browser send failed (${why}); retry the request`);
      if (gen === childGen) void respawnChild(`child send failed: ${why}`);
    });
  };

  http.onclose = () => void session.close("http transport closed");

  session = new Session(
    name,
    http,
    async () => {
      try {
        await child?.close();
      } catch {
        /* ignore */
      }
    },
    (s) => deps.registry.remove(s),
  );

  // Child first so its stdin is ready before the initialize frame arrives.
  child = await startChild(++childGen);
  await http.start();

  return session;
}
