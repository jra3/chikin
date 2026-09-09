import test from "node:test";
import assert from "node:assert/strict";
import { Provisioner } from "../src/provisioner.js";
import { isInstanceName, isInstanceVolume, volumeLabels, volumeName } from "../src/config.js";
import { startDockerStub, type StubContainer } from "./docker-stub.js";
import { withWarnings } from "./log-tap.js";

// Profile-volume lifecycle: issues #58 (reaped browsers leaked their instance
// volumes, 222 orphans / ~47 GB on one host) and #59 (chikin-profile-golden was
// indistinguishable from disposables, so a label-scoped prune ate every saved
// login). The two are one problem: #58's disk pressure is what drives an
// operator to run #59's fatal command.
//
// The load-bearing invariant everywhere below: what makes a volume disposable
// is its NAME (chikin-profile-inst-*), never its label. Docker volume labels are
// immutable after creation, so the chikin.role label this change introduces is
// absent on every volume that already exists on an operator's host — including
// the golden profile we are protecting.

// --- The name rule (issue #59) ---------------------------------------------

test("only inst-* names are disposable; golden/hermes/named profiles are not", () => {
  assert.ok(isInstanceName("inst-18051"), "inst-<pid> is disposable");
  assert.ok(isInstanceName("inst-a"), "any non-empty suffix counts");

  for (const keep of ["golden", "hermes", "alice", "bob", "instance", "inst", "inst-"]) {
    assert.equal(isInstanceName(keep), false, `${keep} must never be treated as disposable`);
  }
});

test("the volume-name rule matches the browser-name rule", () => {
  assert.ok(isInstanceVolume("chikin-profile-inst-18051"));
  for (const keep of [
    "chikin-profile-golden",
    "chikin-profile-hermes",
    "chikin-profile-alice",
    "chikin-profile-inst-", // no suffix -> not a real instance volume
    "chikin-seed",
    "some-other-project-inst-1",
  ]) {
    assert.equal(isInstanceVolume(keep), false, `${keep} must never be a sweep candidate`);
  }
});

// --- The label split (issue #59, direction 1) -------------------------------

test("new instance volumes carry chikin.role=instance; named profiles do not", () => {
  assert.deepEqual(volumeLabels("inst-18051"), {
    "chikin.fleet": "1",
    "chikin.name": "inst-18051",
    "chikin.role": "instance",
  });

  for (const keep of ["golden", "hermes", "alice"]) {
    const labels = volumeLabels(keep);
    assert.equal(labels["chikin.role"], "profile", `${keep} is a keeper, not an instance`);
    assert.notEqual(
      labels["chikin.role"],
      "instance",
      `--filter label=chikin.role=instance must never reach ${keep}`,
    );
    // chikin.fleet stays on everything so the fleet is still one inventory —
    // which is precisely why that label alone is NOT a safe prune scope.
    assert.equal(labels["chikin.fleet"], "1");
  }
});

test("ensureVolume stamps the role label on the volume it creates", async () => {
  const created: { Name?: string; Labels?: Record<string, string> }[] = [];
  const fake = {
    getVolume: () => ({ inspect: async () => { throw new Error("no such volume"); } }),
    createVolume: async (opts: { Name?: string; Labels?: Record<string, string> }) => {
      created.push(opts);
    },
  };
  const p = new Provisioner(fake as never);
  // ensureVolume is private; reach it through the documented seam.
  await (p as unknown as { ensureVolume(n: string): Promise<void> }).ensureVolume("inst-42");
  await (p as unknown as { ensureVolume(n: string): Promise<void> }).ensureVolume("golden");

  assert.equal(created[0]?.Labels?.["chikin.role"], "instance");
  assert.equal(created[1]?.Labels?.["chikin.role"], "profile");
});

// --- Reaper-path volume removal (issue #58) ---------------------------------

// These run against a stub Docker Engine API over real dockerode rather than a
// hand-written object, because what they assert IS Docker's behaviour: a volume
// a container mounts cannot be removed, and that refusal — not a container list
// we compute ourselves — is the ownership rule (ADR 0004). A double that models
// the refusal would be the safety property certifying itself.

test("removeInstanceVolume removes a disposable instance profile", async (t) => {
  const stub = await startDockerStub({ volumes: ["chikin-profile-inst-18051"] });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  assert.equal(await p.removeInstanceVolume("inst-18051"), true);
  assert.deepEqual(stub.requests, ["DELETE /volumes/chikin-profile-inst-18051"]);
  assert.equal(stub.volumes().includes("chikin-profile-inst-18051"), false);
});

test("removeInstanceVolume NEVER touches golden, hermes, or a named profile", async (t) => {
  const keepers = ["golden", "hermes", "alice"];
  const stub = await startDockerStub({ volumes: keepers.map(volumeName) });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  for (const name of keepers) {
    assert.equal(await p.removeInstanceVolume(name), false, `${name} must be refused`);
  }
  // Stronger than "nothing was removed": no request reached Docker at all, so
  // the rule short-circuits rather than relying on the daemon to say no.
  assert.deepEqual(stub.requests, [], "no named profile was even asked about");
  assert.deepEqual(stub.volumes().sort(), keepers.map(volumeName).sort());
});

test("removeInstanceVolume stands down when a provision is in flight (CHK-015)", async (t) => {
  const stub = await startDockerStub({ volumes: ["chikin-profile-inst-7"] });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // The reaper passes () => !registry.isPending(name), re-evaluated inside the
  // provisioner's create gate: a volume must never be deleted out from under a
  // container that is still being created (issue #32).
  let pending = true;
  assert.equal(await p.removeInstanceVolume("inst-7", () => !pending), false);
  assert.deepEqual(stub.requests, [], "mid-provision volume never reached the wire");

  pending = false;
  assert.equal(await p.removeInstanceVolume("inst-7", () => !pending), true);
  assert.deepEqual(stub.volumes(), []);
});

// removeInstanceVolume returns false for EVERY failure — 404, 409, 500,
// transport — so "it returned false" cannot tell the already-gone branch apart
// from any other. The one thing that branch does differently is stay quiet, so
// the warn-or-silence split below (captured through log.ts's tap seam — see
// log-tap.ts) is what makes the branch observable at all. Without these
// assertions, deleting the status branches in provisioner.ts leaves this file
// green.

test("removeInstanceVolume treats an already-gone volume as nothing to do", async (t) => {
  const stub = await startDockerStub({ volumes: [] });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // Real dockerode surfacing a real 404 body, not an invented error string.
  const [removed, warnings] = await withWarnings(() => p.removeInstanceVolume("inst-gone"));

  assert.equal(removed, false);
  assert.deepEqual(stub.requests, ["DELETE /volumes/chikin-profile-inst-gone"]);
  // Silence is the whole behaviour: a volume that is already gone is nothing to
  // do, not something an operator needs to see.
  assert.deepEqual(warnings, [], "already-gone must not read as a failure");
});

test("removeInstanceVolume reports a failure that is NOT already-gone", async (t) => {
  const vol = "chikin-profile-inst-wedged";
  const stub = await startDockerStub({
    // The volume exists and nothing mounts it, so the only reason this fails is
    // the injected one — neither the 404 nor the 409 path can be reached here.
    volumes: [vol],
    removeFailures: { [vol]: { status: 500, message: `remove ${vol}: driver "local" failed` } },
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  const [removed, warnings] = await withWarnings(() => p.removeInstanceVolume("inst-wedged"));

  assert.equal(removed, false);
  assert.deepEqual(stub.requests, [`DELETE /volumes/${vol}`]);
  assert.equal(warnings.length, 1, "a real failure is operator-visible");
  assert.match(warnings[0] ?? "", new RegExp(vol), "the warning names the volume");
  assert.deepEqual(stub.volumes(), [vol], "a failed remove leaves the volume alone");
});

test("removeInstanceVolume leaves a volume a container still mounts (Docker refuses)", async (t) => {
  const stub = await startDockerStub({
    volumes: ["chikin-profile-inst-9"],
    containers: [
      {
        Id: "8f3c1d2e9a7b",
        Names: ["/chikin-chrome-inst-9"],
        State: "running",
        Labels: { "chikin.fleet": "1", "chikin.name": "inst-9" },
        Mounts: [{ Name: "chikin-profile-inst-9" }],
      },
    ],
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // Docker's 409 IS the ownership check — the single-volume path deliberately
  // does not compute "is anything mounting this" for itself (ADR 0004).
  const [removed, warnings] = await withWarnings(() => p.removeInstanceVolume("inst-9"));

  assert.equal(removed, false);
  // It must be Docker refusing, not the name rule declining: the request has to
  // reach the wire and come back 409, or this passes for the wrong reason.
  assert.deepEqual(stub.requests, ["DELETE /volumes/chikin-profile-inst-9"]);
  assert.deepEqual(stub.volumes(), ["chikin-profile-inst-9"], "the mounted volume survives");
  // And the refusal is operator-visible, on its own branch: Docker refusing a
  // mounted volume is the ownership rule working, not a daemon fault, but it
  // still leaves a volume behind so an operator has to be able to find it.
  assert.equal(warnings.length, 1, "Docker's refusal must not be swallowed");
  assert.match(warnings[0] ?? "", /a container still mounts it/, "named as the in-use case");
  assert.match(warnings[0] ?? "", /chikin-profile-inst-9/, "the warning names the volume");
});

// --- A browser whose NAME contains a status code (SPY-161) ------------------

// The defect this pins: the branches used to be decided by matching the error
// MESSAGE against /no such volume|404/i, and Docker echoes the volume's own
// name back inside that message. So for `inst-404` every failure looked like
// an already-gone 404 — no warn, a leaked volume, nothing in the logs, and
// deterministic for that name rather than intermittent. The pair below is the
// same name driven to opposite outcomes, so only a real status can pass both.

test("a real failure on a 404-NAMED browser is reported, not swallowed", async (t) => {
  const vol = "chikin-profile-inst-404";
  const stub = await startDockerStub({
    volumes: [vol],
    removeFailures: { [vol]: { status: 500, message: `remove ${vol}: driver "local" failed` } },
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  const [removed, warnings] = await withWarnings(() => p.removeInstanceVolume("inst-404"));

  assert.equal(removed, false);
  // The 500's message contains "404" only because it names the volume — which
  // is exactly what used to route it into the silent branch.
  assert.equal(warnings.length, 1, "a 500 on inst-404 is a failure like any other");
  assert.match(warnings[0] ?? "", /remove volume .*inst-404 failed/, "reported as a failure");
  assert.deepEqual(stub.volumes(), [vol], "and the volume really did leak, so it must be said");
});

test("an already-gone 404-NAMED browser is still quiet", async (t) => {
  const stub = await startDockerStub({ volumes: [] });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // The other half of the pair: same name, genuine 404 from the daemon. A fix
  // that simply always warned would pass the test above and fail this one.
  const [removed, warnings] = await withWarnings(() => p.removeInstanceVolume("inst-404"));

  assert.equal(removed, false);
  assert.deepEqual(stub.requests, ["DELETE /volumes/chikin-profile-inst-404"]);
  assert.deepEqual(warnings, [], "a real 404 is nothing to do, whatever the name");
});

test("a transport failure is never read as an already-gone volume", async (t) => {
  // Nothing is listening: dockerode throws with NO statusCode at all. The
  // request may never have reached Docker, so the one thing this must not do
  // is fold into the silent already-gone branch.
  const dead = await startDockerStub();
  await dead.close();
  const p = new Provisioner(dead.docker);

  const [removed, warnings] = await withWarnings(() => p.removeInstanceVolume("inst-1"));

  assert.equal(removed, false);
  assert.equal(warnings.length, 1, "a failure with no status is still a failure");
  assert.match(warnings[0] ?? "", /remove volume .*inst-1 failed/);
});

// --- Startup orphan sweep (issue #58, belt and braces) ----------------------

// The sweep computes "no container mounts this" from listContainers({all: true})
// — and `all` is load-bearing: a STOPPED container still mounts its volume, so
// a sweep that saw only running containers would read that volume as orphaned
// and delete a profile out from under it. The stub lists only Running
// containers without the flag, as the real daemon does, so the exited fixture
// plus the wire assertion below is what pins it.

function fleetContainer(id: string, state: string, mounts: string[]): StubContainer {
  return {
    Id: id,
    Names: [`/${id}`],
    State: state,
    Labels: {},
    Mounts: mounts.map((Name) => ({ Name })),
  };
}

test("the sweep reclaims only orphaned inst-* volumes", async (t) => {
  const keepers = [
    "chikin-profile-golden", // the hand-authenticated logins — never a candidate
    "chikin-profile-hermes", // named client profile — never a candidate
    "chikin-profile-alice", // named client profile — never a candidate
    "chikin-seed", // the seed snapshot — never a candidate
    "app_db_data", // someone else's volume entirely
  ];
  const stub = await startDockerStub({
    volumes: [
      ...keepers,
      "chikin-profile-inst-1",
      "chikin-profile-inst-2",
      "chikin-profile-inst-3", // still mounted by a live container
      "chikin-profile-inst-4", // mounted by a STOPPED container — the all:true pin
    ],
    containers: [
      fleetContainer("aaa", "running", ["chikin-profile-inst-3"]),
      fleetContainer("bbb", "exited", ["chikin-profile-inst-4"]),
      fleetContainer("ccc", "running", ["chikin-profile-golden", "app_db_data"]),
    ],
  });
  t.after(() => stub.close());

  const res = await new Provisioner(stub.docker).sweepOrphanInstanceVolumes();

  assert.deepEqual(res.removed, ["chikin-profile-inst-1", "chikin-profile-inst-2"]);
  assert.deepEqual(
    res.inUse,
    ["chikin-profile-inst-3", "chikin-profile-inst-4"],
    "a mounted instance volume is spared — including one held by a stopped container",
  );
  assert.deepEqual(res.failed, []);
  // The wire pin for `all`: a sweep that dropped it would read
  // `GET /containers/json` here — and would have deleted inst-4 above.
  assert.deepEqual(stub.requests, [
    "GET /volumes",
    "GET /containers/json?all=true",
    "DELETE /volumes/chikin-profile-inst-1",
    "DELETE /volumes/chikin-profile-inst-2",
  ]);
  for (const keep of keepers) {
    assert.ok(stub.volumes().includes(keep), `${keep} must survive the sweep`);
  }
});

test("the sweep is a no-op when nothing is orphaned", async (t) => {
  const stub = await startDockerStub({
    volumes: ["chikin-profile-golden", "chikin-profile-hermes", "chikin-profile-inst-9"],
    containers: [fleetContainer("aaa", "running", ["chikin-profile-inst-9"])],
  });
  t.after(() => stub.close());

  const res = await new Provisioner(stub.docker).sweepOrphanInstanceVolumes();

  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(
    stub.requests,
    ["GET /volumes", "GET /containers/json?all=true"],
    "nothing deleted — no DELETE ever reached the wire",
  );
});

test("the sweep never even lists containers when there are no inst-* candidates", async (t) => {
  const stub = await startDockerStub({ volumes: ["chikin-profile-golden"] });
  t.after(() => stub.close());

  const res = await new Provisioner(stub.docker).sweepOrphanInstanceVolumes();

  assert.deepEqual(res.removed, []);
  assert.deepEqual(stub.requests, ["GET /volumes"], "no container list, no deletes");
});

test("the sweep fails closed if container ownership can't be determined", async (t) => {
  const stub = await startDockerStub({
    volumes: ["chikin-profile-inst-1"],
    listContainersFailure: { status: 500, message: "docker proxy unreachable" },
  });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  await assert.rejects(() => p.sweepOrphanInstanceVolumes(), /unreachable|500/);
  assert.deepEqual(
    stub.volumes(),
    ["chikin-profile-inst-1"],
    "unknown ownership never becomes a deletion",
  );
});

test("the sweep tolerates a null volume list and containers with no mounts", async (t) => {
  // `Volumes: null` is a degenerate daemon response the stub deliberately
  // cannot be told to produce, so this half stays on a minimal fake.
  const p = new Provisioner({
    listVolumes: async () => ({ Volumes: null }),
    listContainers: async () => [],
  } as never);
  assert.deepEqual(await p.sweepOrphanInstanceVolumes(), { removed: [], inUse: [], failed: [] });

  const stub = await startDockerStub({
    volumes: ["chikin-profile-inst-1"],
    containers: [{ Id: "aaa", Names: ["/app-db"], State: "running", Labels: {} }], // no Mounts
  });
  t.after(() => stub.close());
  const res = await new Provisioner(stub.docker).sweepOrphanInstanceVolumes();
  assert.deepEqual(res.removed, ["chikin-profile-inst-1"]);
});

test("the sweep reports volumes Docker refuses to remove instead of throwing", async (t) => {
  const vol = "chikin-profile-inst-1";
  const stub = await startDockerStub({
    volumes: [vol],
    removeFailures: { [vol]: { status: 500, message: `remove ${vol}: driver "local" failed` } },
  });
  t.after(() => stub.close());

  const [res, warnings] = await withWarnings(() =>
    new Provisioner(stub.docker).sweepOrphanInstanceVolumes(),
  );

  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.failed, [vol]);
  assert.equal(warnings.length, 1, "a sweep failure is operator-visible");
  assert.match(warnings[0] ?? "", new RegExp(vol), "the warning names the volume");
});
