import {config,encryptToken,parseIds,snowflake} from './discord.mjs';
import {actionForm,consumeAction,page} from './owner-store.js';
import {escapeHtml} from './policy.mjs';
import type {Env} from './auth.js';
export async function discordSettings(request:Request,env:Env,id:string,origin:string){
 const current=await config(env.DB).catch(()=>null);const path=new URL(request.url).pathname;
 if(path==='/discord/stop'&&request.method==='POST'){
  await consumeAction(request,env.DB,id,'discord-stop',origin);
  await env.DB.prepare('UPDATE discord_config SET enabled=0,revision=revision+1 WHERE singleton=1').run();return page('<h1>Discord接続を停止しました</h1><p>送信中だった処理は取り消せません。新しい処理は拒否されます。</p><a href="/discord/settings">設定へ</a>');
 }
 if(request.method==='GET'){
  if(!env.DISCORD_CONFIG_KEY)return page('<h1>Discord設定の準備中</h1><p>このSite専用の暗号化鍵の設定が必要です。Bot tokenはまだ入力しないでください。</p>',503);
  if(path==='/discord/stop')return actionForm(env.DB,id,'discord-stop','/discord/stop','Discord接続を停止');
  const form=await actionForm(env.DB,id,'discord-config','/discord/settings','Discord設定を保存');
  const fields=`<p>Bot tokenはこのSiteの暗号化DBへ保存し、表示・再表示しません。空欄なら現在値を保持します。</p><label>Bot token <input name="bot_token" type="password" autocomplete="new-password"></label><label>Guild ID <input name="guild_id" value="${escapeHtml(current?.guild_id||'')}" required></label><label>Bot User ID <input name="bot_id" value="${escapeHtml(current?.bot_id||'')}" required></label><label>許可channel IDs（カンマ区切り）<input name="channels" value="${escapeHtml(current?.channels.join(',')||'')}" required></label><label>返信・reactionを許可するhuman IDs<input name="authors" value="${escapeHtml(current?.authors.join(',')||'')}" required></label><label><input type="checkbox" name="enabled" value="yes">接続を有効化／再開し、このBotで指定チャンネルの読み書きを許可する</label><p>既定は停止。Gateway・通知・peer Bot連携なし。古い返信（5分超）は拒否。停止は新規処理に適用され、送信済みの取り消しはしません。</p><p>必要権限：View Channel / Read Message History / Send Messages / Add Reactions。threadではSend Messages in Threadsも必要。Message Content Intentが無いと本文等が空になる場合があります。Administratorは不要です。</p>`;
  let html=(await form.text()).replace('<button>',fields+'<button>');
  html=html.replace('</body>','<a href="/discord/stop">停止の確認へ</a><a href="/manage">OAuth client管理へ</a></body>');
  return new Response(html,{headers:form.headers});
 }
 if(path==='/discord/settings'&&request.method==='POST'){
  if(!env.DISCORD_CONFIG_KEY)return page('<h1>暗号化鍵が未設定です</h1>',503);
  const f=await request.clone().formData();await consumeAction(request,env.DB,id,'discord-config',origin,['bot_token','guild_id','bot_id','channels','authors','enabled']);
  const guild=String(f.get('guild_id')||'');const bot=String(f.get('bot_id')||'');const channels=parseIds(f.get('channels'));const authors=parseIds(f.get('authors'));
  if(!snowflake(guild)||!snowflake(bot)||authors.includes(bot))return page('<h1>Discord IDsが不正です</h1>',400);
  const raw=String(f.get('bot_token')||'');const token=raw?await encryptToken(raw,env.DISCORD_CONFIG_KEY):current?.encrypted_token;if(!token)return page('<h1>Bot tokenが必要です</h1>',400);
  await env.DB.prepare('INSERT INTO discord_config VALUES(1,?,?,?,?,?,?,1,0) ON CONFLICT(singleton) DO UPDATE SET guild_id=excluded.guild_id,bot_id=excluded.bot_id,channels=excluded.channels,authors=excluded.authors,encrypted_token=excluded.encrypted_token,enabled=excluded.enabled,revision=discord_config.revision+1,blocked_until=MAX(discord_config.blocked_until,excluded.blocked_until)').bind(guild,bot,JSON.stringify(channels),JSON.stringify(authors),token,f.get('enabled')==='yes'?1:0).run();
  return page('<h1>Discord設定を保存しました</h1><p>tokenは再表示しません。実Discord接続はまだ検証していません。</p><a href="/discord/settings">設定へ</a>');
 }
 return new Response(null,{status:405});
}
