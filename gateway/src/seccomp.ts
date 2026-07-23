import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

/**
 * The custom seccomp profile the gateway attaches to fleet browsers so Chrome's
 * user-namespace sandbox can run under CapDrop:["ALL"] + no-new-privileges. It
 * is moby's default profile plus one allow group for the 5 namespace/chroot
 * syscalls the sandbox needs — see gateway/seccomp/generate.mjs and
 * gateway/seccomp/chikin-browser.json.
 *
 * CRITICAL delivery detail: over the Docker *API* (dockerode via the
 * socket-proxy), `SecurityOpt: ["seccomp=<value>"]` must carry the profile's
 * JSON *content* inlined, NOT a file path — the Docker CLI reads a file, the API
 * does not. So we read the bundled profile once here and hand back its content.
 *
 * The profile lives next to the compiled sources at runtime. The gateway image
 * COPYs gateway/seccomp -> /app/seccomp; from dist/src/seccomp.js that resolves
 * as ../../seccomp/. An override path lets tests/dev point elsewhere.
 */
const PROFILE_PATH =
  process.env.CHIKIN_SECCOMP_PROFILE ||
  fileURLToPath(new URL("../../seccomp/chikin-browser.json", import.meta.url));

let cached: string | null | undefined;

/**
 * Return the seccomp profile JSON as a compact single-line string ready to
 * inline into `SecurityOpt`, or null if it can't be loaded (logged once). A
 * null result means the gateway must NOT claim the browser is sandboxed: the
 * caller falls back to leaving Docker's default seccomp in place, and the
 * container entrypoint's userns probe will then fail and drop to --no-sandbox.
 */
export function seccompProfile(): string | null {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(PROFILE_PATH, "utf8");
    // Re-serialize compactly and validate it parses. This both shrinks the
    // inlined value and fails fast if the bundled file is malformed.
    cached = JSON.stringify(JSON.parse(raw));
  } catch (e) {
    log.warn(
      `seccomp: could not load browser profile at ${PROFILE_PATH}; ` +
        `browsers cannot be sandboxed and will run --no-sandbox`,
      e instanceof Error ? e.message : String(e),
    );
    cached = null;
  }
  return cached;
}
