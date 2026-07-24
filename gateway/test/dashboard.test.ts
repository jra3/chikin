import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "../src/dashboard.js";
import { Registry } from "../src/registry.js";
import { config } from "../src/config.js";

// The dashboard's `idle` column is the plain MCP-traffic clock, which the
// client bridge's 120s keepalive ping pins near zero on every attached session
// — which is why a fleet of about:blank browsers all looked busy (issue #57).
// The `browser idle` column is the clock the attached reap TTL actually runs
// on, so "is this session doing anything?" is a number, not an inference.

function fakeProvisioner(names: string[]) {
  return {
    listFleet: async () =>
      names.map((name) => ({ name, containerId: name, state: "running", status: "Up 8 hours" })),
    sandboxStatus: async () => "sandboxed" as const,
  };
}

test("the fleet table shows real browser activity beside the idle counter", async () => {
  const reg = new Registry();
  const now = Date.now();
  // Attached, heartbeat fresh, but no browser tool call for 8 hours: the exact
  // row the reporter could not tell apart from a working session.
  reg.streamOpened("inst-3244808", now - 8 * 3600_000);
  reg.touch("inst-3244808", now - 30_000);

  const html = await renderDashboard(fakeProvisioner(["inst-3244808"]) as never, reg);

  assert.match(html, /<th[^>]*>browser idle<\/th>/, "the column exists");
  // idle ~30s (the ping), browser idle ~28800s (the truth).
  assert.match(html, />3\ds<\/td>/, "idle counter still reported");
  assert.match(html, /288\d\ds/, "browser-idle counter reports the real 8h gap");
  assert.match(html, /class="work-stale"/, "and is flagged once past ATTACHED_IDLE_TTL_SEC");
});

test("a session between tool calls is not flagged as stale", async () => {
  const reg = new Registry();
  const now = Date.now();
  reg.streamOpened("inst-2", now - 8 * 3600_000);
  reg.touchBrowserActivity("inst-2", now - 60_000);

  const html = await renderDashboard(fakeProvisioner(["inst-2"]) as never, reg);
  assert.ok(!html.includes('class="work-stale"'), "recent browser work is not flagged");
});

test("the runtime-config panel surfaces the attached TTL knob", async () => {
  const html = await renderDashboard(fakeProvisioner([]) as never, new Registry());
  assert.match(html, /ATTACHED_IDLE_TTL_SEC/, "the knob an operator retunes is readable");
  assert.match(
    html,
    new RegExp(String(Math.round(config.attachedIdleTtlMs / 1000))),
    "with its effective value from THIS process",
  );
});
