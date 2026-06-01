import test from "node:test";
import assert from "node:assert/strict";
import { isValidName, assertValidName } from "../src/names.js";
import { containerName, volumeName } from "../src/config.js";

test("accepts dns-safe names", () => {
  for (const n of ["alice", "bob", "a", "a1", "my-browser", "x-9", "abc123", "a".repeat(32)]) {
    assert.ok(isValidName(n), `expected valid: ${n}`);
  }
});

test("rejects unsafe names", () => {
  for (const n of [
    "",
    "-a",
    "a-",
    "A",
    "Alice",
    "ab_c",
    "a.b",
    "a b",
    "../x",
    "a/b",
    "a".repeat(33),
    "ünïcode",
  ]) {
    assert.ok(!isValidName(n), `expected invalid: ${n}`);
  }
});

test("assertValidName throws on bad input", () => {
  assert.throws(() => assertValidName("Bad Name"));
  assert.doesNotThrow(() => assertValidName("good-name"));
});

test("derived docker identifiers", () => {
  assert.equal(containerName("alice"), "chikin-chrome-alice");
  assert.equal(volumeName("alice"), "chikin-profile-alice");
});
