import test from "node:test";
import assert from "node:assert/strict";
import { startDockerStub, type StubContainer } from "./docker-stub.js";

// The stub is infrastructure every other volume test trusts, so its own wire
// contract is asserted here — through real dockerode, never by reading its
// in-memory arrays, which would be the fake certifying itself.
//
// `all` is the reason this file exists. Without it real Docker lists only
// containers whose Running flag is true — State running, paused or restarting;
// moby's List excludes exactly !Running — and listFleet, gcExited and the
// orphan sweep all pass all:true because a STOPPED container still holds a
// fleet slot (the "fleet is full" lockup). A stub that ignored the flag would
// keep passing a test whose production code had dropped it.

function fleet(): StubContainer[] {
  return [
    {
      Id: "aaa",
      Names: ["/chikin-chrome-inst-1"],
      State: "running",
      Labels: { "chikin.fleet": "1", "chikin.name": "inst-1" },
    },
    {
      Id: "bbb",
      Names: ["/chikin-chrome-inst-2"],
      State: "exited",
      Labels: { "chikin.fleet": "1", "chikin.name": "inst-2" },
    },
    { Id: "ccc", Names: ["/app-db"], State: "running", Labels: { app: "db" } },
  ];
}

const ids = (cs: { Id: string }[]) => cs.map((c) => c.Id).sort();

test("the container list omits stopped containers without `all`", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  assert.deepEqual(ids(await stub.docker.listContainers()), ["aaa", "ccc"]);
});

test("`all: true` is what makes a stopped container visible", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  assert.deepEqual(ids(await stub.docker.listContainers({ all: true })), ["aaa", "bbb", "ccc"]);
});

test("paused and restarting containers are Running, so they list without `all`", async (t) => {
  const stub = await startDockerStub({
    containers: [
      ...fleet(),
      { Id: "ddd", Names: ["/chikin-chrome-inst-3"], State: "paused", Labels: {} },
      { Id: "eee", Names: ["/chikin-chrome-inst-4"], State: "restarting", Labels: {} },
    ],
  });
  t.after(() => stub.close());

  // The daemon's no-`all` cut is the Running flag, which pause and restart
  // both keep set (a crash-looping container shows in plain `docker ps` and
  // still holds a fleet slot) — State === "running" would be a stub-side
  // fiction the fleet has no counterpart for.
  assert.deepEqual(ids(await stub.docker.listContainers()), ["aaa", "ccc", "ddd", "eee"]);
});

test("a label filter selects the fleet, by bare key and by key=value", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  // The shape the provisioner actually sends (listFleet).
  const byValue = await stub.docker.listContainers({
    all: true,
    filters: { label: ["chikin.fleet=1"] },
  });
  assert.deepEqual(ids(byValue), ["aaa", "bbb"], "app-db is not fleet");

  const byKey = await stub.docker.listContainers({ all: true, filters: { label: ["app"] } });
  assert.deepEqual(ids(byKey), ["ccc"]);

  // The filter composes with `all` rather than overriding it.
  const running = await stub.docker.listContainers({ filters: { label: ["chikin.fleet=1"] } });
  assert.deepEqual(ids(running), ["aaa"]);
});

test("the map-form filter encoding Docker also accepts is served, not crashed on", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  // Docker's API takes filters as {"label":["k=v"]} AND as the map form
  // {"label":{"k=v":true}}; a raw client may send either. The map form used to
  // throw inside the server callback — an uncaught exception that killed the
  // whole test run rather than failing the request.
  const filters = encodeURIComponent(JSON.stringify({ label: { "chikin.fleet=1": true } }));
  const r = await fetch(`${stub.url}/containers/json?all=1&filters=${filters}`);
  assert.equal(r.status, 200);
  assert.deepEqual(ids((await r.json()) as { Id: string }[]), ["aaa", "bbb"]);
});

test("malformed filters and bodies are a 400, never an uncaught exception", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  // JSON.parse accepts every one of these; dereferencing them is what used to
  // kill the process.
  for (const bad of ["null", "[]", '"label"']) {
    const r = await fetch(`${stub.url}/containers/json?filters=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `filters=${bad} must fail the request, not the process`);
  }
  const scalar = encodeURIComponent(JSON.stringify({ label: "chikin.fleet=1" }));
  const r = await fetch(`${stub.url}/containers/json?filters=${scalar}`);
  assert.equal(r.status, 400, "a scalar filter value is malformed, not a crash");

  // An array with a non-string element must not slip into the map-form branch
  // (an array is an object, and Object.keys would serve its indexes as values).
  const mixed = encodeURIComponent(JSON.stringify({ label: ["chikin.fleet=1", 42] }));
  const m = await fetch(`${stub.url}/containers/json?filters=${mixed}`);
  assert.equal(m.status, 400, "a mixed-type array filter is malformed, not index junk");

  for (const body of ["null", "[]", "not json"]) {
    const created = await fetch(`${stub.url}/volumes/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(created.status, 400, `body=${body} must fail the request, not the process`);
  }
});

test("an unmodelled query param is a 501 naming it, never a silent ignore", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  await assert.rejects(
    () => stub.docker.listContainers({ all: true, size: true }),
    /unmodelled query param 'size'/,
  );
  await assert.rejects(() => stub.docker.listVolumes({ filters: { dangling: ["true"] } }), {
    message: /unmodelled query param 'filters'/,
    statusCode: 501,
  });

  // dockerode drops opts on a volume remove (its path template carries no `?`),
  // so `force` — which turns real Docker's 404 into a 204 — can only be put on
  // the wire directly. It must still be refused rather than served as a plain
  // remove.
  const forced = await fetch(`${stub.url}/volumes/chikin-profile-inst-1?force=true`, {
    method: "DELETE",
  });
  assert.equal(forced.status, 501);
  assert.match((await forced.json()).message, /unmodelled query param 'force'/);
});

test("an unmodelled filter key is a 501 naming it", async (t) => {
  const stub = await startDockerStub({ containers: fleet() });
  t.after(() => stub.close());

  await assert.rejects(
    () => stub.docker.listContainers({ all: true, filters: { status: ["exited"] } }),
    /unmodelled filter 'status'/,
  );
});

test("volumes round-trip through create, inspect and list", async (t) => {
  const stub = await startDockerStub({ volumes: ["chikin-profile-golden"] });
  t.after(() => stub.close());

  await stub.docker.createVolume({
    Name: "chikin-profile-inst-1",
    Labels: { "chikin.fleet": "1", "chikin.role": "instance" },
  });

  const inspected = await stub.docker.getVolume("chikin-profile-inst-1").inspect();
  assert.equal(inspected.Labels["chikin.role"], "instance");

  const listed = (await stub.docker.listVolumes()) as { Volumes: { Name: string }[] };
  assert.deepEqual(
    listed.Volumes.map((v) => v.Name).sort(),
    ["chikin-profile-golden", "chikin-profile-inst-1"],
  );
});

test("create on an existing name returns the stored volume, labels untouched", async (t) => {
  const stub = await startDockerStub();
  t.after(() => stub.close());

  await stub.docker.createVolume({
    Name: "chikin-profile-alice",
    Labels: { "chikin.role": "profile" },
  });
  // The daemon short-circuits on the name: a second create succeeds but its
  // labels are never applied — volume labels are immutable after creation,
  // which is the exact drift class issue #59 is about. A stub that overwrote
  // here would certify a test that relies on relabelling-by-recreate.
  await stub.docker.createVolume({
    Name: "chikin-profile-alice",
    Labels: { "chikin.role": "instance" },
  });

  const inspected = await stub.docker.getVolume("chikin-profile-alice").inspect();
  assert.equal(inspected.Labels["chikin.role"], "profile", "the first create's labels stand");
});

test("an unhandled endpoint is a 501 naming it, so a test cannot wander off", async (t) => {
  const stub = await startDockerStub();
  t.after(() => stub.close());

  await assert.rejects(() => stub.docker.listImages(), /unhandled GET \/images\/json/);
});
