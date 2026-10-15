// THROWAWAY. The only model egress is a fixed Responses relay; authentication stays on the host.
import http from 'node:http';
import { execFile,execFileSync } from 'node:child_process';
import { mkdtemp,readFile,chmod,rm } from 'node:fs/promises';
import {dirname} from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
export async function runContainedCodex({socketDir,token,prompt,timeoutMs=300000,signal}) {
 const dir=await mkdtemp('/tmp/chikin-codex-'),name=`chikin-vault-agent-${randomBytes(5).toString('hex')}`;
 const model=process.env.VAULT_CODEX_MODEL||'gpt-6-astra';
 const sockets=new Set(),requests=new Set();let relay,child,calls=0;
 const stop=()=>{try{execFileSync('docker',['rm','-f',name],{stdio:'ignore'});}catch{}};
 try{
  const auth=JSON.parse(await readFile(`${homedir()}/.codex/auth.json`,'utf8'));
  if(!auth.tokens?.access_token||!auth.tokens?.account_id)throw new Error('This prototype needs an existing ChatGPT Codex login');
  const binary=process.env.VAULT_CODEX_BINARY||execFileSync('mise',['which','codex'],{encoding:'utf8'}).trim();
  relay=http.createServer(async(req,res)=>{
   const refuse=status=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Model relay refused request',type:'relay_error'}}));};
   if(req.method!=='POST'||req.url!=='/v1/responses'||++calls>24)return refuse(403);
   const controller=new AbortController();requests.add(controller);res.on('close',()=>controller.abort());
   try{
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2*1024*1024)return refuse(413);}
    const body=JSON.parse(raw);
    if(body.model!==model||body.previous_response_id||body.conversation||body.background||body.tools?.some(t=>!['function','custom'].includes(t.type)))return refuse(403);
    body.store=false;body.stream=true;
    const response=await fetch('https://chatgpt.com/backend-api/codex/responses',{
     method:'POST',headers:{Authorization:`Bearer ${auth.tokens.access_token}`,'ChatGPT-Account-ID':auth.tokens.account_id,'Content-Type':'application/json',originator:'codex_cli_rs','User-Agent':'codex_cli_rs/0.162.1'},body:JSON.stringify(body),signal:controller.signal
    });
    if(!response.ok){await response.body?.cancel();return refuse(response.status);}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
    for await(const chunk of response.body){if(res.destroyed)break;res.write(chunk);}res.end();
   }catch{if(!res.headersSent)refuse(502);else res.destroy();}
   finally{requests.delete(controller);}
  });
  relay.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(`${dir}/model.sock`,resolve);});await chmod(`${dir}/model.sock`,0o600);
  const entry=fileURLToPath(new URL('./contained-entry.mjs',import.meta.url)),client=fileURLToPath(new URL('./trial-tool.mjs',import.meta.url));
  const args=['run','--rm','--name',name,'--init','--network','none','--read-only','--user',String(process.getuid()),'--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','1g','--cpus','2','--log-driver','none','--tmpfs','/tmp:rw,nosuid,nodev,size=128m','--tmpfs',`/home/node:rw,nosuid,nodev,size=128m,uid=${process.getuid()},gid=${process.getgid()}`,
   '--mount',`type=bind,src=${binary},dst=/codex,readonly`,'--mount',`type=bind,src=${dirname(binary)}/codex-code-mode-host,dst=/codex-code-mode-host,readonly`,'--mount',`type=bind,src=${dir},dst=/model,readonly`,'--mount',`type=bind,src=${socketDir},dst=/broker,readonly`,
   '--mount',`type=bind,src=${entry},dst=/entry.mjs,readonly`,'--mount',`type=bind,src=${client},dst=/tool.mjs,readonly`,
   '-e','AGENT_TOOL_TOKEN','-e','AGENT_TASK','-e','VAULT_CODEX_MODEL','node:22-bookworm-slim','node','/entry.mjs'];
  return await new Promise((resolve,reject)=>{
   child=execFile('docker',args,{encoding:'utf8',timeout:timeoutMs,signal,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,AGENT_TOOL_TOKEN:token,AGENT_TASK:prompt,VAULT_CODEX_MODEL:model}},(error,stdout)=>{
    if(error)return reject(new Error(`Contained Codex failed (exit ${error.code??'unknown'}, model requests ${calls})`));
    resolve(stdout);
   });
  });
 }finally{
  stop();child?.kill();for(const request of requests)request.abort();for(const socket of sockets)socket.destroy();
  if(relay)await new Promise(resolve=>relay.close(resolve));await rm(dir,{recursive:true,force:true});
 }
}
