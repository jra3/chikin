import httpProxy from "http-proxy";
import type { Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { config } from "./config.js";
import { log } from "./log.js";
import { isValidName } from "./names.js";
import { bearerOk } from "./auth.js";
import { hostOk } from "./vnc.js";
import { FleetFullError, ProvisionError } from "./provisioner.js";
import type { Provisioner } from "./provisioner.js";
import type { Registry } from "./registry.js";

/**
 * The CDP lane: `/cdp/<name>/` — a Browser driven over the raw DevTools
 * Protocol by Playwright, puppeteer, or anything else that speaks CDP, with no
 * MCP in the path (#87).
 *
 * Why a proxy at all, when a Browser already listens on `:9222`: `chikin-net`
 * is `internal: true` (ADR 0002/0003), so no host process can reach that port,
 * and publishing it per container would hand every local process an
 * unauthenticated browser logged in as the operator. Routing it through the
 * gateway keeps ONE published port, and the lane inherits the guards that port
 * already has.
 *
 * The lane provisions exactly like the MCP one — lazily, on the first request
 * (#63), from the golden Seed Volume — so a Playwright script gets the same
 * logged-in profile a Claude session would, and MAX_FLEET still counts it.
 */

export interface CdpDeps {
  registry: Registry;
  provisioner: Provisioner;
}

/**
 * How often the websocket activity sampler looks at the driver's socket.
 *
 * A constant rather than an env knob: a knob would also need a compose line to
 * be settable at all (#62), and nothing operational depends on the period —
 * it only has to be far shorter than the idle TTLs it feeds.
 */
export const CDP_ACTIVITY_SAMPLE_MS = 30_000;

/** Connect-phase bound for the HTTP pass. Same reasoning as VNC_PROXY_TIMEOUT_MS. */
export const CDP_PROXY_TIMEOUT_MS = 10_000;

// Requests we resolved a browser for carry the rewrite context here, the way
// the VNC proxy tags a request for <title> injection.
type TaggedReq = IncomingMessage & { __chikinCdp?: { name: string; selfHost: string } };

/**
 * Point a DevTools JSON payload back through this gateway.
 *
 * Chrome answers `/json/version` with `webSocketDebuggerUrl:
 * ws://<container-ip>:9222/devtools/browser/<uuid>` — an address on an
 * `internal: true` network that the driver cannot reach. Playwright's
 * `connectOverCDP` takes that field verbatim for its second hop, so without
 * this rewrite the HTTP hop succeeds and the connection then hangs against a
 * black hole. `devtoolsFrontendUrl` carries the same address in a `ws=` query
 * parameter; it is what a human pasting the URL into a DevTools frontend uses.
 *
 * Pure and string-level on purpose: `/json/version` is an object, `/json/list`
 * an array, `/json/new` another object, and a Chrome that adds a fourth shape
 * should not need a code change here.
 */
export function rewriteCdpJson(body: string, name: string, selfHost: string): string {
  const base = `${selfHost}/cdp/${name}`;
  return body
    .replace(/ws:\/\/[^/"\s\\]+\/devtools\//g, `ws://${base}/devtools/`)
    .replace(/([?&]wss?=)[^&"\s\\]*?\/devtools\//g, `$1${base}/devtools/`);
}

/**
 * May this request drive a browser over CDP?
 *
 * Three checks, and the middle one is the inverse of the VNC guard's:
 *
 *  - **Host** must be one of ours — the same DNS-rebinding guard every other
 *    surface applies (CHK-006a).
 *  - **Origin must be ABSENT.** A CDP driver is a program, and neither
 *    Playwright nor puppeteer nor a raw ws client sends an Origin; a browser
 *    always does, on every fetch and every websocket handshake. So "has an
 *    Origin at all" is precisely "is a web page", and a web page has no
 *    business on this lane — not even one served from our own dashboard
 *    origin, since allowing that would re-open a full control channel into a
 *    logged-in browser to anything that can get script onto that page. This is
 *    the only Origin check in the system: the browser's Chrome runs
 *    `--remote-allow-origins=*` (CHK-002), so it will accept anyone we forward.
 *  - **Bearer** when GATEWAY_TOKEN is set. Unlike noVNC — which is driven by a
 *    browser navigation that cannot carry a header — a CDP driver can:
 *    `connectOverCDP(url, { headers })` sends them on both the HTTP hop and the
 *    upgrade. So this lane is genuinely token-protectable, and is protected.
 */
export function cdpAccessOk(req: IncomingMessage): boolean {
  if (!hostOk(req)) return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") return false;
  return bearerOk(req);
}

/** Split `/cdp/<name>/rest...` into its parts, or null if this isn't ours. */
export function matchCdpUpgrade(url: string): { name: string; rest: string } | null {
  const m = /^\/cdp\/([^/?#]+)(\/[^?#]*)?/.exec(url);
  if (!m) return null;
  if (!isValidName(m[1])) return null;
  return { name: m[1], rest: m[2] ?? "/" };
}

/** The CDP endpoint of one Browser, dialed by IP — see createCdpProxy. */
function cdpTarget(ip: string): string {
  return `http://${ip}:${config.cdpPort}`;
}

/**
 * Build the CDP proxy: HTTP for the `/json/*` handshake, websocket for the
 * session itself.
 *
 * `changeOrigin` is load-bearing rather than cosmetic. Chrome's DevTools
 * endpoint refuses any request whose Host header is not an IP or `localhost`
 * (its own DNS-rebinding defence), so the Host we send has to be the address
 * we dialed — which is also why the target is a resolved `chikin-net` IP and
 * never the `<container>.<network>` DNS form the VNC proxy can afford to use.
 */
export function createCdpProxy(): httpProxy {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    proxyTimeout: CDP_PROXY_TIMEOUT_MS,
  });

  // Arm the bound on the SOCKET so it covers the connect phase; a dropped SYN
  // never fires the "connect" event that ClientRequest.setTimeout waits for
  // (#79). Web pass only: a CDP websocket is legitimately silent for as long as
  // the script is thinking, so an idle bound on the upgrade path would kill
  // live sessions. Never arm one there.
  proxy.on("proxyReq", (proxyReq, _req, _res, options) => {
    const ms = options.proxyTimeout ?? CDP_PROXY_TIMEOUT_MS;
    proxyReq.socket?.setTimeout(ms, () => {
      proxyReq.destroy(new Error(`cdp: upstream unreachable after ${ms}ms`));
    });
  });

  // Rewrite the JSON handshake on its way out. Only requests we tagged are
  // touched, and only uncompressed JSON — anything else is piped through as it
  // came (Chrome does not compress these, but a proxy that mangles a body it
  // did not understand is worse than one that forwards it).
  proxy.on("proxyRes", (proxyRes, req, res) => {
    const tag = (req as TaggedReq).__chikinCdp;
    if (tag === undefined) return; // not tagged: http-proxy handled it normally
    const headers = { ...proxyRes.headers };
    const type = String(headers["content-type"] ?? "");
    if (headers["content-encoding"] || !type.includes("json")) {
      (res as ServerResponse).writeHead(proxyRes.statusCode ?? 200, headers);
      proxyRes.pipe(res as ServerResponse);
      return;
    }
    const chunks: Buffer[] = [];
    proxyRes.on("data", (c: Buffer) => chunks.push(c));
    proxyRes.on("end", () => {
      const body = rewriteCdpJson(Buffer.concat(chunks).toString("utf8"), tag.name, tag.selfHost);
      const buf = Buffer.from(body, "utf8");
      // We buffered the whole body and are sending it in one piece, so the
      // upstream's framing no longer describes what goes out. Leaving a
      // `transfer-encoding: chunked` header beside our own content-length is not
      // a cosmetic inconsistency — it is an illegal response, and Node's HTTP
      // parser rejects it client-side with HPE_INVALID_CONTENT_LENGTH before the
      // driver sees a byte.
      delete headers["transfer-encoding"];
      headers["content-length"] = String(buf.byteLength);
      const sres = res as ServerResponse;
      sres.writeHead(proxyRes.statusCode ?? 200, headers);
      sres.end(buf);
    });
    proxyRes.on("error", () => (res as ServerResponse).destroy());
  });

  proxy.on("error", (err, _req, target) => {
    log.warn("cdp: upstream error", String(err));
    const res = target as ServerResponse | Duplex | undefined;
    if (res && "writeHead" in res && !(res as ServerResponse).headersSent) {
      (res as ServerResponse).writeHead(502, { "content-type": "text/plain" });
      (res as ServerResponse).end("cdp upstream unavailable");
    } else if (res && "destroy" in res) {
      (res as Duplex).destroy();
    }
  });

  return proxy;
}

// One shared proxy for the whole lane, websocket upgrades included.
const proxy = createCdpProxy();

/** The bytes-read counter of a live socket — all the sampler needs of one. */
export interface ByteCounter {
  bytesRead: number;
}

/**
 * Stamp real browser activity for as long as a driver keeps sending commands.
 *
 * The reaper's attached tier measures `lastBrowserActivity`, and on this lane
 * there are no tool calls to stamp it with: after the handshake, everything
 * rides one websocket that the gateway deliberately does not parse. So sample
 * the socket's own byte counter and stamp only when it MOVED.
 *
 * Deliberately not a timer that stamps unconditionally. That is exactly the
 * client bridge's 120s keepalive ping, which kept `Activity.last` permanently
 * fresh and made "is this browser being used?" unanswerable until #57 split
 * the two clocks. A counter that only moves on real traffic keeps the answer
 * honest: a driver that connected and wandered off ages out like anything else.
 *
 * `bytesRead` on the CLIENT socket is commands arriving FROM the driver. The
 * other direction would be a worse signal — Chrome emits lifecycle events at an
 * idle page all by itself.
 */
export function trackCdpActivity(
  socket: ByteCounter,
  stamp: () => void,
  everyMs: number = CDP_ACTIVITY_SAMPLE_MS,
): () => void {
  let seen = socket.bytesRead;
  const timer = setInterval(() => {
    if (socket.bytesRead === seen) return;
    seen = socket.bytesRead;
    stamp();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Run `release` the first time this socket shows the driver is gone.
 *
 * NOT just `close`. The splice is two half-open-capable TCP connections, and a
 * driver that exits sends a FIN: our side emits `end`, http-proxy's pipe ends
 * the browser's side, and the socket stays open — no `close` — until the
 * browser happens to close its half too. Waiting only for `close` therefore
 * leaves the lane marked held by a driver that has already gone, and a browser
 * marked held is a browser that is never reaped. `end`, `close` and `error` all
 * mean the same thing here, and the first one wins.
 */
function onDriverGone(socket: Duplex, release: () => void): void {
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    release();
  };
  socket.on("end", fire);
  socket.on("close", fire);
  socket.on("error", fire);
}

/**
 * Who is already driving this Browser, if anyone.
 *
 * One lane at a time, per Name. MCP has enforced one session per browser since
 * issue #6; two drivers on one Chrome — one of them synthesising clicks the
 * other never asked for — is a failure nobody can read from either side. A
 * caller who wants a second browser asks for a second Name, and gets its own
 * clone of the golden profile.
 */
export function busyWith(registry: Registry, name: string): "mcp" | "cdp" | null {
  if (registry.getByName(name)) return "mcp";
  if (registry.hasCdp(name)) return "cdp";
  return null;
}

/**
 * Ensure the Browser exists and answer with its IP.
 *
 * Mirrors the bridge's `provision()`: the provision is declared to the registry
 * so a reaper sweep landing mid-flight cannot remove the profile volume between
 * seeding it and mounting it (CHK-015), and a container whose Chrome fails its
 * health probe is recreated once — at connect time nobody's session is
 * disturbed, and the profile volume survives a recreate.
 */
async function provisionForCdp(deps: CdpDeps, name: string): Promise<string> {
  // Rotating a stale image is safe here for the same reason it is on a cold MCP
  // attach (#57): the lane refuses a connect while anyone else is driving, so
  // there is nobody to tear down.
  const canRotateImage = () => busyWith(deps.registry, name) === null;
  deps.registry.markProvisioning(name);
  try {
    try {
      return await deps.provisioner.ensureContainer(name, { canRotateImage });
    } catch (e) {
      if (!(e instanceof ProvisionError)) throw e;
      log.warn(`cdp[${name}]: container unhealthy, recreating`, String(e));
      await deps.provisioner.recreateContainer(name);
      return await deps.provisioner.ensureContainer(name, { canRotateImage });
    }
  } finally {
    deps.registry.clearProvisioning(name);
  }
}

/**
 * Express handler for `/cdp/:name/*` — the `/json/*` handshake and anything
 * else the DevTools HTTP endpoint serves.
 *
 * Errors are plain text, not JSON-RPC: the caller here is a CDP client, and
 * what it shows a human is the status line of a failed fetch.
 */
export function makeCdpHttpHandler(deps: CdpDeps) {
  return function cdpHttpHandler(req: Request, res: Response, next: (e?: unknown) => void): void {
    const name = req.params.name;
    if (!config.cdpLane) {
      res.status(404).type("text/plain").send("the CDP lane is disabled (CHIKIN_CDP_LANE=0)");
      return;
    }
    if (!isValidName(name)) {
      res.status(400).type("text/plain").send("invalid browser name");
      return;
    }
    if (!cdpAccessOk(req)) {
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    const busy = busyWith(deps.registry, name);
    if (busy) {
      res
        .status(409)
        .type("text/plain")
        .send(`browser '${name}' is already being driven over the ${busy.toUpperCase()} lane`);
      return;
    }
    provisionForCdp(deps, name)
      .then((ip) => {
        // The handshake IS browser work: it is the moment a driver takes the
        // browser, and until its websocket opens there is nothing else to stamp.
        deps.registry.touchBrowserActivity(name);
        // Host is one of ours (cdpAccessOk), so it is safe to echo into the
        // websocket URL the driver will dial next.
        (req as unknown as TaggedReq).__chikinCdp = { name, selfHost: String(req.headers.host) };
        proxy.web(req, res, { target: cdpTarget(ip), selfHandleResponse: true });
      })
      .catch((e: unknown) => {
        if (e instanceof FleetFullError) {
          res.status(429).type("text/plain").send(e.message);
          return;
        }
        if (e instanceof ProvisionError) {
          log.error(`cdp[${name}]: provisioning failed`, e.message);
          res.status(503).type("text/plain").send(e.message);
          return;
        }
        next(e);
      });
  };
}

/**
 * Raw HTTP upgrade handler for the CDP websocket. Express is not in the upgrade
 * path, so the guards are re-applied here by hand — they are the same function
 * the HTTP handler uses, not a second spelling of it.
 *
 * Returns true if it handled (or refused) the request.
 *
 * No provisioning here: a driver only knows this URL because the `/json/*`
 * handshake handed it over, and that hop provisioned the container. An upgrade
 * for a browser that has since gone away fails fast instead of silently
 * building a second one behind the driver's back.
 */
export function makeCdpUpgradeHandler(deps: CdpDeps) {
  return function cdpUpgradeHandler(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const m = matchCdpUpgrade(req.url ?? "");
    if (!m) return false;
    const { name, rest } = m;
    if (!config.cdpLane || !cdpAccessOk(req)) {
      log.warn(
        `cdp: rejected upgrade for '${name}' (origin='${req.headers.origin ?? ""}' host='${req.headers.host ?? ""}')`,
      );
      socket.destroy();
      return true;
    }
    if (busyWith(deps.registry, name) !== null) {
      log.warn(`cdp: refused a second driver for '${name}'`);
      socket.destroy();
      return true;
    }

    void deps.provisioner
      .resolveIp(name)
      .then((ip) => {
        // Count the open socket as attachment so the reaper applies the
        // attached tier (ATTACHED_IDLE_TTL_SEC) instead of reclaiming a working
        // browser after IDLE_TTL_SEC, and sample the socket so that tier is
        // measured against traffic the driver actually sent.
        deps.registry.cdpOpened(name);
        const stopSampling = trackCdpActivity(socket as unknown as ByteCounter, () =>
          deps.registry.touchBrowserActivity(name),
        );
        onDriverGone(socket, () => {
          stopSampling();
          deps.registry.cdpClosed(name);
          log.info(`cdp[${name}]: driver disconnected`);
        });
        log.info(`cdp[${name}]: driver attached`);
        req.url = rest;
        proxy.ws(req, socket, head, { target: cdpTarget(ip) });
      })
      .catch((e: unknown) => {
        log.warn(`cdp[${name}]: no browser to upgrade onto`, String(e));
        socket.destroy();
      });
    return true;
  };
}
