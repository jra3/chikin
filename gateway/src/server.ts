import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { isValidName } from "./names.js";
import { rpcError, RPC } from "./rpc.js";
import { Registry } from "./registry.js";
import { Provisioner, FleetFullError, ProvisionError } from "./provisioner.js";
import { createSession } from "./bridge.js";
import { renderDashboard } from "./dashboard.js";
import { runtimeConfig, configWarnings } from "./runtime.js";
import { makeVncHttpHandler, vncUpgradeHandler, hostOk } from "./vnc.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface ServerDeps {
  registry: Registry;
  provisioner: Provisioner;
}

function tokenOk(provided: string): boolean {
  if (!config.token) return true; // auth disabled (dev only)
  const a = Buffer.from(provided);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Empty token => auth disabled: accept requests with no Authorization header
  // at all (loopback-trusted). With a token set, a valid Bearer is required.
  if (!config.token) {
    next();
    return;
  }
  const header = req.header("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !tokenOk(m[1])) {
    res.status(401).json(rpcError(RPC.UNAUTHORIZED, "missing or invalid bearer token"));
    return;
  }
  next();
}

function nameMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isValidName(req.params.name)) {
    res.status(400).json(rpcError(RPC.INVALID_REQUEST, `invalid browser name '${req.params.name}'`));
    return;
  }
  next();
}

// DNS-rebinding guard for the MCP endpoint and dashboard (CHK-006a). The
// `application/json` body forces a CORS preflight, which blocks a
// *cross-origin* POST — but not a rebinding attack: once an attacker page
// rebinds its own hostname to 127.0.0.1, the request is same-origin (no
// preflight), and with an empty GATEWAY_TOKEN (the shipped default) nothing
// else stops it driving the fleet. So require the Host to be one we published
// on, reusing the /vnc guard's set (loopback + GATEWAY_EXTRA_ORIGINS). A set
// token already blunts this; this closes the no-token default too.
function hostMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!hostOk(req)) {
    res.status(403).json(rpcError(RPC.UNAUTHORIZED, "forbidden host"));
    return;
  }
  next();
}

/**
 * How often to poke an open SSE stream so it never goes silent. Must stay well
 * under the shortest idle timeout any client (or intervening proxy) applies to
 * a response body — see startSseKeepalive for why 300s is the number that
 * matters. Deliberately a constant rather than an env knob: a knob would also
 * need a line in docker-compose.yml to be settable at all, and there is no
 * operational reason to tune this.
 */
const SSE_KEEPALIVE_MS = 30_000;

/**
 * Keep an open SSE response from going silent.
 *
 * Node's `fetch` (undici) enforces a 300_000 ms `bodyTimeout` on a response
 * body. The standalone MCP event stream carries NOTHING while a client sits
 * idle between tool calls, so undici tore it down at almost exactly five
 * minutes with `UND_ERR_BODY_TIMEOUT` — which surfaces client-side as
 * `TypeError: terminated`. The client then reconnected and re-initialized, and
 * the POST handler above reclaimed the now-streamless old session as stale,
 * which FREES its chikin_identify handle (registry.remove). So every long-lived
 * session silently lost its identity every five minutes and, since #54, its
 * access to every browser tool until it happened to re-identify — which is why
 * a fleet of hours-old browsers all showed `handle: —`. It was long read as
 * flaky-network SSE drops; it was never flaky, it was this clock, ticking on a
 * measured 301s period.
 *
 * A bare SSE comment resets that timer and is invisible to the protocol: the
 * SDK parses with eventsource-parser, which drops `:`-prefixed lines. We only
 * ever write BETWEEN the SDK's own writes (each emits a whole event), so a
 * keepalive can never land inside one.
 *
 * SSE-ness is asserted by the CALLER, not sniffed. `res.getHeader()` CANNOT see
 * a content type the MCP SDK passes straight to `res.writeHead(200, {...})` —
 * it returns undefined, and `getHeaders()` returns `{}` — so an earlier version
 * of this guard silently disabled the whole keepalive (verified live: 75s on a
 * real stream, zero comments written). The content-type check below therefore
 * fails OPEN on an unreadable header and only fails closed on one that is
 * readable and definitively not an event stream.
 *
 * Both call sites are event streams by construction: the MCP GET stream always
 * is, and POST replies are SSE unless the transport is built with
 * `enableJsonResponse`, which this gateway never sets. As a second line of
 * defence the timer only ever fires on a response still open `everyMs` later,
 * which a plain JSON reply never is.
 *
 * Fixed here rather than in our own client so it protects EVERY MCP client that
 * connects to this gateway, not just the bundled bridge.
 */
export function startSseKeepalive(res: Response, everyMs: number = SSE_KEEPALIVE_MS): () => void {
  const timer = setInterval(() => {
    if (!res.headersSent || res.writableEnded || !res.writable) return;
    const ct = res.getHeader("content-type");
    if (ct !== undefined && !String(ct).includes("text/event-stream")) return;
    try {
      res.write(": keepalive\n\n");
    } catch (e) {
      log.debug(`sse keepalive write failed: ${String(e)}`);
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Wrap an async route handler so a rejected promise is forwarded to Express's
 * error middleware instead of surfacing as an unhandledRejection — which, under
 * Node's default policy, crashes the single shared gateway and disconnects every
 * client until restart. Express 4 does not await handlers, so this is required
 * on any `async` route. See CHK-013.
 */
type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;
function asyncRoute(fn: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Health (no auth) — for the compose healthcheck, which only reads the HTTP
  // status. The effective runtime config rides along so an operator can answer
  // "is seeding actually on?" with `curl -s localhost:8080/healthz` instead of a
  // `docker exec` into the container's env (see runtime.ts). Secret-free by
  // construction: GATEWAY_TOKEN appears only as `authEnabled`.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", config: runtimeConfig(), warnings: configWarnings() });
  });

  // Fleet dashboard and the noVNC proxy below are intentionally NOT bearer-
  // gated, even when GATEWAY_TOKEN is set: they're driven by a browser, which
  // can't attach an Authorization header to a plain navigation or a noVNC
  // websocket. GATEWAY_TOKEN protects the MCP endpoint (/b/<name>/) ONLY. These
  // two surfaces rely on loopback binding plus the Origin/Host guard in vnc.ts
  // (CHK-006). A set token therefore does NOT harden a shared/multi-user host —
  // keep the box single-trusted-user. See CHK-016.
  //
  // hostMiddleware keeps a DNS-rebinding page from reading fleet names/status
  // off the dashboard HTML — the last unguarded rebinding surface (issue #47).
  app.get("/", hostMiddleware, async (_req, res) => {
    try {
      res.type("html").send(await renderDashboard(deps.provisioner, deps.registry));
    } catch (e) {
      res.status(500).send(`dashboard error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // noVNC reverse proxy. Mounted as a catch-all so all of noVNC's relative asset
  // requests under /vnc/<name>/ are forwarded. Origin/Host-guarded in vnc.ts.
  app.use("/vnc/:name", makeVncHttpHandler(deps.registry));

  // MCP endpoint, one logical browser per <name>. Bearer-protected.
  const b = express.Router({ mergeParams: true });

  b.post("/", asyncRoute(async (req: Request, res: Response) => {
    const name = req.params.name;
    const sid = req.header("mcp-session-id");

    // Existing session: route by id.
    if (sid) {
      const session = deps.registry.getBySessionId(sid);
      if (!session || session.name !== name) {
        res.status(404).json(rpcError(RPC.NOT_FOUND, "unknown or mismatched session"));
        return;
      }
      // A POST reply is an SSE stream too (the SDK only sends plain JSON with
      // enableJsonResponse), and it stays silent until the tool returns — so a
      // tool call slower than the client's 300s body timeout died the same way
      // the idle event stream did. Same keepalive, same reasoning.
      const stopKeepalive = startSseKeepalive(res);
      res.on("close", stopKeepalive);
      await session.http.handleRequest(req, res, req.body);
      return;
    }

    // No session id: only a fresh initialize may open a session. Note that it
    // opens a SESSION, not a browser — since issue #63 the container is
    // provisioned lazily by the bridge, on the first frame that actually drives
    // the browser. A client that connects and never browses holds no fleet slot.
    if (!isInitializeRequest(req.body)) {
      res
        .status(400)
        .json(rpcError(RPC.INVALID_REQUEST, "missing mcp-session-id (expected an initialize request)"));
      return;
    }

    // Single active session per name (issue #6) — claim synchronously.
    if (!deps.registry.reserve(name)) {
      // Name is taken. If the current holder has NO attached event stream, it's
      // a stale session from an unclean disconnect (client vanished without a
      // DELETE) — reclaim it instead of rejecting, so reconnects don't 409.
      // A genuinely attached client (streams > 0) or an in-flight provision
      // (pending, no live session) still gets a 409.
      const existing = deps.registry.getByName(name);
      const act = deps.registry.getActivity(name);
      if (existing && (!act || act.streams === 0)) {
        await existing.close("reclaimed by new client (stale session)");
      }
      if (!deps.registry.reserve(name)) {
        res.status(409).json(rpcError(RPC.BUSY, `browser '${name}' already has an active session`));
        return;
      }
    }

    let session;
    try {
      session = await createSession(name, deps);
    } catch (e) {
      deps.registry.release(name);
      // Both branches are now near-unreachable: creating a session spawns a
      // browser-less child and touches Docker not at all, so fleet-full and
      // provisioning failures surface on the first browser tool call instead,
      // as a retryable TOOL error that leaves the session intact (issue #63).
      // Kept as the honest mapping if a future change ever provisions here.
      if (e instanceof FleetFullError) {
        res.status(429).json(rpcError(RPC.FLEET_FULL, e.message));
      } else {
        const msg = e instanceof ProvisionError ? e.message : `provisioning failed: ${String(e)}`;
        log.error(`provisioning ${name} failed`, msg);
        res.status(503).json(rpcError(RPC.PROVISION_FAILED, msg));
      }
      return;
    }
    deps.registry.add(session);
    await session.http.handleRequest(req, res, req.body);
  }));

  // Server->client SSE stream. Track attachment so the reaper leaves it alone.
  b.get("/", asyncRoute(async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const session = sid ? deps.registry.getBySessionId(sid) : undefined;
    if (!session || session.name !== req.params.name) {
      res.status(404).json(rpcError(RPC.NOT_FOUND, "unknown or mismatched session"));
      return;
    }
    // NOTE: do NOT close the session when the event stream closes. Claude Code
    // (and other clients) close the standalone SSE stream while idle between
    // tool calls but keep the logical MCP session, intending to POST more
    // requests. Tearing the session down here would 404 the next request and
    // hang the client. The single-session lock is freed instead by reclaiming a
    // stale (streamless) session on the next initialize (see the POST handler),
    // and idle containers are still reaped on the activity TTL.
    deps.registry.streamOpened(session.name);
    // This is THE stream the 300s body timeout was killing: it is silent for as
    // long as the client sits between tool calls. See startSseKeepalive.
    const stopKeepalive = startSseKeepalive(res);
    res.on("close", () => {
      stopKeepalive();
      deps.registry.streamClosed(session.name);
    });
    await session.http.handleRequest(req, res);
  }));

  // Explicit session termination.
  b.delete("/", asyncRoute(async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const session = sid ? deps.registry.getBySessionId(sid) : undefined;
    if (!session || session.name !== req.params.name) {
      res.status(404).json(rpcError(RPC.NOT_FOUND, "unknown or mismatched session"));
      return;
    }
    await session.http.handleRequest(req, res);
  }));

  app.use("/b/:name", hostMiddleware, authMiddleware, nameMiddleware, express.json({ limit: "4mb" }), b);

  // Error backstop: any handler rejection/throw lands here instead of becoming
  // an unhandledRejection that crashes the shared process. If the response has
  // already started streaming (SSE), we can't send a JSON error — delegate to
  // Express's default handler, which closes the socket. See CHK-013.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    log.error("unhandled request error", err instanceof Error ? (err.stack ?? err.message) : String(err));
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json(rpcError(RPC.INTERNAL, "internal gateway error"));
  });

  return app;
}

/** Handle raw HTTP upgrades: only the /vnc/<name>/ websocket is permitted. */
export function makeUpgradeHandler() {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!vncUpgradeHandler(req, socket, head)) {
      socket.destroy();
    }
  };
}
