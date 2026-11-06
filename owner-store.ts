import {BoundaryError,ownerId,sameOriginRequest,escapeHtml} from './policy.mjs';
export const SITE_ORIGIN='https://example.invalid'; // Set APP_URL to your own HTTPS Site origin.
export const page=(body:string,status=200,extra:Record<string,string>={})=>new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>本人限定MCP</title><body>${body}</body></html>`,{status,headers:{'content-type':'text/html;charset=utf-8','cache-control':'private, no-store','referrer-policy':'strict-origin','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",...extra}});
export function identity(request:Request){const id=request.headers.get('oai-authenticated-user-id');if(!id||!request.headers.get('oai-authenticated-user-email'))throw new BoundaryError(401,'Sign in with ChatGPT');ownerId(id);return id;}
export async function readOwner(DB:D1Database){return (await DB.prepare('SELECT sites_id FROM site_owner WHERE singleton=1').first<{sites_id:string}>())?.sites_id;}
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
export async function actionForm(DB:D1Database,id:string,purpose:string,action:string,label:string){
  const bytes=crypto.getRandomValues(new Uint8Array(32));const nonce=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
  await DB.prepare('DELETE FROM action_nonce WHERE expires_at < ?').bind(Date.now()).run();
  await DB.prepare('INSERT INTO action_nonce VALUES (?,?,?,?)').bind(await digest(nonce),id,purpose,Date.now()+600000).run();
  return page(`<h1>${escapeHtml(label)}</h1><p>本人として続行します。IDのコピーは不要です。</p><form method="post" action="${action}"><input type="hidden" name="csrf" value="${nonce}"><button>${escapeHtml(label)}</button></form>`,200,{'set-cookie':`__Host-action=${nonce}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`});
}
export async function consumeAction(request:Request,DB:D1Database,id:string,purpose:string,origin:string,fields:string[]=[]){
  sameOriginRequest(request,origin,true);
  const form=await request.formData();if([...form.keys()].some(k=>k!=='csrf'&&!fields.includes(k))||[...new Set(form.keys())].some(k=>form.getAll(k).length!==1))throw new BoundaryError(400,'Unexpected fields');
  const token=form.get('csrf');const cookie=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('__Host-action='))?.slice(14);
  if(typeof token!=='string'||token!==cookie)throw new BoundaryError(403,'Invalid CSRF');
  const row=await DB.prepare('DELETE FROM action_nonce WHERE digest=? AND sites_id=? AND purpose=? AND expires_at>=? RETURNING digest').bind(await digest(token),id,purpose,Date.now()).first();
  if(!row)throw new BoundaryError(403,'Expired or reused action');
}
export async function setup(request:Request,DB:D1Database,origin:string){
  sameOriginRequest(request,origin);const owner=await readOwner(DB);const path=new URL(request.url).pathname;
  // Read-only boolean behind the platform's private gate, no user ID or credential.
  if(path==='/setup/status'&&request.method==='GET')return Response.json({configured:!!owner},{headers:{'cache-control':'private, no-store'}});
  const id=identity(request);
  if(owner&&owner!==id)throw new BoundaryError(403,'Owner only');
  if(path==='/setup'&&request.method==='GET')return owner?page('<h1>本人登録済み</h1><p>認証設定の有効化をお待ちください。</p><a href="/manage">接続設定へ</a>'):actionForm(DB,id,'enroll','/setup/enroll','このSiteの所有者として登録');
  if(path==='/setup/enroll'&&request.method==='POST'){
    if(owner)throw new BoundaryError(409,'Owner already configured');
    await consumeAction(request,DB,id,'enroll',origin);
    const result=await DB.prepare('INSERT INTO site_owner(singleton,sites_id,created_at) VALUES(1,?,?) ON CONFLICT(singleton) DO NOTHING').bind(id,Date.now()).run();
    if(result.meta.changes!==1)throw new BoundaryError(409,'Owner already configured');
    console.log(JSON.stringify({event:'owner_enrollment_completed',configured:true}));
    return page('<h1>本人登録が完了しました</h1><p>設定はこのSiteに保存されました。</p><a href="/manage">接続設定へ進む</a>');
  }
  return new Response(null,{status:404});
}
