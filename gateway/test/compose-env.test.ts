import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Documented-but-unwired env knobs (issue #62).
 *
 * Compose passes ONLY the vars listed under the gateway service's
 * `environment:` block. A knob that `config.ts` reads and `README.md` /
 * `.env.example` advertise is still completely inert until it has a line
 * there — and the failure is silent: the operator sets it, the gateway keeps
 * its built-in default, and nothing complains. `CHIKIN_VOLUME_GC` (whose
 * default is "delete volumes") lived that way from #60 until it was caught by
 * accident on a deploy, along with all four BROWSER_* resource caps.
 *
 * These tests make the gap loud at build time instead.
 */

// dist/test/*.js -> repo root
const repoRoot = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, repoRoot)), "utf8");

/**
 * Vars that are deliberately NOT container env: compose substitutes them into
 * the file itself (image tags etc.), so they belong in `.env` but must never
 * appear under `environment:`. Anything else documented has to be plumbed.
 */
const SUBSTITUTION_ONLY = new Set(["CHIKIN_VERSION"]);

/** Keys of the gateway service's `environment:` mapping in docker-compose.yml. */
function composeGatewayEnv(): Map<string, string> {
  const lines = read("docker-compose.yml").split("\n");
  const start = lines.findIndex((l) => /^ {2}gateway:\s*$/.test(l));
  assert.ok(start >= 0, "gateway service not found in docker-compose.yml");

  // The service body is everything indented deeper than the service key, up to
  // the next top-level-ish key.
  let inEnv = false;
  const env = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break; // next service / top-level block
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv && /^ {4}\S/.test(line)) break; // next key at service level
    if (!inEnv) continue;
    const m = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (m) env.set(m[1], m[2]);
  }
  assert.ok(env.size > 0, "parsed no environment keys for the gateway service");
  return env;
}

/** Variable names assigned in .env.example (`NAME=` at column 0). */
function envExampleVars(): string[] {
  return read(".env.example")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
    .filter((v): v is string => Boolean(v));
}

/** Variable names in the README "Configuration (fleet)" table's first column. */
function readmeTableVars(): string[] {
  const body = read("README.md");
  const start = body.indexOf("## Configuration (fleet)");
  assert.ok(start >= 0, "README lost its '## Configuration (fleet)' section");
  const section = body.slice(start, body.indexOf("\n### ", start));
  const vars = [...section.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  assert.ok(vars.length > 5, "README config table parsed suspiciously small");
  return vars;
}

test("every var documented in .env.example is passed through docker-compose.yml", () => {
  const env = composeGatewayEnv();
  const missing = envExampleVars().filter((v) => !SUBSTITUTION_ONLY.has(v) && !env.has(v));
  assert.deepEqual(
    missing,
    [],
    `documented in .env.example but not in the gateway 'environment:' block, so setting it does nothing: ${missing.join(", ")}`,
  );
});

test("every var in the README config table is passed through docker-compose.yml", () => {
  const env = composeGatewayEnv();
  const missing = readmeTableVars().filter((v) => !SUBSTITUTION_ONLY.has(v) && !env.has(v));
  assert.deepEqual(
    missing,
    [],
    `documented in README's config table but not in the gateway 'environment:' block: ${missing.join(", ")}`,
  );
});

test("each plumbed knob forwards its own name, not a neighbour's", () => {
  // A copy-paste that leaves `FOO: "${BAR:-…}"` behind is the other way a knob
  // silently ignores what the operator set.
  const mismatched: string[] = [];
  for (const [key, value] of composeGatewayEnv()) {
    const ref = /^"\$\{([A-Z0-9_]+)(:-.*)?\}"$/.exec(value.trim())?.[1];
    if (ref && ref !== key) mismatched.push(`${key} -> \${${ref}}`);
  }
  assert.deepEqual(mismatched, [], `env key forwards a differently-named var: ${mismatched.join(", ")}`);
});
