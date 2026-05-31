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
async function evalText(client, fn) {
  const r = await client.callTool({ name: "evaluate_script", arguments: { function: fn } });
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

const s = await connect(name);
if (mode === "mark") {
  await s.client.callTool({ name: "new_page", arguments: { url: "https://example.com/" } });
  await evalText(s.client, `() => localStorage.setItem('reapmark', ${JSON.stringify(arg)})`);
  const got = await evalText(s.client, "() => localStorage.getItem('reapmark')");
  console.log("SET", got.includes(arg) ? "ok" : got.slice(0, 60));
  await teardown(s);
} else if (mode === "read") {
  await s.client.callTool({ name: "new_page", arguments: { url: "https://example.com/" } });
  const got = await evalText(s.client, "() => String(localStorage.getItem('reapmark'))");
  console.log("MARKER=" + got.replace(/\s+/g, " ").trim());
  await teardown(s);
} else if (mode === "hold") {
  // Stay connected (keeps the SSE stream open) for arg seconds.
  await new Promise((r) => setTimeout(r, Number(arg) * 1000));
  console.log("HELD");
  await teardown(s);
}
