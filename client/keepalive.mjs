// Holds an MCP session open to a named browser so it isn't idle-reaped while a
// human logs in via noVNC (noVNC traffic doesn't refresh the gateway's activity
// clock). Usage: node keepalive.mjs http://localhost:8080/b/<name>/
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] || "http://localhost:8080/b/golden/";
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "chikin-keepalive", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
console.log(`keepalive: holding ${url} (ping every 60s; kill to release)`);
setInterval(() => client.ping().catch(() => {}), 60000);
setInterval(() => {}, 1 << 30); // never exit on its own
