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

// Lazy provisioning (issue #63) makes a connected session that has never made a
// browser tool call hold no container — so it would fall off a table built from
// the fleet listing alone. The old failure was these sessions eating every slot
// invisibly; the new risk is the opposite, that they cannot be seen at all.
test("connected sessions holding no fleet slot are listed, and the count is explicit", async () => {
  const reg = new Registry();
  const now = Date.now();
  reg.streamOpened("inst-working", now - 60_000);
  reg.touchBrowserActivity("inst-working", now - 60_000);
  // Connected, never browsed: no container exists for this name.
  reg.add({ name: "inst-justconnected", handle: undefined } as never);
  reg.streamOpened("inst-justconnected", now - 3600_000);
  reg.touch("inst-justconnected", now - 30_000);

  const html = await renderDashboard(fakeProvisioner(["inst-working"]) as never, reg);

  assert.match(html, /inst-justconnected/, "the browser-less session has a row");
  assert.match(html, /no browser/, "and is marked as holding no browser");
  assert.match(html, /holds no fleet slot/, "with what that means spelled out");
  assert.match(
    html,
    new RegExp(`slots in use: <strong>1/${config.maxFleet}</strong>`),
    "real fleet usage is a number, not an inference from row count",
  );
});

// Slot accounting is derived from the fleet listing, so a Docker outage used to
// turn "we cannot see the fleet" into a confident `0/8` with every live session
// rendered as holding no slot — the most wrong the page can be, stated in the
// most precise-looking way, exactly when an operator is debugging a saturated
// fleet.
test("a fleet listing failure reads as unknown, not as an empty fleet", async () => {
  const reg = new Registry();
  reg.add({ name: "inst-working", handle: undefined } as never);
  reg.streamOpened("inst-working");
  const broken = {
    listFleet: async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    },
    sandboxStatus: async () => "unknown" as const,
  };

  const html = await renderDashboard(broken as never, reg);

  assert.match(html, /Could not list fleet/, "the error banner is still shown");
  assert.match(html, /slots in use: <strong>unknown/, "the slot count is not a confident 0/N");
  assert.ok(!/holds no fleet slot/.test(html), "no session is claimed to hold no slot");
  assert.ok(!/No browsers provisioned yet/.test(html), "and the empty state is not asserted either");
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

// --- the #81 redesign's invariants ------------------------------------------

// Browserless sessions used to be rows in the fleet table, described almost
// entirely in em-dashes. On a real host they outnumber the browsers several to
// one, so the rows that actually hold a slot — the reason the page exists — were
// pushed off the top of it. They now have their own table; what must stay true
// is that a name with no container never appears among the browsers.
test("a session with no container is not listed among the browsers", async () => {
  const reg = new Registry();
  reg.add({ name: "inst-justconnected", handle: undefined } as never);
  reg.streamOpened("inst-justconnected");

  const html = await renderDashboard(fakeProvisioner(["inst-real"]) as never, reg);
  const browsers = html.slice(html.indexOf("<h2>browsers"), html.indexOf("<h2>connected"));

  assert.ok(browsers.includes("inst-real"), "the container is in the browsers table");
  assert.ok(!browsers.includes("inst-justconnected"), "the browserless session is not");
  assert.match(html, /inst-justconnected/, "but it is still on the page");
});

// The live view re-renders by fetching this same URL and swapping `#live` for the
// fresh one. Two things make that work, and neither is visible from reading a
// single element: exactly one `#live` must exist (or the swap targets the wrong
// node), and the control the script binds its listeners to must live OUTSIDE it
// (or the first swap orphans them and the page silently stops updating).
test("the live-refresh region is unique, and the control it rebinds sits outside it", async () => {
  const html = await renderDashboard(fakeProvisioner(["inst-1"]) as never, new Registry());

  assert.equal(html.match(/id="live"/g)?.length, 1, "exactly one swap target");
  const live = html.slice(html.indexOf('id="live"'), html.indexOf("</main>"));
  for (const id of ["refresh", "refresh-toggle", "refresh-status"]) {
    assert.match(html, new RegExp(`id="${id}"`), `the control has #${id}`);
    assert.ok(!live.includes(`id="${id}"`), `#${id} survives a swap of #live`);
  }
});

// A duration column that reads `28800s` does not make an eight-hour gap obvious,
// which is the whole point of `browser idle`. It humanizes — but the seconds are
// the unit ATTACHED_IDLE_TTL_SEC is set in, so they must stay somewhere exact.
test("long durations humanize without losing the exact seconds", async () => {
  const reg = new Registry();
  const now = Date.now();
  reg.streamOpened("inst-old", now - 8 * 3600_000);
  reg.touch("inst-old", now - 20_000);

  const html = await renderDashboard(fakeProvisioner(["inst-old"]) as never, reg);

  assert.match(html, />8h \d+m</, "eight hours reads as eight hours");
  assert.match(html, /title="288\d\ds"/, "with the exact seconds still on the cell");
  assert.match(html, />2\ds<\/td>/, "and a fresh clock stays in raw seconds");
});
