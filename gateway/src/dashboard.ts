import { config } from "./config.js";
import { runtimeConfig, configWarnings } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { Provisioner, FleetMember, SandboxStatus } from "./provisioner.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Humanized age plus the exact second count.
 *
 * The `browser idle` column exists to make an eight-hour gap obvious at a
 * glance, and `28800s` does not do that. Under 90s stays raw, because that is
 * the band where the exact number is the interesting part — the client bridge
 * pings every 120s, so a live session's plain idle clock reads in seconds. Past
 * that the seconds move to the tooltip; they stay readable because they are the
 * unit the reap TTLs are denominated in (`ATTACHED_IDLE_TTL_SEC`).
 */
function age(ms: number): { text: string; exact: string } {
  const s = Math.max(0, Math.round(ms / 1000));
  const exact = `${s}s`;
  if (s < 90) return { text: exact, exact };
  const m = Math.floor(s / 60);
  if (m < 60) return { text: `${m}m`, exact };
  return { text: `${Math.floor(m / 60)}h ${m % 60}m`, exact };
}

/** An age cell: humanized text, exact seconds in the tooltip when they differ. */
function ageCell(ms: number | null, flagged = false): string {
  if (ms === null) return `<td class="num dash">—</td>`;
  const a = age(ms);
  const title = a.text === a.exact ? "" : ` title="${esc(a.exact)}"`;
  const body = flagged ? `<span class="work-stale">${a.text}</span>` : a.text;
  return `<td class="num"${title}>${body}</td>`;
}

/**
 * The driving instance's self-chosen chikin_identify label, with whatever it
 * said it was doing as the tooltip. Per session, and independent of the sticky
 * browser name.
 */
function handleCell(session: { handle?: string; handleDescription?: string } | undefined): string {
  return session?.handle
    ? `<td><code title="${esc(session.handleDescription ?? "")}">${esc(session.handle)}</code></td>`
    : `<td class="dash">—</td>`;
}

/** Whether a client currently holds an open SSE stream for this name. */
function attachedCell(streams: number | undefined): string {
  if (streams === undefined) return `<td class="dash">—</td>`;
  return streams > 0 ? `<td>yes</td>` : `<td class="soft">no</td>`;
}

/**
 * A canary counter (strikes, respawns). Zero is the resting state and is muted;
 * anything above it is the reason to read the row, so it is tinted. Both are
 * gauges on the activity record, not monotonic totals — a reaped browser takes
 * its history with it (README, "Wedge self-healing").
 */
function countCell(n: number | undefined, grp = ""): string {
  const cls = ["num", grp, n === undefined ? "dash" : n > 0 ? "hot" : "zero"]
    .filter(Boolean)
    .join(" ");
  return `<td class="${cls}">${n ?? "—"}</td>`;
}

// Render a browser's renderer-sandbox posture (H1). "sandboxed" is the safe
// state; "fell back"/"disabled" mean a renderer exploit is in-container RCE.
// The labels are the ones README documents — keep them literal.
function sandboxCell(status: SandboxStatus): string {
  const label: Record<SandboxStatus, string> = {
    sandboxed: "sandboxed",
    "fell-back": "fell back ⚠",
    disabled: "disabled ⚠",
    failed: "failed ✗",
    unknown: "—",
  };
  if (status === "unknown") return `<td class="dash">—</td>`;
  return `<td><span class="pill ${status === "sandboxed" ? "ok" : "bad"}">${esc(
    label[status],
  )}</span></td>`;
}

/**
 * Fleet occupancy as one glyph: a pip per slot while the fleet is small enough
 * to count, a proportional bar once it is not. Tinted from 75% so a fleet about
 * to start refusing browser tool calls looks different before it does.
 */
function gauge(used: number, max: number): string {
  const tone = used >= max ? "full" : used >= max * 0.75 ? "high" : "ok";
  if (max > 0 && max <= 16) {
    const pips = Array.from(
      { length: max },
      (_, i) => `<i class="pip${i < used ? ` on ${tone}` : ""}"></i>`,
    ).join("");
    return `<span class="pips" aria-hidden="true">${pips}</span>`;
  }
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return `<span class="bar" aria-hidden="true"><i class="${tone}" style="width:${pct}%"></i></span>`;
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
  return `<section class="card">
    <header>
      <h2>runtime config</h2>
      <p class="hint">what this gateway process actually has — not <code>.env</code> on disk</p>
    </header>
    <p class="seedline">seeding: ${seeding}</p>
    <dl class="cfg">
${knobs.map(([k, v]) => `      <dt><code>${esc(k)}</code></dt><dd>${esc(v)}</dd>`).join("\n")}
    </dl>
  </section>`;
}

/** One browser: a fleet container, which is what a fleet slot actually is. */
function browserRow(
  m: FleetMember,
  registry: Registry,
  now: number,
  sandbox: SandboxStatus,
): string {
  const session = registry.getByName(m.name);
  const act = registry.getActivity(m.name);
  // Time since this browser last did REAL work (a forwarded tools/call), as
  // opposed to `idle`, which the client's 120s keepalive ping keeps near zero on
  // every attached session. This is what the attached-tier reap TTL is measured
  // against, so "is this session actually working?" is readable rather than
  // inferred (issue #57). Flagged once it is past that TTL.
  const workIdleMs = act ? now - act.lastBrowserActivity : 0;
  const overAttachedTtl =
    !!act &&
    act.streams > 0 &&
    config.attachedIdleTtlMs > 0 &&
    workIdleMs > config.attachedIdleTtlMs;
  const name = esc(m.name);
  const vncHref = `/vnc/${name}/vnc.html?autoconnect=true&resize=remote&reconnect=true&path=${encodeURIComponent(
    `vnc/${m.name}/websockify`,
  )}`;
  const running = m.state === "running";
  return `<tr>
    <td class="pin-l"><code class="nm">${name}</code></td>
    ${handleCell(session)}
    <td class="grp"><span class="pill ${running ? "ok" : "bad"}">${esc(m.state)}</span></td>
    <td class="soft status" title="${esc(m.status)}">${esc(m.status)}</td>
    ${sandboxCell(sandbox)}
    <td class="grp">${session ? `<span class="pill ok nodot">live</span>` : `<span class="dash">—</span>`}</td>
    ${attachedCell(act?.streams)}
    ${ageCell(act ? now - act.last : null)}
    ${ageCell(act ? workIdleMs : null, overAttachedTtl)}
    ${countCell(act?.navStrikes, "grp")}
    ${countCell(act?.childRespawns)}
    <td>${act?.chromeVersion ? `<code>${esc(act.chromeVersion)}</code>` : `<span class="dash">—</span>`}</td>
    <td class="pin-r">${running ? `<a class="btn" href="${vncHref}">open noVNC ↗</a>` : `<span class="dash">—</span>`}</td>
  </tr>`;
}

/**
 * A live session that holds NO container — connected, tools registered, but it
 * has not yet made a browser tool call, so lazy provisioning (issue #63) has
 * not claimed it a fleet slot. Before that change these sessions were the ones
 * silently eating the fleet; now they are free, and the risk is the opposite —
 * that they are invisible.
 *
 * They get their own table rather than rows in the fleet table, because a
 * browser-shaped row describes them almost entirely in em-dashes: on a real host
 * they outnumber the browsers several to one, so eleven repetitions of
 * "connected — holds no fleet slot" pushed the browsers that DO hold a slot off
 * the top of the page (issue #81). The phrase is stated once, in the section
 * header; the columns that remain are the ones that vary.
 */
function sessionRow(name: string, registry: Registry, now: number): string {
  const session = registry.getByName(name);
  const act = registry.getActivity(name);
  return `<tr class="noslot">
    <td><code class="nm">${esc(name)}</code></td>
    ${handleCell(session)}
    ${attachedCell(act?.streams)}
    ${ageCell(act ? now - act.last : null)}
    ${countCell(act?.navStrikes)}
    ${countCell(act?.childRespawns)}
  </tr>`;
}

const STYLE = `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8; --panel: #ffffff; --panel-2: #fafbfc;
    --ink: #14161a; --dim: #59616e; --faint: #8b939f;
    --line: #e3e6eb; --soft: #eef0f4;
    --ok: #1a7f37; --ok-bg: #e8f5eb; --bad: #b3261e; --bad-bg: #fdeceb;
    --warn: #8a5a00; --warn-bg: #fff6e0; --accent: #3b5bdb;
    --shadow: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.04);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f13; --panel: #14171d; --panel-2: #191d24;
      --ink: #e6eaf1; --dim: #99a2b1; --faint: #6d7684;
      --line: #242932; --soft: #1d2129;
      --ok: #5ec269; --ok-bg: #12291a; --bad: #ff6b6b; --bad-bg: #2b1517;
      --warn: #e0b341; --warn-bg: #2a2213; --accent: #8aa4ff;
      --shadow: none;
    }
  }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 86rem; margin: 0 auto; padding: 2rem 1.5rem 3rem; }
  code { font-family: var(--mono); font-size: .88em; }
  .dash { color: var(--faint); }
  .soft { color: var(--dim); }

  /* ---- header ---- */
  .top {
    display: flex; flex-wrap: wrap; gap: 1rem 2rem;
    align-items: flex-end; justify-content: space-between; margin-bottom: 1.25rem;
  }
  h1 {
    display: flex; align-items: center; gap: .55rem;
    font-size: 1.15rem; font-weight: 650; letter-spacing: -.012em; margin: 0;
  }
  h1 .mark {
    width: .62rem; height: .62rem; border-radius: 2px;
    background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg);
  }
  h1 .mark.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
  h1 .mark.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-bg); }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .55rem; }
  .chip {
    font: 600 .72rem/1.6 var(--mono); letter-spacing: .01em;
    padding: .1rem .45rem; border-radius: 5px;
    background: var(--panel); border: 1px solid var(--line); color: var(--dim);
  }
  .chip.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
  .chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
  .slots { display: flex; align-items: center; gap: .75rem; }
  .pips { display: flex; gap: 3px; }
  .pip { width: .5rem; height: 1.35rem; border-radius: 2px; background: var(--soft); border: 1px solid var(--line); }
  .pip.on { background: var(--ok); border-color: var(--ok); }
  .pip.on.high { background: var(--warn); border-color: var(--warn); }
  .pip.on.full { background: var(--bad); border-color: var(--bad); }
  .bar { display: block; width: 11rem; height: .55rem; border-radius: 999px; background: var(--soft); overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--ok); }
  .bar > i.high { background: var(--warn); }
  .bar > i.full { background: var(--bad); }
  .meta { color: var(--dim); font-size: .82rem; margin: 0; }
  .meta strong { color: var(--ink); font-family: var(--mono); font-weight: 650; }

  /* ---- cards ---- */
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: var(--shadow); margin: 1.1rem 0; overflow: hidden;
  }
  .card > header {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem .7rem;
    padding: .8rem 1rem; border-bottom: 1px solid var(--soft);
  }
  .card > header h2 { font-size: .95rem; font-weight: 650; margin: 0; letter-spacing: -.005em; }
  .count {
    font: 650 .72rem/1.5 var(--mono); padding: .05rem .4rem; border-radius: 999px;
    background: var(--panel-2); border: 1px solid var(--line); color: var(--dim);
  }
  .hint { color: var(--dim); font-size: .82rem; margin: 0; flex: 1 1 20rem; }
  .scroll { overflow-x: auto; scrollbar-width: thin; }

  /* ---- tables ---- */
  table { border-collapse: collapse; width: 100%; font-size: .855rem; }
  th, td { text-align: left; padding: .42rem .5rem; white-space: nowrap; border-bottom: 1px solid var(--soft); }
  thead th {
    position: sticky; top: 0; z-index: 1; background: var(--panel);
    white-space: nowrap;
    color: var(--faint); font: 600 .655rem/1.5 ui-sans-serif, system-ui, sans-serif;
    text-transform: uppercase; letter-spacing: .07em; border-bottom: 1px solid var(--line);
  }
  th[title] { text-decoration: underline dotted; text-underline-offset: 3px; cursor: help; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--panel-2); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.zero { color: var(--faint); }
  td.status { max-width: 9.5rem; overflow: hidden; text-overflow: ellipsis; }
  table.sessions { max-width: 54rem; }
  td.grp, th.grp { border-left: 1px solid var(--soft); }
  td.pin-l, th.pin-l, td.pin-r, th.pin-r { position: sticky; background: var(--panel); z-index: 1; }
  td.pin-l, th.pin-l { left: 0; border-right: 1px solid var(--line); }
  td.pin-r, th.pin-r { right: 0; border-left: 1px solid var(--line); }
  thead th.pin-l, thead th.pin-r { z-index: 3; }
  tbody tr:hover td.pin-l, tbody tr:hover td.pin-r { background: var(--panel-2); }
  code.nm { font-weight: 600; }
  tr.noslot code.nm { font-weight: 500; color: var(--dim); }
  td.hot { color: var(--warn); font-weight: 650; }
  .work-stale { color: var(--bad); font-weight: 650; }
  .empty { color: var(--dim); text-align: center; padding: 1.6rem 1rem; white-space: normal; }

  /* ---- pills, buttons ---- */
  .pill {
    display: inline-flex; align-items: center; gap: .32rem;
    padding: .1rem .45rem .1rem .4rem; border-radius: 999px;
    font-size: .72rem; font-weight: 650; letter-spacing: .005em;
  }
  .pill::before { content: ""; width: .38rem; height: .38rem; border-radius: 50%; background: currentColor; }
  .pill.nodot::before { display: none; }
  .pill.nodot { padding-left: .45rem; }
  .pill.ok { color: var(--ok); background: var(--ok-bg); }
  .pill.bad { color: var(--bad); background: var(--bad-bg); }
  a.btn {
    display: inline-block; padding: .16rem .5rem; border-radius: 6px;
    border: 1px solid var(--line); background: var(--panel);
    color: var(--accent); font-size: .76rem; font-weight: 600; text-decoration: none;
  }
  a.btn:hover { border-color: var(--accent); background: var(--panel-2); }
  a:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px;
  }

  /* ---- banners ---- */
  .banner {
    display: flex; gap: .6rem; align-items: flex-start; padding: .7rem .9rem;
    border-radius: 10px; margin: 0 0 .7rem; font-size: .86rem;
  }
  .banner.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); }
  .banner.err { background: var(--bad-bg); color: var(--bad); border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent); }
  .banner b { font-weight: 650; }

  /* ---- runtime config ---- */
  .seedline { margin: 0; padding: .8rem 1rem; border-bottom: 1px solid var(--soft); font-size: .86rem; }
  .seed { font: 700 .72rem/1.6 var(--mono); padding: .05rem .4rem; border-radius: 5px; color: #fff; }
  .seed.on { background: var(--ok); }
  .seed.off { background: var(--bad); }
  @media (prefers-color-scheme: dark) { .seed { color: #0d0f13; } }
  .cfg {
    display: grid; grid-template-columns: max-content minmax(0, 1fr);
    gap: .28rem 1.2rem; margin: 0; padding: .85rem 1rem; font-size: .84rem;
  }
  @media (min-width: 76rem) {
    .cfg { grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); }
  }
  .cfg dt { margin: 0; }
  .cfg dd { margin: 0; color: var(--dim); overflow-wrap: anywhere; }

  /* ---- refresh control ---- */
  .refresh {
    position: fixed; top: .75rem; right: .9rem; z-index: 5;
    display: flex; align-items: center; gap: .45rem;
    padding: .25rem .35rem .25rem .6rem; border-radius: 999px;
    background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow);
    font-size: .75rem; color: var(--dim);
  }
  .refresh[hidden] { display: none; }
  .refresh.stale { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .refresh button {
    font: inherit; font-weight: 600; color: var(--accent); cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px; padding: .05rem .5rem;
  }
  .refresh button:hover { border-color: var(--accent); }
  footer { color: var(--dim); font-size: .8rem; margin-top: 1.5rem; line-height: 1.7; }
  @media (max-width: 40rem) {
    main { padding: 1.25rem 1rem 2rem; }
    .refresh { top: .4rem; right: .5rem; font-size: .7rem; padding: .2rem .25rem .2rem .45rem; }
    .refresh #refresh-status { max-width: 7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
`;

/**
 * Live refresh. The page is a view of a fleet that changes under the reader, so
 * it re-renders itself instead of going stale behind a manual reload.
 *
 * Server-rendered and swapped whole: the script re-fetches this same URL and
 * replaces `#live` with the fresh one, which keeps a single renderer (no client
 * template to drift from the server's) and keeps scroll position. Everything the
 * script touches lives outside `#live`, so a swap never orphans a listener.
 *
 * Deliberately quiet: paused while the tab is hidden — a dashboard left open on
 * another desktop should not poll Docker forever — and skipped while the reader
 * has a selection, which a swap would otherwise clear mid-copy. The page is
 * fully readable with JS off; the control is hidden until the script un-hides it.
 */
const SCRIPT = `
(function () {
  var box = document.getElementById("refresh");
  var btn = document.getElementById("refresh-toggle");
  var out = document.getElementById("refresh-status");
  if (!box || !btn || !out) return;
  var PERIOD = 5000;
  var on = true;
  try { on = localStorage.getItem("chikin.refresh") !== "off"; } catch (e) {}
  var last = Date.now();
  var busy = false;
  var failed = false;
  box.hidden = false;

  function label() {
    var secs = Math.round((Date.now() - last) / 1000);
    btn.textContent = on ? "pause" : "resume";
    out.textContent = failed
      ? "refresh failed \\u2014 retrying"
      : on ? "updated " + secs + "s ago" : "paused \\u00b7 " + secs + "s old";
    box.className = failed || secs > 30 ? "refresh stale" : "refresh";
  }

  function pull() {
    if (!on || busy || document.hidden) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // do not clear a selection mid-copy
    busy = true;
    fetch(location.pathname + location.search, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var next = doc.getElementById("live");
        var here = document.getElementById("live");
        if (!next || !here) throw new Error("no live region");
        here.replaceWith(next);
        if (doc.title) document.title = doc.title;
        last = Date.now();
        failed = false;
      })
      .catch(function () { failed = true; })
      .then(function () { busy = false; label(); });
  }

  btn.addEventListener("click", function () {
    on = !on;
    try { localStorage.setItem("chikin.refresh", on ? "on" : "off"); } catch (e) {}
    if (on) pull(); else label();
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pull(); });
  setInterval(pull, PERIOD);
  setInterval(label, 1000);
  label();
})();
`;

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
      sandbox.set(
        m.name,
        m.state === "running" ? await provisioner.sandboxStatus(m.containerId) : "unknown",
      );
    }),
  );

  // Live sessions with no container of their own (issue #63), listed below the
  // real browsers. Only derivable when the fleet listing SUCCEEDED: if Docker
  // could not be reached, `members` is empty for a reason that has nothing to do
  // with what the fleet holds, and every live session would be presented —
  // precisely, and wrongly — as holding no slot. Unknown must read as unknown.
  const held = new Set(members.map((m) => m.name));
  const browserless = err
    ? []
    : registry
        .all()
        .map((s) => s.name)
        .filter((n) => !held.has(n))
        .sort();

  const emptyBrowsers = err
    ? `<tr><td colspan="13" class="empty">Fleet state unknown — the fleet could not be listed (see the error above). Nothing here is a statement about what is running.</td></tr>`
    : `<tr><td colspan="13" class="empty">No browsers provisioned yet. Connect an MCP client to <code>/b/&lt;name&gt;/</code> and make a browser tool call to spin one up.</td></tr>`;
  const browserRows = members.length
    ? members.map((m) => browserRow(m, registry, now, sandbox.get(m.name) ?? "unknown")).join("\n")
    : emptyBrowsers;

  // Slot accounting is only honest on a fleet we could actually read.
  const slotLine = err
    ? `<p class="meta">fleet slots in use: <strong>unknown</strong> — the fleet could not be listed, so neither the count nor which sessions hold a slot can be reported</p>`
    : `<p class="meta">fleet slots in use: <strong>${members.length}/${config.maxFleet}</strong>${
        browserless.length
          ? ` · ${browserless.length} connected session${browserless.length === 1 ? "" : "s"} holding no slot`
          : ""
      }</p>`;

  const rc = runtimeConfig();
  const chips = [
    `<span class="chip ${rc.seedingOn ? "ok" : "bad"}">seeding ${rc.seedingOn ? "on" : "off"}</span>`,
    `<span class="chip">sandbox ${esc(rc.sandbox)}</span>`,
    `<span class="chip">image ${esc(rc.chromeImage)}</span>`,
  ].join("");

  // Warnings lead the page rather than trailing the config panel: they are the
  // states an operator is meant to act on, and the panel is below the fold.
  const warns = configWarnings();
  const warnings = warns
    .map((w) => `<p class="banner warn"><b>⚠</b><span>${esc(w)}</span></p>`)
    .join("\n  ");
  // The header glyph is the page's one-pixel summary, so it must not read
  // "healthy" on a render that could not see the fleet.
  const mark = err ? "mark bad" : warns.length ? "mark warn" : "mark";

  const sessionsCard = browserless.length
    ? `<section class="card">
    <header>
      <h2>connected sessions</h2><span class="count">${browserless.length}</span>
      <p class="hint">Live MCP sessions that have not made a browser tool call yet, so no container exists for them: <strong>connected — holds no fleet slot</strong>. They cost the fleet nothing until they browse, and have no browser to view (issue #63).</p>
    </header>
    <div class="scroll"><table class="sessions">
      <thead>
        <tr><th>name</th><th>handle</th><th>attached</th><th title="since any MCP frame — a client heartbeat ping keeps this near zero">idle</th><th class="num">strikes</th><th class="num">respawns</th></tr>
      </thead>
      <tbody>
${browserless.map((n) => sessionRow(n, registry, now)).join("\n")}
      </tbody>
    </table></div>
  </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>chikin fleet${err ? " · unknown" : ` · ${members.length}/${config.maxFleet}`}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="refresh" id="refresh" hidden>
  <span id="refresh-status">live</span>
  <button type="button" id="refresh-toggle">pause</button>
</div>
<main id="live">
  <header class="top">
    <div>
      <h1><span class="${mark}"></span>chikin fleet</h1>
      <div class="chips">${chips}</div>
    </div>
    <div class="slots">
      ${err ? "" : gauge(members.length, config.maxFleet)}
      <div>${slotLine}</div>
    </div>
  </header>

  ${err ? `<p class="banner err"><b>✗</b><span>Could not list fleet: ${esc(err)}</span></p>` : ""}
  ${warnings}

  <section class="card">
    <header>
      <h2>browsers</h2><span class="count">${err ? "?" : members.length}</span>
      <p class="hint">One container per row — every name that has made a browser tool call and not yet been reaped. Each holds a fleet slot.</p>
    </header>
    <div class="scroll"><table>
      <thead>
        <tr><th class="pin-l">name</th><th>handle</th><th class="grp">state</th><th>status</th><th>sandbox</th><th class="grp">session</th><th>attached</th><th title="since any MCP frame — a client heartbeat ping keeps this near zero">idle</th><th title="since a real browser tool call — what the attached reap TTL measures">browser idle</th><th class="num grp" title="nav verifications that disagreed with the browser (suspicion). Many strikes with no respawns = the detector is firing on something that is not a wedge">strikes</th><th class="num" title="children torn down and replaced, any cause (action)">respawns</th><th title="Chrome reported by the running browser. It floats unpinned, and it governs whether the wedge reproduces at all — see #73">chrome</th><th class="pin-r">view</th></tr>
      </thead>
      <tbody>
${browserRows}
      </tbody>
    </table></div>
  </section>

  ${sessionsCard}
  ${configPanel()}

  <footer>
    <code>MAX_FLEET=${config.maxFleet}</code> · idle reap after ${Math.round(
      config.idleTtlMs / 1000,
    )}s with no attached client${
      config.attachedIdleTtlMs > 0
        ? `, or after ${Math.round(
            config.attachedIdleTtlMs / 1000,
          )}s with a client attached but no browser tool call`
        : " (attached browsers are never reaped)"
    } · sandbox policy <code>CHIKIN_SANDBOX=${esc(config.sandbox)}</code>
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
