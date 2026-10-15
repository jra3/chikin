// Runs only INSIDE the network-disabled Codex container. No model/vault credentials mounted.
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const relay=net.createServer(client=>{
 const peer=net.connect('/model/model.sock');client.pipe(peer);peer.pipe(client);
 client.on('error',()=>peer.destroy());peer.on('error',()=>client.destroy());
 client.on('close',()=>peer.destroy());peer.on('close',()=>client.destroy());
});
await new Promise(resolve=>relay.listen(18080,'127.0.0.1',resolve));
const task=process.env.AGENT_TASK;delete process.env.AGENT_TASK;
const disabled=['apps','plugins','remote_plugin','recommended_plugins','browser_use','computer_use','in_app_browser','multi_agent','code_mode','workspace_dependencies','skill_search','unbounded_connection_retries','api_key_model_discovery','enable_request_compression'];
const config={
 'shell_environment_policy.set.AGENT_TOOL_TOKEN':process.env.AGENT_TOOL_TOKEN,
 web_search:'disabled',model_reasoning_effort:'low',model_provider:'vault_relay',
 'model_providers.vault_relay.name':'Chikin model relay',
 'model_providers.vault_relay.base_url':'http://127.0.0.1:18080/v1',
 'model_providers.vault_relay.wire_api':'responses',
 'model_providers.vault_relay.requires_openai_auth':false,
 'model_providers.vault_relay.supports_websockets':false,
 'model_providers.vault_relay.request_max_retries':0,
 'model_providers.vault_relay.stream_max_retries':0,
 'model_providers.vault_relay.stream_idle_timeout_ms':60000,
 ...Object.fromEntries(disabled.map(key=>[`features.${key}`,false]))
};
const child=spawn('/codex',['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','-C','/tmp','-m',process.env.VAULT_CODEX_MODEL,...Object.entries(config).flatMap(([k,v])=>['-c',`${k}=${JSON.stringify(v)}`]),'-o','/tmp/result.txt',task],{env:process.env,stdio:['ignore','ignore','pipe']});
child.stderr.resume();
const code=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('exit',c=>resolve(c??1));});
if(code===0)process.stdout.write(await readFile('/tmp/result.txt','utf8'));
relay.close();process.exit(code);
