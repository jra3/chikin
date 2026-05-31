#!/usr/bin/env node
// Transparent stdio<->HTTP MCP bridge.
//
// Claude Code (and most MCP clients) speak MCP over stdio to a subprocess. The
// chikin gateway speaks MCP over Streamable HTTP at /b/<name>/. This bridge
// pumps frames between the two so a stdio client can drive a browser behind the
// gateway. The per-instance browser name is baked into the URL (argv[2]) by the
// chikin-mcp launcher, so every Claude instance gets its own multiplexed browser.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  process.stderr.write("chikin bridge: missing gateway URL argument\n");
  process.exit(64);
}

const token = process.env.CHIKIN_TOKEN;
const httpOpts = token
  ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  : undefined;

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(new URL(url), httpOpts);

// Transparent two-way pump. Every frame is forwarded verbatim; the HTTP
// transport handles session-id capture and the server->client SSE stream.
stdio.onmessage = (m) =>
  http.send(m).catch((e) => process.stderr.write(`chikin bridge ->gateway: ${e?.message ?? e}\n`));
http.onmessage = (m) =>
  stdio.send(m).catch((e) => process.stderr.write(`chikin bridge ->client: ${e?.message ?? e}\n`));

stdio.onclose = () => void http.close().catch(() => {});
http.onclose = () => {
  void stdio.close().catch(() => {});
  process.exit(0);
};
http.onerror = (e) => process.stderr.write(`chikin bridge gateway error: ${e?.message ?? e}\n`);

await http.start();
await stdio.start();
process.stderr.write(`chikin bridge: linked stdio <-> ${url}\n`);
