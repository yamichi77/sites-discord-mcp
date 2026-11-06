import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Response as MFResponse } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import {encryptToken} from './discord.mjs';
const discordMock=async req=>{
 const path=new URL(req.url).pathname;
 if(path==='/api/v10/users/@me')return Response.json({id:'900',bot:true});
 if(path==='/api/v10/channels/100')return Response.json({id:'100',guild_id:'200',type:0});
 if(path==='/api/v10/channels/100/messages')return Response.json([{id:'400',channel_id:'100',author:{id:'300',bot:false},content:'synthetic test data',timestamp:new Date().toISOString(),attachments:[]}]);
 throw Error('Unexpected mock Discord request');
};
await build({entryPoints:['enrollment-entry.ts'],outfile:'.local/test-worker.mjs',bundle:true,packages:'external',platform:'node',format:'esm'});
const {default:worker,route}=await import('./.local/test-worker.mjs');
await build({entryPoints:['entry.ts'],outfile:'.local/public-runtime.mjs',bundle:true,packages:'external',platform:'node',format:'esm'});
const {default:publicWorker}=await import('./.local/public-runtime.mjs');
await build({entryPoints:['enrollment-entry.ts'],outfile:'.local/enrollment-fixture.js',bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['browser']});
await build({entryPoints:['entry.ts'],outfile:'.local/public-fixture.js',bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['browser']});
const workerdMode=process.env.FIXTURE_RUNTIME==='workerd';
const origin='https://fixture.example';
const sql=await readFile(workerdMode?'dist/.openai/drizzle/0000_auth.sql':'drizzle/0000_auth.sql','utf8');
const extraSql=await readFile(workerdMode?'dist/.openai/drizzle/0001_owner_setup.sql':'drizzle/0001_owner_setup.sql','utf8');
const json=async r=>r.json();
async function rpcResult(response) {
  if(response.headers.get('content-type')?.includes('text/event-stream')) {
    const text=await response.text();
    const data=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim()));
    const result=data.find(item=>item.id===1);assert.ok(result);return result;
  }
  return response.json();
}
test(`real Better Auth on local D1 (${workerdMode?'workerd bundle':'Node handler'}): DCR, owner login, explicit consent, PKCE and protected ping`,async(t)=>{
  const settings={APP_URL:origin,OWNER_SITES_ID:'synthetic-owner',BETTER_AUTH_SECRET:randomBytes(48).toString('base64url'),DISCORD_CONFIG_KEY:randomBytes(32).toString('hex')};
  const fixtureOptions={modules:true,...(workerdMode?{modules:[{type:'ESModule',path:'.local/enrollment-fixture.js'}],bindings:settings,compatibilityDate:'2026-07-28',outboundService:async(req,instance)=>{if(new URL(req.url).origin==='https://discord.com')return new MFResponse(await (await discordMock(req)).text(),{headers:{'content-type':'application/json'}});if(new URL(req.url).origin!==origin)throw Error('External network forbidden');return instance.dispatchFetch(req);}}:{script:'export default {fetch(){return new Response("fixture")}}'}),d1Databases:['DB'],d1Persist:false,host:'127.0.0.1'};
  const mf=new Miniflare(fixtureOptions);
  let liveWorker=worker;
  const originalFetch=globalThis.fetch;
  try {
    let DB=await mf.getD1Database('DB');
    const statements=sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
    assert.equal(statements.length,31);
    await DB.batch(statements.map(s=>DB.prepare(s)));
    await DB.batch(extraSql.split('--> statement-breakpoint').map(s=>DB.prepare(s.trim())));
    const discordSql=await readFile('drizzle/0002_discord.sql','utf8');await DB.batch(discordSql.split('--> statement-breakpoint').map(s=>DB.prepare(s.trim())));
    await DB.prepare('INSERT INTO discord_config VALUES(1,?,?,?,?,?,1,1,0)').bind('200','900','["100"]','["300"]',await encryptToken('synthetic-bot-token',settings.DISCORD_CONFIG_KEY)).run();
    const env={DB,...settings};
    const dispatch=async req=>workerdMode?mf.dispatchFetch(req.url,{redirect:'manual',method:req.method,headers:Object.fromEntries(req.headers),...(req.body?{body:await req.arrayBuffer()}:{})}):liveWorker.fetch(req,env);
    const request=(path,options={})=>dispatch(new Request(new URL(path,origin),options));
    globalThis.fetch=async(input,init)=>{
      const req=input instanceof Request && !init ? input : new Request(input,init);
      if(new URL(req.url).origin==='https://discord.com')return discordMock(req);
      if(new URL(req.url).origin!==origin)throw Error('External network forbidden');
      return dispatch(req);
    };
    const rpc=(method,params={})=>JSON.stringify({jsonrpc:'2.0',id:1,method,params});
    const ownerHeaders={'oai-authenticated-user-id':'synthetic-owner','oai-authenticated-user-email':'owner@example.test'};
    assert.equal((await request('/api/mcp')).status,503);
    assert.equal((await request('/setup')).status,401);
    assert.equal((await request('/setup',{headers:{'OAI-Sites-Authorization':'Bearer synthetic-service'}})).status,401);
    assert.equal((await request('/setup/identity',{headers:ownerHeaders})).status,404);
    async function form(path,headers=ownerHeaders){
      const response=await request(path,{headers});assert.equal(response.status,200);
      assert.equal(response.headers.get('referrer-policy'),'strict-origin');
      const text=await response.text();const csrf=/name="csrf" value="([^"]+)"/.exec(text)?.[1];assert.ok(csrf);
      return {csrf,cookie:response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
    }
    const setupForm=await form('/setup');
    assert.equal((await request('/setup',{headers:{...ownerHeaders,origin}})).status,200);
    assert.equal((await request('/setup',{headers:{...ownerHeaders,origin:'https://evil.example'}})).status,403);
    const postAction=(path,f,headers=ownerHeaders,originHeader=origin,extra={})=>request(path,{method:'POST',headers:{...headers,origin:originHeader,cookie:[headers.cookie,f.cookie].filter(Boolean).join('; '),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,...extra})});
    assert.equal((await postAction('/setup/enroll',setupForm,ownerHeaders,'https://evil.example')).status,403);
    assert.equal((await postAction('/setup/enroll',setupForm,ownerHeaders,'null')).status,403);
    assert.equal((await request('/setup/enroll',{method:'POST',headers:{...ownerHeaders,cookie:setupForm.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:setupForm.csrf})})).status,403);
    assert.equal((await postAction('/setup/enroll',{...setupForm,csrf:'bad'})).status,403);
    assert.equal((await postAction('/setup/enroll',setupForm,ownerHeaders,origin,{id:'attacker'})).status,400);
    const secondSetup=await form('/setup');
    const race=await Promise.all([postAction('/setup/enroll',setupForm),postAction('/setup/enroll',secondSetup)]);
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    assert.equal((await postAction('/setup/enroll',secondSetup)).status,409);
    const status=await request('/setup/status',{headers:ownerHeaders});assert.deepEqual(await status.json(),{configured:true});
    assert.deepEqual(await (await request('/setup/status')).json(),{configured:true});
    assert.equal((await postAction('/setup/enroll',setupForm,{...ownerHeaders,'oai-authenticated-user-id':'other'})).status,403);
    const disabled=await worker.fetch(new Request(origin+'/manage',{headers:ownerHeaders}),{...env,BETTER_AUTH_SECRET:''});assert.equal(disabled.status,503);
    for(const table of ['session','jwks','oauthClient'])assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,0);
    // Transition from private enrollment to the exact public build without resetting D1.
    if(workerdMode){await mf.setOptions({...fixtureOptions,modules:[{type:'ESModule',path:'.local/public-fixture.js'}]});DB=await mf.getD1Database('DB');env.DB=DB;}
    else liveWorker=publicWorker;
    for(const path of ['/setup','/setup/status','/setup/identity','/setup/enroll'])for(const method of ['GET','POST'])assert.equal((await request(path,{method,headers:ownerHeaders})).status,404);
    assert.equal((await request('/manage')).status,401);
    assert.equal((await request('/manage',{headers:{...ownerHeaders,'oai-authenticated-user-id':'other'}})).status,403);
    const loginForm=await form('/manage');
    const login=await postAction('/manage/login',loginForm);assert.equal(login.status,302);
    const adminHeaders={...ownerHeaders,cookie:login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
    assert.equal((await request('/discord/settings',{headers:{...adminHeaders,'oai-authenticated-user-id':'other'}})).status,403);
    const settingsForm=await form('/discord/settings',adminHeaders);
    const fields={bot_token:'synthetic-bot-token',guild_id:'200',bot_id:'900',channels:'100',authors:'300',enabled:'yes'};
    assert.equal((await postAction('/discord/settings',settingsForm,adminHeaders,'https://evil.example',fields)).status,403);
    assert.equal((await postAction('/discord/settings',{...settingsForm,csrf:'bad'},adminHeaders,origin,fields)).status,403);
    const saved=await postAction('/discord/settings',settingsForm,adminHeaders,origin,fields);assert.equal(saved.status,200);
    assert.ok(!(await saved.text()).includes(fields.bot_token));
    assert.ok(!(await (await request('/discord/settings',{headers:adminHeaders})).text()).includes(fields.bot_token));
    const storedConfig=await DB.prepare('SELECT encrypted_token FROM discord_config').first();assert.ok(!storedConfig.encrypted_token.includes(fields.bot_token));
    assert.equal((await postAction('/discord/settings',settingsForm,adminHeaders,origin,fields)).status,403);
    const mcpHeaders={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
    const noAuth=await request('/api/mcp',{method:'POST',headers:mcpHeaders,body:rpc('tools/list')});
    assert.equal(noAuth.status,401);assert.match(noAuth.headers.get('www-authenticate'),/resource_metadata/);
    const resource=await request('/.well-known/oauth-protected-resource/api/mcp');
    assert.equal(resource.status,200);assert.equal((await json(resource)).resource,origin+'/api/mcp');
    const discovery=await request('/.well-known/oauth-authorization-server/api/auth');
    assert.equal(discovery.status,200);const metadata=await json(discovery);
    assert.equal(metadata.registration_endpoint,undefined);assert.notEqual(metadata.client_id_metadata_document_supported,true);
    assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
    assert.equal((await request('/api/auth/oauth2/register',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    const register=async label=>{
      for(const path of ['/api/auth/oauth2/create-client','/api/auth/admin/oauth2/create-client','/api/auth/oauth2/update-client'])assert.equal((await request(path,{method:'POST',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({scope:'admin',redirect_uris:['https://evil.example'],grant_types:['client_credentials']})})).status,404);
      const f=await form('/manage',adminHeaders);
      assert.equal((await postAction('/manage/create',f,adminHeaders,origin,{scope:'admin'})).status,400);
      assert.equal((await postAction('/manage/create',f,adminHeaders,'https://evil.example')).status,403);
      const response=await postAction('/manage/create',f,adminHeaders);assert.equal(response.status,200);
      assert.match(response.headers.get('cache-control'),/no-store/);
      const text=await response.text();const id=/client_id: <code>([^<]+)/.exec(text)?.[1];const secret=/client secret: <code>([^<]+)/.exec(text)?.[1];assert.ok(id&&secret);
      const row=await DB.prepare('SELECT clientSecret FROM oauthClient WHERE clientId=?').bind(id).first();assert.ok(row&&row.clientSecret!==secret);
      const again=await postAction('/manage/create',f,adminHeaders);assert.equal(again.status,403);assert.ok(!(await again.text()).includes(secret));
      const manage=await request('/manage',{headers:adminHeaders});assert.ok(!(await manage.text()).includes(secret));
      secrets.set(id,secret);return id;
    };
    const secrets=new Map();
    async function flow(clientId,{deny=false,wrongVerifier=false,wrongResource=false,wrongSecret=false,publicClient=false,beforeExchange=null,expectDisabled=false}={}) {
      const callbackUri=publicClient?'https://agent.meta.ai/api/hatch/oauth/callback':'https://claude.ai/api/mcp/auth_callback';
      const verifier=randomBytes(40).toString('base64url');
      const params=new URLSearchParams({client_id:clientId,redirect_uri:callbackUri,response_type:'code',scope:'discord',resource:origin+'/api/mcp',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:'synthetic-state',prompt:'consent'});
      const authorize=await request(metadata.authorization_endpoint+'?'+params,{headers:{accept:'text/html'}});
      assert.equal(authorize.status,302);
      const loginUrl=new URL(authorize.headers.get('location'),origin);
      const {signedQuery}=await import('./policy.mjs');let query=signedQuery(loginUrl.search);
      assert.ok(query);
      const tampered=query.replace(/discord/g,'admin');
      assert.equal((await request('/api/auth/sites-owner-session?oauth_query='+encodeURIComponent(tampered),{headers:{'oai-authenticated-user-id':'synthetic-owner','oai-authenticated-user-email':'owner@example.test'}})).status,400);
      const fakeHeaders={'oai-authenticated-user-id':'synthetic-other','oai-authenticated-user-email':'other@example.test'};
      assert.equal((await request('/api/auth/sites-owner-session?oauth_query='+encodeURIComponent(query),{headers:fakeHeaders})).status,403);
      const bridge=await request('/api/auth/sites-owner-session?oauth_query='+encodeURIComponent(query),{headers:{'oai-authenticated-user-id':'synthetic-owner','oai-authenticated-user-email':'owner@example.test'}});
      assert.equal(bridge.status,302);
      let cookie=bridge.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
      assert.ok(cookie);
      const resumed=await request(bridge.headers.get('location'),{headers:{cookie,accept:'text/html'}});assert.equal(resumed.status,302);
      cookie += '; '+resumed.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
      const consentUrl=new URL(resumed.headers.get('location'),origin);query=signedQuery(consentUrl.search);
      const consent=await request(consentUrl,{headers:{cookie}});assert.equal(consent.status,200);
      const text=await consent.text();assert.ok(text.includes('Discord'));assert.ok(text.includes(callbackUri));
      assert.ok(text.includes('申告名（第三者の自己申告）'));assert.ok(text.includes(publicClient?'Muse (owner-managed)':'Claude (owner-managed)'));
      assert.ok(text.includes('クライアントID: '+clientId));assert.ok(text.includes('アクセストークンは5分'));
      assert.ok(text.includes('更新トークンは発行しません'));assert.ok(text.includes('許可する'));assert.ok(text.includes('拒否する'));
      const form=new URLSearchParams({oauth_query:query,choice:deny?'deny':'allow'});
      const cross=await request('/consent/decision',{method:'POST',headers:{cookie,origin:'https://evil.example','content-type':'application/x-www-form-urlencoded'},body:form});assert.equal(cross.status,403);
      const decided=await request('/consent/decision',{method:'POST',headers:{cookie,origin,'content-type':'application/x-www-form-urlencoded'},body:form});
      assert.equal(decided.status,302);
      const callback=new URL(decided.headers.get('location'));
      if(deny){assert.equal(callback.searchParams.get('error'),'access_denied');return;}
      const code=callback.searchParams.get('code');assert.ok(code);
      const data=new URLSearchParams({grant_type:'authorization_code',client_id:clientId,...(publicClient?{}:{client_secret:secrets.get(clientId)}),code,redirect_uri:callbackUri,code_verifier:wrongVerifier?'wrong-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx':verifier,resource:wrongResource?'https://other.example/api/mcp':origin+'/api/mcp'});
      const exchange=()=>request(metadata.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:data});
      if(wrongSecret)data.set('client_secret','synthetic-invalid-secret');
      if(beforeExchange)await beforeExchange();
      const tokenResponse=await exchange();
      if(expectDisabled){assert.ok(tokenResponse.status>=400);assert.equal((await tokenResponse.json()).error,'invalid_client');return;}
      if(wrongVerifier||wrongResource||wrongSecret){assert.ok(tokenResponse.status>=400);return;}
      assert.equal(tokenResponse.status,200);const tokens=await json(tokenResponse);assert.ok(tokens.access_token);assert.equal(tokens.refresh_token,undefined);
      const replay=await exchange();assert.ok(replay.status>=400);
      const headers={...mcpHeaders,authorization:'Bearer '+tokens.access_token};
      const init=await request('/api/mcp',{method:'POST',headers,body:rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'local',version:'1'}})});assert.equal(init.status,200);
      const ping=await request('/api/mcp',{method:'POST',headers,body:rpc('tools/call',{name:'discord_history',arguments:{channel_id:'100'}})});assert.equal(ping.status,200);const result=(await rpcResult(ping)).result;assert.ok(!result.isError,result.content[0].text);assert.equal(JSON.parse(result.content[0].text)[0].id,'400');
      const {PROTOCOL_VERSION_META_KEY,CLIENT_INFO_META_KEY,CLIENT_CAPABILITIES_META_KEY}=await import('@modelcontextprotocol/server');
      const meta={[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_INFO_META_KEY]:{name:'local-modern',version:'1'},[CLIENT_CAPABILITIES_META_KEY]:{}};
      const modern=await request('/api/mcp',{method:'POST',headers:{...headers,'mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'discord_history'},body:rpc('tools/call',{name:'discord_history',arguments:{channel_id:'100'},_meta:meta})});
      assert.equal(modern.status,200);assert.equal(JSON.parse((await rpcResult(modern)).result.content[0].text)[0].id,'400');
      const altered=await request('/api/mcp',{method:'POST',headers:{...headers,authorization:'Bearer '+tokens.access_token.slice(0,-6)+'AAAAAA'},body:rpc('tools/list')});assert.equal(altered.status,401);
      await DB.prepare('UPDATE site_owner SET sites_id=? WHERE singleton=1').bind('replacement-owner').run();
      const oldOwner=await request('/api/mcp',{method:'POST',headers,body:rpc('tools/list')});assert.equal(oldOwner.status,403);
      await DB.prepare('UPDATE site_owner SET sites_id=? WHERE singleton=1').bind('synthetic-owner').run();
      assert.equal((await request('/api/auth/token',{headers:{cookie}})).status,404);
      return tokens.access_token;
    }
    const one=await register('Synthetic client A');const firstToken=await flow(one);
    const two=await register('Synthetic client B');await flow(two,{deny:true});
    const rotatePath='/manage/rotate?client_id='+encodeURIComponent(one);
    const rotateForm=await form(rotatePath,adminHeaders);
    assert.equal((await postAction(rotatePath,rotateForm,adminHeaders,'https://evil.example')).status,403);
    const rotated=await postAction(rotatePath,rotateForm,adminHeaders);assert.equal(rotated.status,200);
    const rotatedText=await rotated.text();const rotatedSecret=/client secret: <code>([^<]+)/.exec(rotatedText)?.[1];assert.ok(rotatedSecret&&rotatedSecret!==secrets.get(one));
    const stored=await DB.prepare('SELECT clientSecret FROM oauthClient WHERE clientId=?').bind(one).first();assert.ok(stored.clientSecret!==rotatedSecret);
    assert.equal((await postAction(rotatePath,rotateForm,adminHeaders)).status,403);
    if(workerdMode)await flow(one,{wrongSecret:true});
    secrets.set(one,rotatedSecret);
    assert.equal((await request('/manage/create-muse',{headers:{...adminHeaders,'oai-authenticated-user-id':'other'}})).status,403);
    const museForm=await form('/manage/create-muse',adminHeaders);
    assert.equal((await postAction('/manage/create-muse',museForm,adminHeaders,'https://evil.example')).status,403);
    assert.equal((await postAction('/manage/create-muse',museForm,adminHeaders,origin,{redirect_uris:'https://evil.example',scope:'admin'})).status,400);
    const museResponse=await postAction('/manage/create-muse',museForm,adminHeaders);assert.equal(museResponse.status,200);
    const museText=await museResponse.text();const muse=/client_id: <code>([^<]+)/.exec(museText)?.[1];assert.ok(muse);assert.ok(!museText.includes('client secret: <code>'));
    const museRow=await DB.prepare('SELECT clientSecret,tokenEndpointAuthMethod,redirectUris FROM oauthClient WHERE clientId=?').bind(muse).first();
    assert.equal(museRow.clientSecret,null);assert.equal(museRow.tokenEndpointAuthMethod,'none');assert.deepEqual(JSON.parse(museRow.redirectUris),['https://agent.meta.ai/api/hatch/oauth/callback']);
    assert.equal((await postAction('/manage/create-muse',museForm,adminHeaders)).status,403);
    for(const method of ['GET','POST'])assert.equal((await request('/manage/rotate?client_id='+muse,{method,headers:adminHeaders})).status,400);
    const manageText=await (await request('/manage',{headers:adminHeaders})).text();assert.ok(!manageText.includes('/manage/rotate?client_id='+muse));assert.ok(manageText.includes('/manage/rotate?client_id='+one));
    const museToken=await flow(muse,{publicClient:true});
    const disableMuse=async()=>{
      const path='/manage/disable?client_id='+encodeURIComponent(muse);
      assert.equal((await request(path,{headers:{...adminHeaders,'oai-authenticated-user-id':'other'}})).status,403);
      assert.equal((await request(path,{method:'POST'})).status,401);
      assert.equal((await request('/manage/disable?client_id=missing',{headers:adminHeaders})).status,404);
      const f=await form(path,adminHeaders);
      assert.equal((await postAction(path,f,adminHeaders,'https://evil.example')).status,403);
      assert.equal((await postAction(path,{...f,csrf:'bad'},adminHeaders)).status,403);
      assert.equal((await postAction(path,f,adminHeaders,origin,{disabled:'false',scope:'admin'})).status,400);
      assert.equal((await postAction('/manage/disable?client_id='+one,f,adminHeaders)).status,403);
      assert.equal((await postAction(path,f,adminHeaders)).status,200);
      assert.equal((await postAction(path,f,adminHeaders)).status,403);
      const row=await DB.prepare('SELECT disabled FROM oauthClient WHERE clientId=?').bind(muse).first();assert.equal(row.disabled,1);
      const other=await DB.prepare('SELECT disabled FROM oauthClient WHERE clientId=?').bind(one).first();assert.ok(!other.disabled);
      const oldTokenRequest=await request('/api/mcp',{method:'POST',headers:{...mcpHeaders,authorization:'Bearer '+museToken},body:rpc('tools/list')});assert.equal(oldTokenRequest.status,403);
      const claudeRequest=await request('/api/mcp',{method:'POST',headers:{...mcpHeaders,authorization:'Bearer '+firstToken},body:rpc('tools/list')});assert.equal(claudeRequest.status,200);
      const list=await (await request('/manage',{headers:adminHeaders})).text();assert.ok(list.includes('無効化済み'));assert.ok(!list.includes('/manage/disable?client_id='+muse));
      for(const method of ['POST','PATCH'])assert.equal((await request('/api/auth/admin/oauth2/update-client',{method,headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({client_id:muse,update:{disabled:false}})})).status,404);
    };
    if(workerdMode) {
      await flow(muse,{publicClient:true,wrongVerifier:true});
      await flow(one);
      await flow(one,{wrongVerifier:true});
      await flow(one,{wrongResource:true});
      for(const override of [{redirect_uri:'https://evil.example/callback'},{code_challenge_method:'plain'},{code_challenge_method:'',code_challenge:''},{resource:'https://other.example/api/mcp'}]) {
        const q=new URLSearchParams({client_id:one,redirect_uri:'https://claude.ai/api/mcp/auth_callback',response_type:'code',scope:'discord',resource:origin+'/api/mcp',code_challenge:'a'.repeat(43),code_challenge_method:'S256',...override});
        const bad=await request(metadata.authorization_endpoint+'?'+q,{headers:{accept:'text/html'}});
        if(bad.status===302){const location=new URL(bad.headers.get('location'),origin);assert.ok(location.searchParams.get('error'));assert.equal(location.searchParams.get('code'),null);if(override.redirect_uri)assert.notEqual(location.origin,'https://evil.example');}else assert.ok(bad.status>=400);
      }
    }
    await flow(muse,{publicClient:true,beforeExchange:disableMuse,expectDisabled:true});
    if(!workerdMode) {
      t.mock.timers.enable({apis:['Date'],now:Date.now()+600_000});
      try {
        const expired=await request('/api/mcp',{method:'POST',headers:{...mcpHeaders,authorization:'Bearer '+firstToken},body:rpc('tools/list')});assert.equal(expired.status,401);
      } finally { t.mock.timers.reset(); }
    }
  } finally { globalThis.fetch=originalFetch;await mf.dispose(); }
});



