import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { z } from 'zod';
import { createAuth, type Env } from './auth.js';
import {registerDiscord} from './discord-tools.js';
import {discordSettings} from './discord-settings.js';
import {readOwner,identity,actionForm,consumeAction,page,SITE_ORIGIN} from './owner-store.js';
import { BoundaryError, canonicalOrigin, ownerId, dispatchOwner, checkOwnerSubject, sameOriginRequest, signedQuery, checkConsentScope, escapeHtml, limitBody } from './policy.mjs';

const html=(body:string)=>new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Discord接続テスト</title><body>${body}</body></html>`,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','referrer-policy':'strict-origin','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
export async function route(request:Request,env:Env):Promise<Response> {
  if(new URL(request.url).pathname.startsWith('/setup'))return new Response(null,{status:404});
  const configured=await readOwner(env.DB);
  env={...env,APP_URL:env.APP_URL||SITE_ORIGIN,OWNER_SITES_ID:configured||''};
  const origin=canonicalOrigin(env.APP_URL);ownerId(env.OWNER_SITES_ID);
  sameOriginRequest(request,origin);
  const path=new URL(request.url).pathname;
  // This standalone candidate does not implement or intercept Sites' managed MCP.
  if(path==='/mcp') return new Response(null,{status:404});
  request=await limitBody(request);
  if(path==='/manage'&&!env.BETTER_AUTH_SECRET){dispatchOwner(request.headers,env.OWNER_SITES_ID);return page('<h1>本人登録済み</h1><p>認証秘密の設定はまだ有効になっていません。client発行は停止中です。</p>',503);}
  const auth=createAuth(env);
  if(path==='/manage'||path==='/manage/login'||path==='/manage/create'||path==='/manage/create-muse'||path==='/manage/rotate'||path==='/manage/disable'||path==='/discord/settings'||path==='/discord/stop'){
    if(path==='/manage'&&request.method==='GET'&&!request.headers.get('oai-authenticated-user-id'))return page('<h1>本人限定の接続設定</h1><a target="_top" href="/signin-with-chatgpt?return_to=%2Fmanage">Sign in with ChatGPT</a>',401);
    const id=identity(request);dispatchOwner(request.headers,env.OWNER_SITES_ID);
    if(path==='/manage/login'&&request.method==='POST'){
      await consumeAction(request,env.DB,id,'login',origin);
      return auth.handler(new Request(origin+'/api/auth/sites-admin-session',{method:'POST',headers:request.headers}));
    }
    const session=await auth.api.getSession({headers:request.headers});
    if(!session){if(request.method!=='GET')return new Response(null,{status:401});return actionForm(env.DB,id,'login','/manage/login','本人として接続設定を開く');}
    checkOwnerSubject(session.user.id,env.OWNER_SITES_ID);
    if(path.startsWith('/discord/'))return discordSettings(request,env,id,origin);
    if(path==='/manage'&&request.method==='GET'){
      const form=await actionForm(env.DB,id,'create-client','/manage/create','Claude用clientを発行');
      const clients=await auth.api.getOAuthClients({headers:request.headers});
      const list=(clients||[]).map(c=>`<li>${escapeHtml(c.client_name||'Client')} <code>${escapeHtml(c.client_id)}</code> ${c.disabled?'無効化済み':`${c.token_endpoint_auth_method==='none'?'public client（secretなし）':`<a href="/manage/rotate?client_id=${encodeURIComponent(c.client_id)}">secretを再発行</a>`} <a href="/manage/disable?client_id=${encodeURIComponent(c.client_id)}">このclientを無効化</a>`}</li>`).join('');
      return new Response((await form.text()).replace('</body>',`<p>Discord REST 6ツール。OAuthログインと同意が必要です。5分で期限切れ、更新なしです。</p><p><a href="/manage/create-muse">Muse用public clientの追加へ（secretなし）</a></p><a href="/discord/settings">Discord接続設定・停止／再開</a><h2>発行済みclient</h2><ul>${list}</ul></body>`),{headers:form.headers});
    }
    if(path==='/manage/create-muse'){
      if(request.method==='GET'){
        const form=await actionForm(env.DB,id,'create-muse','/manage/create-muse','Muse用public clientを追加発行');
        return new Response((await form.text()).replace('<form', '<p>Muse (agent.meta.ai)用の追加登録です。Claude用は維持します。callback: https://agent.meta.ai/api/hatch/oauth/callback。secretなし・PKCE S256・本人同意・Discord scope限定。tokenは5分、更新なしです。</p><form'),{headers:form.headers});
      }
      if(request.method==='POST'){
        await consumeAction(request,env.DB,id,'create-muse',origin);
        const client=await auth.api.createOAuthClient({headers:request.headers,body:{client_name:'Muse (owner-managed)',redirect_uris:['https://agent.meta.ai/api/hatch/oauth/callback'],scope:'discord',grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none',application_type:'web'}});
        return page(`<h1>Muse用public clientを追加しました</h1><p>client_id: <code>${escapeHtml(client.client_id)}</code></p><p>client secretはありません。MCP URL / resource: <code>${escapeHtml(origin+'/api/mcp')}</code></p><p>scope: discord / token認証方式: none / authorization_code + PKCE S256</p><p>callback: https://agent.meta.ai/api/hatch/oauth/callback</p><p>Museで本人が接続・ログイン・同意してください。access tokenは5分、更新なしです。Museとの実接続は未検証です。</p><a href="/manage">管理へ戻る</a>`);
      }
      return new Response(null,{status:405});
    }
    if(path==='/manage/disable'){
      const query=new URL(request.url).searchParams;
      if(query.getAll('client_id').length!==1||[...query.keys()].some(k=>k!=='client_id'))return new Response(null,{status:400});
      const clientId=query.get('client_id')!;
      const clients=await auth.api.getOAuthClients({headers:request.headers});
      const client=clients?.find(c=>c.client_id===clientId);if(!client)return new Response(null,{status:404});
      if(request.method==='GET'){
        if(client.disabled)return page('<h1>このclientは無効化済みです</h1><a href="/manage">管理へ戻る</a>');
        const form=await actionForm(env.DB,id,'disable:'+clientId,`/manage/disable?client_id=${encodeURIComponent(clientId)}`,'このclientのアクセスを停止');
        return new Response((await form.text()).replace('<form',`<p>対象: ${escapeHtml(client.client_name||'Client')} / <code>${escapeHtml(clientId)}</code></p><p>新しいtoken発行と、既発行tokenによる次のMCP要求を拒否します。処理中・送信済みのDiscord操作は取り消せません。他のclientは変更しません。削除ではなく無効化です。この画面では再有効化しません。</p><form`),{headers:form.headers});
      }
      if(request.method==='POST'){
        await consumeAction(request,env.DB,id,'disable:'+clientId,origin);
        await auth.api.adminUpdateOAuthClient({headers:request.headers,body:{client_id:clientId,update:{disabled:true}}});
        return page('<h1>clientを無効化しました</h1><p>このSiteへの次のMCP要求は拒否されます。Museなど接続先側の切断も本人が行ってください。</p><a href="/manage">管理へ戻る</a>');
      }
      return new Response(null,{status:405});
    }
    if(path==='/manage/rotate'){
      const clientId=new URL(request.url).searchParams.get('client_id')||'';
      const clients=await auth.api.getOAuthClients({headers:request.headers});
      if(!clients?.some(c=>c.client_id===clientId))return new Response(null,{status:404});
      if(clients.find(c=>c.client_id===clientId)?.token_endpoint_auth_method==='none')return page('<h1>public clientにsecretはありません</h1>',400);
      if(request.method==='GET')return actionForm(env.DB,id,'rotate:'+clientId,`/manage/rotate?client_id=${encodeURIComponent(clientId)}`,'古いsecretを無効化して再発行（Claudeの設定更新が必要）');
      if(request.method==='POST'){
        await consumeAction(request,env.DB,id,'rotate:'+clientId,origin);
        const client=await auth.api.rotateClientSecret({headers:request.headers,body:{client_id:clientId}});
        return page(`<h1>secretを再発行しました</h1><p>client_id: <code>${escapeHtml(client.client_id)}</code></p><p>client secret: <code>${escapeHtml(client.client_secret)}</code></p><p>今回のみ表示します。Claudeの設定を更新してください。既発行のaccess tokenは最大5分残ります。</p><a href="/manage">管理へ戻る</a>`);
      }
      return new Response(null,{status:405});
    }
    if(path==='/manage/create'&&request.method==='POST'){
      await consumeAction(request,env.DB,id,'create-client',origin);
      const client=await auth.api.createOAuthClient({headers:request.headers,body:{client_name:'Claude (owner-managed)',redirect_uris:['https://claude.ai/api/mcp/auth_callback'],scope:'discord',grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'client_secret_post',application_type:'web'}});
      return page(`<h1>Claude用clientを発行しました</h1><p>secretは今回だけ表示します。チャットへ送らず、Claudeの「Use your own OAuth client」へ貼ってください。再読込すると再表示できません。</p><p>MCP URL: <code>${escapeHtml(origin+'/api/mcp')}</code></p><p>client_id: <code>${escapeHtml(client.client_id)}</code></p><p>client secret: <code>${escapeHtml(client.client_secret)}</code></p><p>callback: https://claude.ai/api/mcp/auth_callback</p><p>Discord REST 6ツール・PKCE S256・本人同意が必要です。access tokenは5分、更新なし。期限後は再認可してください。他クライアントには専用redirectとpublic/confidential種別の登録が必要です。DCRとCIMDは未対応です。</p>`);
    }
    return new Response(null,{status:405});
  }
  if(path==='/api/mcp') {
    return requireMcpAuth(auth,async(req,claims)=>{
      checkOwnerSubject(claims.sub,env.OWNER_SITES_ID);
      if(typeof claims.client_id!=='string'||!claims.client_id) return Response.json({error:'delegated_token_required'},{status:403});
      // Do not rely on JWT expiry for owner-requested revocation. Read only
      // non-secret client state on each MCP request; fail closed if missing.
      const client=await env.DB.prepare('SELECT disabled,userId FROM oauthClient WHERE clientId=?').bind(claims.client_id).first<{disabled:number|null;userId:string|null}>();
      if(!client||client.disabled||client.userId!==claims.sub)return Response.json({error:'client_access_disabled'},{status:403});
      if(req.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST'}});
      const handler=createMcpHandler(()=>{
        const server=new McpServer({name:'sites-owner-discord',version:'0.0.1'});
        registerDiscord(server,env,claims.sub!);
        return server;
      },{legacy:'stateless',responseMode:'json',maxSubscriptions:0});
      try{return await handler.fetch(req);}finally{await handler.close();}
    },{resource:`${origin}/api/mcp`,requiredScopes:['discord']})(request);
  }
  if(path==='/sign-in' || path==='/consent') {
    const query=signedQuery(new URL(request.url).search);
    const {secret}=await auth.$context;
    if(!await verifyOAuthQueryParams(query,secret))return Response.json({error:'invalid_authorization_query'},{status:400});
    const params=new URLSearchParams(query);checkConsentScope(params,origin);
    if(path==='/sign-in') {
      const returnTo=`/api/auth/sites-owner-session?oauth_query=${encodeURIComponent(query)}`;
      const href=`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`;
      return html(`<h1>本人の接続テスト</h1><p>ChatGPTで本人確認してから、Discordの利用を許可します。</p><a target="_top" href="${escapeHtml(href)}">Sign in with ChatGPT</a>`);
    }
    const session=await auth.api.getSession({headers:request.headers});
    if(!session)return Response.redirect(`${origin}/sign-in?oauth_query=${encodeURIComponent(query)}`,302);
    checkOwnerSubject(session.user.id,env.OWNER_SITES_ID);
    if(!session.user.emailVerified)return new Response(null,{status:403});
    const client=await auth.api.getOAuthClientPublic({query:{client_id:params.get('client_id')!},headers:request.headers});
    const redirect=params.get('redirect_uri')!;
    return html(`<h1>Discordへのアクセス許可</h1><p>クライアントID: ${escapeHtml(params.get('client_id'))}</p><p>申告名（第三者の自己申告）: ${escapeHtml(client.client_name || '名称なし')}</p><p>戻り先: ${escapeHtml(redirect)}</p><p>許可内容: 許可チャンネル内のDiscord読み取り・送信・返信・限定reaction。アクセストークンは5分。更新トークンは発行しません。</p><form method="post" action="/consent/decision"><input type="hidden" name="oauth_query" value="${escapeHtml(query)}"><button name="choice" value="allow">許可する</button><button name="choice" value="deny">拒否する</button></form>`);
  }
  if(path==='/consent/decision' && request.method==='POST') {
    sameOriginRequest(request,origin,true);
    const session=await auth.api.getSession({headers:request.headers});
    if(!session)return new Response(null,{status:401});checkOwnerSubject(session.user.id,env.OWNER_SITES_ID);
    const form=await request.formData();const query=form.get('oauth_query');const choice=form.get('choice');
    if(typeof query!=='string'||!['allow','deny'].includes(String(choice)))return new Response(null,{status:400});
    if(!await verifyOAuthQueryParams(query,(await auth.$context).secret))return new Response(null,{status:400});
    checkConsentScope(new URLSearchParams(query),origin);
    // Dispatch through the provider's HTTP handler: its consent continuation needs
    // the Request context, which the server-side API helper does not supply here.
    const consentHeaders=new Headers(request.headers);consentHeaders.set('content-type','application/json');consentHeaders.delete('content-length');
    const response=await auth.handler(new Request(`${origin}/api/auth/oauth2/consent`,{method:'POST',headers:consentHeaders,body:JSON.stringify({accept:choice==='allow',scope:'discord',oauth_query:query})}));
    if(response.status!==200)return response;
    const data=await response.json() as {redirect?:boolean;url?:string;redirect_uri?:string};
    const destination=data.url ?? data.redirect_uri;
    if(typeof destination!=='string')throw Error('Provider did not return a redirect');
    // Redirect only to a library-validated result, never an unverified query URL.
    const headers=new Headers(response.headers);headers.set('location',destination);headers.delete('content-type');
    return new Response(null,{status:302,headers});
  }
  if(path.startsWith('/api/auth/')||path.startsWith('/.well-known/')) {
    // Provider management endpoints are never exposed. The UI calls the library
    // server API with fixed metadata after owner/session/one-time CSRF checks.
    const allowed=new Set(['/api/auth/oauth2/authorize','/api/auth/oauth2/token','/api/auth/oauth2/consent','/api/auth/jwks','/api/auth/sites-owner-session']);
    if(path.startsWith('/api/auth/')&&!allowed.has(path))return new Response(null,{status:404});
    // Block stale/non-owner browser sessions before provider authorization or consent.
    if(path==='/api/auth/oauth2/authorize'||path==='/api/auth/oauth2/consent') {
      const session=await auth.api.getSession({headers:request.headers});
      if(session)checkOwnerSubject(session.user.id,env.OWNER_SITES_ID);
    }
    if(path==='/api/auth/sites-owner-session')dispatchOwner(request.headers,env.OWNER_SITES_ID);
    const response=await auth.handler(request);
    // Some provider versions return JSON navigation instructions to an HTML
    // browser. Preserve its cookies while following only provider-produced URLs.
    if(response.status===200 && request.method==='GET' && request.headers.get('accept')?.includes('text/html') && response.headers.get('content-type')?.includes('application/json')) {
      const data=await response.clone().json() as {redirect?:boolean;url?:string};
      if(data.redirect===true && typeof data.url==='string') {
        const headers=new Headers(response.headers);headers.set('location',data.url);headers.delete('content-type');
        return new Response(null,{status:302,headers});
      }
    }
    return response;
  }
  return html('<h1>本人限定Discord MCP</h1><p>外部クライアントには /api/mcp を指定してください。</p>');
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
  try{return await route(request,env);}catch(e){return Response.json({error:e instanceof BoundaryError?e.message:'Request unavailable'},{status:e instanceof BoundaryError?e.status:503,headers:{'cache-control':'no-store'}});}
}};

