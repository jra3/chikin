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
