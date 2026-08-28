# Split the volume lock from the fleet cap; let Docker own volume ownership

One module owns the Profile Volume's whole lifecycle — the disposability rule,
creation, seeding, destruction, and the orphan sweep. It carries a **per-name**
lock spanning the creation of a volume through the mounting of its container.
The **fleet-cap** gate stays where it is: global, in the Provisioner. Destroying
a volume applies the name rule and the unconditional Seed Volume exclusion, then
asks Docker — Docker's refusal to remove a mounted volume *is* the ownership
check, and no path re-implements one.

**This record runs ahead of the code.** The decision is made and lands across
SPY-160 – SPY-166; `gateway/src` does not implement all of it yet. Where a
paragraph below describes something that has not landed, it names the ticket
that lands it, so this file is never read as a description of today's
`provisioner.ts`. The Seed Volume exclusion above is one such: today
`removeInstanceVolume` gates on the name rule alone, and the unconditional
exclusion is SPY-164.

## Why one mutex could not simply move

`createGate` carried two unrelated invariants, and only ever looked like one
because create and destroy lived in the same file.

The **cap** invariant is fleet-wide and container-only: check-and-create must be
atomic, or concurrent provisions of distinct names all pass the cap and overshoot
`MAX_FLEET` (CHK-010). The **seed→mount** invariant is per-name and spans the
seam this refactor introduces: a volume must not be destroyed between the moment
it is seeded and the moment its container mounts it (CHK-015 / issue #32). Carve
the volume module out and the second one straddles the boundary, which is why
"move the gate" has no correct answer.

Splitting them gives each its right granularity. The cap genuinely needs a
fleet-wide lock. The volume invariant never did, so per-name locking also stops
every provision in the fleet serialising behind every other.

Scale matters to the choice. The protected window is `createVolume` → seed copy →
`createContainer`, and the seed copy runs a helper container to completion:
**seconds**, all of it inside the volume module. What crosses the module boundary
is one await hop, **milliseconds**. Losing that race is not a crash — Docker
auto-creates a missing named volume on bind, so the Browser comes up with an
empty profile and the golden login quietly absent.

## Why Docker's refusal, not a mounted-check

`sweepOrphanInstanceVolumes` computed "no container mounts this" from
`listContainers({all: true})`; `removeInstanceVolume` relied on Docker refusing.
Promoting the computed check to every path would dress it as the safety rule. It
is not one: it is TOCTOU — a container can begin mounting between the list and
the remove — while Docker's refusal is atomic and authoritative. The sweep keeps
its container list to report `inUse` and to skip pointless round trips, not as a
safety property.

That makes Docker's 409 load-bearing, so it is asserted at the wire against a
stub Engine API rather than against a hand-written double that models it. The
same exercise found the 404 branch string-matching `/no such volume|404/i` on an
error message that carries the volume's own name — so for a Browser whose pid
contains `404`, every removal failure is silently swallowed. Dockerode exposes
`statusCode` as a number; the branches switch on it (SPY-161 — until then they
still match the message, and `volumes.test.ts` pins the distinction by asserting
which failures warn).

## Considered options

- **Two gates plus a lease** (rejected). Makes the in-flight state first-class and
  queryable, and handles windows that are not lexically scoped. But release is
  discipline: a throw between acquire and release leaks the lease, the volume
  becomes permanently undeletable, and disk leaks until restart — which is issue
  #58's failure mode. Buying safety with a mechanism whose failure is the original
  bug is a bad trade.
- **One shared gate injected into both** (rejected). Preserves today's behaviour
  exactly and adds no failure modes, but keeps the conflation: the guarantee moves
  from the wrong file to the wrong object, and the next module to need it takes it
  too.
- **The volume module owns the birth scope** — `withNewProfile(name, fn)`
  (rejected). The only option a caller cannot get wrong. It pays for that by
  hiding create-and-seed inside a callee and inverting the reading order of the
  most safety-critical path in the codebase, and what it defends structurally is
  the millisecond tail; the seconds-long part was already inside the module.
- **No lock across the seam; verify the volume before binding** (rejected).
  Shrinks exposure from seconds to microseconds and turns a silent wrong profile
  into a loud one, but knowingly keeps a race. CHK-015 exists because a race was
  once judged too small to matter.
- **Per-name lock lent by the volume module (chosen).** `runExclusive(name, fn)`,
  with the create path asserting the lock is held for that name. Scope-based, so
  there is nothing to leak; the assertion closes the only gap a lent lock has, at
  the cost of a set lookup, and a caller who forgets the scope fails on the first
  test run rather than silently in production.

## Consequences

- **The copier is its own module.** Copying between volumes needs a helper
  container, making the Provisioner its natural implementor — but the Provisioner
  also calls the volume module to reclaim, so constructing either first is
  impossible (`ReferenceError: Cannot access 'containers' before initialization`).
  Splitting the copier out yields a DAG: copier ← volumes ← containers.
- **Two locks are held across Docker I/O**, cap gate outside, volume lock inside,
  always in that order.
- **`reclaim` returns the container and volume outcomes separately.** Collapsing
  them loses the fact the Reaper needs to say what it threw away: reclaiming a
  sticky Browser tears down its container while keeping its volume, and a single
  return value cannot report both.
- **`isInstanceVolume` stops existing** (SPY-165). The sweep derives a Name by
  stripping `chikin-profile-` and applies the same rule as every other path,
  leaving one spelling of disposability.
- **The sweep is safe whenever it runs.** It stays at startup, but `index.ts`
  statement ordering stops being load-bearing, and exposing it as a control
  becomes a product decision rather than a risk.
- **Erasing inside a volume is authorised by freshness, not disposability.**
  Sticky profiles are seeded too, so gating the erase on disposability would break
  seeding for every sticky Browser.
