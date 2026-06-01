// Minimal CDP helper over the browser-level WebSocket (node 22+ global WebSocket).
// Usage: node cdp-cookie.mjs <ip> set|get
// `set` writes a cookie into the DEFAULT (persistent) browser context;
// `get` lists browser cookies. Used to prove seed/clone cookie portability.
const ip = process.argv[2];
const mode = process.argv[3] || "get";
const NAME = "chikincdp";
const VALUE = "CDPSEED456";

const ver = await (await fetch(`http://${ip}:9222/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
await new Promise((r) => (ws.onopen = r));

if (mode === "set") {
  await send("Storage.setCookies", {
    cookies: [
      {
        name: NAME,
        value: VALUE,
        domain: "example.com",
        path: "/",
        secure: true,
        expires: Math.floor(Date.now() / 1000) + 86400 * 30,
      },
    ],
  });
  console.log(`set ${NAME}=${VALUE} in default context`);
}
const got = await send("Storage.getCookies");
const mine = (got.cookies || []).filter((c) => c.name === NAME);
console.log(`browser has ${NAME}: ${mine.length ? mine[0].value : "(none)"}`);
ws.close();
process.exit(0);
