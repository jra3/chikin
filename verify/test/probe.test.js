import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretProbe } from "../probe.js";

const goodRaw = {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  webdriver: undefined,
  pluginsLength: 3,
  languages: ["en-US", "en"],
  hasWindowChrome: true,
  hasWindowChromeRuntime: false,
  webglVendor: "Google Inc. (Google)",
  webglRenderer: "ANGLE (Google, SwiftShader Device, SwiftShader driver)",
};

test("all good → all must-pass checks pass", () => {
  const rows = interpretProbe(goodRaw);
  const musts = rows.filter((r) => r.required);
  assert.ok(musts.every((r) => r.status === "pass"), JSON.stringify(rows, null, 2));
});

test("HeadlessChrome in UA → webdriver-relevant UA check fails", () => {
  const rows = interpretProbe({ ...goodRaw, userAgent: goodRaw.userAgent.replace("Chrome/", "HeadlessChrome/") });
  const uaRow = rows.find((r) => r.id === "userAgent");
  assert.equal(uaRow.status, "fail");
});

test("navigator.webdriver === true → fail", () => {
  const rows = interpretProbe({ ...goodRaw, webdriver: true });
  const row = rows.find((r) => r.id === "webdriver");
  assert.equal(row.status, "fail");
});

test("empty plugins → fail", () => {
  const rows = interpretProbe({ ...goodRaw, pluginsLength: 0 });
  const row = rows.find((r) => r.id === "plugins");
  assert.equal(row.status, "fail");
});

test("empty languages → fail", () => {
  const rows = interpretProbe({ ...goodRaw, languages: [] });
  const row = rows.find((r) => r.id === "languages");
  assert.equal(row.status, "fail");
});

test("windowChrome is informational, never required", () => {
  const presentRows = interpretProbe({ ...goodRaw, hasWindowChrome: true });
  const present = presentRows.find((r) => r.id === "windowChrome");
  assert.equal(present.required, false);
  assert.equal(present.status, "info");
  assert.equal(present.value, true);

  const absentRows = interpretProbe({ ...goodRaw, hasWindowChrome: false });
  const absent = absentRows.find((r) => r.id === "windowChrome");
  assert.equal(absent.required, false);
  assert.equal(absent.status, "info");
  assert.equal(absent.value, false);
});

test("window.chrome.runtime is informational, never required", () => {
  const rows = interpretProbe({ ...goodRaw, hasWindowChromeRuntime: false });
  const row = rows.find((r) => r.id === "windowChromeRuntime");
  assert.equal(row.required, false);
  assert.equal(row.status, "info");
});

test("WebGL row is informational, never fails", () => {
  const rows = interpretProbe({ ...goodRaw, webglVendor: "SwiftShader", webglRenderer: "SwiftShader" });
  const row = rows.find((r) => r.id === "webgl");
  assert.equal(row.required, false);
  assert.equal(row.status, "info");
});

test("all rows have the expected shape", () => {
  const rows = interpretProbe(goodRaw);
  for (const r of rows) {
    assert.ok(typeof r.id === "string");
    assert.ok(typeof r.label === "string");
    assert.ok(["pass", "fail", "info"].includes(r.status));
    assert.ok(typeof r.required === "boolean");
    assert.ok("value" in r);
  }
});
