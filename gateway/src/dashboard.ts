import { config } from "./config.js";
import type { Registry } from "./registry.js";
import type { Provisioner, FleetMember } from "./provisioner.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function row(m: FleetMember, registry: Registry, now: number): string {
  const session = registry.getByName(m.name);
  const act = registry.getActivity(m.name);
  const idle = act ? `${Math.round((now - act.last) / 1000)}s` : "—";
  const attached = act ? (act.streams > 0 ? "yes" : "no") : "—";
  const name = esc(m.name);
  const vncHref = `/vnc/${name}/vnc.html?autoconnect=true&resize=remote&reconnect=true&path=${encodeURIComponent(
    `vnc/${m.name}/websockify`,
  )}`;
  const running = m.state === "running";
  return `<tr>
    <td><code>${name}</code></td>
    <td><span class="state ${running ? "up" : "down"}">${esc(m.state)}</span></td>
    <td>${esc(m.status)}</td>
    <td>${session ? "live" : "—"}</td>
    <td>${attached}</td>
    <td>${idle}</td>
    <td>${running ? `<a href="${vncHref}">open noVNC ↗</a>` : "—"}</td>
  </tr>`;
}

/** Render the fleet dashboard listing every managed browser (issue #9). */
export async function renderDashboard(
  provisioner: Provisioner,
  registry: Registry,
): Promise<string> {
  const now = Date.now();
  let members: FleetMember[] = [];
  let err = "";
  try {
    members = (await provisioner.listFleet()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  const rows = members.length
    ? members.map((m) => row(m, registry, now)).join("\n")
    : `<tr><td colspan="7" class="empty">No browsers provisioned yet. Connect an MCP client to <code>/b/&lt;name&gt;/</code> to spin one up.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>chikin fleet</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  table { border-collapse: collapse; width: 100%; max-width: 60rem; margin-top: 1rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e3e3e3; }
  th { font-weight: 600; color: #555; }
  code { background: #f4f4f4; padding: 0 .25rem; border-radius: 3px; }
  .state.up { color: #137333; font-weight: 600; }
  .state.down { color: #a50e0e; }
  .empty { color: #888; text-align: center; padding: 1.2rem; }
  .err { color: #a50e0e; }
  .meta { color: #777; font-size: .85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
  <h1>chikin fleet</h1>
  ${err ? `<p class="err">Could not list fleet: ${esc(err)}</p>` : ""}
  <table>
    <thead>
      <tr><th>name</th><th>state</th><th>status</th><th>session</th><th>attached</th><th>idle</th><th>view</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="meta">MAX_FLEET=${config.maxFleet} · idle reap after ${Math.round(
    config.idleTtlMs / 1000,
  )}s with no attached client</p>
</body>
</html>`;
}
