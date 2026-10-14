/** Attack the real HTTP tool interface. Never pass the driver or operator methods to the caller. */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRestrictedBrowser } from './restricted-browser.mjs';
import { waitForPage } from './browser-login.mjs';

export async function exerciseRestricted({cdp,origin,password,gatewayBase,name,confinement,assert,record}) {
  const agentKey=randomBytes(24).toString('hex'),otherKey=randomBytes(24).toString('hex');
  const agentKeys=new Map([[agentKey,'demo-agent'],[otherKey,'other-agent']]);
  const clientDir=await mkdtemp('/tmp/chikin-vault-client-');
  const socketPath=`${clientDir}/client.sock`;
  const options={cdp,origin,resolveCredential:async()=>({username:'demo-user',password}),agentKeys,socketPath};
  const outputs=[];
  async function request(socketPath,path,body,key=agentKey){
    const value=await new Promise((resolve,reject)=>{
      const req=http.request({agent:false,socketPath,host:'vault-broker',path,method:body===undefined?'GET':'POST',headers:{Host:'vault-broker',Authorization:`Bearer ${key}`,'Content-Type':'application/json'}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{resolve({status:res.statusCode,...JSON.parse(raw)});}catch{reject(new Error('Invalid tool reply'));}});});
      req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Tool request timeout')));req.end(body===undefined?undefined:JSON.stringify(body));
    });outputs.push(value);return value;
  }
  // Real expiry clock, with zero lifetime. No navigation or credential use can occur.
  const expired=await createRestrictedBrowser(options);
  try{const id=expired.approve('demo-agent',{ttlMs:0});assert('expired tool grant refused',(await request(expired.socketPath,'/call',{grantId:id,method:'browser_login'})).error==='expired');}finally{await expired.close();}
  // Exercise the allowed logout action as a separate sequential operator-owned session.
  const initial=await createRestrictedBrowser(options);
  try{
    const id=initial.approve('demo-agent');
    assert('restricted login works',(await request(initial.socketPath,'/call',{grantId:id,method:'browser_login'})).authenticated===true);
    assert('restricted logout works',(await request(initial.socketPath,'/call',{grantId:id,method:'browser_logout'})).signedOut===true);
    assert('read after logout refused',(await request(initial.socketPath,'/call',{grantId:id,method:'invoice_read'})).error==='not_authenticated');
  }finally{await initial.close();}
  const broker=await createRestrictedBrowser(options);
  try{
    const grantId=broker.approve('demo-agent');
    const call=(method,extra={},key=agentKey)=>request(broker.socketPath,'/call',{grantId,method,...extra},key);
    const listing=await request(broker.socketPath,'/tools');record('agent tool list',listing);
    assert('only three reviewed operations exposed',listing.tools.join(',')==='browser_login,invoice_read,browser_logout');
    assert('unauthenticated caller refused',(await request(broker.socketPath,'/call',{grantId,method:'browser_login'},'invalid')).status===401);
    assert('wrong principal refused',(await call('browser_login',{},otherKey)).error==='wrong_agent');
    assert('agent cannot approve its own grant',(await request(broker.socketPath,'/operator/approve',{actor:'demo-agent'})).status===404);
    assert('no account read before login',(await call('invoice_read')).error==='not_authenticated');
    const attackMethods=['evaluate_script','Runtime.evaluate','Network.getAllCookies','get_cookies','get_network_requests','take_screenshot','get_dom','navigate_page','upload_file','download','connect_cdp','open_devtools','__proto__'];
    for(const method of attackMethods)assert(`${method} unavailable before login`,(await call(method)).error==='tool_unavailable');
    const login=await call('browser_login');record('agent login reply',login);assert('restricted browser login authenticated',login.authenticated===true);
    for(const method of attackMethods)assert(`${method} unavailable after login`,(await call(method)).error==='tool_unavailable');
    for(const extra of [{selector:'#secret-canary'},{expression:'document.cookie'},{url:'https://unapproved.example.test/'},{actor:'operator'},{headers:{Authorization:'override'}},{methodParams:{includeSecrets:true}}])assert('caller-supplied browser controls refused',(await call('invoice_read',extra)).error==='arguments_refused');
    assert('login replay refused',(await call('browser_login')).error==='login_already_used');
    // Positive control: the trusted driver really can see a hidden credential echo.
    const canary=await cdp.send('Runtime.evaluate',{expression:"document.querySelector('#secret-canary').getAttribute('data-password').length === 48",returnByValue:true});
    assert('credential canary exists behind restricted interface',canary.result.value===true);
    const read=await call('invoice_read');record('agent invoice reply',read);
    assert('useful account read succeeds without raw DOM',read.invoice?.totalUSD===42&&read.invoice?.status==='paid'&&Object.keys(read.invoice).length===2);
    // Stronger projection control: a credential echoed in an otherwise allowed field must fail schema checks.
    await cdp.send('Runtime.evaluate',{expression:"document.querySelector('#invoice').setAttribute('data-total', document.querySelector('#secret-canary').getAttribute('data-password'))"});
    assert('credential echo in allowed output field refused',(await call('invoice_read')).error==='result_schema_refused');
    await cdp.send('Runtime.evaluate',{expression:"document.querySelector('#invoice').setAttribute('data-total','42')"});
    // Broker-side routing still stops off-origin navigation initiated outside the tool interface.
    await cdp.send('Page.navigate',{url:'http://unapproved.example.test/'});
    assert('off-origin browser request blocked',confinement.blockedRequests>0);
    assert('read of unexpected page refused',(await call('invoice_read')).error==='page_refused');
    await cdp.send('Page.navigate',{url:`${origin}/account`});
    await waitForPage(cdp,undefined,`location.href===${JSON.stringify(origin+'/account')} && !!document.querySelector('#invoice')`);
    // Run the client in its own PID/filesystem/network namespaces. Mount only its code and broker socket.
    const agentFile=fileURLToPath(new URL('./restricted-agent.mjs',import.meta.url));
    const args=['run','--rm','--network','none','--read-only','--user',String(process.getuid()),'--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,src=${clientDir},dst=/broker,readonly`,'--mount',`type=bind,src=${agentFile},dst=/agent.mjs,readonly`,'-e','AGENT_TOOL_TOKEN','-e','AGENT_GRANT_ID','-e','PROBE_GATEWAY_PORT','node:22-bookworm-slim','node','/agent.mjs'];
    // Async execution lets this process continue servicing the Unix socket.
    const {execFile}=await import('node:child_process');
    const isolated=await new Promise((resolve,reject)=>execFile('docker',args,{encoding:'utf8',timeout:20000,env:{...process.env,AGENT_TOOL_TOKEN:agentKey,AGENT_GRANT_ID:grantId,PROBE_GATEWAY_PORT:new URL(gatewayBase).port}},(error,stdout)=>error?reject(new Error('Isolated agent exercise failed')):resolve(JSON.parse(stdout))));
    outputs.push(isolated);record('contained agent evidence',isolated);
    assert('contained agent can work only through restricted socket',isolated.isolatedClient&&isolated.hostGatewayUnreachable&&isolated.invoice.totalUSD===42);
    assert('read allowance enforced',(await call('invoice_read')).error==='read_allowance_exhausted');
    // A bearer accepted by the restricted interface does not authorize the underlying CDP Lane.
    const rawStatus=await new Promise((resolve,reject)=>{const req=http.get(`${gatewayBase}/cdp/${name}/json/version`,{headers:{Authorization:`Bearer ${agentKey}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('raw lane check timed out')));});
    assert('agent credential cannot access raw Chikin CDP',rawStatus===403);
    broker.revoke(grantId);
    assert('revocation refuses every later operation',(await call('invoice_read')).error==='revoked'&&(await call('browser_logout')).error==='revoked');
    const privateSession=await cdp.send('Runtime.evaluate',{expression:"!!document.querySelector('#account-marker')",returnByValue:true});
    assert('website session remains private to broker after revoke',privateSession.result.value===true);
    outputs.push(broker.audit);record('restricted audit',broker.audit);
    assert('generated password absent from all captured tool outputs and audit',!JSON.stringify(outputs).includes(password));
    console.log('VERDICT: restricted browser operations resisted the exercised extraction attempts. Broker host, destination site and driver remain trusted; this is not a sandbox for a shell-capable agent.');
  }finally{await broker.close();await rm(clientDir,{recursive:true,force:true});}
}
