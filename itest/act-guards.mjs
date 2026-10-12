// Do chikin_act's guards hold in a REAL browser? (#99)
//
// Usage: BASE=http://localhost:18096 node act-guards.mjs [browser-name]
//
// gateway/test/act.test.ts proves the ordering against a fake Chrome: nothing
// is input unless the freshness check and the target resolve both pass. Whether
// the in-page guard script actually tells a changed page from an unchanged one
// is a property of real DOM and real layout, so it is asked here, with the
// cases Browser Use wrote for the same script (jev-ultrafast
// scripts/check_guards.py), driven through the gateway's own tools: the page is
// set up and mutated with upstream evaluate_script, read with chikin_snapshot,
// and acted on with chikin_act. A refusal is only believed when the page's own
// click counter did not move.
//
// Same cleanup rules as snapshot.mjs: inst-* names only, and only what this run
// created is removed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "";
const NAME = process.argv[2] ?? "inst-actguards";
if (!/^inst-[a-z0-9-]+$/.test(NAME)) {
  console.error(`refusing to run against '${NAME}': only an inst-* name may be created and removed here`);
  process.exit(2);
}

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
};

const existedBefore = docker("ps", "-a", "--format", "{{.Names}}").split("\n").includes(`chikin-chrome-${NAME}`);
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${NAME}/`), {
  requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
});
const client = new Client({ name: "itest-act-guards", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const call = (name, args = {}) => client.callTool({ name, arguments: args });

/** Run a function body in the page via upstream evaluate_script; return its JSON value. */
async function page(body) {
  const r = await call("evaluate_script", { function: `() => { ${body} }` });
  if (r.isError) throw new Error(`evaluate_script: ${textOf(r)}`);
  const m = /```json\n([\s\S]*?)\n```/.exec(textOf(r));
  return m ? JSON.parse(m[1]) : undefined;
}

async function snapshot() {
  const r = await call("chikin_snapshot");
  if (r.isError) throw new Error(`chikin_snapshot: ${textOf(r)}`);
  return r.structuredContent;
}
const rowNamed = (snap, label) => snap.actions.find((a) => a.label === label);

const clicks = () => page("return window.clicks || 0;");

const FIXTURE_1 = `<!doctype html><title>Guard checks</title>
<style>body{margin:30px}button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
<p id="context">Cart total: $10</p>
<button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
<label>City<input id="field" value="Zurich"></label>
<label><input id="toggle" type="checkbox">Refundable</label>
<select aria-label="Category"><option>All</option><option>Design</option></select>
<p id="outside">Unrelated offscreen text</p>`;

const FIXTURE_2 = `<form><p id="price">Total $10</p>
<button type="button" id="buy" onclick="window.clicks=(window.clicks||0)+1">Buy</button>
<label>Search <input id="query" role="combobox" aria-controls="suggestions"></label>
<div role="listbox" id="suggestions"></div>
<label><input id="check" type="checkbox">Enabled</label>
<label><input id="radio" type="radio">Choice</label>
<input id="readonly" aria-label="Read only" readonly>
<input id="secret" type="password" value="never expose this">
<button id="off" disabled>Disabled</button>
<select id="category" aria-label="Category">
<option>All</option><option>Design</option><option disabled>Unavailable</option>
</select></form><aside id="unrelated">News</aside>`;

try {
  await call("chikin_identify", { handle: "itest-act-guards" });
  const nav = await call("navigate_page", { type: "url", url: "data:text/html," + encodeURIComponent(FIXTURE_1) });
  if (nav.isError) throw new Error(`navigate_page: ${textOf(nav)}`);

  // --- fixture 1: one button, one field -------------------------------------
  let snap = await snapshot();
  let target = rowNamed(snap, "Continue");
  await page("document.querySelector('#target').style.transform='translateX(200px)'; return true;");
  let r = await call("chikin_act", { id: target.id });
  check("a moved target is clicked where it is now, with no second read", !r.isError && (await clicks()) === 1, textOf(r).slice(0, 200));

  snap = await snapshot();
  await page("document.querySelector('#outside').textContent='Updated outside the viewport'; return true;");
  r = await call("chikin_act", { id: "wait" });
  check("unrelated off-screen text does not invalidate", !r.isError, textOf(r).slice(0, 200));

  const mutations = {
    "visible context": "document.querySelector('#context').textContent='Cart total: $100'",
    "accessible label": "document.querySelector('#target').setAttribute('aria-label','Delete account')",
    "field property": "document.querySelector('#field').value='London'",
    "checkbox property": "document.querySelector('#toggle').checked=true",
    "disabled target": "document.querySelector('#target').disabled=true",
    "read-only field": "document.querySelector('#field').readOnly=true",
    "hidden target": "document.querySelector('#target').style.display='none'",
    "replaced node": "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
    "dropdown option": "document.querySelector('select').options[1].text='Coastal'",
  };
  for (const [label, expression] of Object.entries(mutations)) {
    await page("const t=document.querySelector('#target'); t.style.display='block'; t.disabled=false; return true;");
    await snapshot();
    await page(`${expression}; return true;`);
    r = await call("chikin_act", { id: "wait" });
    check(`${label} invalidates`, r.isError && /changed since/.test(textOf(r)), textOf(r).slice(0, 200));
  }

  await page("const t=document.querySelector('#target'); t.style.display='block'; t.disabled=false; return true;");
  snap = await snapshot();
  target = rowNamed(snap, "Delete account") ?? rowNamed(snap, "Continue");
  const before = await clicks();
  await page(
    "const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover); return true;",
  );
  r = await call("chikin_act", { id: target.id });
  check(
    "a textless overlay blocks the click before any input",
    r.isError && (await clicks()) === before,
    `isError=${r.isError} clicks ${before} -> ${await clicks()}: ${textOf(r).slice(0, 160)}`,
  );

  // --- fixture 2: a form ------------------------------------------------------
  await page(`document.body.innerHTML=${JSON.stringify(FIXTURE_2)}; window.clicks=0; return true;`);
  snap = await snapshot();
  await page("document.querySelector('#unrelated').textContent='New unrelated news'; return true;");
  r = await call("chikin_act", { id: rowNamed(snap, "Buy").id });
  check("the click guard accepts an unrelated visible update", !r.isError && (await clicks()) === 1, textOf(r).slice(0, 200));

  await snapshot();
  await page("document.querySelector('#unrelated').textContent='Newer unrelated news'; return true;");
  r = await call("chikin_act", { id: "wait" });
  check("...while the whole-page marker rejects it", r.isError, textOf(r).slice(0, 200));

  for (const [label, expression] of Object.entries({
    "nearby price": "document.querySelector('#price').textContent='Total $100'",
    "form value": "document.querySelector('#query').value='changed'",
    "form toggle": "document.querySelector('#check').checked=true",
    "target replacement": "document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML",
  })) {
    snap = await snapshot();
    const n = await clicks();
    await page(`${expression}; return true;`);
    r = await call("chikin_act", { id: rowNamed(snap, "Buy").id });
    check(`${label} invalidates the click's own guard`, r.isError && (await clicks()) === n, textOf(r).slice(0, 200));
  }

  snap = await snapshot();
  const acts = snap.actions;
  const kinds = (pred) => [...new Set(acts.filter(pred).map((a) => a.kind))].sort().join(",");
  check("checkbox and radio rows are click-only", kinds((a) => a.role === "checkbox") === "click" && kinds((a) => a.role === "radio") === "click");
  check("a read-only field is click-only", kinds((a) => a.label === "Read only") === "click");
  check("disabled controls and password values never appear", !acts.some((a) => a.label === "Disabled" || a.value === "never expose this"));
  check(
    "a native select offers only its enabled, unselected options",
    JSON.stringify(acts.filter((a) => a.kind === "select").map((a) => a.value)) === '["Design"]',
    JSON.stringify(acts.filter((a) => a.kind === "select").map((a) => a.value)),
  );

  r = await call("chikin_act", { id: acts.find((a) => a.kind === "select").id });
  check("a native dropdown selects the observed option", !r.isError && (await page("return document.querySelector('#category').value;")) === "Design", textOf(r).slice(0, 200));

  await page(
    "document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'},60)); return true;",
  );
  snap = await snapshot();
  const field = snap.actions.find((a) => a.kind === "fill");
  r = await call("chikin_act", { id: field.id, text: "Generated" });
  const after = r.structuredContent;
  check(
    "a fill waits for asynchronous combobox suggestions and returns them",
    !r.isError &&
      (await page("return document.querySelector('#query').value;")) === "Generated" &&
      (after?.actions ?? []).some((a) => a.role === "option"),
    textOf(r).slice(0, 300),
  );

  const stale = after.actions.find((a) => a.kind === "fill");
  await call("navigate_page", { type: "url", url: "about:blank" });
  r = await call("chikin_act", { id: stale.id, text: "x" });
  check("a navigation invalidates the old document's rows", r.isError, textOf(r).slice(0, 200));

  // --- a link that wraps onto a short second line (#113) ---------------------
  // Its bounding box's centre lands in the gap beside the second line, where
  // elementFromPoint finds the container: the shape of every multi-line
  // result link (GitHub's issue list was the live case).
  await page(
    `document.body.innerHTML='<div style="width:640px;line-height:40px;font:14px sans-serif"><a id="wrap" href="#" ' +
      'onclick="window.clicks=(window.clicks||0)+1; return false">A long result title that fills the first line of its block<br>x</a></div>'; window.clicks=0; return true;`,
  );
  const premise = await page(
    "const a=document.querySelector('#wrap'); const r=a.getBoundingClientRect(); return [a.getClientRects().length, a.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2))];",
  );
  check("premise: the wrapped link's box centre misses it", premise?.[0] >= 2 && premise?.[1] === false, JSON.stringify(premise));
  snap = await snapshot();
  const wrapped = snap.actions.find((a) => a.label.startsWith("A long result title"));
  r = await call("chikin_act", { id: wrapped.id });
  check("a wrapped link is clicked on one of its own lines, not refused as covered", !r.isError && (await clicks()) === 1, textOf(r).slice(0, 200));
  await page(
    "const c=document.createElement('div'); c.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(c); return true;",
  );
  snap = await snapshot();
  r = await call("chikin_act", { id: snap.actions.find((a) => a.label.startsWith("A long result title"))?.id ?? "e1" });
  check("...and still refused when an overlay covers every line", r.isError && (await clicks()) === 1, textOf(r).slice(0, 200));

  // --- a click that navigates (a real cross-site link) -----------------------
  await call("navigate_page", { type: "url", url: "https://example.com/" });
  snap = await snapshot();
  const link = snap.actions.find((a) => a.role === "link");
  const t0 = performance.now();
  r = await call("chikin_act", { id: link.id });
  const ms = Math.round(performance.now() - t0);
  check(
    "a click that navigates answers with the NEW page's table",
    !r.isError && r.structuredContent?.url && !r.structuredContent.url.startsWith("https://example.com/"),
    `${ms}ms: ${textOf(r).slice(0, 200)}`,
  );
  console.log(`      (cross-site click, settle and read of ${r.structuredContent?.url}: ${ms} ms round trip)`);
} finally {
  try { await transport.terminateSession(); } catch {}
  try { await client.close(); } catch {}
  if (!existedBefore) {
    try { docker("rm", "-f", `chikin-chrome-${NAME}`); } catch {}
    try { docker("volume", "rm", `chikin-profile-${NAME}`); } catch {}
    console.log(`removed chikin-chrome-${NAME} and chikin-profile-${NAME} (created by this run)`);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall guard checks passed");
process.exit(failures ? 1 : 0);
