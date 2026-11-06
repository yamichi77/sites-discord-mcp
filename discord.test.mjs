import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {DiscordAdapter,encryptToken,snowflake} from './discord.mjs';
test('Discord REST safety boundaries with synthetic D1 and no external network',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:['DB'],d1Persist:false,host:'127.0.0.1'});
 try{
  const DB=await mf.getD1Database('DB');const sql=await readFile('drizzle/0002_discord.sql','utf8');await DB.batch(sql.split('--> statement-breakpoint').map(s=>DB.prepare(s.trim())));
  const key=randomBytes(32).toString('hex');const token='synthetic-token-never-log';const encrypted=await encryptToken(token,key);assert.ok(!encrypted.includes(token));
  const env={DB,DISCORD_CONFIG_KEY:key};let calls=[];let mode='ok';let reactions=[];
  let source={id:'400',channel_id:'100',author:{id:'300',bot:false},content:'<@900> synthetic',mentions:[{id:'900'}],timestamp:new Date().toISOString(),attachments:[]};
  const fetcher=async(url,options)=>{
   calls.push({path:new URL(url).pathname,method:options.method,body:options.body?JSON.parse(options.body):null});
   assert.equal(new URL(url).origin,'https://discord.com');assert.equal(options.redirect,'manual');assert.ok(options.headers.authorization==='Bot '+token);
   if(mode==='error')throw Error('do not leak '+token);
   if(mode==='429')return Response.json({retry_after:2},{status:429,headers:{'retry-after':'2'}});
   const path=new URL(url).pathname;
   if(path.endsWith('/users/@me'))return Response.json({id:mode==='wrongbot'?'901':'900',bot:true});
   if(path==='/api/v10/channels/100')return Response.json({id:'100',guild_id:mode==='wrongguild'?'201':'200',type:0});
   if(options.method==='POST')return Response.json({id:'500',channel_id:'100',author:{id:'900',bot:true},content:JSON.parse(options.body).content,timestamp:new Date().toISOString()});
   if(options.method==='PUT'){reactions=[{emoji:{name:'⏳',id:null},me:true}];return new Response(null,{status:204});}
   if(options.method==='DELETE'){reactions=[];return new Response(null,{status:204});}
   if(path.endsWith('/messages'))return Response.json([source]);return Response.json({...source,reactions});
  };
  const adapter=()=>new DiscordAdapter(env,'synthetic-owner',fetcher);
  await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/not configured/);assert.equal(calls.length,0);
  await DB.prepare('INSERT INTO discord_config VALUES(1,?,?,?,?,?,0,1,0)').bind('200','900','["100"]','["300"]',encrypted).run();
  await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/stopped/);assert.equal(calls.length,0);
  await DB.prepare('UPDATE discord_config SET enabled=1').run();
  for(const channel_id of ['101','../x','0','18446744073709551616'])await assert.rejects(()=>adapter().call('discord_history',{channel_id}),/allowlisted/);
  assert.ok(!snowflake(123));
  mode='wrongbot';await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/identity mismatch/);
  mode='wrongguild';await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/mismatch/);mode='ok';
  assert.equal((await adapter().call('discord_history',{channel_id:'100'}))[0].untrusted_content,true);
  await assert.rejects(()=>adapter().call('discord_send',{channel_id:'100',content:'a'.repeat(2001),idempotency_key:'valid_key'}),/Invalid/);
  await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100',limit:101}),/Invalid/);
  const args={channel_id:'100',content:'@everyone <@123> synthetic',idempotency_key:'same_key_123'};
  const sent=await adapter().call('discord_send',args);assert.equal(sent.id,'500');
  await adapter().call('discord_send',args);assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.deepEqual(calls.find(c=>c.method==='POST').body.allowed_mentions,{parse:[],replied_user:false});
  await assert.rejects(()=>adapter().call('discord_send',{...args,content:'different'}),/reused/);
  const oldTime=source.timestamp;source.timestamp=new Date(Date.now()-301000).toISOString();await assert.rejects(()=>adapter().call('discord_reply',{...args,idempotency_key:'stale_key',message_id:'400'}),/Stale/);source.timestamp=oldTime;
  source.author.bot=true;await assert.rejects(()=>adapter().call('discord_reply',{...args,idempotency_key:'peer_key',message_id:'400'}),/human/);source.author.bot=false;
  await assert.rejects(()=>adapter().call('discord_react',{channel_id:'100',message_id:'400',emoji:'🔥'}),/emoji/);
  assert.equal((await adapter().call('discord_react',{channel_id:'100',message_id:'400',emoji:'⏳'})).status,'added');
  assert.equal((await adapter().call('discord_reaction_remove',{channel_id:'100',message_id:'400',emoji:'⏳'})).status,'removed');
  assert.ok(calls.filter(c=>['PUT','DELETE'].includes(c.method)).every(c=>c.path.endsWith('/@me')));
  // Reset application budget for independent fault scenarios, not production state.
  await DB.prepare('DELETE FROM discord_budget').run();
  const uncertainArgs={...args,idempotency_key:'uncertain_key'};
  const uncertain=new DiscordAdapter(env,'synthetic-owner',async(url,options)=>options.method==='POST'?Promise.reject(Error('sensitive '+token)):fetcher(url,options));
  await assert.rejects(()=>uncertain.call('discord_send',uncertainArgs),e=>e.message.includes('outcome unknown')&&!e.message.includes(token));
  await assert.rejects(()=>adapter().call('discord_send',uncertainArgs),/uncertain/);
  const before=calls.filter(c=>c.method==='POST').length;
  const race=await Promise.allSettled([adapter().call('discord_send',{...args,idempotency_key:'race_key'}),adapter().call('discord_send',{...args,idempotency_key:'race_key'})]);
  assert.ok(race.some(r=>r.status==='fulfilled'));assert.equal(calls.filter(c=>c.method==='POST').length-before,1);
  mode='429';const beforeRate=calls.length;await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/rate limited/);assert.equal(calls.length-beforeRate,1);
  mode='ok';await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/rate limited/);assert.equal(calls.length-beforeRate,1);
  await DB.prepare('UPDATE discord_config SET blocked_until=0,enabled=0,revision=revision+1').run();await assert.rejects(()=>adapter().call('discord_history',{channel_id:'100'}),/stopped/);
 }finally{await mf.dispose();}
});

