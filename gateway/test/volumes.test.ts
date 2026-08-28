import test from "node:test";
import assert from "node:assert/strict";
import { Provisioner } from "../src/provisioner.js";
import { isInstanceName, isInstanceVolume, volumeLabels, volumeName } from "../src/config.js";
import { startDockerStub } from "./docker-stub.js";

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
// from any other. The one thing that branch does differently is stay quiet, and
// log.ts writes straight to process.stderr with no injectable sink, so the tap
// below is what makes the branch observable at all. Without the pair of
// assertions it feeds, deleting the /no such volume|404/i guard in
// provisioner.ts leaves this file green.
async function withWarnings<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const warnings: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = String(chunk);
    if (s.startsWith("[warn] ")) warnings.push(s);
    return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return [await fn(), warnings];
  } finally {
    process.stderr.write = real;
  }
}

test("removeInstanceVolume treats an already-gone volume as nothing to do", async (t) => {
  const stub = await startDockerStub({ volumes: [] });
  t.after(() => stub.close());
  const p = new Provisioner(stub.docker);

  // Real dockerode surfacing a real 404 body, not an invented error string.
  // The name deliberately does NOT contain "404": provisioner.ts decides
  // "already gone" by matching /no such volume|404/i against the error MESSAGE,
  // which embeds the volume name — so a fixture called inst-404 would satisfy
  // that branch whatever Docker actually returned, and prove nothing. Switching
  // this to a status-code check is ticket 2.
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
  assert.equal(await p.removeInstanceVolume("inst-9"), false);
  // It must be Docker refusing, not the name rule declining: the request has to
  // reach the wire and come back 409, or this passes for the wrong reason.
  assert.deepEqual(stub.requests, ["DELETE /volumes/chikin-profile-inst-9"]);
  assert.deepEqual(stub.volumes(), ["chikin-profile-inst-9"], "the mounted volume survives");
});

// --- Startup orphan sweep (issue #58, belt and braces) ----------------------

function sweepFixture(volumes: string[], containerMounts: string[][]) {
  const removed: string[] = [];
  const docker = {
    listVolumes: async () => ({ Volumes: volumes.map((Name) => ({ Name })) }),
    listContainers: async () => containerMounts.map((mounts) => ({
      Mounts: mounts.map((Name) => ({ Name })),
    })),
    getVolume: (name: string) => ({
      remove: async () => void removed.push(name),
    }),
  };
  return { docker, removed };
}

test("the sweep reclaims only orphaned inst-* volumes", async () => {
  const { docker, removed } = sweepFixture(
    [
      "chikin-profile-golden", // the hand-authenticated logins — never a candidate
      "chikin-profile-hermes", // named client profile — never a candidate
      "chikin-profile-alice", // named client profile — never a candidate
      "chikin-seed", // the seed snapshot — never a candidate
      "app_db_data", // someone else's volume entirely
      "chikin-profile-inst-1",
      "chikin-profile-inst-2",
      "chikin-profile-inst-3", // still mounted by a live container
    ],
    [["chikin-profile-inst-3"], ["chikin-profile-golden"], ["app_db_data"]],
  );
  const p = new Provisioner(docker as never);

  const res = await p.sweepOrphanInstanceVolumes();

  assert.deepEqual(res.removed, ["chikin-profile-inst-1", "chikin-profile-inst-2"]);
  assert.deepEqual(res.inUse, ["chikin-profile-inst-3"], "a mounted instance volume is spared");
  assert.deepEqual(res.failed, []);
  assert.deepEqual(removed, ["chikin-profile-inst-1", "chikin-profile-inst-2"]);
  for (const keep of ["chikin-profile-golden", "chikin-profile-hermes", "chikin-profile-alice"]) {
    assert.ok(!removed.includes(keep), `${keep} must survive the sweep`);
  }
});

test("the sweep is a no-op when nothing is orphaned", async () => {
  const { docker, removed } = sweepFixture(
    ["chikin-profile-golden", "chikin-profile-hermes", "chikin-profile-inst-9"],
    [["chikin-profile-inst-9"]],
  );
  const p = new Provisioner(docker as never);

  const res = await p.sweepOrphanInstanceVolumes();

  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(removed, [], "nothing deleted");
});

test("the sweep never even lists containers when there are no inst-* candidates", async () => {
  let listed = false;
  const docker = {
    listVolumes: async () => ({ Volumes: [{ Name: "chikin-profile-golden" }] }),
    listContainers: async () => {
      listed = true;
      return [];
    },
    getVolume: () => ({ remove: async () => assert.fail("must not remove anything") }),
  };
  const res = await new Provisioner(docker as never).sweepOrphanInstanceVolumes();
  assert.deepEqual(res.removed, []);
  assert.equal(listed, false);
});

test("the sweep fails closed if container ownership can't be determined", async () => {
  const removed: string[] = [];
  const docker = {
    listVolumes: async () => ({ Volumes: [{ Name: "chikin-profile-inst-1" }] }),
    listContainers: async () => {
      throw new Error("docker proxy unreachable");
    },
    getVolume: (name: string) => ({ remove: async () => void removed.push(name) }),
  };
  const p = new Provisioner(docker as never);

  await assert.rejects(() => p.sweepOrphanInstanceVolumes(), /unreachable/);
  assert.deepEqual(removed, [], "unknown ownership never becomes a deletion");
});

test("the sweep tolerates a null volume list and volumes with no mounts", async () => {
  const p = new Provisioner({
    listVolumes: async () => ({ Volumes: null }),
    listContainers: async () => [],
  } as never);
  assert.deepEqual(await p.sweepOrphanInstanceVolumes(), { removed: [], inUse: [], failed: [] });

  const { docker } = sweepFixture(["chikin-profile-inst-1"], []);
  const withoutMounts = {
    ...docker,
    listContainers: async () => [{}],
  };
  const res = await new Provisioner(withoutMounts as never).sweepOrphanInstanceVolumes();
  assert.deepEqual(res.removed, ["chikin-profile-inst-1"]);
});

test("the sweep reports volumes Docker refuses to remove instead of throwing", async () => {
  const docker = {
    listVolumes: async () => ({ Volumes: [{ Name: "chikin-profile-inst-1" }] }),
    listContainers: async () => [],
    getVolume: () => ({
      remove: async () => {
        throw new Error("volume is in use");
      },
    }),
  };
  const res = await new Provisioner(docker as never).sweepOrphanInstanceVolumes();
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.failed, ["chikin-profile-inst-1"]);
});
