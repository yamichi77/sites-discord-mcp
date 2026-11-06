export class DiscordError extends Error {}
export const snowflake=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)&&BigInt(v)<=18446744073709551615n;
const fail=m=>{throw new DiscordError(m);};
export const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
async function aes(key){if(typeof key!=='string'||!/^[0-9a-f]{64}$/.test(key))fail('Discord secure configuration unavailable');return crypto.subtle.importKey('raw',Uint8Array.from(key.match(/../g),x=>parseInt(x,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function encryptToken(token,key){if(typeof token!=='string'||!token.trim()||token.length>2048||/[\s]/.test(token))fail('Invalid bot token');const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('discord-bot-token-v1')},await aes(key),new TextEncoder().encode(token));return JSON.stringify({iv:Array.from(iv),data:Array.from(new Uint8Array(data))});}
async function decryptToken(value,key){try{const x=JSON.parse(value);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(x.iv),additionalData:new TextEncoder().encode('discord-bot-token-v1')},await aes(key),new Uint8Array(x.data)));}catch{fail('Discord secure configuration unavailable');}}
export function parseIds(value){const ids=String(value||'').split(',').map(s=>s.trim()).filter(Boolean);if(!ids.length||ids.length>20||!ids.every(snowflake)||new Set(ids).size!==ids.length)fail('Specify 1–20 unique Discord IDs');return ids;}
export function projectMessage(m){return {id:m.id,channel_id:m.channel_id,author:{id:m.author?.id,username:m.author?.username,bot:!!m.author?.bot},content:String(m.content||'').slice(0,4000),timestamp:m.timestamp,attachments:(m.attachments||[]).slice(0,10).map(a=>({id:a.id,filename:a.filename,url:a.url,content_type:a.content_type,size:a.size})),untrusted_content:true};}
export async function config(DB){const c=await DB.prepare('SELECT * FROM discord_config WHERE singleton=1').first();if(!c)fail('Discord is not configured');return {...c,channels:JSON.parse(c.channels),authors:JSON.parse(c.authors)};}
export class DiscordAdapter {
 constructor(env,owner,fetcher=fetch){this.env=env;this.owner=owner;this.fetcher=fetcher;}
 async api(path,method='GET',body){
  const c=await config(this.env.DB);if(!c.enabled)fail('Discord is stopped');if(c.revision!==this.c.revision)fail('Discord configuration changed; retry explicitly');
  if(c.blocked_until>Date.now())fail('Discord rate limited; retry later');
  const window=Math.floor(Date.now()/60000);const budget=await this.env.DB.prepare('INSERT INTO discord_budget VALUES(?,1) ON CONFLICT(window) DO UPDATE SET count=count+1 RETURNING count').bind(window).first();
  if(budget.count>60)fail('Local Discord request budget exhausted');
  let r;try{r=await (0,this.fetcher)('https://discord.com/api/v10'+path,{method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{authorization:'Bot '+this.token,'content-type':'application/json','user-agent':'DiscordBot (Sites LT, 1.0)'},...(body?{body:JSON.stringify(body)}:{})});}catch{fail('Discord request outcome unknown; do not resend writes automatically');}
  let delay=Number(r.headers.get('retry-after')||r.headers.get('x-ratelimit-reset-after')||0);
  if(r.status===429||r.headers.get('x-ratelimit-remaining')==='0'){
   if(r.status===429){try{const j=await r.clone().json();delay=Number(j.retry_after)||delay;}catch{}}
   delay=Number.isFinite(delay)&&delay>0?Math.min(delay,3600):60;
   await this.env.DB.prepare('UPDATE discord_config SET blocked_until=MAX(blocked_until,?) WHERE singleton=1').bind(Date.now()+Math.ceil(delay*1000)).run();
  }
  if(!r.ok)fail(r.status===429?'Discord rate limited; retry later':`Discord HTTP ${r.status}`);
  if(r.status===204)return null;try{return await r.json();}catch{fail('Invalid Discord response');}
 }
 async prepare(channel){
  this.c=await config(this.env.DB);if(!this.c.enabled)fail('Discord is stopped');if(!snowflake(channel)||!this.c.channels.includes(channel))fail('Channel not allowlisted');
  this.token=await decryptToken(this.c.encrypted_token,this.env.DISCORD_CONFIG_KEY);
  const bot=await this.api('/users/@me');if(bot.id!==this.c.bot_id||bot.bot!==true)fail('Configured bot identity mismatch');
  const ch=await this.api('/channels/'+channel);if(ch.id!==channel||ch.guild_id!==this.c.guild_id||![0,5,11,12].includes(ch.type))fail('Channel/guild/type mismatch');
 }
 async source(a,fresh=true){if(!snowflake(a.message_id))fail('Invalid message ID');const m=await this.api(`/channels/${a.channel_id}/messages/${a.message_id}`);
  if(m.id!==a.message_id||m.channel_id!==a.channel_id||!this.c.authors.includes(m.author?.id)||m.author?.bot||m.webhook_id)fail('Target must be an allowlisted human message');
  if(fresh){const stamp=Date.parse(m.timestamp);if(!Number.isFinite(stamp)||Date.now()-stamp>300000||stamp>Date.now()+5000)fail('Stale target; replies/reactions require a message within 5 minutes');}
  return m;
 }
 async call(name,a){
  await this.prepare(a.channel_id);
  if(name==='discord_history'){
   const limit=a.limit??25;if(!Number.isInteger(limit)||limit<1||limit>100||(a.before!==undefined&&!snowflake(a.before)))fail('Invalid history arguments');
   const data=await this.api(`/channels/${a.channel_id}/messages?limit=${limit}${a.before?'&before='+a.before:''}`);if(!Array.isArray(data))fail('Invalid Discord response');return data.map(projectMessage);
  }
  if(name==='discord_message'){if(!snowflake(a.message_id))fail('Invalid message ID');const m=await this.api(`/channels/${a.channel_id}/messages/${a.message_id}`);if(m.id!==a.message_id||m.channel_id!==a.channel_id)fail('Message mismatch');return projectMessage(m);}
  if(['discord_react','discord_reaction_remove'].includes(name)){
   const remove=name==='discord_reaction_remove';const emoji=a.emoji??(remove?'⏳':'👀');if(!(remove?['⏳']:['👀','⏳']).includes(emoji))fail('Unsupported emoji');
   const m=await this.source(a,!remove);if(!new RegExp(`<@!?${this.c.bot_id}>`).test(m.content||'')||!m.mentions?.some(u=>u.id===this.c.bot_id))fail('Reaction requires a human direct bot mention');
   const present=x=>x.reactions?.some(r=>!r.emoji?.id&&r.emoji?.name===emoji&&r.me===true);
   if(!!present(m)===!remove)return {status:remove?'already_absent':'already_present'};
   await this.api(`/channels/${a.channel_id}/messages/${a.message_id}/reactions/${encodeURIComponent(emoji)}/@me`,remove?'DELETE':'PUT');
   const after=await this.source(a,false);if(!!present(after)!==!remove)fail('Reaction result unconfirmed; inspect before retrying');return {status:remove?'removed':'added'};
  }
  if(!['discord_send','discord_reply'].includes(name))fail('Unknown tool');
  if(typeof a.content!=='string'||!a.content.trim()||a.content.length>2000||! /^[A-Za-z0-9_-]{8,128}$/.test(a.idempotency_key||''))fail('Invalid message arguments');
  const reply=name==='discord_reply';if(reply&&!snowflake(a.message_id))fail('Invalid message ID');
  const key=await hash(JSON.stringify([this.owner,a.idempotency_key]));const fingerprint=await hash(JSON.stringify([name,a.channel_id,a.message_id||null,a.content]));
  const prior=await this.env.DB.prepare('SELECT * FROM discord_writes WHERE key_hash=?').bind(key).first();
  if(prior){if(prior.fingerprint!==fingerprint)fail('Idempotency key reused with different arguments');if(prior.status==='complete')return JSON.parse(prior.result);fail('Previous send outcome uncertain; inspect Discord, no automatic retry');}
  if(reply)await this.source(a);
  const reserved=await this.env.DB.prepare("INSERT INTO discord_writes VALUES(?,?,'pending',NULL,?) ON CONFLICT(key_hash) DO NOTHING").bind(key,fingerprint,Date.now()).run();
  if(reserved.meta.changes!==1)fail('Concurrent/repeated send rejected; inspect result');
  const m=await this.api(`/channels/${a.channel_id}/messages`,'POST',{content:a.content,allowed_mentions:{parse:[],replied_user:false},nonce:key.slice(0,24),enforce_nonce:true,...(reply?{message_reference:{message_id:a.message_id,channel_id:a.channel_id,fail_if_not_exists:true}}:{})});
  if(!snowflake(m?.id)||m.channel_id!==a.channel_id)fail('Send result unconfirmed');const result=projectMessage(m);
  await this.env.DB.prepare("UPDATE discord_writes SET status='complete',result=? WHERE key_hash=?").bind(JSON.stringify(result),key).run();return result;
 }
}



