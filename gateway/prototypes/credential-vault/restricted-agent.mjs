// Untrusted-client demonstration: this file alone runs in a read-only, network-none container.
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
const key=process.env.AGENT_TOOL_TOKEN,grantId=process.env.AGENT_GRANT_ID;
async function call(path,body){
  return new Promise((resolve,reject)=>{
    const req=http.request({agent:false,socketPath:'/broker/client.sock',host:'vault-broker',path,method:body===undefined?'GET':'POST',headers:{Host:'vault-broker',Authorization:`Bearer ${key}`,'Content-Type':'application/json'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,...JSON.parse(text)});}catch{reject(new Error('Invalid broker reply'));}});});
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Broker timeout')));req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
const assert=(value,label)=>{if(!value)throw new Error(label);};
const tools=await call('/tools');assert(tools.tools?.length===3,'Broker unreachable');
const attacks=['evaluate_script','Network.getAllCookies','get_network_requests','take_screenshot','get_dom','navigate_page','upload_file','connect_cdp'];
for(const method of attacks)assert((await call('/call',{grantId,method})).error==='tool_unavailable',`Allowed ${method}`);
assert((await call('/call',{grantId,method:'invoice_read',selector:'#secret-canary'})).error==='arguments_refused','Allowed selector');
assert((await call('/operator/approve',{actor:'operator'})).status===404,'Allowed self approval');
assert(!existsSync('/var/run/docker.sock'),'Docker socket exposed');
const rawReachable=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:Number(process.env.PROBE_GATEWAY_PORT)});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
assert(!rawReachable,'Raw gateway reachable');
const invoice=await call('/call',{grantId,method:'invoice_read'});assert(invoice.ok&&invoice.invoice?.totalUSD===42,'Approved operation failed');
console.log(JSON.stringify({isolatedClient:true,restrictedSocketWorks:true,extractionAttemptsRefused:attacks.length+1,selfApprovalRefused:true,dockerSocketAbsent:true,hostGatewayUnreachable:true,invoice:invoice.invoice}));
