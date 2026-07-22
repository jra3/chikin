// Browser names map directly into Docker container/volume names and DNS labels,
// so keep them to a conservative DNS-safe charset. Issue #4: `[a-z0-9-]+`.
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function isValidName(name: string): boolean {
  return typeof name === "string" && NAME_RE.test(name);
}

export function assertValidName(name: string): void {
  if (!isValidName(name)) {
    throw new Error(
      `invalid browser name '${name}': must match [a-z0-9-], 1-32 chars, no leading/trailing dash`,
    );
  }
}

// A session "handle" (chikin_identify) is a human-friendly display/correlation
// label for the *instance driving* a browser. It shares this same DNS-safe
// charset rule but is orthogonal to the browser name / profile-volume identity.
export const HANDLE_RULE = "1-32 chars, lowercase letters/digits/dashes, no leading or trailing dash";

export function isValidHandle(handle: unknown): handle is string {
  return typeof handle === "string" && NAME_RE.test(handle);
}
