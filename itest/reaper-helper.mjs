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

// The gateway reports a refusal — the identify gate (#54), fleet-full, a handle
// already claimed, a provisioning failure — as a normal tool result with
// `isError: true`, NOT by throwing. So an unchecked call returns the refusal
// text and reads exactly like data: that is how `mark`/`read` spent from #54 to
// #66 printing SET/MARKER= lines carrying the gate's error message where the
// localStorage marker should have been, asserting nothing while looking green.
// Every browser call in this file goes through here.
async function call(s, tool, args, label) {
  const res = await s.client.callTool({ name: tool, arguments: args });
  if (res?.isError) {
    const text = textOf(res).trim();
    console.error(`${label} FAILED: ${tool} for '${name}': ${text || "(no message)"}`);
    await teardown(s);
    process.exit(1);
  }
  return res;
}

// Browser tools are gated on chikin_identify (#54), so every mode that drives
// the browser must identify first. Handles share the browser-name charset
// (`[a-z0-9-]`, 1-32, no leading/trailing dash — HANDLE_RULE in
// gateway/src/names.ts), hence the trim.
const handleFor = (m, n) => `itest-${m}-${n}`.slice(0, 32).replace(/-+$/, "");

if (!mode || !name) {
  console.error("usage: reaper-helper.mjs <mark|read|hold> <browser-name> [marker|seconds]");
  process.exit(2);
}

const s = await connect(name);

if (mode === "mark" || mode === "read") {
  const label = mode.toUpperCase();
  await call(s, "chikin_identify", { handle: handleFor(mode, name) }, label);
  // new_page is the first browser tool call, so it is also what provisions the
  // container (lazy provisioning, #63) and gives evaluate_script a page.
  await call(s, "new_page", { url: "https://example.com/" }, label);

  if (mode === "mark") {
    if (arg === undefined) {
      console.error("MARK FAILED: no marker value given");
      await teardown(s);
      process.exit(2);
    }
    await call(
      s,
      "evaluate_script",
      { function: `() => localStorage.setItem('reapmark', ${JSON.stringify(arg)})` },
      label,
    );
    const got = textOf(await call(s, "evaluate_script", { function: "() => localStorage.getItem('reapmark')" }, label));
    console.log("SET", got.includes(arg) ? "ok" : got.slice(0, 60));
  } else {
    const got = textOf(await call(s, "evaluate_script", { function: "() => String(localStorage.getItem('reapmark'))" }, label));
    console.log("MARKER=" + got.replace(/\s+/g, " ").trim());
  }
  await teardown(s);
} else if (mode === "hold") {
  // Hold a REAL browser attached for arg seconds. Connecting is not enough:
  // since issue #63 it provisions nothing, and the reaper skips names with no
  // container — so a connect-only session holds no fleet slot and blocks no
  // reap. Identify, then make one browser tool call to force the container into
  // existence, and only then stay attached with the SSE stream open, which is
  // what the attached-tier TTL measures. Sleeping past a refused call would
  // print HELD while holding no browser and no fleet slot, so `call` exits.
  await call(s, "chikin_identify", { handle: handleFor("hold", name) }, "HOLD");
  await call(s, "list_pages", {}, "HOLD");
  await new Promise((r) => setTimeout(r, Number(arg) * 1000));
  console.log("HELD");
  await teardown(s);
} else {
  console.error(`unknown mode '${mode}' (expected mark, read or hold)`);
  await teardown(s);
  process.exit(2);
}
