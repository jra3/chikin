// THROWAWAY trusted Reddit adapter. No agent-supplied browser code, URL or selector.
const ORIGIN='https://www.reddit.com';
const ASSETS=new Set(['https://www.redditstatic.com','https://www.gstatic.com','https://www.google.com','https://www.recaptcha.net','https://recaptcha.net']);
export async function createRedditSession({page,origin=ORIGIN,fixture=false}) {
 if(origin!==ORIGIN&&!fixture)throw new Error('Unapproved origin');
 let credential=null,expectedUser=null,state='preparing',lastResult=null,reads=0,revoked=false,busy=false;
 const expiresAt=Date.now()+20*60*1000;
 const audit=[];
 const alive=()=>!revoked&&Date.now()<expiresAt;
 await page.context().clearPermissions();
 await page.context().route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin===origin)return route.continue();
  // Cross-origin assets/challenge frames are permitted only for these reviewed services.
  // Top-level redirects remain pinned to Reddit. The destination website is trusted.
  if(!fixture&&ASSETS.has(url.origin)&&!(req.isNavigationRequest()&&req.frame()===page.mainFrame()))return route.continue();
  return route.abort();
 });
 await page.context().routeWebSocket('**/*',socket=>socket.close());
 page.context().on('page',popup=>{if(popup!==page)popup.close().catch(()=>{});});
 page.on('download',download=>download.cancel().catch(()=>{}));
 page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
 await page.goto(origin+'/login/',{waitUntil:'domcontentloaded',timeout:45000});
 const ready=async()=>{
  if(!alive())return false;
  return page.evaluate(expected=>{
   const f=document.querySelector('faceplate-form#login');
   return location.origin===expected&&location.pathname==='/login/'&&f?.getAttribute('action')==='/svc/shreddit/account/login'&&f?.getAttribute('method')==='post'&&!!document.querySelector('#login-password')?.shadowRoot?.querySelector('input[type=password]');
  },origin).catch(()=>false);
 };
 async function supply(value){
  if(state!=='preparing'||!alive()||!await ready())return {ok:false,error:'login_form_not_ready'};
  if(!value||Object.keys(value).sort().join(',')!=='password,username'||!/^[-_A-Za-z0-9]{3,20}$/.test(value.username)||typeof value.password!=='string'||!value.password||value.password.length>1024)return {ok:false,error:'credential_shape_refused'};
  credential={...value};expectedUser=value.username.toLowerCase();state='ready';return {ok:true};
 }
 // Only typed identity comparison crosses out of the page; never the whole /api/me object.
 async function identity(){
  return page.evaluate(async({origin,user})=>{
   if(location.origin!==origin)return false;
   try{const r=await fetch('/api/me.json',{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)return false;const j=await r.json();return typeof j?.data?.name==='string'&&j.data.name.toLowerCase()===user;}catch{return false;}
  },{origin,user:expectedUser}).catch(()=>false);
 }
 async function call(request){
  const method=request?.method;
  const deny=error=>({ok:false,error,retryable:false});
  if(!request||Array.isArray(request)||Object.keys(request).join(',')!=='method')return deny('arguments_refused');
  if(!['browser_login','subreddit_list','session_end'].includes(method))return deny('tool_unavailable');
  if(!alive())return deny(revoked?'revoked':'expired');
  if(busy)return deny('operation_in_progress');
  busy=true;
  try{
   if(method==='session_end'){revoked=true;credential=null;state='ended';return {ok:true,ended:true,remoteLogout:false};}
   if(method==='browser_login'){
    if(state!=='ready')return deny('login_not_ready_or_already_used');
    state='login_started';
    if(!await ready()){credential=null;return deny('login_form_not_ready');}
    const secret=credential;credential=null;
    if(!alive())return deny('revoked_or_expired');
    const filled=await page.evaluate(({origin,username,password})=>{
     const f=document.querySelector('faceplate-form#login');
     const u=document.querySelector('#login-username')?.shadowRoot?.querySelector('input');
     const p=document.querySelector('#login-password')?.shadowRoot?.querySelector('input');
     if(location.origin!==origin||location.pathname!=='/login/'||f?.getAttribute('action')!=='/svc/shreddit/account/login'||f?.getAttribute('method')!=='post'||!u||p?.type!=='password')return false;
     for(const [input,value] of [[u,username],[p,password]]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));}
     return true;
    },{origin,...secret});
    secret.password='';
    if(!filled)return deny('login_form_refused');
    const button=page.locator('faceplate-form#login').getByRole('button',{name:'Log In',exact:true});
    await button.waitFor({state:'visible',timeout:10000});
    if(!alive()||!await ready())return deny('login_form_refused');
    // Once dispatched, every failure is non-retryable. Human may clear a challenge in noVNC.
    await button.click({timeout:10000});
    const deadline=Date.now()+80000;
    while(Date.now()<deadline){
     if(!alive())return deny('revoked_or_expired');
     if(await identity()){state='authenticated';return {ok:true,authenticated:true};}
     await new Promise(r=>setTimeout(r,1500));
    }
    state='login_unknown';return deny('login_outcome_unknown_check_operator_browser');
   }
   if(state!=='authenticated')return deny('not_authenticated');
   if(reads++>=2)return deny('read_allowance_exhausted');
   if(!await identity())return deny('account_not_verified');
   const names=new Set(),seen=new Set();let after=null;
   for(let n=0;n<100;n++){
    if(!alive())return deny('revoked_or_expired');
    const result=await page.evaluate(async({origin,after})=>{
     if(location.origin!==origin)return {error:'origin_refused'};
     const url=new URL('/subreddits/mine/subscriber.json',origin);url.searchParams.set('limit','100');url.searchParams.set('raw_json','1');if(after)url.searchParams.set('after',after);
     try{
      const r=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!r.ok)return {error:'membership_request_refused'};
      const j=await r.json();
      if(j.kind!=='Listing'||!Array.isArray(j.data?.children)||j.data.children.length>100)return {error:'membership_schema_refused'};
      const names=[];
      for(const c of j.data.children){if(c?.data?.subreddit_type==='user')continue;const name=c?.data?.display_name;if(c.kind!=='t5'||!/^[-_A-Za-z0-9]{2,32}$/.test(name)||c.data.user_is_subscriber!==true)return {error:'membership_schema_refused'};names.push(name);}
      const cursor=j.data.after;
      if(cursor!==null&&!(typeof cursor==='string'&&/^t5_[a-z0-9]+$/.test(cursor)))return {error:'cursor_refused'};
      return {names,after:cursor};
     }catch{return {error:'membership_read_failed'};}
    },{origin,after});
    if(result.error)return deny(result.error);
    // Validate again at the process boundary; page data never chooses a destination.
    if(!Array.isArray(result.names)||result.names.some(n=>typeof n!=='string'||!/^[-_A-Za-z0-9]{2,32}$/.test(n)))return deny('result_schema_refused');
    for(const name of result.names)names.add(name);
    if(result.after===null){
     if(!alive()||!await identity())return deny('account_not_verified');
     lastResult={ok:true,complete:true,subreddits:[...names].sort((a,b)=>a.localeCompare(b)).map(name=>({name,url:`https://www.reddit.com/r/${name}/`}))};return lastResult;
    }
    if(!/^t5_[a-z0-9]+$/.test(result.after)||seen.has(result.after))return deny('pagination_refused');
    seen.add(result.after);after=result.after;
   }
   return deny('pagination_limit_reached');
  }catch{return deny('outcome_unknown');}
  finally{audit.push({method,state,time:new Date().toISOString()});busy=false;}
 }
 return {ready,supply,call,audit,result:()=>lastResult,revoke(){revoked=true;credential=null;},status:()=>({state,expired:Date.now()>=expiresAt,revoked})};
}
