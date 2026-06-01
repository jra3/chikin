import httpProxy from "http-proxy";
import type { Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { vncUrl } from "./config.js";
import { isValidName } from "./names.js";
import { log } from "./log.js";

// Single shared proxy for all /vnc/<name>/ traffic, websocket upgrades included.
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

proxy.on("error", (err, _req, target) => {
  log.warn("vnc: upstream error", String(err));
  const res = target as ServerResponse | Duplex | undefined;
  if (res && "writeHead" in res && !(res as ServerResponse).headersSent) {
    (res as ServerResponse).writeHead(502, { "content-type": "text/plain" });
    (res as ServerResponse).end("vnc upstream unavailable");
  } else if (res && "destroy" in res) {
    (res as Duplex).destroy();
  }
});

/**
 * Express handler mounted at `/vnc/:name`. Express strips the mount prefix from
 * req.url, so the remainder proxies straight to the container's noVNC server.
 * The dashboard links to `/vnc/<name>/vnc.html?...&path=vnc/<name>/websockify`
 * so the page's relative asset + websocket URLs resolve back through here.
 */
export function vncHttpHandler(req: Request, res: Response): void {
  const name = req.params.name;
  if (!isValidName(name)) {
    res.status(400).send("invalid browser name");
    return;
  }
  proxy.web(req, res, { target: vncUrl(name) });
}

/**
 * Raw HTTP upgrade handler for the websockify socket. Express is not in the
 * upgrade path, so we match `/vnc/<name>/...` ourselves, strip the prefix, and
 * forward the upgrade to the container. Returns true if it handled the request.
 */
export function vncUpgradeHandler(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const m = (req.url ?? "").match(/^\/vnc\/([a-z0-9-]+)(\/.*)?$/);
  if (!m) return false;
  const name = m[1];
  if (!isValidName(name)) {
    socket.destroy();
    return true;
  }
  req.url = m[2] ?? "/";
  proxy.ws(req, socket, head, { target: vncUrl(name) });
  return true;
}
