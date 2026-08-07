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
import { FleetFullError, ProvisionError } from "./provisioner.js";

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
// compare the page list the CHILD reports against the container's CDP
// /json/list (ground truth). Strikes on consecutive failures force a child
// respawn — a fresh child binds the browser's REAL current target.
//
// The test is "does the child's view of the browser match the browser?", NOT
// "did the page set move?". Those look equivalent and are not: a nav to a URL
// that redirects to the page you are ALREADY on moves nothing, and the older
// did-it-move test struck healthy children for it (a live session took a
// strike on Ancestry's legacy->canonical person-page redirect; two in a row
// bounce a working child mid-task). A wedged child is identifiable directly —
// it reports a stale URL the browser no longer has open — so test that.
//
// "No longer has open" is judged against the browser as it was when the child
// reported AND as it is after the settle delay, so the strike cannot mean "the
// page moved after we looked" — a self-redirect, meta refresh, OAuth bounce or
// SPA route change all move the page set inside the verify window while the
// child is perfectly healthy. There is no pre-nav CDP snapshot: the request-time
// /json/list was traded for this reply-time one, which is what makes the verdict
// accurate (it is contemporaneous with the view the child reported).
const NAV_TOOLS = new Set(["navigate_page", "new_page", "navigate_page_history"]);
const NAV_VERIFY_DELAY_MS = Number(process.env.NAV_VERIFY_DELAY_MS || 2500);
const NAV_WEDGE_STRIKES = 2;
// Consecutive superseded (therefore unjudged) nav verifications before the
// session says so. A client navigating faster than NAV_VERIFY_DELAY_MS would
// otherwise run with a quietly suppressed watchdog.
const NAV_SUPERSEDED_ALARM = 5;
// Consecutive child-stderr CDP connection failures (e.g. the container was
// docker-rm'd out from under it and the child keeps fetching a dead IP) that
// force a respawn. Internal fetch errors never surface on the stdio transport.
const CDP_FAIL_LIMIT = 3;
const CDP_FAIL_RE = /fetch failed|ECONNREFUSED|ERR_CONNECTION_REFUSED|socket hang up/i;

// --- Lazy browser attachment (issue #63) ------------------------------------
// The `--browserUrl` a BROWSER-LESS child is spawned against. chrome-devtools-mcp
// resolves its browser connection lazily — `getContext()` is called from inside
// the tool handler, never at startup — so a child pointed here answers
// `initialize`, `tools/list` and `ping` perfectly well while no container exists
// at all. That is what lets a session complete its MCP handshake, register every
// tool, and hold NO fleet slot until it does real browser work.
//
// Port 1 refuses instantly. If a future upstream ever did dereference this at
// startup we want a loud immediate error, not a hang against a black-holed
// address — and the CDP-failure watchdog is disabled while browser-less
// (startChild below), so such an error could never respawn-loop.
const NO_BROWSER_URL = "http://127.0.0.1:1";

export interface ReportedPages {
  pages: string[];
  selected?: string;
}

// The child's own view of the browser, taken from its own tool reply.
//
// chrome-devtools-mcp reports the page list twice: machine-readably as
// `structuredContent.pages` ([{id, url, selected, isolatedContext?}]), and as
// the human-readable "## Pages" block appended to every page-scoped reply:
//
//   ## Pages
//   0: https://example.com/
//   1: https://example.org/ [selected] isolatedContext=work
//
// The structured form is authoritative; the text parse is only a fallback for a
// reply that carries no structuredContent. `selected` is the page the child
// believes its tools act on — the value that goes stale when it wedges.
// Returns null when neither form is parseable, which must NOT be read as
// "healthy" (see navVerdict).
export function reportedPages(result: unknown): ReportedPages | null {
  return pagesFromStructuredContent(result) ?? pagesFromText(result);
}

function pagesFromStructuredContent(result: unknown): ReportedPages | null {
  const list = (result as { structuredContent?: { pages?: unknown } })?.structuredContent?.pages;
  if (!Array.isArray(list)) return null;
  const pages: string[] = [];
  let selected: string | undefined;
  for (const entry of list) {
    const url = (entry as { url?: unknown })?.url;
    if (typeof url !== "string" || !url) continue;
    pages.push(url);
    if ((entry as { selected?: unknown })?.selected === true) selected = url;
  }
  return pages.length ? { pages, selected } : null;
}

function pagesFromText(result: unknown): ReportedPages | null {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  const pages: string[] = [];
  let selected: string | undefined;
  let inPages = false;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      // Only the "## Pages" section — "## Extension Pages" and the other
      // numbered sections are not what the child's tools act on.
      inPages = /^##\s+Pages\s*$/.test(line);
      continue;
    }
    if (!inPages) continue;
    // Anything after the URL (`[selected]`, `isolatedContext=<name>`, whatever
    // upstream adds next) is tolerated: dropping the line entirely would blind
    // the watchdog rather than fail loudly.
    const m = /^\s*\d+:\s+(\S+)(\s+\[selected\])?(\s.*)?$/.exec(line);
    if (!m) continue;
    pages.push(m[1]);
    if (m[2]) selected = m[1];
  }
  return pages.length ? { pages, selected } : null;
}

// The whole wedge decision, kept pure so it can be tested without a browser.
//
//   "ok"      — the child's selected page really is open; it is not wedged
//   "wedge"   — the child is acting on a page the browser does not have
//   "unknown" — not enough evidence; NEVER strike (no ground truth, or the
//               child's reply carried no usable page list, e.g. upstream
//               changed the format — the format tests are what catch that)
//
// `samples` are CDP page sets observed at different instants; the child is only
// judged wedged if its selected page is in NONE of them. That is what keeps
// "the page moved after we looked" (client-side redirect, meta refresh, OAuth
// bounce, SPA route change landing inside the verify delay) out of the strike
// count: such a page WAS really open when the child reported it, so the
// reply-time sample clears it. A strike then means only what it should — the
// child is bound to a target the browser has never had open in this window.
export function navVerdict(
  reported: ReportedPages | null,
  ...samples: Array<string[] | null>
): "ok" | "wedge" | "unknown" {
  const selected = reported?.selected;
  const known = samples.filter((s): s is string[] => Array.isArray(s));
  if (!selected || !known.length) return "unknown";
  return known.some((real) => real.some((u) => sameDoc(u, selected))) ? "ok" : "wedge";
}

// Which scheduled verifications are allowed to reach navVerdict, kept pure for
// the same reason it is.
//
// A verification is judged when its nav is still the newest one to have replied:
// otherwise an automation loop's own NEXT navigation would read as this one's
// wedge. Dropping every superseded nav outright, though, silently disables the
// watchdog for any client that navigates faster than the verify delay — and a
// wedged child replies in milliseconds, so it is the client's think-time that
// sets that cadence. So a superseded nav is still judged when it names the same
// page as the newest one. That is the wedge signature exactly: a wedged child
// repeats one stale page for every nav, while a healthy fast loop reports a
// different page each time and stays correctly suppressed.
export function shouldJudgeNav(
  nav: { seq: number; reported: ReportedPages | null },
  newest: { seq: number; selected?: string },
): boolean {
  if (nav.seq === newest.seq) return true;
  const selected = nav.reported?.selected;
  if (selected === undefined || newest.selected === undefined) return false;
  return sameDoc(selected, newest.selected);
}

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

/**
 * The tool error returned when a browser tool arrives but the browser cannot be
 * provisioned — usually `FleetFullError` (issue #63), but a Docker or
 * socket-proxy failure lands here too and needs different advice: pointing the
 * model at the dashboard's slot accounting explains nothing when no slot is the
 * problem.
 *
 * Before lazy provisioning this was an HTTP 429 on the MCP handshake, which
 * killed the whole session: an MCP client fixes its tool registry at session
 * start, so the browser lane stayed unavailable for the rest of that session
 * even after a slot freed. Now the session is already up and every tool is
 * registered; only this one call failed, and the model can free a slot and
 * retry. Both branches therefore say so — what happened, that the session is
 * intact, and what to do.
 */
export function browserUnavailableMessage(tool: string | undefined, cause: unknown): string {
  const guidance =
    cause instanceof FleetFullError
      ? "Retry the call once a slot frees; the chikin dashboard (the gateway's root URL) lists which browsers " +
        "are holding them and how long each has been idle."
      : "No fleet slot is missing — chikin failed to build the browser itself (Docker or the socket proxy). " +
        "Retry the call; if it fails the same way again the gateway host needs attention, and its logs carry " +
        "the underlying Docker error.";
  return (
    `chikin could not start a browser for '${tool ?? "that tool"}': ${String(cause)}. ` +
    "This session is still connected and every browser tool is still registered — nothing has been lost, " +
    "and the very same call works as soon as a browser can be started. " +
    guidance
  );
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
 * Spawn this session's chrome-devtools-mcp child and wire a transparent
 * JSON-RPC pump between the client's HTTP MCP transport and the child's stdio.
 * Returns once both transports are started; the caller then drives the
 * initialize handshake via `session.http.handleRequest`.
 *
 * LAZY PROVISIONING (issue #63). Creating a session does NOT create a browser.
 * The child starts BROWSER-LESS (see NO_BROWSER_URL) and the container is
 * provisioned by `attachBrowser` on the first frame `isBrowserWork` recognises
 * — the same predicate the reap TTL runs on. Everything before that (the
 * handshake, `tools/list`, the keepalive ping, `chikin_identify`,
 * `chikin_reset`, identity-blocked calls) is served with no container in
 * existence, so MAX_FLEET now bounds browsers actually being DRIVEN rather than
 * MCP clients that happen to be connected. Eight idle Claude Code windows used
 * to saturate the fleet and lock out the one session that needed a browser.
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
  // Container IP the CHILD is bound to (null = this child is browser-less, so
  // the session holds no fleet slot — issue #63). It tracks the child, not the
  // session's claim: `startChild` stamps it before the new child is spawned, so
  // through the whole attach swap it names a browser no child is serving yet.
  let currentIp: string | null = null;
  // In-flight `attachBrowser`, so concurrent first calls share one provision —
  // and so a frame landing mid-swap joins that attach instead of racing it.
  let attaching: Promise<void> | null = null;
  // "Can a browser frame go straight to the child?" — the question `currentIp`
  // alone cannot answer, and the reason it must not be asked alone.
  const browserReady = (): boolean => currentIp !== null && attaching === null;
  // nav request id -> what was asked for (the child's view comes off its reply)
  const pendingNavs = new Map<string | number, { url?: string }>();
  let navStrikes = 0;
  // The newest verifiable nav REPLY: its sequence number and the page the child
  // reported selected. Anything older is normally not judged — back-to-back navs
  // would otherwise judge an older nav's view against a browser that has
  // legitimately moved on since (see shouldJudgeNav).
  let navNewest: { seq: number; selected?: string } = { seq: 0 };
  // Consecutive verifications dropped that way, so a session whose watchdog is
  // effectively suppressed says so instead of just going quiet.
  let navSuperseded = 0;
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
    // Declare the provision so the reaper can see it (CHK-015). `registry.reserve`
    // no longer implies this: since issue #63 the container is created on the
    // first browser tool call, long after the name stopped being pending, so
    // without this mark a sweep landing mid-provision could remove the profile
    // volume between the moment it is seeded and the moment the container mounts
    // it — silently handing out a blank profile instead of a golden clone.
    deps.registry.markProvisioning(name);
    try {
      try {
        return await deps.provisioner.ensureContainer(name, { canRotateImage });
      } catch (e) {
        if (!(e instanceof ProvisionError)) throw e;
        log.warn(`session[${name}]: container unhealthy, recreating`, String(e));
        await deps.provisioner.recreateContainer(name);
        return await deps.provisioner.ensureContainer(name, { canRotateImage });
      }
    } finally {
      deps.registry.clearProvisioning(name);
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
            // Capture the child's OWN view from this reply AND sample the
            // browser right now, while the two are still contemporaneous — a
            // page that moves on its own afterwards must not read as a wedge.
            const reported = reportedPages(f.result);
            navNewest = { seq: navNewest.seq + 1, selected: reported?.selected };
            const withView = {
              ...nav,
              gen, // bind this check to the child (and container) it came from
              seq: navNewest.seq,
              reported,
              atReply: realPages(),
            };
            setTimeout(() => void verifyNav(withView), NAV_VERIFY_DELAY_MS).unref?.();
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

  // The child said the nav succeeded — is it still talking about the browser we
  // actually have? Two consecutive disagreements = the stale-target wedge, and
  // a fresh child (which binds the REAL current target) clears it. A nav that
  // moved nothing is NOT evidence of a wedge on its own, and neither is a page
  // that moved after the child reported it: see navVerdict.
  async function verifyNav(nav: {
    url?: string;
    gen: number;
    seq: number;
    reported: ReportedPages | null;
    atReply: Promise<string[] | null>;
  }): Promise<void> {
    if (session?.isClosed || respawning) return;
    // The child that scheduled this check is gone — a respawn (or a
    // chikin_reset, which swaps the CONTAINER too) has happened since, so its
    // view says nothing about the child now serving this session.
    if (nav.gen !== childGen) return;
    if (!shouldJudgeNav(nav, navNewest)) {
      navSuperseded++;
      if (navSuperseded === NAV_SUPERSEDED_ALARM)
        log.warn(
          `session[${name}]: ${navSuperseded} consecutive nav verifications superseded — ` +
            `this client navigates faster than NAV_VERIFY_DELAY_MS (${NAV_VERIFY_DELAY_MS}ms), ` +
            `so wedge detection is only running on navs that report the same page`,
        );
      return;
    }
    navSuperseded = 0;
    const [atReply, real] = await Promise.all([nav.atReply, realPages()]);
    const verdict = navVerdict(nav.reported, atReply, real);
    if (verdict === "unknown") {
      // A nav reply with no usable page list means the signal is gone, not that
      // the browser is fine — say so, or an upstream format change would
      // silently retire the watchdog. (`reportedPages` is pinned by tests.)
      // Note this covers a page list that parsed but selected nothing, not just
      // a missing one: both blind the watchdog identically.
      if ((atReply !== null || real !== null) && !nav.reported?.selected)
        log.warn(
          `session[${name}]: nav reply carried no selected page — wedge detection is blind ` +
            `(chrome-devtools-mcp output format may have changed)`,
        );
      return;
    }
    if (verdict === "ok") {
      navStrikes = 0;
      return;
    }
    navStrikes++;
    log.warn(
      `session[${name}]: nav verify failed (${navStrikes}/${NAV_WEDGE_STRIKES}): ` +
        `requested ${nav.url ?? "(history)"}; child is on ${nav.reported?.selected} ` +
        `but the browser's real pages were [${(atReply ?? []).join(", ")}] at reply time ` +
        `and are [${(real ?? []).join(", ")}] now`,
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

  /**
   * Spawn + start a chrome-devtools-mcp child. With `ip`, it is bound to that
   * browser's CDP; with null it is BROWSER-LESS — it serves the handshake,
   * `tools/list` and pings while no container exists (issue #63).
   */
  async function startChild(gen: number, ip: string | null): Promise<StdioClientTransport> {
    currentIp = ip;
    cdpFailStreak = 0;
    // Connect by IP (not container name): Chrome's DevTools HTTP endpoint
    // rejects a DNS-name Host header but accepts an IP; socat in the container
    // bridges to Chrome's loopback CDP port.
    const browserUrl = ip ? `http://${ip}:${config.cdpPort}` : NO_BROWSER_URL;
    const c = new StdioClientTransport({
      command: config.cdmCommand,
      args: ["--browserUrl", browserUrl, ...config.cdmExtraArgs],
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
      // Disabled while browser-less: NO_BROWSER_URL refuses by design, so a
      // stray CDP error there is expected, not evidence of a wedged browser.
      if (gen === childGen && currentIp && CDP_FAIL_RE.test(line)) {
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
    try {
      log.warn(`session[${name}]: child gone (${why}); respawning`);
      failAllInflight(`chikin browser restarted (${why}); retry the request`);
      // Those requests got error replies; nothing left to verify or decorate.
      pendingNavs.clear();
      toolsListIds.clear();
      navStrikes = 0;
      navSuperseded = 0;
      try {
        await child?.close();
      } catch {
        /* already gone */
      }
      // Rebuild the child in whatever state this session is currently in: a
      // browser-less session (issue #63) respawns browser-less and must NOT
      // provision a container just because its child died.
      const wantBrowser = currentIp !== null;
      for (let attempt = 1; attempt <= MAX_RESPAWN_ATTEMPTS; attempt++) {
        if (session?.isClosed) return;
        const gen = ++childGen;
        let spawned: StdioClientTransport | null = null;
        try {
          spawned = await startChild(gen, wantBrowser ? await provision() : null);
          await replayInitialize(spawned, gen);
          child = spawned;
          spawned = null;
          log.info(`session[${name}]: child respawned (gen ${gen})`);
          return;
        } catch (e) {
          log.warn(`session[${name}]: respawn attempt ${attempt} failed`, String(e));
          try {
            await spawned?.close();
          } catch {
            /* already gone */
          }
          await sleep(Math.min(500 * attempt, 5000));
        }
      }
      // Exhausted: fall back to dropping the session. The self-healing client
      // bridge will then reconnect from scratch.
      log.error(`session[${name}]: child respawn exhausted; closing session`);
      await session.close("child respawn exhausted");
    } finally {
      respawning = false;
    }
  }

  /**
   * Claim this session's fleet slot: provision the browser and swap the
   * browser-less child for one bound to its CDP. This is the whole of the lazy
   * half of issue #63 — it runs on the FIRST frame that is real browser work,
   * never on the MCP handshake.
   *
   * `provision()` deliberately runs BEFORE anything is torn down, so the common
   * failure — `FleetFullError` — leaves the browser-less child exactly as it
   * was. The session stays connected with every tool registered, and the same
   * call succeeds the moment a slot frees. That is the difference between "one
   * tool call failed" and the old "this session has no browser lane at all".
   */
  async function attachBrowser(): Promise<void> {
    const ip = await provision();

    // A cold provision blocks for tens of seconds, and the session can end or
    // another child swap can begin inside that window — so re-establish both
    // preconditions before touching any child state, exactly as respawnChild
    // and handleReset do at their own spawn sites:
    //  - the client may have disconnected, in which case `Session.close` has
    //    already closed the BROWSER-LESS child. A child spawned after that
    //    belongs to nobody and would outlive the session holding a CDP
    //    connection open until the gateway restarts.
    //  - the browser-less child may have died and `respawnChild` may be part
    //    way through installing its replacement. Two swaps interleaving their
    //    `childGen` bumps orphan one of them: the pump then drops every reply
    //    from the live child (client requests hang instead of failing) and the
    //    loser's retry reinstalls a browser-less child over the browser we just
    //    provisioned, stranding its container. Waiting the other swap out keeps
    //    the invariant every other site assumes — at most one swap at a time.
    if (session.isClosed) return;
    while (respawning && !session.isClosed) await sleep(250);
    if (session.isClosed) return;

    // Swap the child. `respawning` carries its established meaning here — "the
    // child is being replaced" — so the pump fails concurrent frames retryably
    // instead of sending them into a child that is going away.
    respawning = true;
    const old = child;
    const gen = ++childGen; // orphans `old`: its onmessage/onclose go quiet
    // Non-null while nothing else owns the new child yet, so the `finally` below
    // is what closes it if the swap fails or the session went away mid-swap.
    let spawned: StdioClientTransport | null = null;
    try {
      failAllInflight("chikin browser attaching; retry the request");
      pendingNavs.clear();
      toolsListIds.clear();
      navStrikes = 0;
      navSuperseded = 0;
      spawned = await startChild(gen, ip);
      await replayInitialize(spawned, gen);
      respawning = false;
      if (session.isClosed) return;
      child = spawned;
      spawned = null;
      log.info(`session[${name}]: browser attached at ${ip} (child gen ${gen})`);
    } catch (e) {
      // The container is up but the child swap failed. `currentIp` is set, so
      // the ordinary respawn path re-attaches to that same warm container (and,
      // if it must, drops the session for the client bridge to rebuild).
      respawning = false;
      log.warn(`session[${name}]: browser attach failed`, String(e));
      void respawnChild("browser attach failed");
      throw e;
    } finally {
      for (const c of [old, spawned]) {
        try {
          await c?.close();
        } catch {
          /* already gone */
        }
      }
    }
  }

  /**
   * Attach the browser at most once, sharing one attach across racers. The
   * in-flight attach is checked FIRST: from `startChild` onwards `currentIp` is
   * set while the browser-bound child is still starting, and a racer that
   * short-circuited on it there would be forwarded into a child that does not
   * exist yet. Awaiting the shared promise also keeps racers in arrival order.
   */
  function ensureBrowser(): Promise<void> {
    if (attaching) return attaching;
    if (currentIp) return Promise.resolve();
    attaching = attachBrowser().finally(() => {
      attaching = null;
    });
    return attaching;
  }

  // The model asked for a hard reset (it noticed the browser is wedged before
  // the watchdog did). Recreate the container outright — not just the child —
  // then respawn and reply on the gateway's own behalf. Never forwarded to the
  // child; never tracked in inflight (respawnChild would fail it mid-reset).
  async function handleReset(id: string | number | undefined): Promise<void> {
    log.warn(`session[${name}]: chikin_reset requested by client`);
    while (respawning && !session?.isClosed) await sleep(250); // let any in-progress respawn settle first
    if (session?.isClosed) return;
    // A browser IS on its way — a cold provision blocks for tens of seconds,
    // which is exactly when a model gets impatient and calls this. Saying
    // "nothing to reset" here would be a lie about the one state where it
    // matters, so answer with what is actually happening. Not awaited: the
    // reset the caller asked for is a container recreate, and running one over
    // a container that is still being built is worse than telling it to wait.
    if (attaching) {
      replyTool(
        id,
        "chikin is starting a browser for this session right now — your first browser tool call is still " +
          "in flight. Nothing is wedged yet, so nothing was reset. Wait for that call to return, and use " +
          "chikin_reset only if the browser it gives you is genuinely stuck.",
        true,
      );
      return;
    }
    // Nothing exists to reset before the first browser tool call (issue #63) —
    // and provisioning one here would hand a fleet slot to a session that has
    // not asked for a browser, which is the bug this laziness fixes.
    if (!currentIp) {
      replyTool(
        id,
        "No browser is attached to this chikin session yet, so there is nothing to reset. " +
          "A fresh browser is provisioned automatically on your first browser tool call.",
        false,
      );
      return;
    }
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

  // Everything past the identify gate: track the request, record nav state, and
  // hand the frame to the child. Split out of the pump below so the lazy-attach
  // path can re-enter it with the very same frame once the browser is up.
  function forwardToChild(msg: JSONRPCMessage, f: Frame): void {
    const tracked = f && f.method !== undefined && f.id !== undefined;
    if (tracked) {
      inflight.set(f.id as string | number, true);
      if (f.method === "tools/list") toolsListIds.add(f.id as string | number);
      // Record what each nav asked for, so its reply can be verified
      // out-of-band. Only the requested URL is kept here: the child's own view
      // of the browser comes off the reply itself (see wireChild/verifyNav).
      if (f.method === "tools/call" && NAV_TOOLS.has(f.params?.name ?? "")) {
        const id = f.id as string | number;
        const url = typeof f.params?.arguments?.url === "string" ? f.params.arguments.url : undefined;
        pendingNavs.set(id, { url });
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
  }

  // First browser work on a browser-less session (issue #63): provision, rebind
  // the child, then forward the frame that triggered it. If provisioning fails
  // the session SURVIVES — the caller gets a retryable tool error with every
  // tool still registered, instead of losing the browser lane for good.
  async function attachThenForward(msg: JSONRPCMessage, f: Frame): Promise<void> {
    try {
      await ensureBrowser();
    } catch (e) {
      replyTool(f.id, browserUnavailableMessage(f.params?.name, e), true);
      return;
    }
    if (session.isClosed) return;
    forwardToChild(msg, f);
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
    if (isBrowserWork(f, session.handle !== undefined)) {
      deps.registry.touchBrowserActivity(name);
      // ...and the same predicate is where the FLEET SLOT is claimed (issue
      // #63). A container is created here, on the first frame that genuinely
      // drives the browser — never on the handshake every MCP client sends at
      // startup. One definition of "browser work", used for both the clock and
      // the allocation, so the two can never disagree.
      if (!browserReady()) {
        void attachThenForward(msg, f);
        return;
      }
    }
    forwardToChild(msg, f);
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

  // Child first so its stdin is ready before the initialize frame arrives — but
  // BROWSER-LESS (issue #63). It answers the handshake, tools/list and pings on
  // its own; `attachBrowser` provisions the container later, if and when this
  // session actually drives a browser.
  child = await startChild(++childGen, null);
  await http.start();

  return session;
}
