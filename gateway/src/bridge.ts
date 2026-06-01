import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

/**
 * Provision (or reuse) the named browser, spawn its chrome-devtools-mcp child,
 * and wire a transparent JSON-RPC pump between the client's HTTP MCP transport
 * and the child's stdio. Returns once both transports are started; the caller
 * then drives the initialize handshake via `session.http.handleRequest`.
 */
export async function createSession(name: string, deps: BridgeDeps): Promise<Session> {
  const ip = await deps.provisioner.ensureContainer(name);

  // Connect by IP (not container name): Chrome's DevTools HTTP endpoint rejects
  // a DNS-name Host header, but accepts an IP. socat inside the container
  // bridges this to Chrome's loopback CDP port.
  const child = new StdioClientTransport({
    command: config.cdmCommand,
    args: ["--browserUrl", `http://${ip}:${config.cdpPort}`],
    stderr: "pipe",
  });

  let session!: Session;
  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      session.sessionId = sid;
      deps.registry.bindSessionId(sid, session);
      log.info(`session[${name}]: initialized as ${sid}`);
    },
  });

  session = new Session(name, http, child, (s) => deps.registry.remove(s));

  // Transparent bidirectional JSON-RPC proxy. Every frame counts as activity,
  // which keeps the reaper away from a session that's mid-task (issue #7).
  http.onmessage = (msg) => {
    deps.registry.touch(name);
    child.send(msg).catch((e) => log.warn(`session[${name}]: child send failed`, String(e)));
  };
  child.onmessage = (msg) => {
    deps.registry.touch(name);
    http.send(msg).catch((e) => log.warn(`session[${name}]: http send failed`, String(e)));
  };

  http.onclose = () => void session.close("http transport closed");
  child.onclose = () => void session.close("child process exited");
  child.onerror = (e) => log.warn(`session[${name}]: child transport error`, String(e));

  // Child first so its stdin is ready before the initialize frame arrives.
  await child.start();
  child.stderr?.on("data", (d: Buffer) =>
    log.debug(`[cdm:${name}] ${d.toString().trimEnd()}`),
  );
  await http.start();

  return session;
}
