// Human-operated helper. Secrets travel over stdin + operator-only Unix socket, never argv/env.
import http from 'node:http';
const [dir,method]=process.argv.slice(2);
if(!/^\/tmp\/chikin-reddit-[a-zA-Z0-9]+$/.test(dir||''))throw new Error('Invalid trial directory');
const request={method};
if(method==='supply'){
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)throw new Error('Input too large');}
 const parts=input.split('\0');
 if(parts.length!==3||parts[2]!=='')throw new Error('Invalid private input');
 request.credential={username:parts[0],password:parts[1]};input='';
}
try{
 const value=await new Promise((resolve,reject)=>{
  const req=http.request({agent:false,socketPath:`${dir}/operator.sock`,path:'/call',method:'POST',headers:{Host:'vault-broker','Content-Type':'application/json'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(new Error('Invalid reply'));}});});
  req.on('error',reject);req.setTimeout(360000,()=>req.destroy(new Error('Operator request timed out')));req.end(JSON.stringify(request));
 });
 if(!value.ok){console.error(value.error);process.exitCode=1;}
 else if(method==='status'){
  if(process.argv.includes('--url'))console.log(value.operatorUrl);
  else if(process.argv.includes('--check-ready')){if(!value.loginFormReady){console.error('Reddit login form is not ready. Complete the human verification in the operator browser first.');process.exitCode=2;}}
  else console.log(JSON.stringify(value));
 }else if(method==='run'){console.log(value.answer);if(value.result){console.log('\nVerified broker list ('+value.result.subreddits.length+' joined subreddits; complete):');for(const sub of value.result.subreddits)console.log('r/'+sub.name+' '+sub.url);}else{console.error('No verified subreddit list was returned.');process.exitCode=1;}}
 else console.log(method==='supply'?'Credential accepted into broker memory.':'Stopped.');
}catch{console.error('Operator connection failed.');process.exitCode=1;}
