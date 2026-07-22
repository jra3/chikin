import httpProxy from "http-proxy";
import type { Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { config, vncUrl } from "./config.js";
import { isValidName } from "./names.js";
import { log } from "./log.js";

// Single shared proxy for all /vnc/<name>/ traffic, websocket upgrades included.
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

// Host:port values we consider "ourselves" for the loopback-trusted dashboard.
// The gateway is published on 127.0.0.1:<port>; a browser reaching it uses one
// of these as its Origin/Host. An optional DASHBOARD_ORIGINS config (comma-list
// of origins, e.g. for an SSH-tunnel hostname) extends the set.
export function buildSelfHosts(port: number, originsCsv: string): Set<string> {
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  for (const o of originsCsv.split(",")) {
    const trimmed = o.trim();
    if (!trimmed) continue;
    try {
      hosts.add(new URL(trimmed).host);
    } catch {
      log.warn(`vnc: ignoring unparseable DASHBOARD_ORIGINS entry '${trimmed}'`);
    }
  }
  return hosts;
}
const selfHosts = buildSelfHosts(config.port, config.dashboardOrigins);

/** True if the request's Host header is one of ours (DNS-rebinding guard). */
export function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return typeof host === "string" && selfHosts.has(host);
}

/**
 * Origin guard for the websocket upgrade. WebSocket handshakes are exempt from
 * CORS same-origin enforcement, so without this any page the operator loads
 * could open a control channel into a logged-in browser (CHK-006). A browser
 * always sends Origin on a ws handshake, so a missing Origin from this path is
 * treated as untrusted and rejected too.
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return false;
  try {
    return selfHosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

/** Whether a websocket upgrade is allowed to proxy: same-origin AND same-host. */
export function vncUpgradeAllowed(req: IncomingMessage): boolean {
  return originOk(req) && hostOk(req);
}

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
  // DNS-rebinding guard: only serve the noVNC page/assets to a request that
  // addressed us as one of our own loopback hosts (CHK-006). Origin is not
  // checked here — top-level navigations legitimately send none.
  if (!hostOk(req)) {
    res.status(403).send("forbidden");
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
  // Reject cross-origin / DNS-rebinding websocket upgrades: this socket is a
  // full read+keystroke control channel into a possibly-logged-in browser, and
  // ws handshakes bypass CORS, so the Origin/Host checks are the only defense
  // (CHK-006).
  if (!vncUpgradeAllowed(req)) {
    log.warn(`vnc: rejected upgrade for '${name}' (origin='${req.headers.origin ?? ""}' host='${req.headers.host ?? ""}')`);
    socket.destroy();
    return true;
  }
  req.url = m[2] ?? "/";
  proxy.ws(req, socket, head, { target: vncUrl(name) });
  return true;
}
