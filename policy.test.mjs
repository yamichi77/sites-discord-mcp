import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerId, dispatchOwner, checkOwnerSubject, sameOriginRequest, signedQuery, checkConsentScope, escapeHtml, limitBody } from './policy.mjs';
globalThis.fetch=async()=>{throw Error('No network in policy tests');};
const origin='https://fixture.example';
test('unset owner fails closed and email cannot substitute for site-scoped ID',()=>{
  for(const id of ['',undefined,' '])assert.throws(()=>ownerId(id),{status:503});
  assert.throws(()=>dispatchOwner(new Headers({'oai-authenticated-user-email':'owner@example.test'}),'fixture-owner'),{status:401});
  assert.throws(()=>dispatchOwner(new Headers({'oai-authenticated-user-id':'someone-else','oai-authenticated-user-email':'owner@example.test'}),'fixture-owner'),{status:403});
});
test('synthetic dispatched owner mapping and token/session owner checks',()=>{
  const id=dispatchOwner(new Headers({'oai-authenticated-user-id':'fixture-owner','oai-authenticated-user-email':'owner@example.test'}),'fixture-owner');
  assert.equal(id.id,'sites:fixture-owner');checkOwnerSubject(id.id,'fixture-owner');
  assert.throws(()=>checkOwnerSubject('sites:other','fixture-owner'),{status:403});
});
test('host and consent origin are bound to the site',()=>{
  sameOriginRequest(new Request(origin+'/setup'),origin);
  sameOriginRequest(new Request(origin+'/setup',{headers:{origin}}),origin);
  assert.throws(()=>sameOriginRequest(new Request(origin+'/setup',{headers:{origin:'https://evil.example'}}),origin),{status:403});
  assert.throws(()=>sameOriginRequest(new Request('https://evil.example/consent'),origin),{status:400});
  assert.throws(()=>sameOriginRequest(new Request(origin+'/consent/decision',{method:'POST'}),origin,true),{status:403});
  sameOriginRequest(new Request(origin+'/consent/decision',{method:'POST',headers:{origin}}),origin,true);
  assert.throws(()=>sameOriginRequest(new Request(origin+'/setup/enroll',{method:'POST',headers:{origin:'null'}}),origin,true),{status:403});
  assert.throws(()=>sameOriginRequest(new Request(origin+'/setup/enroll',{method:'POST',headers:{origin:'https://evil.example'}}),origin,true),{status:403});
});
test('signed query extraction preserves provider fields; does not claim signature validation',()=>{
  assert.equal(signedQuery('?oauth_query=a%3Db'),'a=b');
  assert.throws(()=>signedQuery('?oauth_query=a&oauth_query=b'),{status:400});
  assert.equal(signedQuery('?sig=x&ba_param=client_id&client_id=c&untrusted=y'),'sig=x&ba_param=client_id&client_id=c');
});
test('consent scope/resource limited to ping, no openid/offline_access or other resource',()=>{
  const good=new URLSearchParams({scope:'discord',resource:origin+'/api/mcp',client_id:'synthetic',redirect_uri:'https://client.example/callback'});
  checkConsentScope(good,origin);
  for(const scope of ['openid','discord offline_access','']){const p=new URLSearchParams(good);p.set('scope',scope);assert.throws(()=>checkConsentScope(p,origin),{status:400});}
  const p=new URLSearchParams(good);p.set('resource','https://other.example/api/mcp');assert.throws(()=>checkConsentScope(p,origin),{status:400});
});
test('self-reported client display is escaped and bodies are bounded',async()=>{
  assert.equal(escapeHtml('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
  await assert.rejects(()=>limitBody(new Request(origin,{method:'POST',body:'x'.repeat(65537)})),{status:413});
});
