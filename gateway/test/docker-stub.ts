import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Docker from "dockerode";

/**
 * A stub Docker Engine API, served over HTTP, for exercising destructive volume
 * paths without a daemon (CLAUDE.md: never against the live fleet — a bug here
 * would delete an operator's `chikin-profile-golden`).
 *
 * Why a real server rather than a hand-written dockerode-shaped object: since
 * ADR 0004, Docker's own refusal to remove a mounted volume IS the ownership
 * rule — the single-volume destroy path deliberately does not compute
 * "is anything mounting this" for itself. A double that models that refusal is
 * the safety property asserted against a copy of itself. Here the 409 is
 * emergent from container state, and the 404/409 error text the gateway parses
 * is produced by real dockerode from a real response, not invented by the test.
 *
 * The gateway talks to a socket-proxy over `{ host, port, protocol: "http" }`
 * (see provisioner.ts), so this is a drop-in for the transport it really uses.
 *
 * Scope is deliberately the volume endpoints plus the container list they
 * depend on. Container creation, exec, networks and images are not modelled —
 * a request for anything unhandled fails loudly with a 501 naming it, so a test
 * that wanders outside this surface says so instead of silently passing. That
 * applies to query params and filters too, not just paths: see `guardParams`.
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
}

export interface DockerStub {
  /** A real dockerode client pointed at this stub. */
  docker: Docker;
  /** Base URL of the stub, for asserting on raw requests dockerode cannot send. */
  url: string;
  /** Every request received, as `METHOD /path`, in order. */
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

/**
 * Answers 501 if the request carries a query param this stub does not model,
 * and reports whether it did. Silently ignoring one is how a stub drifts from
 * the daemon: `DELETE /volumes/<name>?force=true` makes real Docker answer 204
 * where it otherwise answers 404, so a test that starts sending `force` must be
 * told the stub does not implement it rather than quietly getting the old
 * behaviour.
 */
function guardParams(res: ServerResponse, url: URL, modelled: readonly string[]): boolean {
  for (const [k] of url.searchParams) {
    if (!modelled.includes(k)) {
      json(res, 501, { message: `docker-stub: unmodelled query param '${k}'` });
      return true;
    }
  }
  return false;
}

export async function startDockerStub(init: DockerStubInit = {}): Promise<DockerStub> {
  const volumes = new Map<string, StubVolume>(
    (init.volumes ?? [])
      .map((v) => (typeof v === "string" ? { Name: v } : v))
      .map((v) => [v.Name, v] as const),
  );
  const containers: StubContainer[] = [...(init.containers ?? [])];
  const removeFailures = new Map(Object.entries(init.removeFailures ?? {}));
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://docker");
    // Strip the optional /v1.4x API-version prefix dockerode may negotiate.
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    requests.push(`${req.method} ${path}`);

    const matched = /^\/volumes\/([^/]+)$/.exec(path)?.[1];
    let name: string | undefined;
    if (matched !== undefined) {
      // A malformed percent-escape throws synchronously; without this the whole
      // test process dies instead of the request failing.
      try {
        name = decodeURIComponent(matched);
      } catch {
        return json(res, 400, { message: `invalid volume name: ${matched}` });
      }
    }

    if (req.method === "DELETE" && name !== undefined) {
      // Nothing is modelled here — notably not `force`.
      if (guardParams(res, url, [])) return;
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
      return res.end();
    }

    if (req.method === "GET" && name !== undefined) {
      if (guardParams(res, url, [])) return;
      const v = volumes.get(name);
      if (!v) return json(res, 404, { message: `get ${name}: no such volume` });
      return json(res, 200, { Name: v.Name, Labels: v.Labels ?? {}, Driver: "local" });
    }

    if (req.method === "POST" && path === "/volumes/create") {
      // docker-modem mirrors a POST's whole config into the query string as
      // well as the body (the createContainer sharp edge in CLAUDE.md), so the
      // modelled params here are exactly the body fields, not an empty set.
      if (guardParams(res, url, ["Name", "Labels", "Driver", "DriverOpts"])) return;
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        // Thrown inside an event handler this would be an uncaught exception and
        // would kill the test process, not fail the request.
        let opts: StubVolume;
        try {
          opts = body ? (JSON.parse(body) as StubVolume) : ({} as StubVolume);
        } catch {
          return json(res, 400, { message: "create: malformed body" });
        }
        if (!opts.Name) return json(res, 400, { message: "create: name required" });
        volumes.set(opts.Name, { Name: opts.Name, Labels: opts.Labels ?? {} });
        json(res, 201, { Name: opts.Name, Labels: opts.Labels ?? {}, Driver: "local" });
      });
      return;
    }

    if (req.method === "GET" && path === "/volumes") {
      // `filters` is deliberately NOT modelled: the sweep selects by name from
      // the full list, and a stub that accepted `dangling` without implementing
      // it would hand back every volume as though the filter had matched.
      if (guardParams(res, url, [])) return;
      return json(res, 200, { Volumes: [...volumes.values()], Warnings: [] });
    }

    if (req.method === "GET" && path === "/containers/json") {
      // `all` is load-bearing, not cosmetic: real Docker lists ONLY running
      // containers without it, and listFleet, gcExited and the orphan sweep all
      // depend on seeing stopped ones (a stopped container still holds a fleet
      // slot — that is the "fleet is full" lockup). A stub that ignored it would
      // pass a test whose production code had dropped the flag.
      if (guardParams(res, url, ["all", "filters"])) return;
      const allRaw = url.searchParams.get("all");
      const all = allRaw === "1" || allRaw === "true";
      const raw = url.searchParams.get("filters");
      let parsed: Record<string, string[]> = {};
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, string[]>;
        } catch {
          return json(res, 400, { message: "filters: malformed" });
        }
      }
      for (const k of Object.keys(parsed)) {
        if (k !== "label") {
          return json(res, 501, { message: `docker-stub: unmodelled filter '${k}'` });
        }
      }
      const wanted: string[] = parsed.label ?? [];
      const out = containers
        .filter((c) => all || c.State === "running")
        .filter((c) =>
          wanted.every((w) => {
            const eq = w.indexOf("=");
            // Docker accepts both `key` (present) and `key=value` label filters.
            return eq === -1 ? w in c.Labels : c.Labels[w.slice(0, eq)] === w.slice(eq + 1);
          }),
        );
      return json(res, 200, out);
    }

    json(res, 501, { message: `docker-stub: unhandled ${req.method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
