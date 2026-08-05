import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "testtoken-abc123";
const [mode, name, arg] = process.argv.slice(2);

async function connect(n) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${n}/`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "itest", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
async function teardown({ client, transport }) {
  try { await transport.terminateSession?.(); } catch {}
  try { await client.close(); } catch {}
}

const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

// Browser tools are gated on chikin_identify (#54), so every mode that drives
// the browser must identify first. Handles share the browser-name charset
// (`[a-z0-9-]`, 1-32, no leading/trailing dash — HANDLE_RULE in
// gateway/src/names.ts), hence the trim.
const handleFor = (mode, name) => `itest-${mode}-${name}`.slice(0, 32).replace(/-+$/, "");

// --- Usage, checked BEFORE connecting -----------------------------------------
// All of it up front: a usage error must not open a session, and must certainly
// not provision a container (the first browser tool call does — #63) only to
// die on an argument that was never there. Usage exits 2; a gateway refusal
// below exits 1.
const usage = (msg) => {
  console.error(`${msg}\nusage: reaper-helper.mjs <mark|read|hold> <browser-name> [marker|seconds]`);
  process.exit(2);
};
if (!mode || !name) usage("missing mode or browser name");
if (!["mark", "read", "hold"].includes(mode)) usage(`unknown mode '${mode}'`);
if (mode === "mark" && arg === undefined) usage("mark needs a marker value");
// hold's whole contract is a duration, and `Number(undefined) * 1000` is NaN,
// which setTimeout fires immediately — printing HELD having held nothing, exit
// 0. That is the same silent-green failure this file exists to stop.
const seconds = Number(arg);
if (mode === "hold" && !Number.isFinite(seconds)) usage(`hold needs seconds, got ${JSON.stringify(arg)}`);

const label = mode.toUpperCase();
const s = await connect(name);

// The gateway reports a refusal — the identify gate (#54), fleet-full, a handle
// already claimed, a provisioning failure — as a normal tool result with
// `isError: true`, NOT by throwing. So an unchecked call returns the refusal
// text and reads exactly like data: that is how `mark`/`read` spent from #54 to
// #66 printing SET/MARKER= lines carrying the gate's error message where the
// localStorage marker should have been, asserting nothing while looking green.
// Every browser call in this file goes through here.
async function mustCall(tool, args) {
  const res = await s.client.callTool({ name: tool, arguments: args });
  if (res?.isError) {
    const text = textOf(res).trim();
    await die(`${tool} for '${name}': ${text || "(no message)"}`);
  }
  return res;
}
async function die(msg) {
  console.error(`${label} FAILED: ${msg}`);
  await teardown(s);
  process.exit(1);
}

await mustCall("chikin_identify", { handle: handleFor(mode, name) });

if (mode === "mark" || mode === "read") {
  // new_page is the first browser tool call, so it is also what provisions the
  // container (lazy provisioning, #63) and gives evaluate_script a page.
  await mustCall("new_page", { url: "https://example.com/" });

  if (mode === "mark") {
    await mustCall("evaluate_script", {
      function: `() => localStorage.setItem('reapmark', ${JSON.stringify(arg)})`,
    });
    const got = textOf(await mustCall("evaluate_script", { function: "() => localStorage.getItem('reapmark')" }));
    // Read back what we just wrote. A mismatch means the write didn't stick, so
    // it fails loudly too — printing SET with the wrong value and exiting 0 is
    // the same "looks like data" trap as the gate error was.
    if (!got.includes(arg)) await die(`marker did not read back: ${got.slice(0, 120)}`);
    console.log("SET ok");
  } else {
    const got = textOf(await mustCall("evaluate_script", { function: "() => String(localStorage.getItem('reapmark'))" }));
    console.log("MARKER=" + got.replace(/\s+/g, " ").trim());
  }
  await teardown(s);
} else {
  // hold: keep a REAL browser attached for `seconds`. Connecting is not enough:
  // since issue #63 it provisions nothing, and the reaper skips names with no
  // container — so a connect-only session holds no fleet slot and blocks no
  // reap. The identify above plus one browser tool call force the container
  // into existence; only then does staying attached with the SSE stream open
  // mean anything, which is what the attached-tier TTL measures.
  await mustCall("list_pages", {});
  await new Promise((r) => setTimeout(r, seconds * 1000));
  console.log("HELD");
  await teardown(s);
}
