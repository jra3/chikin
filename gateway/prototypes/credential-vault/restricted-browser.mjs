/** THROWAWAY. A tool-only principal gets no driver, URL, selector, page text or credential. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLoginBroker, waitForPage } from './browser-login.mjs';

const METHODS = ['browser_login', 'invoice_read', 'browser_logout'];
export async function createRestrictedBrowser({cdp,origin,resolveCredential,agentKeys,socketPath}) {
  const loginBroker=createLoginBroker({cdp,origin,resolveCredential});
  const grants=new Map(), audit=[]; let busy=false, owner=null;
  const decision=(actor,method,reason)=>audit.push({actor,method:METHODS.includes(method)?method:'unavailable',decision:reason});
  // Operator-only, never exposed on the HTTP interface. One grant owns this Browser.
  const approve=(actor,{ttlMs=60000}={})=>{
    if(owner)throw new Error('This Browser is already assigned');
    const id=randomUUID();owner=id;
    grants.set(id,{actor,expiresAt:Date.now()+ttlMs,revoked:false,state:'fresh',reads:3,loginId:loginBroker.approve(actor,{ttlMs})});
    return id;
  };
  const revoke=id=>{const g=grants.get(id);if(g){g.revoked=true;loginBroker.revoke(g.loginId);}};
  async function call(actor,request) {
    const method=request?.method;
    const deny=reason=>{decision(actor,method,reason);return {ok:false,error:reason};};
    if(!request||Array.isArray(request)||Object.keys(request).some(k=>!['grantId','method'].includes(k)))return deny('arguments_refused');
    if(!METHODS.includes(method))return deny('tool_unavailable');
    const g=grants.get(request.grantId);
    if(!g)return deny('unknown_grant');
    if(g.actor!==actor)return deny('wrong_agent');
    if(g.revoked)return deny('revoked');
    if(Date.now()>=g.expiresAt)return deny('expired');
    if(busy)return deny('operation_in_progress');
    if(method==='browser_login'&&g.state!=='fresh')return deny('login_already_used');
    if(method!=='browser_login'&&g.state!=='authenticated')return deny('not_authenticated');
    if(method==='invoice_read'&&g.reads===0)return deny('read_allowance_exhausted');
    busy=true;
    try {
      if(method==='browser_login'){
        g.state='login_started';
        const result=await loginBroker.login(actor,{grantId:g.loginId,account:'demo-accounts'});
        if(!result.ok)return deny(result.error);
        g.state='authenticated';
        decision(actor,method,'allowed');
        return {ok:true,authenticated:true,account:'demo-accounts'};
      }
      // Observe only the exact approved page. No agent input is interpolated into executable code.
      const check=await cdp.send('Runtime.evaluate',{expression:`location.href === ${JSON.stringify(origin+'/account')} && !!document.querySelector('#account-marker')`,returnByValue:true});
      if(check.result?.value!==true)return deny('page_refused');
      // Re-check after the asynchronous observation, before another operation starts.
      if(g.revoked||Date.now()>=g.expiresAt)return deny(g.revoked?'revoked':'expired');
      if(method==='invoice_read'){
        g.reads--;
        const response=await cdp.send('Runtime.evaluate',{expression:`(()=>{if(location.href!==${JSON.stringify(origin+'/account')})return null;const e=document.querySelector('#invoice');return e?{total:e.getAttribute('data-total'),status:e.getAttribute('data-status')}:null;})()`,returnByValue:true});
        const value=response.result?.value;
        if(!value||!/^\d{1,6}(\.\d{1,2})?$/.test(value.total)||!['paid','unpaid'].includes(value.status))return deny('result_schema_refused');
        decision(actor,method,'allowed');
        return {ok:true,invoice:{totalUSD:Number(value.total),status:value.status}};
      }
      // Logout is a fixed action with same-origin form validation; no arbitrary click/fill surface.
      g.state='logout_started';
      const response=await cdp.send('Runtime.evaluate',{expression:`(()=>{if(location.href!==${JSON.stringify(origin+'/account')})return false;const f=document.querySelector('form');if(!f||f.method!=='post'||f.action!==${JSON.stringify(origin+'/logout')})return false;f.requestSubmit();return true;})()`,returnByValue:true});
      if(response.result?.value!==true)return deny('form_refused');
      await waitForPage(cdp,undefined,`location.href===${JSON.stringify(origin+'/login')} && !!document.querySelector('#password')`);
      g.state='logged_out';decision(actor,method,'allowed');return {ok:true,signedOut:true};
    }catch{decision(actor,method,'outcome_unknown');return {ok:false,error:'outcome_unknown',retryable:false};}
    finally{busy=false;}
  }
  const server=http.createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const host='vault-broker';
    if(req.headers.host!==host||req.headers.origin)return reply(403,{error:'origin_refused'});
    const actor=agentKeys.get(req.headers.authorization?.replace(/^Bearer /,''));
    if(!actor)return reply(401,{error:'agent_auth_required'});
    if(req.method==='GET'&&req.url==='/tools')return reply(200,{tools:METHODS});
    if(req.method!=='POST'||req.url!=='/call')return reply(404,{error:'not_found'});
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)return reply(413,{error:'request_too_large'});}
      const result=await call(actor,JSON.parse(raw));return reply(result.ok?200:403,result);
    }catch{return reply(400,{error:'invalid_request'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  return {socketPath,approve,revoke,audit,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
