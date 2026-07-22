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
