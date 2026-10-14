// THROWAWAY: cooperative-agent transcript protection, not hostile-CDP isolation.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
// Reuse Chikin's integration-test dependency and its ordinary HTTP/WebSocket transport.
const { chromium } = createRequire(import.meta.url)('playwright-core');

export async function connectCdp(url) {
  const browser = await chromium.connectOverCDP(url, { timeout: 15000 });
  const page = await browser.contexts()[0].newPage();
  const session = await page.context().newCDPSession(page);
  return {
    async send(method, params = {}) {
      let timer;
      try { return await Promise.race([
        session.send(method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP command timed out')), 15000); }),
      ]); } finally { clearTimeout(timer); }
    },
    async close() { await browser.close(); },
  };
}

export async function waitForPage(cdp, sessionId, expression) {
  for(let i=0;i<100;i++){
    try{const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true},sessionId);if(r.result?.value)return r.result.value;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Expected page state did not appear');
}

export function createLoginBroker({cdp,sessionId,origin,resolveCredential}) {
  const grants=new Map(),audit=[];let busy=false;
  function log(actor,decision){audit.push({actor,account:'demo-accounts',decision});}
  // Only the trusted operator/harness calls this method. It is not exposed to the agent.
  function approve(actor,{ttlMs=60_000}={}){const grant={id:randomUUID(),actor,expiresAt:Date.now()+ttlMs,used:false,revoked:false};grants.set(grant.id,grant);return grant.id;}
  function revoke(id){const g=grants.get(id);if(g)g.revoked=true;}
  async function login(actor,request){
    const deny=reason=>{log(actor,reason);return {ok:false,error:reason};};
    if(!request||Object.keys(request).some(k=>!['grantId','account'].includes(k)))return deny('caller_override_refused');
    const g=grants.get(request.grantId);
    if(!g)return deny('unknown_grant');
    if(g.actor!==actor)return deny('wrong_agent');
    if(request.account!=='demo-accounts')return deny('wrong_account');
    if(g.revoked)return deny('revoked');
    if(Date.now()>=g.expiresAt)return deny('expired');
    if(g.used)return deny('exhausted');
    if(busy)return deny('login_in_progress');
    busy=true;g.used=true;
    try{
      // Navigate a broker-owned fresh tab; never inject into an arbitrary caller-selected page.
      await cdp.send('Page.navigate',{url:`${origin}/login`},sessionId);
      await waitForPage(cdp,sessionId,`location.href === ${JSON.stringify(origin+'/login')} && document.readyState === 'complete' && !!document.querySelector('#password')`);
      if(g.revoked||Date.now()>=g.expiresAt)return deny(g.revoked?'revoked':'expired');
      const credential=await resolveCredential('demo-accounts');
      if(g.revoked||Date.now()>=g.expiresAt)return deny(g.revoked?'revoked':'expired');
      // Origin, form destination and field shape are checked in the same invocation that fills/submits.
      const result=await cdp.send('Runtime.callFunctionOn',{
        functionDeclaration:`function(expectedOrigin,username,password){
          if(location.origin!==expectedOrigin||location.pathname!=='/login')return 'origin_refused';
          const user=document.querySelector('#username'),pass=document.querySelector('#password'),form=user?.form;
          if(!form||pass?.form!==form||pass.type!=='password'||form.method!=='post'||new URL(form.action).href!==expectedOrigin+'/login')return 'form_refused';
          user.value=username;pass.value=password;form.requestSubmit();return 'submitted';
        }`,
        objectId:(await cdp.send('Runtime.evaluate',{expression:'globalThis',returnByValue:false},sessionId)).result.objectId,
        arguments:[{value:origin},{value:credential.username},{value:credential.password}],returnByValue:true,
      },sessionId);
      if(result.result?.value!=='submitted')return deny('form_refused');
      await waitForPage(cdp,sessionId,`location.href === ${JSON.stringify(origin+'/account')} && !!document.querySelector('#account-marker')`);
      log(actor,'authenticated');
      return {ok:true,account:'demo-accounts',authenticated:true,session:'available_in_browser'};
    }catch{
      log(actor,'login_outcome_unknown');
      // Never return CDP exception details: page errors and protocol payloads may contain secrets.
      return {ok:false,error:'login_outcome_unknown',retryable:false};
    }finally{busy=false;}
  }
  return {approve,revoke,login,audit};
}
