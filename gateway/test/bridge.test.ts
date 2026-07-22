import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyClientFrame,
  identifyRequiredMessage,
  augmentInstructions,
} from "../src/bridge.js";

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

// --- layer 3: the blocked-call error is actionable -------------------------

test("gating error names chikin_identify, the format, and an example", () => {
  const msg = identifyRequiredMessage("navigate_page");
  assert.match(msg, /chikin_identify/);
  assert.match(msg, /navigate_page/, "names the blocked tool");
  assert.match(msg, /1-32 chars/, "states the handle format");
  assert.match(msg, /"handle"/, "shows a worked example");
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
