import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Docker from "dockerode";

/**
 * A stub Docker Engine API, served over HTTP, for exercising destructive
 * volume and container-removal paths without a daemon (CLAUDE.md: never
 * against the live fleet — a bug here would delete an operator's
 * `chikin-profile-golden`).
 *
 * Why a real server rather than a hand-written dockerode-shaped object: since
 * ADR 0004, Docker's own refusal to remove a mounted volume IS the ownership
 * rule — the single-volume destroy path deliberately does not compute
 * "is anything mounting this" for itself. A double that models that refusal is
 * the safety property asserted against a copy of itself. Here the 409 is
 * emergent from container state, and the numeric `statusCode` the gateway
 * branches on — plus the name-echoing error text it must NOT branch on
 * (SPY-161) — is produced by real dockerode from a real response, not invented
 * by the test.
 *
 * The gateway talks to a socket-proxy over `{ host, port, protocol: "http" }`
 * (see provisioner.ts), so this is a drop-in for the transport it really uses.
 *
 * Scope is deliberately the volume endpoints, container removal, and the
 * container list they depend on. Container creation, exec, networks and images
 * are not modelled — a request for anything unhandled fails loudly with a 501
 * naming it, so a test that wanders outside this surface says so instead of
 * silently passing. The same contract covers query params and filters, and it
 * is enforced by the dispatcher from each route's declaration (see `Route`)
 * rather than by each handler remembering to check: a new route models nothing
 * until it says so.
 */

export interface StubVolume {
  Name: string;
  Labels?: Record<string, string>;
}

export interface StubContainer {
  Id: string;
  Names: string[];
  State: string;
  Status?: string;
  Labels: Record<string, string>;
  Mounts?: { Name?: string }[];
}

/** A response the stub is told to give instead of serving the request. */
export interface StubFailure {
  status: number;
  /** The body's `message`; dockerode folds it into the Error it throws. */
  message: string;
}

export interface DockerStubInit {
  /** Volumes present at start. A bare string is a volume with no labels. */
  volumes?: (string | StubVolume)[];
  /** Containers present at start. Their `Mounts` decide what is removable. */
  containers?: StubContainer[];
  /**
   * Failures to inject into `DELETE /volumes/<name>`, keyed by full volume name
   * and taking precedence over the volume's real state. This is the seam for
   * driving "Docker failed some other way" — a 500, a driver error — which the
   * gateway must treat differently from an already-gone 404, without a test
   * reaching into the server's internals to arrange it.
   */
  removeFailures?: Record<string, StubFailure>;
  /**
   * Failures to inject into `DELETE /containers/<id>`, keyed by the id or name
   * the gateway addresses the container by, and taking precedence over its
   * real state. The volume seam's counterpart for the container path.
   */
  removeContainerFailures?: Record<string, StubFailure>;
  /**
   * Failure to inject into `GET /containers/json`, for driving "container
   * ownership cannot be read" paths — the orphan sweep must fail closed —
   * without the test hand-rolling a Docker double for one throw.
   */
  listContainersFailure?: StubFailure;
}

export interface DockerStub {
  /** A real dockerode client pointed at this stub. */
  docker: Docker;
  /** Base URL of the stub, for asserting on raw requests dockerode cannot send. */
  url: string;
  /**
   * Every request received, as `METHOD /decoded-path?query`, in order. The
   * query string is included precisely because the load-bearing params (`all`,
   * `filters`, `force`) travel there — a log without it could not tell a list
   * that sent `all` from one that dropped it.
   */
  requests: string[];
  /** Volume names currently present. */
  volumes(): string[];
  /**
   * Containers currently present. Mutate it IN PLACE (`push`, `splice`) to
   * change the fleet mid-test — the server closes over this exact array.
   * `readonly` because reassigning it would leave the server on the old one,
   * which is silent rather than a type error.
   */
  readonly containers: StubContainer[];
  close(): Promise<void>;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface RouteCtx {
  res: ServerResponse;
  /** Captures from the route's pattern, matched against the decoded path. */
  match: RegExpExecArray;
  query: URLSearchParams;
  /** `filters`, normalized to arrays whichever encoding the client sent. */
  filters: Record<string, string[]>;
  /** The parsed JSON body — always an object — for routes that declare one. */
  body: Record<string, unknown>;
}

/**
 * A route declares what it models; the dispatcher enforces it. Silently
 * ignoring a query param is how a stub drifts from the daemon —
 * `DELETE /volumes/<name>?force=true` makes real Docker answer 204 where it
 * otherwise answers 404 — so a param outside `params` (plus `filters` where
 * `filterKeys` is declared) is answered 501 naming it before the handler runs.
 * Structural on purpose: a handler cannot forget a check it never makes.
 */
interface Route {
  method: "GET" | "POST" | "DELETE";
  /** Matched against the decoded, version-stripped pathname. */
  pattern: RegExp;
  /** Query params this endpoint models; anything else is a 501 naming it. */
  params: readonly string[];
  /** Filter keys this endpoint models. Declaring any is what models `filters`. */
  filterKeys?: readonly string[];
  /** Collect and JSON-parse the request body before calling the handler. */
  body?: boolean;
  handle(ctx: RouteCtx): void;
}

/**
 * Parse and normalize the `filters` query param. Docker accepts two encodings —
 * the array form `{"label":["a=b"]}` and the map form `{"label":{"a=b":true}}`
 * — and a client may send either, so both must be served rather than crash:
 * a throw inside the server callback is an uncaught exception that kills the
 * whole test process, not a failed request. An unmodelled key is a 501 naming
 * it, the same contract as query params. Returns undefined after writing a
 * response.
 */
function parseFilters(
  res: ServerResponse,
  raw: string,
  modelledKeys: readonly string[],
): Record<string, string[]> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { message: "filters: malformed" });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    json(res, 400, { message: "filters: malformed" });
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!modelledKeys.includes(k)) {
      json(res, 501, { message: `docker-stub: unmodelled filter '${k}'` });
      return undefined;
    }
    if (Array.isArray(v)) {
      // Array form — but a non-string element must be the 400 here, not fall
      // through to the map-form branch below (an array IS an object, and
      // Object.keys would silently serve its indexes as filter values).
      if (!v.every((s) => typeof s === "string")) {
        json(res, 400, { message: `filters: malformed value for '${k}'` });
        return undefined;
      }
      out[k] = v as string[];
    } else if (typeof v === "object" && v !== null) {
      // Map form. moby's filters.Args.Get returns every key regardless of its
      // boolean, so the values are deliberately ignored here too.
      out[k] = Object.keys(v);
    } else {
      json(res, 400, { message: `filters: malformed value for '${k}'` });
      return undefined;
    }
  }
  return out;
}

// What the daemon lists without `all`: containers whose Running flag is true.
// That is State running, paused OR restarting — moby's List excludes only
// !Running, and pause and restart both keep it set (plain `docker ps` shows
// them) — not merely State === "running".
const RUNNING_STATES = new Set(["running", "paused", "restarting"]);

export async function startDockerStub(init: DockerStubInit = {}): Promise<DockerStub> {
  const volumes = new Map<string, StubVolume>(
    (init.volumes ?? [])
      .map((v) => (typeof v === "string" ? { Name: v } : v))
      .map((v) => [v.Name, v] as const),
  );
  const containers: StubContainer[] = [...(init.containers ?? [])];
  const removeFailures = new Map(Object.entries(init.removeFailures ?? {}));
  const removeContainerFailures = new Map(Object.entries(init.removeContainerFailures ?? {}));
  const requests: string[] = [];

  const routes: Route[] = [
    {
      method: "DELETE",
      pattern: /^\/volumes\/([^/]+)$/,
      // Nothing is modelled here — notably not `force`.
      params: [],
      handle({ res, match }) {
        const name = match[1] ?? "";
        const injected = removeFailures.get(name);
        if (injected) return json(res, injected.status, { message: injected.message });
        if (!volumes.has(name)) {
          return json(res, 404, { message: `remove ${name}: no such volume` });
        }
        // The ownership rule: Docker refuses while any container mounts it, and
        // names the offending containers. This is what the gateway relies on
        // instead of listing containers itself.
        const holders = containers.filter((c) => (c.Mounts ?? []).some((m) => m?.Name === name));
        if (holders.length) {
          return json(res, 409, {
            message: `remove ${name}: volume is in use - [${holders.map((c) => c.Id).join(", ")}]`,
          });
        }
        volumes.delete(name);
        res.writeHead(204);
        res.end();
      },
    },
    {
      method: "GET",
      pattern: /^\/volumes\/([^/]+)$/,
      params: [],
      handle({ res, match }) {
        const v = volumes.get(match[1] ?? "");
        if (!v) return json(res, 404, { message: `get ${match[1]}: no such volume` });
        json(res, 200, { Name: v.Name, Labels: v.Labels ?? {}, Driver: "local" });
      },
    },
    {
      method: "POST",
      pattern: /^\/volumes\/create$/,
      // docker-modem mirrors a POST's whole config into the query string as
      // well as the body (the createContainer sharp edge in CLAUDE.md), so the
      // modelled params here are exactly the body fields, not an empty set.
      params: ["Name", "Labels", "Driver", "DriverOpts"],
      body: true,
      handle({ res, body }) {
        const name = body.Name;
        if (typeof name !== "string" || !name) {
          return json(res, 400, { message: "create: name required" });
        }
        const existing = volumes.get(name);
        if (existing) {
          // Real Docker's create on an existing name returns the STORED volume
          // unchanged — the new request's labels are never applied (labels are
          // immutable after creation; moby's volume store short-circuits on the
          // name and errors only on a driver conflict). Overwriting here would
          // certify exactly the label-drift class (issue #59) this suite pins.
          return json(res, 201, {
            Name: existing.Name,
            Labels: existing.Labels ?? {},
            Driver: "local",
          });
        }
        const labels = (body.Labels ?? {}) as Record<string, string>;
        volumes.set(name, { Name: name, Labels: labels });
        json(res, 201, { Name: name, Labels: labels, Driver: "local" });
      },
    },
    {
      method: "GET",
      pattern: /^\/volumes$/,
      // `filters` is deliberately NOT modelled (no filterKeys): the sweep
      // selects by name from the full list, and a stub that accepted `dangling`
      // without implementing it would hand back every volume as though the
      // filter had matched.
      params: [],
      handle({ res }) {
        json(res, 200, { Volumes: [...volumes.values()], Warnings: [] });
      },
    },
    {
      method: "DELETE",
      pattern: /^\/containers\/([^/]+)$/,
      // `force` is modelled because the gateway sends it: real Docker answers
      // 409 for a RUNNING container without it, and removes it with it. The
      // other documented params (`v`, `link`) are not modelled — a caller that
      // starts sending one gets a 501 naming it rather than silence.
      params: ["force"],
      handle({ res, match, query }) {
        const ref = match[1] ?? "";
        const injected = removeContainerFailures.get(ref);
        if (injected) return json(res, injected.status, { message: injected.message });
        // Docker addresses a container by id OR name; the gateway uses the name.
        const i = containers.findIndex((c) => c.Id === ref || c.Names.includes(`/${ref}`));
        if (i === -1) return json(res, 404, { message: `remove ${ref}: no such container` });
        const force = query.get("force") === "1" || query.get("force") === "true";
        const target = containers[i] as StubContainer;
        if (!force && RUNNING_STATES.has(target.State)) {
          return json(res, 409, {
            message: `remove ${ref}: You cannot remove a running container ${target.Id}. ` +
              `Stop the container before attempting removal or force remove`,
          });
        }
        containers.splice(i, 1);
        res.writeHead(204);
        res.end();
      },
    },
    {
      method: "GET",
      pattern: /^\/containers\/json$/,
      // `all` is load-bearing, not cosmetic: listFleet, gcExited and the orphan
      // sweep all depend on seeing stopped containers (a stopped container
      // still holds a fleet slot — that is the "fleet is full" lockup). A stub
      // that ignored the flag would pass a test whose production code had
      // dropped it.
      params: ["all"],
      filterKeys: ["label"],
      handle({ res, query, filters }) {
        const injected = init.listContainersFailure;
        if (injected) return json(res, injected.status, { message: injected.message });
        const allRaw = query.get("all");
        const all = allRaw === "1" || allRaw === "true";
        const wanted = filters.label ?? [];
        const out = containers
          .filter((c) => all || RUNNING_STATES.has(c.State))
          .filter((c) =>
            wanted.every((w) => {
              const eq = w.indexOf("=");
              // Docker accepts both `key` (present) and `key=value` label filters.
              return eq === -1 ? w in c.Labels : c.Labels[w.slice(0, eq)] === w.slice(eq + 1);
            }),
          );
        json(res, 200, out);
      },
    },
  ];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://docker");
    // Strip the optional /v1.4x API-version prefix dockerode may negotiate.
    // Anchored on the slash that follows it, so a non-version path that merely
    // begins /v<digits> is not mangled before the 501 can name it.
    const rawPath = url.pathname.replace(/^\/v[\d.]+(?=\/)/, "");
    // Decode per segment, so handlers and the request log see one spelling. A
    // malformed percent-escape throws synchronously; without the catch the
    // whole test process dies instead of the request failing.
    let path: string;
    try {
      path = rawPath.split("/").map(decodeURIComponent).join("/");
    } catch {
      requests.push(`${req.method} ${rawPath}${url.search}`);
      return json(res, 400, { message: `invalid path: ${rawPath}` });
    }
    requests.push(`${req.method} ${path}${url.search}`);

    let route: Route | undefined;
    let match: RegExpExecArray | null = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      match = r.pattern.exec(path);
      if (match) {
        route = r;
        break;
      }
    }
    if (!route || !match) {
      return json(res, 501, { message: `docker-stub: unhandled ${req.method} ${path}` });
    }

    const modelled = route.filterKeys ? [...route.params, "filters"] : route.params;
    for (const [k] of url.searchParams) {
      if (!modelled.includes(k)) {
        return json(res, 501, { message: `docker-stub: unmodelled query param '${k}'` });
      }
    }

    let filters: Record<string, string[]> = {};
    const rawFilters = url.searchParams.get("filters");
    if (rawFilters !== null) {
      const parsed = parseFilters(res, rawFilters, route.filterKeys ?? []);
      if (!parsed) return;
      filters = parsed;
    }

    const ctx: RouteCtx = { res, match, query: url.searchParams, filters, body: {} };
    if (!route.body) return route.handle(ctx);

    let raw = "";
    // A client abort mid-body emits 'error' on the request stream; with no
    // listener that is an uncaught exception killing the test process — the
    // same crash class as the JSON and listen hardening above. The response
    // socket is gone with the client, so there is no one to answer: drop it.
    req.on("error", () => res.destroy());
    req.on("data", (c) => {
      raw += c;
    });
    const handle = route.handle.bind(route);
    req.on("end", () => {
      // Thrown inside this event handler an exception is uncaught and kills the
      // test process rather than failing the request — so parse defensively,
      // and reject the non-object documents JSON.parse happily produces
      // ("null", "[]", '"x"') before a handler can dereference them.
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { message: "malformed body" });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json(res, 400, { message: "malformed body" });
      }
      handle({ ...ctx, body: body as Record<string, unknown> });
    });
  });

  // A failed bind must reject this promise and fail the one test that started
  // the stub: with no 'error' listener Node rethrows the event as an uncaught
  // exception, taking down the whole run before t.after cleanups register.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    docker: new Docker({ host: "127.0.0.1", port, protocol: "http" }),
    url: `http://127.0.0.1:${port}`,
    requests,
    volumes: () => [...volumes.keys()],
    containers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
