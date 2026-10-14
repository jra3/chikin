/** Real Chikin login spike. Synthetic credentials, one fresh Browser, automatic exact-name cleanup. */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { connectCdp, createLoginBroker, waitForPage } from './browser-login.mjs';
const run=randomBytes(5).toString('hex');
const name=`inst-vault-${run}`, browserName=`chikin-chrome-${name}`, volumeName=`chikin-profile-${name}`;
const gatewayName=`chikin-vault-gateway-${run}`, fixtureName=`chikin-vault-fixture-${run}`;
const port=Number(process.env.VAULT_CHIKIN_PORT||18116), base=`http://127.0.0.1:${port}`;
const gatewayImage=process.env.VAULT_GATEWAY_IMAGE||'chikin-gateway:local';
const chromeImage=process.env.VAULT_CHROME_IMAGE||'chikin:local';
const shared=`/tmp/chikin-vault-${run}`;
const screenshot=process.env.VAULT_SCREENSHOT||`/tmp/chikin-vault-authenticated-${run}.png`;
const password=randomBytes(24).toString('hex');
const docker=(args,extra={})=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...extra}).trim();
const exists=(kind,id)=>{try{docker([kind,'inspect',id]);return true;}catch{return false;}};
const assert=(label,condition)=>{if(!condition)throw new Error(label);console.log(`PASS ${label}`);};
const owned=[];let cdp,mayHaveBrowser=false;
const transcript=[];
function record(label,value){transcript.push(value);console.log(`${label}: ${JSON.stringify(value)}`);return value;}
async function until(fn){for(let i=0;i<150;i++){try{const result=await fn();if(result)return result;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Scratch gateway did not become ready');}
try{
 if(!Number.isInteger(port)||port<1024||port===8080)throw new Error('Choose a dedicated non-production port');
 if(exists('container',browserName)||exists('volume',volumeName))throw new Error('Refusing preexisting Browser or Profile Volume');
 const count=docker(['ps','-a','--filter','label=chikin.fleet=1','--format','{{.ID}}']).split('\n').filter(Boolean).length;
 const imageId=docker(['image','inspect',gatewayImage,'--format','{{.Id}}']);
 console.log(`Scratch Gateway image: ${imageId}`);
 await mkdir(shared,{mode:0o777});
 const fixtureFile=fileURLToPath(new URL('./browser-fixture.mjs',import.meta.url));
 docker(['create','--name',fixtureName,'--network','chikin-net','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','-e','CHIKIN_DEMO_PASSWORD','--mount',`type=bind,src=${fixtureFile},dst=/fixture.mjs,readonly`,'node:22-bookworm-slim','node','/fixture.mjs'],{env:{...process.env,CHIKIN_DEMO_PASSWORD:password}});
 owned.push(fixtureName);docker(['start',fixtureName]);
 const env={HOST:'0.0.0.0',PORT:String(port),MAX_FLEET:String(count+1),GATEWAY_TOKEN:'',CHIKIN_VOLUME_GC:'0',SEED_VOLUME:'',IDLE_TTL_SEC:'100000',ATTACHED_IDLE_TTL_SEC:'0',REAP_INTERVAL_SEC:'100000',CHROME_IMAGE:chromeImage,CHIKIN_NETWORK:'chikin-net',CHIKIN_EGRESS_NETWORK:'chikin-egress',SHARED_DIR:shared,DOCKER_PROXY_HOST:'docker-socket-proxy',DOCKER_PROXY_PORT:'2375'};
 docker(['create','--name',gatewayName,'--init','--network','chikin-control','-p',`127.0.0.1:${port}:${port}`,...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),gatewayImage]);
 owned.push(gatewayName);docker(['network','connect','chikin-net',gatewayName]);docker(['network','connect','chikin-egress',gatewayName]);docker(['start',gatewayName]);
 const health=await until(async()=>{const response=await fetch(`${base}/healthz`,{signal:AbortSignal.timeout(1000)});return response.ok&&response.json();});
 assert('effective scratch config disables seeding and volume GC',health.config.seedVolume===''&&!health.config.volumeGc);
 assert('effective scratch config disables attached reaping',health.config.attachedIdleTtlSec===0&&health.config.idleTtlSec===100000);
 mayHaveBrowser=true;
 // Node fetch adds Sec-Fetch-Mode, correctly refused by the CDP lane's page guard.
 const version=await new Promise((resolve,reject)=>{const req=http.get(`${base}/cdp/${name}/json/version`,res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('Scratch gateway could not provision Browser'));try{resolve(JSON.parse(body));}catch{reject(new Error('Invalid CDP discovery response'));}});});req.setTimeout(150000,()=>req.destroy(new Error('Browser provisioning timed out')));req.on('error',reject);});
 assert('real Chrome provisioned through Chikin CDP Lane',typeof version.Browser==='string'&&version.Browser.includes('Chrome/'));
 cdp=await connectCdp(version.webSocketDebuggerUrl);
 const sessionId='broker-owned-page';
 await cdp.send('Page.enable',{},sessionId);
 const origin=`http://${fixtureName}.chikin-net:43116`;
 const broker=createLoginBroker({cdp,sessionId,origin,resolveCredential:async alias=>{if(alias!=='demo-accounts')throw new Error('Unknown account');return {username:'demo-user',password};}});
 const grantId=broker.approve('demo-agent');
 const request={grantId,account:'demo-accounts'};
 assert('wrong agent refused',record('agent reply',await broker.login('other-agent',request)).error==='wrong_agent');
 assert('caller destination override refused',record('agent reply',await broker.login('demo-agent',{...request,url:'https://unapproved.example.test'})).error==='caller_override_refused');
 assert('wrong account refused',record('agent reply',await broker.login('demo-agent',{...request,account:'other-account'})).error==='wrong_account');
 assert('real website login completed',record('agent reply',await broker.login('demo-agent',request)).authenticated===true);
 assert('login grant replay refused',record('agent reply',await broker.login('demo-agent',request)).error==='exhausted');
 const userAgent=await cdp.send('Runtime.evaluate',{expression:'navigator.userAgent',returnByValue:true},sessionId);
 assert('Browser is headful Chrome',userAgent.result.value.includes('Chrome/')&&!userAgent.result.value.includes('Headless'));
 // Browser now owns the website cookie: revoking login permission cannot invalidate it.
 broker.revoke(grantId);
 await cdp.send('Page.navigate',{url:`${origin}/account`},sessionId);
 await waitForPage(cdp,sessionId,`location.pathname==='/account' && !!document.querySelector('#account-marker')`);
 assert('website session remains usable after grant revocation',true);
 assert('revoked grant refuses a fresh login',record('agent reply',await broker.login('demo-agent',request)).error==='revoked');
 const expired=broker.approve('demo-agent',{ttlMs:0});
 assert('expired login grant refused',record('agent reply',await broker.login('demo-agent',{grantId:expired,account:'demo-accounts'})).error==='expired');
 const metrics=await cdp.send('Runtime.evaluate',{expression:"fetch('/metrics').then(r=>r.json())",awaitPromise:true,returnByValue:true},sessionId);
 record('website evidence',metrics.result.value);
 assert('denials did not submit extra logins',metrics.result.value.attempts===1&&metrics.result.value.accepted===1);
 await cdp.send('Page.bringToFront',{},sessionId);
 const capture=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);
 await writeFile(screenshot,Buffer.from(capture.data,'base64'));console.log(`Authenticated Browser screenshot: ${screenshot}`);
 // Actual browser logout, then verify an account navigation returns to the login form.
 await cdp.send('Runtime.evaluate',{expression:"document.querySelector('form').requestSubmit()"},sessionId);
 await waitForPage(cdp,sessionId,"location.pathname==='/login' && !!document.querySelector('#password')");
 await cdp.send('Page.navigate',{url:`${origin}/account`},sessionId);
 await waitForPage(cdp,sessionId,"location.pathname==='/login' && !!document.querySelector('#password')");
 assert('website logout ends the browser session',true);
 record('broker audit',broker.audit);
 assert('synthetic password absent from agent replies and audit',!JSON.stringify(transcript).includes(password));
 console.log('VERDICT: website login through Chikin works with broker-owned synthetic credentials. Bitwarden, MFA, hostile-CDP protection and production integration are not connected.');
}catch(error){console.error(`FAIL ${error.message?.startsWith('Command failed')?'Docker operation failed (details suppressed)':error.message}`);process.exitCode=1;}
finally{
 await cdp?.close().catch(()=>{});
 // Only unpredictable disposable names checked absent before this run may be removed.
 if(mayHaveBrowser){
  if(!/^chikin-profile-inst-vault-[a-f0-9]{10}$/.test(volumeName))throw new Error('Cleanup name guard');
  if(exists('container',browserName)){try{docker(['rm','-f',browserName]);}catch{console.error(`Cleanup needed: ${browserName}`);process.exitCode=1;}}
  if(exists('volume',volumeName)){try{docker(['volume','rm',volumeName]);}catch{console.error(`Cleanup needed: ${volumeName}`);process.exitCode=1;}}
 }
 for(const container of owned.reverse()){try{docker(['rm','-f',container]);}catch{console.error(`Cleanup needed: ${container}`);process.exitCode=1;}}
 await rm(shared,{recursive:true,force:true}).catch(()=>{});
 if(!process.exitCode)console.log('CLEANUP removed only this run’s Browser, disposable Profile Volume, fixture and scratch Gateway.');
}
