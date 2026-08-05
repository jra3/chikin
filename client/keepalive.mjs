// Holds a chikin browser open — and alive — while a human logs into sites by
// hand at http://localhost:8080/vnc/<name>/ (noVNC traffic never reaches the
// gateway's MCP activity clocks, so nothing else keeps that window around).
//
// It has to DRIVE the browser, not just sit on a session, because of two things:
//
//   1. Since issue #63 a browser is provisioned LAZILY, on the first real
//      browser tool call. Connecting creates only a session — no container, and
//      so /vnc/<name>/ 502s. Something must make a browser tool call before
//      there is anything to log into.
//   2. The attached-tier reap clock (ATTACHED_IDLE_TTL_SEC, issue #57) is
//      stamped only by forwarded `tools/call`s — never by `ping`, which by
//      design refreshes the plain idle clock instead. Pinging an attached
//      session therefore cannot save its browser from being reclaimed.
//
// So: identify, make one browser tool call to provision, then repeat a cheap
// one on a timer to keep `lastBrowserActivity` fresh. `list_pages` is used for
// both — it is a forwarded tool call (real browser work) but doesn't disturb
// whatever the human is doing in the window. The `ping` loop stays, keeping the
// plain idle clock and the session warm between beats.
//
// Usage: node keepalive.mjs [http://localhost:8080/b/<name>/]
//        GATEWAY_TOKEN=<token>   if the gateway requires a bearer
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BROWSER_BEAT_MS = 300000; // must stay well under ATTACHED_IDLE_TTL_SEC
const PING_MS = 60000;

const url = new URL(process.argv[2] || "http://localhost:8080/b/golden/");
const name = url.pathname.split("/").filter(Boolean).pop() ?? "golden";
// Handle rule (gateway names.ts): 1-32 chars, [a-z0-9-], no leading/trailing dash.
const handle = `keepalive-${name}`.slice(0, 32).replace(/-+$/, "");
const vnc = new URL(`/vnc/${name}/`, url).href;
const token = process.env.GATEWAY_TOKEN;

const transport = new StreamableHTTPClientTransport(
  url,
  token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
);
const client = new Client({ name: "chikin-keepalive", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

// Browser tools are gated until the session identifies.
await client.callTool({ name: "chikin_identify", arguments: { handle } });

// The call that actually creates chikin-chrome-<name>, and with it the noVNC URL.
const beat = () => client.callTool({ name: "list_pages", arguments: {} });
await beat();

console.log(`keepalive: holding ${name} as '${handle}' — log in at ${vnc} (kill to release)`);
setInterval(
  () => beat().catch((e) => console.error(`keepalive: browser beat failed: ${e.message}`)),
  BROWSER_BEAT_MS,
);
setInterval(
  () => client.ping().catch((e) => console.error(`keepalive: ping failed: ${e.message}`)),
  PING_MS,
);
setInterval(() => {}, 1 << 30); // never exit on its own
