import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.js";
import { Session } from "../src/session.js";

const noopTransport = { close: async () => {} } as never;

function fakeSession(name: string, reg: Registry): Session {
  return new Session(name, noopTransport, noopTransport, (s) => reg.remove(s));
}

test("reserve enforces single in-flight provision", () => {
  const r = new Registry();
  assert.equal(r.reserve("alice"), true);
  assert.equal(r.reserve("alice"), false, "second reserve must fail");
  r.release("alice");
  assert.equal(r.reserve("alice"), true, "released name is reusable");
});

test("a live session blocks a new reserve for the same name", () => {
  const r = new Registry();
  r.reserve("alice");
  const s = fakeSession("alice", r);
  r.add(s);
  assert.equal(r.getByName("alice"), s);
  assert.equal(r.reserve("alice"), false, "live session must block reserve");
});

// CHK-015: the reaper calls off a profile-volume removal while a provision is in
// flight. Since issue #63 that is no longer the reserve/add window — the
// container is created on the first browser tool call, with the session long
// since live — so the mark has to cover the lazy attach and respawn paths too,
// or a sweep can delete a freshly seeded volume out from under them.
test("a provision on a live session still reads as pending (CHK-015)", () => {
  const r = new Registry();
  r.reserve("inst-9");
  r.add(fakeSession("inst-9", r));
  assert.equal(r.isPending("inst-9"), false, "add() ended the reservation");

  r.markProvisioning("inst-9");
  assert.equal(r.isPending("inst-9"), true, "a lazy attach is a provision in flight");
  r.markProvisioning("inst-9"); // a respawn overlapping the attach
  r.clearProvisioning("inst-9");
  assert.equal(r.isPending("inst-9"), true, "overlapping provisions are counted, not a boolean");
  r.clearProvisioning("inst-9");
  assert.equal(r.isPending("inst-9"), false, "and the name is reapable again once both finish");
  r.clearProvisioning("inst-9"); // unbalanced clear must not go negative
  assert.equal(r.isPending("inst-9"), false);
});

test("session id binding and removal; name reusable but activity persists", () => {
  const r = new Registry();
  r.reserve("bob", 100);
  const s = fakeSession("bob", r);
  r.add(s);
  s.sessionId = "sid-1";
  r.bindSessionId("sid-1", s);
  assert.equal(r.getBySessionId("sid-1"), s);

  r.remove(s, 200);
  assert.equal(r.getByName("bob"), undefined, "session routing cleared");
  assert.equal(r.getBySessionId("sid-1"), undefined);
  assert.equal(r.reserve("bob"), true, "name reusable after clean close");
  // activity record survives session removal (so reaper can stop the container)
  assert.ok(r.getActivity("bob"), "activity persists after remove");
});

test("claimHandle enforces uniqueness across live sessions; frees on remove", () => {
  const r = new Registry();
  r.reserve("alice");
  const a = fakeSession("alice", r);
  r.add(a);
  r.reserve("bob");
  const b = fakeSession("bob", r);
  r.add(b);

  assert.equal(r.claimHandle("login-fix", a), true, "first claim wins");
  assert.equal(a.handle, "login-fix", "claim sets the session field");
  assert.equal(r.getByHandle("login-fix"), a);
  assert.equal(r.claimHandle("login-fix", b), false, "another live session is rejected");
  assert.equal(r.claimHandle("login-fix", a), true, "same session re-claim is idempotent");

  // Re-identify frees the old handle.
  assert.equal(r.claimHandle("other-work", a), true);
  assert.equal(r.getByHandle("login-fix"), undefined, "old handle freed on re-identify");
  assert.equal(r.getByHandle("other-work"), a);
  // Now bob may take the freed handle.
  assert.equal(r.claimHandle("login-fix", b), true, "freed handle reusable by another session");

  // Removing a session frees its handle for reuse.
  r.remove(a);
  assert.equal(r.getByHandle("other-work"), undefined, "handle freed when session removed");
});

test("every activity record has a browser-activity clock from the moment it exists", () => {
  const r = new Registry();
  // Both ways a record can be born: a frame/adoption stamp, and a reservation.
  r.touch("adopted", 4242);
  assert.equal(r.getActivity("adopted")?.lastBrowserActivity, 4242, "seeded at creation");
  r.reserve("provisioning", 99);
  assert.equal(r.getActivity("provisioning")?.lastBrowserActivity, 99);
  // A browser that has never run a tool call therefore ages from when it
  // appeared, rather than looking infinitely busy or infinitely stale.
  r.streamOpened("fresh", 7);
  assert.equal(r.getActivity("fresh")?.lastBrowserActivity, 7);
});

test("stream open/close tracking", () => {
  const r = new Registry();
  r.touch("x", 0);
  assert.equal(r.getActivity("x")?.streams, 0);
  r.streamOpened("x", 1);
  assert.equal(r.getActivity("x")?.streams, 1);
  r.streamOpened("x", 2);
  assert.equal(r.getActivity("x")?.streams, 2);
  r.streamClosed("x", 3);
  assert.equal(r.getActivity("x")?.streams, 1);
  assert.equal(r.getActivity("x")?.last, 3, "close stamps activity");
});

// --- canary counters for the wedge watchdog (#73) --------------------------
// Two numbers, not one, because the informative state is the GAP between them:
// strikes without respawns means the detector is firing on something that is
// not a wedge — the shape of both false-positive classes fixed in #72.

test("strikes and respawns are counted separately", () => {
  const reg = new Registry();
  reg.touch("inst-1", 1000);

  reg.noteNavStrike("inst-1");
  reg.noteNavStrike("inst-1");
  let a = reg.getActivity("inst-1")!;
  assert.equal(a.navStrikes, 2, "suspicions accumulate");
  assert.equal(a.childRespawns, 0, "a strike is not an action");

  reg.noteChildRespawn("inst-1");
  a = reg.getActivity("inst-1")!;
  assert.equal(a.navStrikes, 2, "respawning does not consume the strike history");
  assert.equal(a.childRespawns, 1);
});

test("a new activity record starts both counters at zero, not undefined", () => {
  const reg = new Registry();
  reg.touch("inst-1", 1000);
  const a = reg.getActivity("inst-1")!;
  assert.equal(a.navStrikes, 0);
  assert.equal(a.childRespawns, 0);
  assert.equal(a.chromeVersion, undefined, "unknown until the browser is attached");
});

// Every entry point that can create the record must produce a complete one, or
// a counter bump on a session that only ever opened a stream would throw.
test("counters survive a record created by any entry point", () => {
  for (const seed of [
    (r: Registry) => r.streamOpened("inst-1", 1000),
    (r: Registry) => r.touchBrowserActivity("inst-1", 1000),
    (r: Registry) => r.noteNavStrike("inst-1", 1000),
    (r: Registry) => r.noteChildRespawn("inst-1", 1000),
    (r: Registry) => r.setChromeVersion("inst-1", "Chrome/150.0.7871.181", 1000),
  ]) {
    const reg = new Registry();
    seed(reg);
    reg.noteNavStrike("inst-1");
    const a = reg.getActivity("inst-1")!;
    assert.equal(typeof a.navStrikes, "number", "record is complete however it was created");
    assert.ok(a.navStrikes >= 1);
    assert.equal(typeof a.childRespawns, "number");
  }
});

// A container can be recreated from a floating image tag under a live name, so
// a version we can no longer read must not survive as the answer for the one
// we now have: "unknown" is honest, the previous browser's version is not.
test("an unreadable Chrome clears the cached version instead of keeping it", () => {
  const reg = new Registry();
  reg.setChromeVersion("inst-1", "Chrome/147.0.7727.101", 1000);
  assert.equal(reg.getActivity("inst-1")?.chromeVersion, "Chrome/147.0.7727.101");

  reg.setChromeVersion("inst-1", null);
  assert.equal(reg.getActivity("inst-1")?.chromeVersion, undefined, "stale version is forgotten");
  assert.equal(reg.canarySummary().chromeVersions.length, 0, "and drops out of the rollup");

  reg.setChromeVersion("inst-1", "Chrome/150.0.7871.181");
  assert.equal(reg.getActivity("inst-1")?.chromeVersion, "Chrome/150.0.7871.181");
});

test("the /healthz rollup sums the fleet and reports Chrome as a set", () => {
  const reg = new Registry();
  reg.touch("inst-1", 1000);
  reg.touch("inst-2", 1000);
  reg.noteNavStrike("inst-1");
  reg.noteNavStrike("inst-2");
  reg.noteChildRespawn("inst-2");
  reg.setChromeVersion("inst-1", "Chrome/150.0.7871.181");
  reg.setChromeVersion("inst-2", "Chrome/150.0.7871.181");

  let s = reg.canarySummary();
  assert.equal(s.navStrikes, 2);
  assert.equal(s.childRespawns, 1);
  assert.deepEqual(s.chromeVersions, ["Chrome/150.0.7871.181"], "one version reported once");

  // A rotated image under a long-lived container: mixed Chrome across the
  // fleet is worth seeing when reading strike counts, so it is a SET not a scalar.
  reg.setChromeVersion("inst-2", "Chrome/151.0.0.0");
  s = reg.canarySummary();
  assert.deepEqual(s.chromeVersions, ["Chrome/150.0.7871.181", "Chrome/151.0.0.0"]);
});

test("an empty fleet rolls up to zeroes, not to nothing", () => {
  const s = new Registry().canarySummary();
  assert.deepEqual(s, { navStrikes: 0, childRespawns: 0, chromeVersions: [] });
});
