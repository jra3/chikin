import test from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { startSseKeepalive } from "../src/server.js";

/**
 * Regression cover for the 5-minute session churn.
 *
 * Node's `fetch` (undici) applies a 300_000 ms `bodyTimeout` to a response
 * body. The MCP event stream is silent while a client sits between tool calls,
 * so undici killed it at ~301s with `UND_ERR_BODY_TIMEOUT` (measured directly:
 * a silent SSE response errored after 300706 ms). The client reconnected, the
 * gateway reclaimed the streamless session as stale, and that FREED its
 * chikin_identify handle — so every long-lived session lost its identity, and
 * with it every browser tool, every five minutes. Measured on the live fleet as
 * reclaim intervals of [301, 388, 584, 301, 301, 301, 301, 472, 310] seconds.
 *
 * The cure is a periodic SSE comment. These tests pin the two things that make
 * it safe: it must be frequent enough to beat that timeout, and it must never
 * write into a response that is not an event stream.
 */

/** Minimal ServerResponse stand-in recording what got written. */
function fakeRes(over: Partial<Response> = {}) {
  const written: string[] = [];
  const res = {
    headersSent: true,
    writableEnded: false,
    writable: true,
    getHeader: () => "text/event-stream",
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    ...over,
  };
  return { res: res as unknown as Response, written };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an idle event stream is kept alive with SSE comments", async () => {
  const { res, written } = fakeRes();
  const stop = startSseKeepalive(res, 10);
  await tick(55);
  stop();
  assert.ok(written.length >= 3, `expected repeated keepalives, got ${written.length}`);
  assert.ok(
    written.every((w) => w === ": keepalive\n\n"),
    "each write is a bare SSE comment — invisible to the protocol (eventsource-parser drops ':' lines)",
  );
});

test("stopping ends the keepalive (no writes after a stream closes)", async () => {
  const { res, written } = fakeRes();
  const stop = startSseKeepalive(res, 10);
  await tick(35);
  const afterStop = written.length;
  stop();
  await tick(40);
  assert.equal(written.length, afterStop, "a closed stream must never be written to again");
});

// The same helper is attached to POST replies, which are SSE by default but
// would be plain JSON under enableJsonResponse. Writing an SSE comment into a
// JSON body would corrupt it, so a readable, wrong content type must stop it.
test("a response whose content-type is readable and NOT an event stream is left alone", async () => {
  const { res, written } = fakeRes({ getHeader: () => "application/json" });
  const stop = startSseKeepalive(res, 10);
  await tick(40);
  stop();
  assert.deepEqual(written, [], "JSON replies must be left alone");
});

/**
 * The guard must FAIL OPEN when the content type cannot be read.
 *
 * This is not hypothetical: the MCP SDK sets the SSE content type by passing it
 * straight to `res.writeHead(200, {...})`, and Node does not expose headers set
 * that way — `getHeader()` returns undefined and `getHeaders()` returns `{}`.
 * A first cut of this keepalive required `content-type` to match, so on the
 * real transport it never wrote a single byte. It passed its unit tests (whose
 * fake response returned a content type) and was verified inert only against a
 * live stream: 75s, zero comments, and the 5-minute churn continuing underneath
 * (9 reclaims by 344s of gateway uptime).
 */
test("an unreadable content-type still gets keepalives (the real SDK response shape)", async () => {
  const { res, written } = fakeRes({ getHeader: () => undefined });
  const stop = startSseKeepalive(res, 10);
  await tick(45);
  stop();
  assert.ok(
    written.length >= 2,
    `writeHead-set headers are invisible to getHeader(); the keepalive must still fire (got ${written.length})`,
  );
});

test("a response that has not sent headers, or has ended, is never written to", async () => {
  for (const state of [{ headersSent: false }, { writableEnded: true }, { writable: false }]) {
    const { res, written } = fakeRes(state);
    const stop = startSseKeepalive(res, 10);
    await tick(40);
    stop();
    assert.deepEqual(written, [], `must not write when ${JSON.stringify(state)}`);
  }
});

test("the keepalive period beats the 300s body timeout with room to spare", async () => {
  // The default is what actually protects a live session; a regression to
  // anything near 300s would quietly restore the churn.
  const { res, written } = fakeRes();
  const stop = startSseKeepalive(res); // default period
  await tick(50);
  stop();
  assert.deepEqual(written, [], "the default must not fire within 50ms (i.e. it is not tiny)");

  // Read the default off the module's own behaviour rather than duplicating the
  // number: 30s leaves a 10x margin under undici's 300s.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8"),
  );
  const ms = Number(/SSE_KEEPALIVE_MS\s*=\s*([0-9_]+)/.exec(src)?.[1].replace(/_/g, ""));
  assert.ok(Number.isFinite(ms), "the keepalive period is a readable constant");
  assert.ok(ms > 0 && ms <= 60_000, `keepalive ${ms}ms must stay well under the 300000ms timeout`);
});
