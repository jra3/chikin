// THROWAWAY trusted lifecycle for one isolated Chikin Browser.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { connectCdp } from './browser-login.mjs';


export async function createScratchBrowser(){
const run=randomBytes(5).toString('hex');
const name=`inst-vault-${run}`, browserName=`chikin-chrome-${name}`, volumeName=`chikin-profile-${name}`;
const gatewayName=`chikin-vault-gateway-${run}`;
const port=Number(process.env.VAULT_CHIKIN_PORT||18116), base=`http://127.0.0.1:${port}`;
const gatewayImage=process.env.VAULT_GATEWAY_IMAGE||'chikin-gateway:local';
const chromeImage=process.env.VAULT_CHROME_IMAGE||'chikin:local';
const shared=`/tmp/chikin-vault-${run}`;

const gatewayToken=randomBytes(24).toString('hex');
const dataNetwork=`chikin-vault-net-${run}`;
const docker=(args,extra={})=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...extra}).trim();
const exists=(kind,id)=>{try{docker([kind,'inspect',id]);return true;}catch{return false;}};
const assert=(label,condition)=>{if(!condition)throw new Error(label);console.log(`PASS ${label}`);};
const owned=[],networks=[];let cdp,mayHaveBrowser=false;
async function until(fn){for(let i=0;i<150;i++){try{const result=await fn();if(result)return result;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Scratch gateway did not become ready');}
let closing;
const close=()=>closing??=(async()=>{
 let cleaned=true;
 await cdp?.close().catch(()=>{});
 // Only unpredictable disposable names checked absent before this run may be removed.
 if(mayHaveBrowser){
  if(!/^chikin-profile-inst-vault-[a-f0-9]{10}$/.test(volumeName))throw new Error('Cleanup name guard');
  if(exists('container',browserName)){try{docker(['rm','-f',browserName]);}catch{cleaned=false;console.error(`Cleanup needed: ${browserName}`);}}
  if(exists('volume',volumeName)){try{docker(['volume','rm',volumeName]);}catch{cleaned=false;console.error(`Cleanup needed: ${volumeName}`);}}
 }
 for(const container of owned.reverse()){try{docker(['rm','-f',container]);}catch{cleaned=false;console.error(`Cleanup needed: ${container}`);}}
 for(const network of networks.reverse()){try{docker(['network','rm',network]);}catch{cleaned=false;console.error(`Cleanup needed: ${network}`);}}
 await rm(shared,{recursive:true,force:true}).catch(()=>{cleaned=false;});
 return cleaned;
})();
try{
 if(!Number.isInteger(port)||port<1024||port===8080)throw new Error('Choose a dedicated non-production port');
 if(exists('container',browserName)||exists('volume',volumeName))throw new Error('Refusing preexisting Browser or Profile Volume');
 const count=docker(['ps','-a','--filter','label=chikin.fleet=1','--format','{{.ID}}']).split('\n').filter(Boolean).length;
 const imageId=docker(['image','inspect',gatewayImage,'--format','{{.Id}}']);
 console.log(`Scratch Gateway image: ${imageId}`);
 await mkdir(shared,{mode:0o777});
 {
   const options=JSON.parse(docker(['network','inspect','chikin-egress','--format','{{json .Options}}']));
   assert('shared egress forbids container-to-container traffic',options['com.docker.network.bridge.enable_icc']==='false');
   docker(['network','create','--internal',dataNetwork]);networks.push(dataNetwork);
 }
 const env={HOST:'0.0.0.0',PORT:String(port),MAX_FLEET:String(count+1),GATEWAY_TOKEN:gatewayToken,CHIKIN_VOLUME_GC:'0',SEED_VOLUME:'',IDLE_TTL_SEC:'100000',ATTACHED_IDLE_TTL_SEC:'0',REAP_INTERVAL_SEC:'100000',CHROME_IMAGE:chromeImage,CHIKIN_NETWORK:dataNetwork,CHIKIN_EGRESS_NETWORK:'chikin-egress',SHARED_DIR:shared,DOCKER_PROXY_HOST:'docker-socket-proxy',DOCKER_PROXY_PORT:'2375'};
 docker(['create','--name',gatewayName,'--init','--network','chikin-control','-p',`127.0.0.1:${port}:${port}`,...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),gatewayImage]);
 owned.push(gatewayName);docker(['network','connect',dataNetwork,gatewayName]);docker(['network','connect','chikin-egress',gatewayName]);docker(['start',gatewayName]);
 const health=await until(async()=>{const response=await fetch(`${base}/healthz`,{signal:AbortSignal.timeout(1000)});return response.ok&&response.json();});
 assert('effective scratch config disables seeding and volume GC',health.config.seedVolume===''&&!health.config.volumeGc);
 assert('effective scratch config disables attached reaping',health.config.attachedIdleTtlSec===0&&health.config.idleTtlSec===100000);
 mayHaveBrowser=true;
 // Node fetch adds Sec-Fetch-Mode, correctly refused by the CDP lane's page guard.
 const version=await new Promise((resolve,reject)=>{const req=http.get(`${base}/cdp/${name}/json/version`,{headers:{Authorization:`Bearer ${gatewayToken}`} },res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('Scratch gateway could not provision Browser'));try{resolve(JSON.parse(body));}catch{reject(new Error('Invalid CDP discovery response'));}});});req.setTimeout(150000,()=>req.destroy(new Error('Browser provisioning timed out')));req.on('error',reject);});
 assert('raw CDP requires broker authentication',health.config.authEnabled===true);
 const browserNetworks=JSON.parse(docker(['inspect',browserName,'--format','{{json .NetworkSettings.Networks}}']));
 assert('Browser isolated from live Fleet data network',!!browserNetworks[dataNetwork]&&!browserNetworks['chikin-net']);
 assert('real Chrome provisioned through Chikin CDP Lane',typeof version.Browser==='string'&&version.Browser.includes('Chrome/'));
 cdp=await connectCdp(version.webSocketDebuggerUrl,{headers:{Authorization:`Bearer ${gatewayToken}`} });

 const operatorUrl=`${base}/vnc/${name}/vnc.html?autoconnect=true&resize=remote&path=${encodeURIComponent(`vnc/${name}/websockify`)}`;
 return {cdp,name,base,dataNetwork,operatorUrl,close};
 }catch(error){await close();throw new Error('Could not prepare isolated Chikin Browser');}
}
