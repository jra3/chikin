import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPretty, formatJson } from "../format.js";

const rows = [
  { id: "userAgent", label: "UA ok", status: "pass", required: true, value: "Chrome/124" },
  { id: "webdriver", label: "webdriver", status: "fail", required: true, value: true },
  { id: "webgl", label: "webgl", status: "info", required: false, value: { vendor: "SwiftShader" } },
];

test("formatJson returns parseable JSON with rows", () => {
  const s = formatJson({ rows, sannysoft: null });
  const obj = JSON.parse(s);
  assert.equal(obj.rows.length, 3);
  assert.equal(obj.sannysoft, null);
});

test("formatPretty lists every row with a status marker", () => {
  const s = formatPretty({ rows, sannysoft: null });
  assert.match(s, /PASS/);
  assert.match(s, /FAIL/);
  assert.match(s, /INFO/);
  assert.match(s, /UA ok/);
  assert.match(s, /webdriver/);
  assert.match(s, /webgl/);
});

test("formatPretty summary counts required pass/fail", () => {
  const s = formatPretty({ rows, sannysoft: null });
  assert.match(s, /1\/2 required/);
});

test("formatPretty includes sannysoft section when provided", () => {
  const sanny = [{ label: "Test A", result: "passed" }, { label: "Test B", result: "failed" }];
  const s = formatPretty({ rows, sannysoft: sanny });
  assert.match(s, /sannysoft/i);
  assert.match(s, /Test A/);
  assert.match(s, /Test B/);
});

test("formatPretty omits sannysoft section when null", () => {
  const s = formatPretty({ rows, sannysoft: null });
  assert.doesNotMatch(s, /sannysoft/i);
});
