import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";

/**
 * Bearer-token checks, shared by every authenticated surface.
 *
 * Extracted from server.ts because the CDP lane needs the identical check on a
 * path Express never sees: a websocket upgrade arrives as a raw
 * `IncomingMessage`, with no router, no middleware chain and no Express
 * `Request`. Two spellings of "is this token right" is exactly how one of them
 * ends up subtly weaker than the other.
 */

/** Constant-time compare against GATEWAY_TOKEN. True when auth is disabled. */
export function tokenOk(provided: string): boolean {
  if (!config.token) return true; // auth disabled (dev only)
  const a = Buffer.from(provided);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this request's Authorization header acceptable?
 *
 * With an empty GATEWAY_TOKEN (the shipped default) every request passes — the
 * published port is loopback-only and the Host/Origin guards carry the weight.
 * With a token set, a well-formed `Bearer <token>` is required.
 */
export function bearerOk(req: IncomingMessage): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m !== null && tokenOk(m[1]);
}
