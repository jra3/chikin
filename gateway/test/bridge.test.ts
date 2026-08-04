import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyClientFrame,
  identifyRequiredMessage,
  augmentInstructions,
  isBrowserWork,
  browserUnavailableMessage,
} from "../src/bridge.js";
import { Registry } from "../src/registry.js";
import { FleetFullError, ProvisionError } from "../src/provisioner.js";

// --- gate: which client frames are blocked before identify -----------------

test("gate: browser tools are blocked until identified, allowed after", () => {
  const nav = { method: "tools/call", params: { name: "navigate_page" } };
  assert.equal(classifyClientFrame(nav, false), "block", "browser tool blocked pre-identify");
  assert.equal(classifyClientFrame(nav, true), "forward", "browser tool passes post-identify");
});

test("gate: chikin_identify and chikin_reset are never gated", () => {
  const identify = { method: "tools/call", params: { name: "chikin_identify" } };
  const reset = { method: "tools/call", params: { name: "chikin_reset" } };
  for (const identified of [false, true]) {
    assert.equal(classifyClientFrame(identify, identified), "identify");
    assert.equal(classifyClientFrame(reset, identified), "reset");
  }
});

test("gate: non-tools/call methods always forward (never gated)", () => {
  for (const method of ["initialize", "tools/list", "ping", "notifications/initialized"]) {
    assert.equal(
      classifyClientFrame({ method }, false),
      "forward",
      `${method} must never be gated`,
    );
  }
});

// --- the browser-activity clock (issue #57) --------------------------------
// The plain idle clock is unusable as an activity signal for an attached
// session: client/bridge.mjs fires a JSON-RPC `ping` every 120s for the stated
// purpose of refreshing it, so it never ages past ~2 minutes however long the
// browser sits on about:blank. isBrowserWork is what the attached-tier reap TTL
// is measured against instead.

test("a heartbeat ping is NOT browser work (this is the whole of issue #57)", () => {
  assert.equal(isBrowserWork({ method: "ping" }, true), false, "the keepalive must not count");
  for (const method of ["initialize", "tools/list", "notifications/initialized"]) {
    assert.equal(isBrowserWork({ method }, true), false, `${method} is protocol, not browser work`);
  }
  assert.equal(isBrowserWork(null, true), false);
  assert.equal(isBrowserWork(undefined, true), false);
});

test("a forwarded tools/call IS browser work; gateway-owned and blocked ones are not", () => {
  const nav = { method: "tools/call", params: { name: "navigate_page" } };
  assert.equal(isBrowserWork(nav, true), true, "a real, forwarded tool call counts");

  // Blocked pre-identify: it never reaches the browser, so it is not activity.
  assert.equal(isBrowserWork(nav, false), false, "an identity-blocked call never reaches Chrome");
  // Gateway-owned tools are answered by the gateway itself, browser untouched.
  for (const name of ["chikin_identify", "chikin_reset"]) {
    for (const identified of [false, true]) {
      assert.equal(
        isBrowserWork({ method: "tools/call", params: { name } }, identified),
        false,
        `${name} is handled by the gateway, not the browser`,
      );
    }
  }
});

test("only browser work moves the browser-activity clock (a ping moves only `last`)", () => {
  const reg = new Registry();
  reg.touch("inst-1", 1000); // record created: both clocks start here

  // A heartbeat ping arrives at t=200000 — the pump calls touch() for any frame.
  reg.touch("inst-1", 200_000);
  let a = reg.getActivity("inst-1")!;
  assert.equal(a.last, 200_000, "protocol traffic refreshes the idle clock");
  assert.equal(a.lastBrowserActivity, 1000, "...but NOT the browser-activity clock");

  // Attaching / detaching an SSE stream is not browser work either: clients
  // routinely reopen that stream while idle between tool calls (server.ts).
  reg.streamOpened("inst-1", 300_000);
  reg.streamClosed("inst-1", 400_000);
  assert.equal(reg.getActivity("inst-1")!.lastBrowserActivity, 1000, "stream churn is not work");

  // A forwarded tools/call moves both.
  reg.touchBrowserActivity("inst-1", 500_000);
  a = reg.getActivity("inst-1")!;
  assert.equal(a.lastBrowserActivity, 500_000);
  assert.equal(a.last, 500_000, "real work is protocol traffic too");
});

// --- layer 3: the blocked-call error is actionable -------------------------

test("gating error names chikin_identify, the format, and an example", () => {
  const msg = identifyRequiredMessage("navigate_page");
  assert.match(msg, /chikin_identify/);
  assert.match(msg, /navigate_page/, "names the blocked tool");
  assert.match(msg, /1-32 chars/, "states the handle format");
  assert.match(msg, /"handle"/, "shows a worked example");
});

// --- lazy provisioning: the fleet-full error is now a TOOL error (issue #63) --
// It used to be an HTTP 429 on the MCP handshake, which took the whole session
// with it — and an MCP client fixes its tool registry at session start, so the
// caller could not get the browser lane back even after a slot freed. Now one
// call fails and the session is intact, so the message has to say so.

test("the fleet-full tool error names the cause, the tool, and that the session survived", () => {
  const msg = browserUnavailableMessage("navigate_page", new FleetFullError(8));
  assert.match(msg, /navigate_page/, "names the tool that failed");
  assert.match(msg, /fleet is full/, "and the real reason");
  assert.match(msg, /still registered/, "tells the caller nothing was lost");
  assert.match(msg, /[Rr]etry/, "and that retrying is the fix");
  assert.match(msg, /dashboard/, "fleet-full is the case the slot accounting explains");
});

// Anything that is NOT fleet-full lands here too — a Docker or socket-proxy
// failure. Sending the model to a page listing who holds the slots explains
// nothing when no slot is the problem, so the guidance has to branch.
test("a non-fleet-full failure gets guidance that actually applies", () => {
  const msg = browserUnavailableMessage("navigate_page", new ProvisionError("docker: 400 Bad request"));
  assert.match(msg, /navigate_page/, "names the tool that failed");
  assert.match(msg, /400 Bad request/, "and the real reason");
  assert.doesNotMatch(msg, /dashboard/, "no slot accounting to send it to");
  assert.match(msg, /Docker/, "names what actually failed");
  // Both branches must still say the session survived and the call is retryable
  // — that sentence is the fix for issue #63's reported impact.
  assert.match(msg, /still registered/, "tells the caller nothing was lost");
  assert.match(msg, /[Rr]etry/, "and that retrying is the fix");
});

// --- layer 1: initialize instructions are augmented, upstream preserved ----

test("augmentInstructions prepends chikin contract, preserving upstream text", () => {
  const result: { instructions?: string } = { instructions: "UPSTREAM DOC" };
  augmentInstructions(result);
  assert.match(result.instructions!, /chikin_identify/, "chikin contract present");
  assert.match(result.instructions!, /UPSTREAM DOC/, "upstream text preserved");
  assert.ok(
    result.instructions!.indexOf("chikin_identify") < result.instructions!.indexOf("UPSTREAM DOC"),
    "chikin text comes first",
  );
});

test("augmentInstructions works with no upstream instructions", () => {
  const result: { instructions?: string } = {};
  augmentInstructions(result);
  assert.match(result.instructions!, /chikin_identify/);
});
