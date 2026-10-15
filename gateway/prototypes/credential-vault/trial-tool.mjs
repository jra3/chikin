// Restricted client; no URL, selectors or executable browser arguments.
import http from 'node:http';
const method=process.argv[2];
const value=await new Promise((resolve,reject)=>{
 const req=http.request({agent:false,socketPath:'/broker/agent.sock',path:'/call',method:'POST',headers:{Host:'vault-broker',Authorization:`Bearer ${process.env.AGENT_TOOL_TOKEN}`,'Content-Type':'application/json'}},res=>{
  let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(new Error('Invalid broker response'));}});
 });req.on('error',reject);req.setTimeout(180000,()=>req.destroy(new Error('Broker timeout')));req.end(JSON.stringify({method}));
});
console.log(JSON.stringify(value));
