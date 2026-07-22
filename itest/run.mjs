import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = process.env.GATEWAY_TOKEN ?? "testtoken-abc123";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}  ${detail}`);
    failed++;
  }
}

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "itest", version: "0.0.0" },
  },
};

async function rawPost(path, { token, body, headers } = {}) {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body ?? INIT_BODY),
  });
  return res;
}

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${name}/`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "itest", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function teardown({ client, transport }) {
  try {
    await transport.terminateSession?.();
  } catch {}
  try {
    await client.close();
  } catch {}
}

// chikin_identify is required before any browser tool (breaking-change gate).
async function identify(client, handle, description) {
  return client.callTool({
    name: "chikin_identify",
    arguments: { handle, ...(description ? { description } : {}) },
  });
}

// evaluate a function in the page and return the raw text payload
async function evalText(client, fn) {
  const r = await client.callTool({ name: "evaluate_script", arguments: { function: fn } });
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

const sessions = [];
try {
  console.log("== Auth ==");
  check("missing token -> 401", (await rawPost("/b/alice/")).status === 401);
  check("bad token -> 401", (await rawPost("/b/alice/", { token: "wrong" })).status === 401);

  console.log("== Validation ==");
  check(
    "invalid name -> 400",
    (await rawPost("/b/Bad_Name/", { token: TOKEN })).status === 400,
  );
  check(
    "no session id + non-initialize -> 400",
    (await rawPost("/b/alice/", { token: TOKEN, body: { jsonrpc: "2.0", id: 9, method: "tools/list" } }))
      .status === 400,
  );

  console.log("== Provision alice + tools + egress ==");
  const alice = await connect("alice");
  sessions.push(alice);
  check("alice initialize", alice.client.getServerVersion()?.name === "chrome_devtools");
  const tools = await alice.client.listTools();
  check("alice exposes chrome-devtools tools", tools.tools.length > 20, `got ${tools.tools.length}`);
  const toolNames = new Set(tools.tools.map((t) => t.name));
  check("tools/list includes chikin_identify", toolNames.has("chikin_identify"));
  check("tools/list includes chikin_reset", toolNames.has("chikin_reset"));

  console.log("== Identify gate ==");
  const blocked = await alice.client.callTool({ name: "new_page", arguments: { url: "https://example.com/" } });
  check(
    "browser tool before identify -> instructive error",
    blocked.isError === true && /chikin_identify/.test((blocked.content ?? []).map((c) => c.text ?? "").join("")),
    JSON.stringify(blocked).slice(0, 120),
  );
  const ident = await identify(alice.client, "alice-itest", "itest driver");
  check("chikin_identify succeeds", ident.isError !== true, JSON.stringify(ident).slice(0, 120));

  await alice.client.callTool({ name: "new_page", arguments: { url: "https://example.com/" } });
  const aliceTitle = await evalText(alice.client, "() => document.title");
  check("alice browsed example.com (egress works, post-identify)", /Example Domain/.test(aliceTitle), aliceTitle.slice(0, 80));

  console.log("== Single active session per name ==");
  const dupe = await rawPost("/b/alice/", { token: TOKEN });
  check("concurrent connect to alice -> 409", dupe.status === 409, `got ${dupe.status}`);

  console.log("== Profile isolation alice vs bob ==");
  const aliceSet = await evalText(
    alice.client,
    "() => { localStorage.setItem('chikin','alice-secret'); return localStorage.getItem('chikin'); }",
  );
  check("alice set localStorage", /alice-secret/.test(aliceSet), aliceSet.slice(0, 80));

  const bob = await connect("bob");
  sessions.push(bob);
  const dupeHandle = await identify(bob.client, "alice-itest");
  check(
    "handle already held by a live session -> error",
    dupeHandle.isError === true && /already in use/.test((dupeHandle.content ?? []).map((c) => c.text ?? "").join("")),
    JSON.stringify(dupeHandle).slice(0, 120),
  );
  await identify(bob.client, "bob-itest");
  await bob.client.callTool({ name: "new_page", arguments: { url: "https://example.com/" } });
  const bobRead = await evalText(bob.client, "() => String(localStorage.getItem('chikin'))");
  check(
    "bob cannot see alice's localStorage (isolated profile)",
    !/alice-secret/.test(bobRead),
    `bob read: ${bobRead.slice(0, 80)}`,
  );

  console.log("== Fleet cap (MAX_FLEET) ==");
  // alice + bob are live. Provision carol (=3 if cap is 3), then dave must fail.
  const carol = await connect("carol");
  sessions.push(carol);
  check("carol provisioned (within cap)", carol.client.getServerVersion()?.name === "chrome_devtools");
  const dave = await rawPost("/b/dave/", { token: TOKEN });
  check("provision past MAX_FLEET -> 429", dave.status === 429, `got ${dave.status}`);

  console.log("== Dashboard ==");
  const dash = await fetch(`${BASE}/`);
  const dashHtml = await dash.text();
  check("dashboard 200", dash.status === 200);
  check("dashboard lists alice", /alice/.test(dashHtml));
  check("dashboard lists bob", /bob/.test(dashHtml));

  console.log("== noVNC reverse proxy ==");
  const vnc = await fetch(`${BASE}/vnc/alice/vnc.html`);
  const vncBody = await vnc.text();
  check("/vnc/alice/vnc.html 200", vnc.status === 200, `got ${vnc.status}`);
  check("vnc.html looks like noVNC", /noVNC|canvas|vnc/i.test(vncBody));
  check("vnc.html title carries alice's handle", /<title>alice-itest · chikin<\/title>/.test(vncBody), vncBody.slice(0, 200));
  const vncAsset = await fetch(`${BASE}/vnc/alice/app/ui.js`);
  check("vnc static asset proxied", vncAsset.status === 200, `got ${vncAsset.status}`);

  console.log("== Reconnect after clean close frees the name ==");
  await teardown(bob);
  sessions.splice(sessions.indexOf(bob), 1);
  // give the gateway a moment to process the DELETE
  await new Promise((r) => setTimeout(r, 500));
  const bob2 = await connect("bob");
  sessions.push(bob2);
  check("bob reconnects after terminateSession", bob2.client.getServerVersion()?.name === "chrome_devtools");
  // profile persisted: bob set nothing, but the container/volume is reused
  const bobOrigin = await (async () => {
    await identify(bob2.client, "bob-itest"); // handle freed when bob disconnected
    await bob2.client.callTool({ name: "new_page", arguments: { url: "https://example.com/" } });
    return evalText(bob2.client, "() => location.origin");
  })();
  check("bob2 usable after reconnect", /example\.com/.test(bobOrigin), bobOrigin.slice(0, 80));
} finally {
  for (const s of sessions) await teardown(s);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
