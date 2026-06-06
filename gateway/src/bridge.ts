import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Session } from "./session.js";
import { log } from "./log.js";
import type { Registry } from "./registry.js";
import type { Provisioner } from "./provisioner.js";

export interface BridgeDeps {
  provisioner: Provisioner;
  registry: Registry;
}

// JSON-RPC frame shape we care about (id + method routing). The MCP SDK types
// the transport payload as `unknown`, so we narrow locally.
type Frame = { id?: string | number; method?: string } & Record<string, unknown>;

const REPLAY_TIMEOUT_MS = 20_000;
const MAX_RESPAWN_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // (ensureContainer's health probe throws). The profile volume survives a
  // recreate, so cookies/login persist.
  async function provision(): Promise<string> {
    try {
      return await deps.provisioner.ensureContainer(name);
    } catch (e) {
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
      const f = msg as Frame;
      if (f && f.id !== undefined) inflight.delete(f.id);
      http.send(msg).catch((e) => log.warn(`session[${name}]: http send failed`, String(e)));
    };
    c.onclose = () => {
      if (gen !== childGen || session?.isClosed) return;
      void respawnChild("child process exited");
    };
    c.onerror = (e) => log.warn(`session[${name}]: child transport error`, String(e));
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
    // Connect by IP (not container name): Chrome's DevTools HTTP endpoint
    // rejects a DNS-name Host header but accepts an IP; socat in the container
    // bridges to Chrome's loopback CDP port.
    const c = new StdioClientTransport({
      command: config.cdmCommand,
      args: ["--browserUrl", `http://${ip}:${config.cdpPort}`],
      stderr: "pipe",
    });
    wireChild(c, gen);
    await c.start();
    c.stderr?.on("data", (d: Buffer) => log.debug(`[cdm:${name}] ${d.toString().trimEnd()}`));
    return c;
  }

  // Replace a dead child transparently, keeping the client http session alive.
  async function respawnChild(why: string): Promise<void> {
    if (session?.isClosed || respawning) return;
    respawning = true;
    log.warn(`session[${name}]: child gone (${why}); respawning`);
    failAllInflight(`chikin browser restarted (${why}); retry the request`);
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

  // Client -> child pump. Cache initialize; track requests; fail fast while a
  // respawn is in flight so the client retries instead of hanging.
  http.onmessage = (msg) => {
    deps.registry.touch(name);
    const f = msg as Frame;
    if (f && f.method === "initialize") {
      initFrame = msg;
      initId = f.id;
    }
    const tracked = f && f.method !== undefined && f.id !== undefined;
    if (tracked) inflight.set(f.id as string | number, true);

    if (respawning || !child) {
      if (tracked) failRequest(f.id as string | number, "chikin browser restarting; retry the request");
      return;
    }
    child.send(msg).catch((e) => {
      const why = String(e);
      log.warn(`session[${name}]: child send failed`, why);
      if (tracked) failRequest(f.id as string | number, `chikin browser send failed (${why}); retry the request`);
      void respawnChild(`child send failed: ${why}`);
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
