import test from "node:test";
import assert from "node:assert/strict";
import { Provisioner } from "../src/provisioner.js";
import { config, containerName } from "../src/config.js";

// Image rotation on cold attach (issue #57, option 4 in its non-disruptive
// form). `ensureContainer` used to reuse a running container without ever
// comparing its image to the current one, so a browser that outlived an image
// upgrade kept its original hardening posture forever — the reporter's 30-hour
// instance whose `sandbox` column read `—` while every other row read
// `sandboxed`. A stale container is now recreated, but ONLY when no client
// stream is attached: nobody is evicted to fix an image problem, and there is
// deliberately no blunt max-age cap that would do exactly that.

const CURRENT = "sha256:current";
const OLD = "sha256:old";

function fakeDocker(opts: { containerImage: string | null; currentImage?: string | null }) {
  const ops: string[] = [];
  // Mutable container state so a recreate is observable.
  let image = opts.containerImage;
  const cname = containerName("inst-88175");

  const docker = {
    getContainer: (n: string) => ({
      inspect: async () => {
        if (n !== cname || image === null) throw new Error("no such container");
        return {
          Image: image,
          State: { Running: true },
          NetworkSettings: { Networks: { [config.network]: { IPAddress: "10.0.0.5" } } },
        };
      },
      start: async () => void ops.push(`start-existing:${n}`),
      stop: async () => void ops.push(`stop:${n}`),
      remove: async () => {
        ops.push(`rm-container:${n}`);
        image = null;
      },
    }),
    getImage: (n: string) => ({
      inspect: async () => {
        if (opts.currentImage === null) throw new Error(`no such image: ${n}`);
        return { Id: opts.currentImage ?? CURRENT };
      },
    }),
    getVolume: () => ({ inspect: async () => ({}) }), // volume already exists
    createContainer: async () => {
      ops.push("create");
      image = opts.currentImage ?? CURRENT;
      return { id: "cid-new", start: async () => void ops.push("start-new") };
    },
    getNetwork: () => ({ connect: async () => void ops.push("attach-egress") }),
    listContainers: async () => [],
  };
  return { docker, ops };
}

/** waitHealthy polls a real CDP endpoint; shadow it so tests stay hermetic. */
function provisioner(docker: unknown): Provisioner {
  const p = new Provisioner(docker as never);
  (p as unknown as { waitHealthy: () => Promise<void> }).waitHealthy = async () => {};
  return p;
}

test("a running container on a stale image is recreated when nothing is attached", async () => {
  const { docker, ops } = fakeDocker({ containerImage: OLD });
  const ip = await provisioner(docker).ensureContainer("inst-88175", {
    canRotateImage: () => true, // cold attach: no client stream
  });

  assert.equal(ip, "10.0.0.5");
  // Stopped and removed before the recreate, so the old container is never
  // holding the name (or the fleet slot) while the new one is created.
  assert.deepEqual(ops, [
    `stop:${containerName("inst-88175")}`,
    `rm-container:${containerName("inst-88175")}`,
    "create",
    "attach-egress",
    "start-new",
  ]);
});

test("a stale image is NOT rotated while a client stream is attached", async () => {
  const { docker, ops } = fakeDocker({ containerImage: OLD });
  await provisioner(docker).ensureContainer("inst-88175", {
    canRotateImage: () => false, // a live session is using this browser
  });
  assert.deepEqual(ops, [], "nobody is evicted to fix an image problem");
});

test("rotation is re-checked inside the create gate (a stream may attach meanwhile)", async () => {
  const { docker, ops } = fakeDocker({ containerImage: OLD });
  // True for the pre-gate check, false by the time the gate is entered —
  // everything before it is awaited, so this really can happen.
  let calls = 0;
  await provisioner(docker).ensureContainer("inst-88175", {
    canRotateImage: () => ++calls === 1,
  });
  assert.deepEqual(ops, [], "the rotation stands down rather than tearing down a live session");
});

test("a container already on the current image is reused, not recreated", async () => {
  const { docker, ops } = fakeDocker({ containerImage: CURRENT });
  await provisioner(docker).ensureContainer("inst-88175", { canRotateImage: () => true });
  assert.deepEqual(ops, [], "no churn when the image already matches");
});

test("rotation is opt-in: without the predicate, behaviour is exactly as before", async () => {
  const { docker, ops } = fakeDocker({ containerImage: OLD });
  await provisioner(docker).ensureContainer("inst-88175");
  assert.deepEqual(ops, []);
});

test("an unresolvable current image fails safe (no recreate on a Docker hiccup)", async () => {
  const { docker, ops } = fakeDocker({ containerImage: OLD, currentImage: null });
  await provisioner(docker).ensureContainer("inst-88175", { canRotateImage: () => true });
  assert.deepEqual(ops, [], "a proxy error must never cascade into recreating containers");
});

test("rotation frees and re-claims its slot inside ONE create-gate hold (CHK-010)", async () => {
  // The removal frees a fleet slot; re-claiming it outside the gate is exactly
  // the MAX_FLEET TOCTOU #27 closed. Both halves must therefore run in the same
  // critical section, with no other provision interleaved between them.
  const ops: string[] = [];
  // Which containers exist right now, and on what image. "stale" is running an
  // old image; "fresh" is a brand-new name that has to pass the cap check.
  const images = new Map<string, string>([[containerName("stale"), OLD]]);
  const who = (n: string) => (n.includes("stale") ? "stale" : "fresh");
  const docker = {
    getContainer: (n: string) => ({
      inspect: async () => {
        const img = images.get(n);
        if (!img) throw new Error("no such container");
        return {
          Image: img,
          State: { Running: true },
          NetworkSettings: { Networks: { [config.network]: { IPAddress: "10.0.0.5" } } },
        };
      },
      start: async () => {},
      stop: async () => void ops.push(`stop:${who(n)}`),
      remove: async () => {
        ops.push(`rm:${who(n)}`);
        images.delete(n);
        await new Promise((r) => setTimeout(r, 5)); // a real docker rm is slow
      },
    }),
    getImage: () => ({ inspect: async () => ({ Id: CURRENT }) }),
    getVolume: () => ({ inspect: async () => ({}) }),
    createContainer: async (o: { _query?: { name?: string } }) => {
      const name = o?._query?.name ?? "";
      ops.push(`create:${who(name)}`);
      images.set(name, CURRENT);
      return { id: name, start: async () => {} };
    },
    getNetwork: () => ({ connect: async () => {} }),
    listContainers: async () => [],
  };

  const p = provisioner(docker);
  await Promise.all([
    p.ensureContainer("stale", { canRotateImage: () => true }),
    p.ensureContainer("fresh"),
  ]);

  const rm = ops.indexOf("rm:stale");
  const create = ops.indexOf("create:stale");
  assert.ok(rm >= 0 && create > rm, "the stale container is removed then recreated");
  assert.deepEqual(
    ops.slice(rm, create + 1),
    ["rm:stale", "create:stale"],
    "no other provision claims the freed slot in between",
  );
});
