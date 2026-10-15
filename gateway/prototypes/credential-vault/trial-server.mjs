// Private Unix HTTP interface shared by the trial and its synthetic checks.
import http from 'node:http';
import {chmod} from 'node:fs/promises';
export async function serveTrialCalls(path,handler,token){
 const s=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.headers.host!=='vault-broker'||req.headers.origin||req.method!=='POST'||req.url!=='/call')return reply(403,{ok:false,error:'request_refused'});
  if(token&&req.headers.authorization!==`Bearer ${token}`)return reply(403,{ok:false,error:'agent_auth_required'});
  try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)return reply(413,{ok:false,error:'request_too_large'});}
   reply(200,await handler(JSON.parse(raw)));
  }catch{reply(400,{ok:false,error:'operation_failed'});}
 });
 await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(path,resolve);});await chmod(path,0o600);return s;
}
