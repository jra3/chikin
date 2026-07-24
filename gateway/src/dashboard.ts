import { config } from "./config.js";
import { runtimeConfig, configWarnings } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { Provisioner, FleetMember, SandboxStatus } from "./provisioner.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Render a browser's renderer-sandbox posture (H1). "sandboxed" is the safe
// state; "fell-back"/"disabled" mean a renderer exploit is in-container RCE.
function sandboxCell(status: SandboxStatus): string {
  const label: Record<SandboxStatus, string> = {
    sandboxed: "sandboxed",
    "fell-back": "fell back ⚠",
    disabled: "disabled ⚠",
    failed: "failed ✗",
    unknown: "—",
  };
  const cls =
    status === "sandboxed" ? "sb-on" : status === "unknown" ? "sb-unknown" : "sb-off";
  return `<span class="sandbox ${cls}">${esc(label[status])}</span>`;
}

/**
 * The effective runtime config of THIS gateway process (runtime.ts), rendered
 * so "is seeding on?" is answerable at a glance. Container env is frozen at
 * create time, so the .env on disk can disagree with what is running — this
 * panel is the running truth. Seeding leads because it is the knob that failed
 * silently for ~7 weeks.
 */
function configPanel(): string {
  const rc = runtimeConfig();
  const seeding = rc.seedingOn
    ? `<span class="seed on">ON</span> <code>SEED_VOLUME=${esc(rc.seedVolume)}</code> — new browsers are cloned from this profile`
    : `<span class="seed off">OFF</span> <code>SEED_VOLUME</code> is unset — new browsers get <strong>blank profiles</strong> and start logged out`;
  const knobs: [string, string][] = [
    ["CHROME_IMAGE", rc.chromeImage],
    ["CHIKIN_SANDBOX", rc.sandbox],
    ["MAX_FLEET", String(rc.maxFleet)],
    ["IDLE_TTL_SEC", `${rc.idleTtlSec} (detached browsers)`],
    [
      "ATTACHED_IDLE_TTL_SEC",
      rc.attachedIdleTtlSec > 0
        ? `${rc.attachedIdleTtlSec} (attached but no browser tool call — see the "browser idle" column)`
        : "0 (attached browsers are never reaped)",
    ],
    ["CHIKIN_VOLUME_GC", rc.volumeGc ? "on (orphaned inst-* volumes swept at startup)" : "off"],
    ["WINDOW_SIZE", rc.windowSize],
    ["SHARED_DIR", rc.sharedDir],
    ["CHIKIN_NETWORK", rc.network],
    ["CHIKIN_EGRESS_NETWORK", rc.egressNetwork],
    ["LOG_LEVEL", rc.logLevel],
    ["GATEWAY_TOKEN", rc.authEnabled ? "set (bearer auth on)" : "empty (bearer auth OFF)"],
    ["GATEWAY_EXTRA_ORIGINS", rc.extraOrigins || "—"],
    ["CDM_EXTRA_ARGS", rc.cdmExtraArgs.join(" ") || "—"],
  ];
  const warn = configWarnings()
    .map((w) => `<p class="warnbox">⚠ ${esc(w)}</p>`)
    .join("\n");
  return `<h2>runtime config <span class="hint">(what this gateway process actually has — not <code>.env</code> on disk)</span></h2>
  <p class="seedline">seeding: ${seeding}</p>
  ${warn}
  <table class="cfg">
    <tbody>
${knobs.map(([k, v]) => `      <tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join("\n")}
    </tbody>
  </table>`;
}

function row(
  m: FleetMember,
  registry: Registry,
  now: number,
  sandbox: SandboxStatus,
): string {
  const session = registry.getByName(m.name);
  const act = registry.getActivity(m.name);
  const idle = act ? `${Math.round((now - act.last) / 1000)}s` : "—";
  const attached = act ? (act.streams > 0 ? "yes" : "no") : "—";
  // Seconds since this browser last did REAL work (a forwarded tools/call), as
  // opposed to `idle` above, which the client's 120s keepalive ping keeps near
  // zero on every attached session. This is the number the attached-tier reap
  // TTL is measured against, so "is this session actually working?" is readable
  // rather than inferred (issue #57). Flagged once it is past that TTL.
  const workIdleMs = act ? now - act.lastBrowserActivity : 0;
  const overAttachedTtl =
    !!act && act.streams > 0 && config.attachedIdleTtlMs > 0 && workIdleMs > config.attachedIdleTtlMs;
  const browserIdle = act
    ? `<span class="${overAttachedTtl ? "work-stale" : ""}">${Math.round(workIdleMs / 1000)}s</span>`
    : "—";
  const name = esc(m.name);
  const vncHref = `/vnc/${name}/vnc.html?autoconnect=true&resize=remote&reconnect=true&path=${encodeURIComponent(
    `vnc/${m.name}/websockify`,
  )}`;
  const running = m.state === "running";
  // The handle is the driving instance's self-chosen label (chikin_identify),
  // set per session and independent of the sticky browser name above.
  const handle = session?.handle
    ? `<code title="${esc(session.handleDescription ?? "")}">${esc(session.handle)}</code>`
    : "—";
  return `<tr>
    <td><code>${name}</code></td>
    <td>${handle}</td>
    <td><span class="state ${running ? "up" : "down"}">${esc(m.state)}</span></td>
    <td>${esc(m.status)}</td>
    <td>${sandboxCell(sandbox)}</td>
    <td>${session ? "live" : "—"}</td>
    <td>${attached}</td>
    <td>${idle}</td>
    <td>${browserIdle}</td>
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

  // Per-browser renderer-sandbox posture (H1), parsed from each container's logs.
  // Best-effort and cached in the provisioner, so this is cheap on re-render.
  const sandbox = new Map<string, SandboxStatus>();
  await Promise.all(
    members.map(async (m) => {
      sandbox.set(m.name, m.state === "running" ? await provisioner.sandboxStatus(m.containerId) : "unknown");
    }),
  );

  const rows = members.length
    ? members.map((m) => row(m, registry, now, sandbox.get(m.name) ?? "unknown")).join("\n")
    : `<tr><td colspan="10" class="empty">No browsers provisioned yet. Connect an MCP client to <code>/b/&lt;name&gt;/</code> to spin one up.</td></tr>`;

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
  .sandbox.sb-on { color: #137333; font-weight: 600; }
  .sandbox.sb-off { color: #a50e0e; font-weight: 600; }
  .sandbox.sb-unknown { color: #888; }
  .work-stale { color: #a50e0e; font-weight: 600; }
  .empty { color: #888; text-align: center; padding: 1.2rem; }
  .err { color: #a50e0e; }
  .meta { color: #777; font-size: .85rem; margin-top: 1.5rem; }
  h2 { font-size: 1rem; margin-top: 2rem; }
  h2 .hint { font-weight: 400; color: #777; font-size: .85rem; }
  .seedline { margin: .4rem 0; }
  .seed { font-weight: 700; padding: 0 .35rem; border-radius: 3px; color: #fff; }
  .seed.on { background: #137333; }
  .seed.off { background: #a50e0e; }
  .warnbox { background: #fff4e5; border-left: 4px solid #b06000; color: #6b3b00;
             padding: .6rem .8rem; margin: .6rem 0; max-width: 60rem; }
  table.cfg { max-width: 40rem; }
  table.cfg td:first-child { width: 14rem; }
</style>
</head>
<body>
  <h1>chikin fleet</h1>
  ${err ? `<p class="err">Could not list fleet: ${esc(err)}</p>` : ""}
  <table>
    <thead>
      <tr><th>name</th><th>handle</th><th>state</th><th>status</th><th>sandbox</th><th>session</th><th>attached</th><th title="since any MCP frame — a client heartbeat ping keeps this near zero">idle</th><th title="since a real browser tool call — what the attached reap TTL measures">browser idle</th><th>view</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  ${configPanel()}
  <p class="meta">MAX_FLEET=${config.maxFleet} · idle reap after ${Math.round(
    config.idleTtlMs / 1000,
  )}s with no attached client${
    config.attachedIdleTtlMs > 0
      ? `, or after ${Math.round(
          config.attachedIdleTtlMs / 1000,
        )}s with a client attached but no browser tool call`
      : " (attached browsers are never reaped)"
  } · sandbox policy <code>CHIKIN_SANDBOX=${esc(config.sandbox)}</code></p>
</body>
</html>`;
}
