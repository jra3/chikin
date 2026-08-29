import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Control flow must never be decided by matching the PROSE of an error.
 *
 * This rule exists because the gateway shipped the same defect three times
 * (SPY-161). Docker echoes the entity's own name and id back inside its error
 * message, so `/no such volume|404/i` tested against that message matched
 * EVERY failure for a browser named `inst-404` — and browser names are
 * `inst-<pid>`, of which 0.63% of the pid space contains "404". Removal
 * failures went unlogged and profile volumes leaked, deterministically for
 * those names rather than intermittently. `stopContainer` had the same shape
 * with 304.
 *
 * The structured field is `statusCode`; `dockerStatus()` in provisioner.ts
 * reads it. This test is the enforcement of that rule, so nobody has to know
 * the story above to avoid repeating it.
 *
 * It is deliberately a cheap textual check, not a real analysis: it catches
 * the shape the defect actually took (a status-like number in a literal tested
 * against something) and cannot catch every spelling — a regex assigned to a
 * const and tested on another line would slip past. That is an accepted limit,
 * not an oversight; the value is failing loudly at the moment someone writes
 * the obvious version, with the reason attached.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** A 100–599 literal — an HTTP status — anywhere on the line. */
const STATUS_LITERAL = /(?<![\d.])[1-5]\d\d(?![\d.])/;
/** ...being used as a predicate. */
const PREDICATE = /\.(test|includes|match|startsWith|endsWith|indexOf)\s*\(/;

test("no source file branches on the prose of an error (SPY-161)", () => {
  const offenders: string[] = [];

  // Recursive: a guard that silently stops covering a new subdirectory is the
  // same failure mode it exists to prevent.
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" });
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(join(SRC, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const code = line.trim();
      // Comments are where this rule is explained, so they name these codes.
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (!PREDICATE.test(code) || !STATUS_LITERAL.test(code)) return;
      offenders.push(`${file}:${i + 1}: ${code}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "An HTTP status in a string/regex predicate reads as branching on an error " +
      "message. Docker echoes the entity's own name into that message, so this " +
      "silently swallows every failure for a browser whose name contains the " +
      "code. Use dockerStatus(e) from provisioner.ts instead:\n" +
      offenders.join("\n"),
  );
});
