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
import { vncHttpHandler, vncUpgradeHandler } from "./vnc.js";
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

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Health (no auth) — for compose healthcheck.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Fleet dashboard (loopback-trusted, no bearer).
  app.get("/", async (_req, res) => {
    try {
      res.type("html").send(await renderDashboard(deps.provisioner, deps.registry));
    } catch (e) {
      res.status(500).send(`dashboard error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // noVNC reverse proxy (loopback-trusted). Mounted as a catch-all so all of
  // noVNC's relative asset requests under /vnc/<name>/ are forwarded.
  app.use("/vnc/:name", vncHttpHandler);

  // MCP endpoint, one logical browser per <name>. Bearer-protected.
  const b = express.Router({ mergeParams: true });

  b.post("/", async (req: Request, res: Response) => {
    const name = req.params.name;
    const sid = req.header("mcp-session-id");

    // Existing session: route by id.
    if (sid) {
      const session = deps.registry.getBySessionId(sid);
      if (!session || session.name !== name) {
        res.status(404).json(rpcError(RPC.NOT_FOUND, "unknown or mismatched session"));
        return;
      }
      await session.http.handleRequest(req, res, req.body);
      return;
    }

    // No session id: only a fresh initialize may start a browser.
    if (!isInitializeRequest(req.body)) {
      res
        .status(400)
        .json(rpcError(RPC.INVALID_REQUEST, "missing mcp-session-id (expected an initialize request)"));
      return;
    }

    // Single active session per name (issue #6) — claim synchronously.
    if (!deps.registry.reserve(name)) {
      res.status(409).json(rpcError(RPC.BUSY, `browser '${name}' already has an active session`));
      return;
    }

    let session;
    try {
      session = await createSession(name, deps);
    } catch (e) {
      deps.registry.release(name);
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
  });

  // Server->client SSE stream. Track attachment so the reaper leaves it alone.
  b.get("/", async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const session = sid ? deps.registry.getBySessionId(sid) : undefined;
    if (!session || session.name !== req.params.name) {
      res.status(404).json(rpcError(RPC.NOT_FOUND, "unknown or mismatched session"));
      return;
    }
    deps.registry.streamOpened(session.name);
    res.on("close", () => deps.registry.streamClosed(session.name));
    await session.http.handleRequest(req, res);
  });

  // Explicit session termination.
  b.delete("/", async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const session = sid ? deps.registry.getBySessionId(sid) : undefined;
    if (!session || session.name !== req.params.name) {
      res.status(404).json(rpcError(RPC.NOT_FOUND, "unknown or mismatched session"));
      return;
    }
    await session.http.handleRequest(req, res);
  });

  app.use("/b/:name", authMiddleware, nameMiddleware, express.json({ limit: "4mb" }), b);

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
