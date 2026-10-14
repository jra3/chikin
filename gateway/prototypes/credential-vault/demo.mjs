/** Executable walkthrough, not a production test suite. All credentials are synthetic. */
import { startPrototype } from './broker.mjs';
const app = await startPrototype({port:0,ttlMs:1500});
const transcript=[];
const knownSecrets=new Set(app.secretValues());
async function call(path,key,body,extraHeaders={}) {
 const response=await fetch(app.base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...extraHeaders},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await response.json();const record={status:response.status,...value};transcript.push(record);
 for(const secret of app.secretValues())knownSecrets.add(secret);
 return record;
}
function expect(label,value,predicate){if(!predicate(value))throw new Error(`${label}: unexpected ${JSON.stringify(value)}`);console.log(`PASS ${label}: ${JSON.stringify(value)}`);}
const grant=async(operation,uses=1)=>call('/operator/grants',app.operatorKey,{actor:'research-agent',operation,uses});
const use=async(g,key=app.agentKey,extras={})=>call('/agent/execute',key,{grantId:g.id,operation:g.operation,...extras});
try {
 const api=await grant('invoices.read');
 expect('unauthenticated agent',await use(api,'invalid'),r=>r.status===401);
 expect('agent cannot approve itself',await call('/operator/grants',app.agentKey,{actor:'research-agent',operation:'invoices.read'}),r=>r.status===401);
 expect('wrong agent',await use(api,app.otherAgentKey),r=>r.error==='wrong_agent');
 expect('wrong operation',await use(api,app.agentKey,{operation:'account.read'}),r=>r.error==='wrong_operation');
 expect('destination override',await use(api,app.agentKey,{url:'https://unapproved.example.test/'}),r=>r.error==='caller_override_refused');
 expect('body identity override',await use(api,app.agentKey,{actor:'other-agent'}),r=>r.error==='caller_override_refused');
 expect('cross-origin request',await call('/agent/execute',app.agentKey,{grantId:api.id,operation:api.operation},{Origin:'https://unapproved.example.test'}),r=>r.error==='origin_refused');
 expect('authenticated API read',await use(api),r=>r.status===200&&r.result.totalUSD===42);
 expect('replay refused',await use(api),r=>r.error==='exhausted');
 const web=await grant('account.read',3);
 expect('website login and account read',await use(web),r=>r.status===200&&r.result.authenticated);
 expect('website session reused',await use(web),r=>r.status===200&&r.remaining===1);
 const before=await call('/operator/state',app.operatorKey);
 expect('session retained only by broker',{sessions:before.sessions.length,logins:before.evidence.webAuthenticated},r=>r.sessions===1&&r.logins===1);
 expect('revoke and logout',await call('/operator/revoke',app.operatorKey,{grantId:web.id}),r=>r.revoked===true);
 expect('revoked grant',await use(web),r=>r.error==='revoked');
 const race=await grant('invoices.read');
 const concurrent=await Promise.all([use(race),use(race)]);
 expect('one allowance under concurrency',{statuses:concurrent.map(r=>r.status).sort()},r=>r.statuses.join(',')==='200,403');
 const parallelWeb=await grant('account.read',3);
 const webRace=await Promise.all([use(parallelWeb),use(parallelWeb)]);
 expect('concurrent website use serialized',{statuses:webRace.map(r=>r.status).sort(),reason:webRace.find(r=>r.status===403)?.error},r=>r.statuses.join(',')==='200,403'&&r.reason==='in_flight');
 await call('/operator/revoke',app.operatorKey,{grantId:parallelWeb.id});
 const expiring=await grant('account.read',3);
 await use(expiring);
 await new Promise(r=>setTimeout(r,1750));
 expect('expired grant',await use(expiring),r=>r.error==='expired');
 const final=await call('/operator/state',app.operatorKey);
 expect('real upstream evidence',final.evidence,r=>r.apiAuthenticated===2&&r.webAuthenticated===3&&r.accountReads===4&&r.logoutCalls===3);
 expect('sessions removed',{retained:final.sessions.length},r=>r.retained===0);
 const exposed=JSON.stringify(transcript);
 if([...knownSecrets].some(secret=>exposed.includes(secret)))throw new Error('Synthetic credential appeared in transcript');
 console.log('PASS no synthetic password, API key, or retained session token appeared in captured HTTP replies or audit state, despite upstream diagnostic echoes.');
 console.log('VERDICT: scoped broker works against real HTTP fixtures. Chrome/CDP, vault backend, persistent storage, MFA and hostile-host isolation remain unproven.');
} finally {await app.close();}
