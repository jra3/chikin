// Synthetic login site, run only by chikin-demo.mjs in its own disposable container.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
const password = process.env.CHIKIN_DEMO_PASSWORD;
if (!password) throw new Error('Synthetic password missing');
const sessions = new Set();
const metrics = { attempts: 0, accepted: 0, accountReads: 0, logouts: 0 };
const style = `<style>body{font:18px/1.6 system-ui;color:#203e34;background:#f4f6f0;max-width:760px;margin:70px auto;padding:24px}main{background:white;padding:40px;border:1px solid #d6dfd4;border-radius:12px}h1{font-size:38px;line-height:1.15}label{display:block;margin:18px 0}input,button{font:inherit;padding:10px;border:1px solid #b7cbbd;border-radius:6px}input{display:block}button{background:#285c43;color:white;cursor:pointer}.tag{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#587360}.success{color:#246740}small{color:#627462}a{color:#285c43}</style>`;
const page = content => `<!doctype html><html><head><meta charset="utf-8"><title>Chikin credential login demo</title>${style}</head><body><div class="tag">Chikin · synthetic login site · #116</div><main>${content}</main></body></html>`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
  const send = (status, content, type='text/html') => {res.writeHead(status, {'Content-Type':type});res.end(content);};
  const sid = /(?:^|;\s*)demo_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  if (req.method === 'GET' && req.url === '/login') return send(200, page('<h1>Sign in to Demo Accounts</h1><p>A trusted broker fills this form inside a real Chikin Browser.</p><form method="post" action="/login"><label>Username<input id="username" name="username" autocomplete="username" required></label><label>Password<input id="password" name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form><p><small>Only generated, disposable credentials are accepted here.</small></p>'));
  if (req.method === 'POST' && req.url === '/login') {
    let raw=''; for await(const chunk of req){raw+=chunk;if(raw.length>8192){return send(413,'Too large');}}
    const form=new URLSearchParams(raw);metrics.attempts++;
    if(form.get('username')!=='demo-user'||form.get('password')!==password)return send(401,page('<h1>Sign-in refused</h1>'));
    const session=randomBytes(24).toString('hex');sessions.add(session);metrics.accepted++;
    res.writeHead(303,{Location:'/account','Set-Cookie':`demo_session=${session}; HttpOnly; SameSite=Strict; Path=/`});return res.end();
  }
  if (req.method === 'GET' && req.url === '/account') {
    if(!sessions.has(sid)){res.writeHead(303,{Location:'/login'});return res.end();}
    metrics.accountReads++;
    return send(200,page('<div class="success">● Authenticated in a real Chikin Browser</div><h1>Welcome, demo-user.</h1><p id="account-marker">Your demo account is ready.</p><p>The broker submitted the login. The agent received the result without receiving the password.</p><dl><dt>Account</dt><dd>Demo Accounts / sandbox</dd><dt>Example task</dt><dd>Invoice INV-DEMO-001 · $42 · Paid</dd></dl><form method="post" action="/logout"><button>Sign out</button></form><p><small>This session is synthetic. It is separate from the grant that authorized the login.</small></p>'));
  }
  if (req.method === 'POST' && req.url === '/logout') {sessions.delete(sid);metrics.logouts++;res.writeHead(303,{Location:'/login','Set-Cookie':'demo_session=; HttpOnly; Max-Age=0; Path=/'});return res.end();}
  if (req.method === 'GET' && req.url === '/metrics') return send(200,JSON.stringify(metrics),'application/json');
  return send(404,'Not found');
});
server.listen(43116,'0.0.0.0');
