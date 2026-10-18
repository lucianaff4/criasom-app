import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformClient } from '../client/platform-client.mjs';
const csrf = 'a'.repeat(64);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type':'application/json' } });

test('same-origin cookies, no-store and CSRF; no user-selected entitlement or identity', async () => {
  const calls=[];
  const client=new PlatformClient({fetchImpl:async (url,init)=>{calls.push({url,init});return json(url.endsWith('/session')?{authenticated:true,user:{id:'alice',email:'alice@example.invalid'},csrf,capabilities:['app']}:{revision:8,data:{favorites:['song-1']}});}});
  await client.refreshSession(); await client.saveState('repertoire',7,{favorites:['song-1']});
  assert.equal(calls[1].url,'/api/v1/state/repertoire');
  assert.equal(calls[1].init.credentials,'same-origin'); assert.equal(calls[1].init.cache,'no-store');
  assert.equal(calls[1].init.headers['X-CSRF-Token'],csrf);
  assert.deepEqual(JSON.parse(calls[1].init.body),{expected_revision:7,data:{favorites:['song-1']}});
});
test('anonymous writes require server session context', async () => {
  const client=new PlatformClient({fetchImpl:()=>{throw new Error('should not fetch');}});
  await assert.rejects(client.requestCode('student@example.invalid'),/Session context/);
});
test('401 discards private state and never falls back to local entitlements', async () => {
  let cleared=0; const client=new PlatformClient({fetchImpl:async()=>json({},401),onClear:()=>cleared++});
  client.user={id:'alice'};client.csrf=csrf;
  await assert.rejects(client.resource('penta-page-1'),/Sign-in required/);
  assert.equal(client.user,null);assert.equal(client.csrf,null);assert.equal(cleared,1);
});
test('response arriving after logout cannot restore the old account', async () => {
  let release;const client=new PlatformClient({fetchImpl:()=>new Promise(r=>release=r)});
  const pending=client.refreshSession();client.clear();release(json({authenticated:true,user:{id:'alice',email:'alice@example.invalid'},csrf,capabilities:['app']}));
  await assert.rejects(pending,/Session changed/);assert.equal(client.user,null);
});
test('resource route rejects traversal, external URLs and client-side file paths', () => {
  const client=new PlatformClient();
  for(const id of ['../private','https://example.invalid/file','page?grant=all','C:/secret']) assert.throws(()=>client.resource(id),/Invalid resource/);
});
test('conflicting write is reported; does not retry or overwrite remote progress', async () => {
  let count=0;const client=new PlatformClient({fetchImpl:async()=>{count++;return json({},409);}});client.csrf=csrf;
  await assert.rejects(client.saveState('study',1,{}),/State changed/);assert.equal(count,1);
});
test('logout failure clears local data but is not reported as server success', async () => {
  const client=new PlatformClient({fetchImpl:async()=>{throw new Error('network unavailable');}});client.user={id:'alice'};client.csrf=csrf;
  await assert.rejects(client.logout(),/network unavailable/);assert.equal(client.user,null);
});
test('switching accounts clears old view state and accepts only structured session data', async () => {
  let cleared=0;let next=json({authenticated:true,user:{id:'bob',email:'bob@example.invalid'},csrf,capabilities:['app']});
  const client=new PlatformClient({fetchImpl:async()=>next,onClear:()=>cleared++});client.user={id:'alice'};
  await client.refreshSession();assert.equal(cleared,1);assert.equal(client.user.id,'bob');
  next=json({authenticated:true,user:null,csrf});
  await assert.rejects(client.refreshSession(),/Invalid session/);assert.equal(client.user,null);
  next=json(null);client.user={id:'alice'};
  await assert.rejects(client.refreshSession(),/Invalid session/);assert.equal(client.user,null);
});
