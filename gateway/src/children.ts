/**
 * How many chrome-devtools-mcp child PROCESSES this gateway has running.
 *
 * Issue #122 ran for 3.5 days and ended in an OOM because the only way to see
 * the children was `ps` on the host. The count is reported on /healthz and the
 * dashboard beside the session count, and the reaper warns when it stays above
 * it.
 *
 * `childExited` is called from the process's own `close` event and nowhere
 * else. Counting down when the gateway ASKS a child to close would report zero
 * for exactly the child worth knowing about: one that was asked and did not go.
 */
let live = 0;

export function childSpawned(): void {
  live += 1;
}

export function childExited(): void {
  live = Math.max(0, live - 1);
}

export function liveChildren(): number {
  return live;
}
