/** THROWAWAY PROTOTYPE — synthetic credentials only; never connect a real vault. */
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const token = () => randomBytes(24).toString('hex');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
async function json(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('body_too_large'); }
  return JSON.parse(body || '{}');
}

export async function startPrototype({ port = 43871, ttlMs = 60_000 } = {}) {
  // The fixture is a separate HTTP listener. Its synthetic secrets never go to the UI or agent replies.
  const secrets = { api: token(), password: token() };
  const operatorKey = token();
  const agents = new Map([[token(), 'research-agent'], [token(), 'other-agent']]);
  const agentKey = [...agents.keys()][0];
  const otherAgentKey = [...agents.keys()][1];
  const grants = new Map();
  const inFlight = new Set();
  const audit = [];
  const fixtureSessions = new Set();
  const sessions = new Map();
  const evidence = { apiAuthenticated: 0, webAuthenticated: 0, accountReads: 0, logoutCalls: 0 };
  const fixture = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/invoices') {
      if (!equal(req.headers.authorization, `Bearer ${secrets.api}`)) return reply(res, 401, { error: 'unauthorized' });
      evidence.apiAuthenticated++;
      return reply(res, 200, { invoices: [{ id: 'INV-DEMO-001', amount: 42, currency: 'USD', status: 'paid' }], diagnostic: { echoedToken: secrets.api } });
    }
    if (req.method === 'POST' && req.url === '/login') {
      const body = await json(req).catch(() => ({}));
      if (body?.username !== 'demo@example.test' || !equal(body?.password, secrets.password)) return reply(res, 401, { error: 'unauthorized' });
      const sid = token(); fixtureSessions.add(sid); evidence.webAuthenticated++;
      res.setHeader('Set-Cookie', `fixture_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
      return reply(res, 200, { authenticated: true });
    }
    const sid = /^fixture_session=([a-f0-9]+)$/.exec(req.headers.cookie || '')?.[1];
    if (req.method === 'GET' && req.url === '/account') {
      if (!fixtureSessions.has(sid)) return reply(res, 401, { error: 'unauthorized' });
      evidence.accountReads++;
      return reply(res, 200, { account: 'Demo account', plan: 'sandbox', authenticated: true, diagnostic: { echoedCookie: sid, echoedPassword: secrets.password } });
    }
    if (req.method === 'POST' && req.url === '/logout') {
      fixtureSessions.delete(sid); evidence.logoutCalls++;
      return reply(res, 200, { loggedOut: true });
    }
    reply(res, 404, { error: 'not_found' });
  });
  const upstream = await listen(fixture, 0);
  const operations = {
    'invoices.read': { credential: 'demo-api', target: `${upstream}/api/invoices`, method: 'GET', mode: 'api' },
    'account.read': { credential: 'demo-login', target: `${upstream}/account`, method: 'GET', mode: 'web' },
  };
  const view = () => ({ inFlight: [...inFlight], grants: [...grants.values()], sessions: [...sessions.keys()], evidence, audit, operations });
  function record(actor, operation, decision, grantId = null) {
    audit.push({ at: new Date().toISOString(), actor, operation, decision, grantId: typeof grantId === 'string' && grants.has(grantId) ? grantId : null });
  }
  function deny(res, actor, operation, reason, grantId) {
    record(actor, typeof operation === 'string' && Object.hasOwn(operations, operation) ? operation : 'unknown', reason, grantId);
    return reply(res, 403, { error: reason });
  }
  async function dropSession(id) {
    const cookie = sessions.get(id);
    sessions.delete(id);
    if (cookie) await fetch(`${upstream}/logout`, { method: 'POST', headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(3000) });
  }
  async function execute(req, res, body, actor) {
    const { grantId, operation } = body;
    // The caller chooses only a named operation. Destination, headers, body and identity are broker-owned.
    if (Object.keys(body).some(k => !['grantId', 'operation'].includes(k))) return deny(res, actor, operation, 'caller_override_refused', grantId);
    const grant = grants.get(grantId);
    if (!grant) return deny(res, actor, operation, 'unknown_grant', null);
    if (grant.actor !== actor) return deny(res, actor, operation, 'wrong_agent', grantId);
    if (grant.operation !== operation) return deny(res, actor, operation, 'wrong_operation', grantId);
    if (grant.revoked) return deny(res, actor, operation, 'revoked', grantId);
    if (Date.now() >= grant.expiresAt) { await dropSession(grantId); return deny(res, actor, operation, 'expired', grantId); }
    if (grant.remaining === 0) return deny(res, actor, operation, 'exhausted', grantId);
    // Reserve before awaiting: no duplicate spend or competing session creation.
    if (inFlight.has(grantId)) return deny(res, actor, operation, 'in_flight', grantId);
    inFlight.add(grantId);
    grant.remaining--;
    const op = operations[operation];
    const headers = {};
    try {
      if (op.mode === 'api') headers.authorization = `Bearer ${secrets.api}`;
      else {
        if (!sessions.has(grantId)) {
          const login = await fetch(`${upstream}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo@example.test', password: secrets.password }), redirect: 'error', signal: AbortSignal.timeout(3000) });
          if (!login.ok) throw new Error('login_failed');
          const cookie = login.headers.get('set-cookie')?.split(';')[0];
          if (!cookie || !/^fixture_session=[a-f0-9]+$/.test(cookie)) throw new Error('login_failed');
          sessions.set(grantId, cookie);
        }
        headers.cookie = sessions.get(grantId);
      }
      if (grant.revoked || Date.now() >= grant.expiresAt) {
        await dropSession(grantId);
        return deny(res, actor, operation, grant.revoked ? 'revoked' : 'expired', grantId);
      }
      const response = await fetch(op.target, { method: op.method, headers, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('upstream_failed');
      const value = await response.json();
      // Explicit output projection. Never forward upstream headers, cookies, arbitrary strings, or bodies.
      if (op.mode === 'api' && (!Array.isArray(value.invoices) || value.invoices.length > 100 || value.invoices.some(row => row.currency !== 'USD' || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || Math.abs(row.amount) > 1e9))) throw new Error('invalid_upstream_result');
      const result = op.mode === 'api'
        ? { invoiceCount: value.invoices.length, totalUSD: value.invoices.reduce((sum, row) => sum + row.amount, 0) }
        : { authenticated: value.authenticated === true, accountAvailable: value.account === 'Demo account' };
      record(actor, operation, 'allowed', grantId);
      reply(res, 200, { result, remaining: grant.remaining });
    } catch {
      record(actor, operation, 'outcome_unknown_allowance_consumed', grantId);
      reply(res, 502, { error: 'outcome_unknown', retryable: false, message: 'Allowance consumed. Inspect state before requesting another operation.' });
    } finally {
      if (grant.remaining === 0 || grant.revoked || Date.now() >= grant.expiresAt) await dropSession(grantId).catch(() => {});
      inFlight.delete(grantId);
    }
  }
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return reply(res, 403, { error: 'origin_refused' });
    const path = req.url;
    if (req.method === 'GET' && (path === '/' || path === '/model')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(await readFile(new URL(path === '/' ? './console.html' : './model.html', import.meta.url)));
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const isOperator = equal(bearer, operatorKey);
    const actor = agents.get(bearer);
    if (path?.startsWith('/operator/') && !isOperator) return reply(res, 401, { error: 'operator_auth_required' });
    try {
      if (req.method === 'GET' && path === '/operator/state') return reply(res, 200, view());
      if (req.method === 'POST' && path === '/operator/grants') {
        const body = await json(req);
        if (!Object.hasOwn(operations, body.operation) || !['research-agent', 'other-agent'].includes(body.actor)) return reply(res, 400, { error: 'invalid_grant' });
        const uses = body.uses ?? 1;
        if (!Number.isInteger(uses) || uses < 1 || uses > 3) return reply(res, 400, { error: 'invalid_uses' });
        const grant = { id: randomUUID(), actor: body.actor, operation: body.operation, expiresAt: Date.now() + ttlMs, remaining: uses, revoked: false };
        grants.set(grant.id, grant); record('operator', body.operation, 'granted', grant.id);
        return reply(res, 201, grant);
      }
      if (req.method === 'POST' && path === '/operator/revoke') {
        const { grantId } = await json(req); const grant = grants.get(grantId);
        if (!grant) return reply(res, 404, { error: 'unknown_grant' });
        grant.revoked = true; await dropSession(grantId); record('operator', grant.operation, 'revoked', grantId);
        return reply(res, 200, { revoked: true, note: 'Future calls refused. A request already sent cannot be recalled.' });
      }
      // Deliberate operator-only demonstration bridge. The real /agent/execute route authenticates separately.
      if (req.method === 'POST' && path === '/operator/simulate-agent') {
        const { as = 'research-agent', request } = await json(req);
        if (!['research-agent', 'other-agent'].includes(as)) return reply(res, 400, { error: 'invalid_actor' });
        return await execute(req, res, request, as);
      }
      if (req.method === 'POST' && path === '/agent/execute') {
        if (!actor) return reply(res, 401, { error: 'agent_auth_required' });
        return await execute(req, res, await json(req), actor);
      }
      reply(res, 404, { error: 'not_found' });
    } catch { reply(res, 400, { error: 'invalid_request' }); }
  });
  const base = await listen(server, port);
  const cleanup = setInterval(() => {
    for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) void dropSession(id).catch(() => {});
  }, 250);
  cleanup.unref();
  return {
    base, operatorKey, agentKey, otherAgentKey, upstream,
    // Verification hooks live in the trusted harness, never in an HTTP endpoint.
    secretValues: () => [secrets.api, secrets.password, ...fixtureSessions],
    close: async () => { clearInterval(cleanup); server.closeAllConnections(); fixture.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => fixture.close(r))]); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startPrototype({ port: Number(process.env.VAULT_PROTOTYPE_PORT || 43871) });
  console.log(`Synthetic credential vault prototype\nOperator console: ${app.base}/#${app.operatorKey}\nGrant model: ${app.base}/model\nNo real vault connected. Stop with Ctrl+C.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
