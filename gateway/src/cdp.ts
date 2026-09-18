import httpProxy from "http-proxy";
import { STATUS_CODES } from "node:http";
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
 * already has. The decision and the options it beat are docs/adr/0005.
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
 * Fetch Metadata: headers a user agent writes onto EVERY request it makes —
 * every fetch in every mode, every subresource load, every navigation, every
 * websocket handshake — and that no HTTP library sends of its own accord.
 *
 * They are forbidden header names, so script cannot set, spoof or strip them:
 * if one is here, a browser put it here. That is the property `Origin` lacks.
 */
const FETCH_METADATA = ["sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"];

/**
 * Did a web browser make this request, as opposed to a program?
 *
 * `Origin` alone does not answer it. Fetch attaches an Origin only to
 * CORS-tainted requests, non-GET/HEAD methods and websocket handshakes — so a
 * `mode: 'no-cors'` GET, an `<img src>`, or a plain top-level navigation to
 * `/cdp/<name>/json/version` arrives with no Origin at all, and "has an Origin"
 * is therefore only *part* of "is a web page". Fetch Metadata is the half that
 * covers the rest, and the two together are the check.
 */
export function fromWebPage(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") return true;
  return FETCH_METADATA.some((h) => req.headers[h] !== undefined);
}

/**
 * May this request drive a browser over CDP?
 *
 * Three checks, and the middle one is the inverse of the VNC guard's:
 *
 *  - **Host** must be one of ours — the same DNS-rebinding guard every other
 *    surface applies (CHK-006a).
 *  - **It must not come from a web browser** (`fromWebPage`): no Origin, and no
 *    Fetch Metadata. A CDP driver is a program, and neither Playwright nor
 *    puppeteer nor a raw ws client sends either. A web page has no business on
 *    this lane — not even one served from our own dashboard origin, since
 *    allowing that would re-open a full control channel into a logged-in
 *    browser to anything that can get script onto that page. Chrome will not
 *    make this check for us: the browsers run `--remote-allow-origins=*`
 *    (CHK-002), so they accept whatever we forward. Refusing the *whole* GET
 *    surface matters as much as refusing the websocket, because reaching
 *    `/json/*` alone provisions a browser (a fleet slot and a seeded profile
 *    volume per name) and exposes `/json/close/<id>`.
 *  - **Bearer** when GATEWAY_TOKEN is set. Unlike noVNC — which is driven by a
 *    browser navigation that cannot carry a header — a CDP driver can:
 *    `connectOverCDP(url, { headers })` sends them on both the HTTP hop and the
 *    upgrade. So this lane is genuinely token-protectable, and is protected.
 */
export function cdpAccessOk(req: IncomingMessage): boolean {
  if (!hostOk(req)) return false;
  if (fromWebPage(req)) return false;
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
 * Who is already driving this Browser, if anyone — asked without reference to
 * who is doing the asking. `conflictFor` is what a request is judged against;
 * this is for decisions about the Browser itself, like rotating its image.
 *
 * One lane at a time, per Name. MCP has enforced one session per browser since
 * issue #6; two drivers on one Chrome — one of them synthesising clicks the
 * other never asked for — is a failure nobody can read from either side. A
 * caller who wants a second browser asks for a second Name, and gets its own
 * clone of the golden profile.
 *
 * `registry.has` (byName ∪ pending), not `getByName`: the MCP initialize path
 * claims a Name synchronously with `reserve()` and only promotes it to a live
 * session once the child process is up (server.ts), so for the tens to hundreds
 * of milliseconds in between, a Name that is already spoken for reads as free —
 * long enough for a driver's handshake AND its upgrade to take the lane, and
 * the MCP session then attaches chrome-devtools-mcp to the same Chrome. Not
 * `isPending`, which also counts the `provisioning` bumps this lane's own
 * provision makes, and would therefore conflict with itself.
 */
export function busyWith(registry: Registry, name: string): "mcp" | "cdp" | null {
  if (registry.has(name)) return "mcp";
  if (registry.hasCdp(name)) return "cdp";
  return null;
}

/** Name -> the driver currently holding the CDP lane on it. */
const cdpHolders = new Map<string, string>();

/**
 * Which driver this request belongs to.
 *
 * The source address is the whole of what an HTTP hop tells us: a driver's
 * `/json/*` fetch and its websocket are separate TCP connections with nothing
 * in common but where they came from. So the grain is coarse — two processes
 * on the same host look like one driver — and that is the deliberate trade.
 * The lane exists to stop a SECOND driver stealing a Browser out from under
 * the first; locking the first driver out of its own follow-up request (a
 * `/json/list` mid-session, a second target socket — the chrome-remote-interface
 * pattern) is not that, it is just a lane nobody can use twice.
 */
export function driverKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Is this Browser held by somebody OTHER than the driver making this request?
 *
 * MCP always conflicts — the two lanes never share a Chrome. CDP conflicts only
 * when the holder is a different driver; an unrecorded holder (the registry
 * says held but no key was taken) counts as different, so the refusal fails
 * closed.
 */
export function conflictFor(registry: Registry, name: string, driver: string): "mcp" | "cdp" | null {
  const busy = busyWith(registry, name);
  if (busy === "cdp" && cdpHolders.get(name) === driver) return null;
  return busy;
}

/**
 * Is this driver the one holding the lane on `name` right now?
 *
 * Not the same question as `conflictFor` answering null, which is also true of
 * a Name nobody holds at all. This one asks whether a websocket of OURS is
 * already spliced to a running browser — which is what decides whether a
 * request may provision one.
 */
function holdsLane(registry: Registry, name: string, driver: string): boolean {
  return registry.hasCdp(name) && cdpHolders.get(name) === driver;
}

/** Take the lane for `driver`, or add a second socket to the one it holds. */
function holdLane(registry: Registry, name: string, driver: string): void {
  cdpHolders.set(name, driver);
  registry.cdpOpened(name);
}

/** Give back one socket's share; the last one out drops the driver's claim. */
function releaseLane(registry: Registry, name: string): void {
  registry.cdpClosed(name);
  if (!registry.hasCdp(name)) cdpHolders.delete(name);
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
async function provisionOnce(deps: CdpDeps, name: string): Promise<string> {
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

/** Provisions running right now, one per Name — see provisionForCdp. */
const provisioning = new Map<string, Promise<string>>();

/**
 * Single-flight `provisionOnce`, the way the bridge shares one `attaching`
 * promise (bridge.ts).
 *
 * Nothing else serialises this lane: the busy check only sees a Browser once a
 * websocket is open, and the handshake that opens one happens first. So two
 * `/json/version` fetches for the same cold Name both find no container, both
 * create one, and the loser gets Docker's 409 name conflict — which is not a
 * ProvisionError, so it would surface as a bare 500 on a lane that is plain
 * text everywhere else. Concurrent callers share one provision instead, and
 * both get the same IP.
 */
function provisionForCdp(deps: CdpDeps, name: string): Promise<string> {
  const inFlight = provisioning.get(name);
  if (inFlight) return inFlight;
  const started: Promise<string> = provisionOnce(deps, name).finally(() => {
    if (provisioning.get(name) === started) provisioning.delete(name);
  });
  provisioning.set(name, started);
  return started;
}

/**
 * Express handler for `/cdp/:name/*` — the `/json/*` handshake and anything
 * else the DevTools HTTP endpoint serves.
 *
 * Errors are plain text, not JSON-RPC: the caller here is a CDP client, and
 * what it shows a human is the status line of a failed fetch.
 */
export function makeCdpHttpHandler(deps: CdpDeps) {
  return function cdpHttpHandler(req: Request, res: Response): void {
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
    const driver = driverKey(req);
    const busy = conflictFor(deps.registry, name, driver);
    if (busy) {
      res
        .status(409)
        .type("text/plain")
        .send(`browser '${name}' is already being driven over the ${busy.toUpperCase()} lane`);
      return;
    }
    // The lane exclusion has to hold from the FIRST request, not from the first
    // websocket. A cold handshake provisions a container before any socket
    // exists — seconds, up to PROVISION_TIMEOUT_SEC — and for all of it the MCP
    // side would read this Name as free, open a session on it, and then have
    // its own lazy attach race Docker for the same container name. Scoped to
    // this request and given back on whichever of `finish`/`close` comes first,
    // so a handshake that fails, or that never comes back to open a websocket,
    // cannot leave the Name refusing both lanes forever.
    deps.registry.claimCdp(name);
    let claimed = true;
    const unclaim = (): void => {
      if (!claimed) return;
      claimed = false;
      deps.registry.unclaimCdp(name);
    };
    res.on("finish", unclaim);
    res.on("close", unclaim);

    // Laziness is for the FIRST request on an unheld Name (#63) — that is what
    // it is for. Once this driver holds the lane it has a websocket spliced to
    // a running container, and every provision ends in `waitHealthy`: a browser
    // whose DevTools endpoint has wedged (#73) would be stopped and removed out
    // from under the very socket its own driver is holding, killing a live
    // session to "recover" it. So a holder's follow-up resolves the container
    // that exists and says so plainly when there is none — the rule the upgrade
    // handler already applies, for the same reason.
    const held = holdsLane(deps.registry, name, driver);
    (held ? deps.provisioner.resolveIp(name) : provisionForCdp(deps, name))
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
        if (held) {
          log.warn(`cdp[${name}]: the browser this lane is holding is gone`, String(e));
          if (!res.headersSent) {
            res
              .status(502)
              .type("text/plain")
              .send(`no browser named '${name}' to reach`);
          }
          return;
        }
        if (e instanceof FleetFullError) {
          res.status(429).type("text/plain").send(e.message);
          return;
        }
        if (e instanceof ProvisionError) {
          log.error(`cdp[${name}]: provisioning failed`, e.message);
          res.status(503).type("text/plain").send(e.message);
          return;
        }
        // Not Express's JSON backstop: a CDP client shows a human the status
        // line of a failed fetch, and a JSON-RPC envelope in the middle of a
        // plain-text lane tells that human nothing.
        log.error(`cdp[${name}]: unexpected failure`, String(e));
        if (!res.headersSent) res.status(500).type("text/plain").send("internal gateway error");
      });
  };
}

/**
 * Turn an upgrade down in words.
 *
 * Express is not in this path, so nothing writes a status line unless we do —
 * and a bare `socket.destroy()` reaches the driver as `socket hang up`, which
 * says nothing about whether the browser is taken, the lane is off, or the
 * request looked like it came from a web page. A refusal a human can read is
 * worth the six lines, and an HTTP response is a legal answer to an upgrade
 * request (RFC 9110 §15: the server simply declines to switch protocols).
 */
function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`;
  // Destroyed once the refusal is on the wire, not merely half-closed: an
  // upgrade socket is detached from its http.Server, so nothing else will ever
  // reach it, and a client that keeps its own half open would otherwise leave
  // this one hanging around — and `server.close()` waiting on it forever.
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n` +
      "content-type: text/plain\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n" +
      "\r\n" +
      body,
    () => socket.destroy(),
  );
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
    if (!config.cdpLane) {
      refuseUpgrade(socket, 404, "the CDP lane is disabled (CHIKIN_CDP_LANE=0)");
      return true;
    }
    if (!cdpAccessOk(req)) {
      log.warn(
        `cdp: rejected upgrade for '${name}' (origin='${req.headers.origin ?? ""}' host='${req.headers.host ?? ""}')`,
      );
      refuseUpgrade(socket, 403, "forbidden");
      return true;
    }
    const driver = driverKey(req);
    const busy = conflictFor(deps.registry, name, driver);
    if (busy !== null) {
      log.warn(`cdp: refused a second driver for '${name}' (held over the ${busy} lane)`);
      refuseUpgrade(
        socket,
        409,
        `browser '${name}' is already being driven over the ${busy.toUpperCase()} lane`,
      );
      return true;
    }

    // Count the open socket as attachment so the reaper applies the attached
    // tier (ATTACHED_IDLE_TTL_SEC) instead of reclaiming a working browser
    // after IDLE_TTL_SEC.
    holdLane(deps.registry, name, driver);
    let stopSampling: (() => void) | null = null;
    let spliced = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      stopSampling?.();
      releaseLane(deps.registry, name);
      // Before the splice, nobody else can close this socket: http-proxy has
      // no other end to end, and a driver that FINs leaves it half-open — a
      // socket with nothing on it that `server.close()` then waits on forever.
      // After the splice the proxy owns both ends, and a half-close there may
      // still have bytes to deliver (AGENTS.md: an `end` is not a `close`).
      if (!spliced && !socket.destroyed && !socket.writableEnded) socket.destroy();
      log.info(`cdp[${name}]: driver disconnected`);
    };
    // Claimed and armed BEFORE the awaited Docker inspect below, because a
    // driver that gives up during it (Playwright's 30s connect default, a ^C,
    // an aborted retry) has already emitted `close` by the time that promise
    // settles — listeners added afterwards never fire, and the Browser stays
    // marked held by a driver that is gone: 409 on both lanes, a fleet slot
    // spent, nothing to reap it but the attached tier hours later.
    onDriverGone(socket, release);
    if (socket.destroyed) {
      release();
      return true;
    }

    void deps.provisioner
      .resolveIp(name)
      .then((ip) => {
        if (released || socket.destroyed) {
          release();
          return;
        }
        // Sample the socket so the attached tier is measured against traffic
        // the driver actually sent.
        stopSampling = trackCdpActivity(socket as unknown as ByteCounter, () =>
          deps.registry.touchBrowserActivity(name),
        );
        log.info(`cdp[${name}]: driver attached`);
        req.url = rest;
        spliced = true;
        proxy.ws(req, socket, head, { target: cdpTarget(ip) });
      })
      .catch((e: unknown) => {
        log.warn(`cdp[${name}]: no browser to upgrade onto`, String(e));
        if (!socket.destroyed) refuseUpgrade(socket, 502, `no browser named '${name}' to upgrade onto`);
        release();
      });
    return true;
  };
}
