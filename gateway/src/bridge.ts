import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Session } from "./session.js";
import { log } from "./log.js";
import { isValidHandle, HANDLE_RULE } from "./names.js";
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

// Synthetic gateway-owned tool. THE session MUST call this before any browser
// tool: it labels the driving instance with a unique, human-friendly handle that
// surfaces in the dashboard, logs, and noVNC title, making an otherwise anonymous
// `inst-<pid>` session correlatable to what it's doing. The description is written
// to be fully self-explanatory so a naive MCP client reaches correct usage from
// the tool schema alone (see also the augmented initialize `instructions` and the
// gating error). Kept in lockstep with the RESET_TOOL pattern above.
const IDENTIFY_TOOL = {
  name: "chikin_identify",
  description:
    "REQUIRED FIRST STEP — call this before using ANY browser tool. Every other " +
    "browser tool is blocked until you identify. Give this chikin session a unique, " +
    "human-friendly `handle` describing what you (the driving instance) are doing, so " +
    "the session is correlatable in the dashboard, logs, and noVNC title. " +
    `The handle must be ${HANDLE_RULE}. It must be unique across all live sessions — ` +
    "if the one you pick is already taken you'll get an error naming the conflict; just " +
    "choose another. Optionally pass a short free-text `description` for richer context. " +
    'Example: { "handle": "mulm-login-fix", "description": "debugging the MULM OAuth callback" }. ' +
    "You must re-identify after any reconnect.",
  inputSchema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: `Unique short slug identifying this session (${HANDLE_RULE}), e.g. "mulm-login-fix".`,
      },
      description: {
        type: "string",
        description: "Optional one-line free-text description of what this session is doing.",
      },
    },
    required: ["handle"],
    additionalProperties: false,
  },
};

// Prepended to the upstream chrome-devtools-mcp `instructions` so a caller with
// zero prior knowledge of chikin learns the contract up front, before ever
// touching a browser tool. Layer 1 of the self-directing design.
const CHIKIN_INSTRUCTIONS =
  "This is a chikin browser gateway. Before using ANY browser tool, you MUST call " +
  "`chikin_identify` with a unique short `handle` (e.g. `mulm-login-fix`) describing what " +
  "you're doing; the handle labels this session everywhere it surfaces. Browser tools are " +
  "blocked until you identify. `chikin_reset` hard-resets a wedged browser.";

// Control methods/tools a not-yet-identified session may always use. `initialize`
// and `tools/list` are MCP methods (never `tools/call`); the two chikin_* tools
// are gateway-owned and handled without a browser.
const ALWAYS_ALLOWED_TOOLS = new Set([IDENTIFY_TOOL.name, RESET_TOOL.name]);

export type FrameAction = "forward" | "identify" | "reset" | "block";

// Pure routing/gate decision for a client->child frame, given whether the
// session has identified. Extracted as a seam so the gate can be unit-tested
// without a live browser. Only `tools/call` is gated — every other MCP method
// (initialize, tools/list, ping, notifications, …) forwards untouched.
export function classifyClientFrame(
  f: { method?: string; params?: { name?: string } },
  identified: boolean,
): FrameAction {
  if (f?.method !== "tools/call") return "forward";
  const tool = f.params?.name;
  if (tool === IDENTIFY_TOOL.name) return "identify";
  if (tool === RESET_TOOL.name) return "reset";
  if (!identified && !ALWAYS_ALLOWED_TOOLS.has(tool ?? "")) return "block";
  return "forward";
}

/**
 * Does this client frame actually drive the BROWSER? True only for a
 * `tools/call` the gate forwards to chrome-devtools-mcp — so the client
 * bridge's keepalive `ping`, `initialize`, `tools/list`, notifications, the
 * gateway-owned `chikin_identify`/`chikin_reset`, and calls blocked by the
 * identify gate are all excluded.
 *
 * This is the single definition of "real browser activity" behind
 * `Activity.lastBrowserActivity` and therefore behind the attached-tier reap
 * TTL (issue #57): the plain idle clock cannot be used, because the client
 * heartbeat exists precisely to keep it fresh.
 */
export function isBrowserWork(
  f: { method?: string; params?: { name?: string } } | null | undefined,
  identified: boolean,
): boolean {
  if (!f || f.method !== "tools/call") return false;
  return classifyClientFrame(f, identified) === "forward";
}

// Layer 3 of the self-directing design: the actionable error a blocked browser
// tool returns, naming chikin_identify, the handle format, and a worked example
// so a caller that just starts browsing self-corrects on its first call.
export function identifyRequiredMessage(tool: string | undefined): string {
  return (
    `This chikin browser is not yet identified, so '${tool ?? "that tool"}' is blocked. ` +
    "Before using any browser tool, call `chikin_identify` with a unique `handle` — a short slug " +
    `(${HANDLE_RULE}) describing what you're doing, ` +
    'e.g. { "handle": "mulm-login-fix" } (optionally add a "description"). Then retry.'
  );
}

// Merge chikin's contract into whatever instructions the upstream child returned,
// preserving the upstream text. Mutates the initialize result in place.
export function augmentInstructions(result: { instructions?: string }): void {
  const upstream = typeof result.instructions === "string" ? result.instructions.trim() : "";
  result.instructions = upstream ? `${CHIKIN_INSTRUCTIONS}\n\n${upstream}` : CHIKIN_INSTRUCTIONS;
}

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

  // Rotate a browser still running an older image onto the current one, but
  // ONLY on a cold attach — with no client stream open, nobody is disturbed by
  // the recreate (issue #57). During a mid-session child respawn a stream is
  // attached, so the wedged browser is rebuilt from the image it already has.
  const canRotateImage = () => (deps.registry.getActivity(name)?.streams ?? 0) === 0;

  // Provision the browser, recreating the container if its Chrome is wedged
  // (ensureContainer's health probe throws ProvisionError). The profile volume
  // survives a recreate, so cookies/login persist. Anything else — fleet cap,
  // docker API hiccups — must propagate untouched: destroying a healthy
  // container over a transient proxy error (or recreate-looping a slow cold
  // boot) would be worse than the failure itself.
  async function provision(): Promise<string> {
    try {
      return await deps.provisioner.ensureContainer(name, { canRotateImage });
    } catch (e) {
      if (!(e instanceof ProvisionError)) throw e;
      log.warn(`session[${name}]: container unhealthy, recreating`, String(e));
      await deps.provisioner.recreateContainer(name);
      return await deps.provisioner.ensureContainer(name, { canRotateImage });
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
        // Append the gateway's synthetic tools to tools/list replies.
        if (toolsListIds.has(f.id)) {
          toolsListIds.delete(f.id);
          if (Array.isArray(f.result?.tools)) f.result.tools.push(RESET_TOOL, IDENTIFY_TOOL);
        }
        // Layer 1 of the self-directing design: fold chikin's contract into the
        // initialize result's `instructions` before the client sees it. This is
        // the genuine handshake reply (respawn replays are swallowed elsewhere).
        if (initId !== undefined && f.id === initId && f.result && typeof f.result === "object") {
          augmentInstructions(f.result as { instructions?: string });
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

  // Reply to a gateway-owned tool call on the gateway's own behalf (never
  // forwarded to the child), mirroring handleReset's MCP tool-result shape.
  const replyTool = (id: string | number | undefined, text: string, isError: boolean): void => {
    if (id === undefined || session?.isClosed) return;
    http
      .send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError },
      } as JSONRPCMessage)
      .catch((e) => log.warn(`session[${name}]: tool reply failed`, String(e)));
  };

  // The client is identifying this session (chikin_identify). Validate the
  // handle, enforce global uniqueness across live sessions, record it for
  // display/correlation, then unlock browser tools. Never forwarded to the child.
  function handleIdentify(id: string | number | undefined, args: Record<string, unknown> | undefined): void {
    const handle = args?.handle;
    const description = args?.description;
    if (!isValidHandle(handle)) {
      replyTool(
        id,
        `Invalid handle ${JSON.stringify(handle)}: must be ${HANDLE_RULE}. ` +
          'Example: { "handle": "mulm-login-fix" }.',
        true,
      );
      return;
    }
    if (description !== undefined && typeof description !== "string") {
      replyTool(id, "`description` must be a string when provided.", true);
      return;
    }
    if (!deps.registry.claimHandle(handle, session)) {
      replyTool(
        id,
        `Handle '${handle}' is already in use by another live chikin session. ` +
          "Pick a different unique handle and call chikin_identify again.",
        true,
      );
      return;
    }
    session.handleDescription = description;
    log.info(`session[${name}] (${handle}): identified${description ? ` — ${description}` : ""}`);
    replyTool(
      id,
      `Identified as '${handle}'${description ? ` (${description})` : ""}. ` +
        "Browser tools are now unlocked for this session.",
      false,
    );
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
    // Gateway-owned tools + the identify gate. Only tools/call is affected;
    // initialize / tools/list / notifications always fall through to forward.
    if (f && f.method === "tools/call") {
      const action = classifyClientFrame(f, session.handle !== undefined);
      if (action === "reset") {
        void handleReset(f.id);
        return;
      }
      if (action === "identify") {
        handleIdentify(f.id, f.params?.arguments);
        return;
      }
      if (action === "block") {
        // Layer 3: instructive error until the session identifies. Not tracked
        // in inflight (never forwarded), so nothing to fail on respawn.
        replyTool(f.id, identifyRequiredMessage(f.params?.name), true);
        return;
      }
    }
    // Real browser work — the ONLY thing that moves the browser-activity clock
    // the attached-tier reap TTL runs on (issue #57). Everything the gate
    // handles itself above (identify/reset/block) and every non-tools/call frame
    // (ping, initialize, tools/list, notifications) is excluded by construction,
    // which is exactly what makes that clock meaningful.
    if (isBrowserWork(f, session.handle !== undefined)) deps.registry.touchBrowserActivity(name);
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
