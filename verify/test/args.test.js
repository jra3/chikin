import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../args.js";

test("defaults when no flags", () => {
  const a = parseArgs([]);
  assert.equal(a.host, "http://localhost:9322");
  assert.equal(a.json, false);
  assert.equal(a.skipSannysoft, false);
});

test("--host overrides default", () => {
  const a = parseArgs(["--host", "http://example.com:9999"]);
  assert.equal(a.host, "http://example.com:9999");
});

test("--json sets json flag", () => {
  const a = parseArgs(["--json"]);
  assert.equal(a.json, true);
});

test("--skip-sannysoft sets skip flag", () => {
  const a = parseArgs(["--skip-sannysoft"]);
  assert.equal(a.skipSannysoft, true);
});

test("all flags together", () => {
  const a = parseArgs(["--host", "http://x:1", "--json", "--skip-sannysoft"]);
  assert.equal(a.host, "http://x:1");
  assert.equal(a.json, true);
  assert.equal(a.skipSannysoft, true);
});

test("unknown flag throws", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/i);
});
