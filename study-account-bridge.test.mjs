import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createStudyAccountBridge} from '../client/study-account-bridge.mjs';
const model = await import('data:text/javascript;base64,' + (await readFile(new URL('../../criasom-app-piloto/dist/model.js', import.meta.url))).toString('base64'));
const clone = data => JSON.parse(JSON.stringify(data));
const edit = id => state => model.planSession(state,{id,courseId:'dap',moduleId:'dap:modulo:03',practiceId:'demo',date:'2026-10-20',time:id==='one'?'12:00':id==='two'?'13:00':'14:00',minutes:10});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('no anonymous browser state is read, and saved requires a real acknowledgement', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('Must not read anonymous localStorage');}});
  try {
    let resolve; const states=[];
    const bridge=createStudyAccountBridge({model,initial:{revision:0,data:{}},onStatus:s=>states.push(s.phase),client:{saveState:(_,revision,data)=>new Promise(done=>{resolve=()=>done({revision:revision+1,data:clone(data)});})}});
    const change=bridge.store.transact(edit('one'));
    assert.equal(change.ok,true);assert.equal(change.persisted,false);assert.equal(bridge.status().phase,'saving');
    resolve();assert.equal(await bridge.flush(),true);
    assert.equal(bridge.store.read().persisted,true);assert.equal(bridge.status().remoteRevision,1);assert.deepEqual(states,['saving','saved']);
  } finally {if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;}
});

test('serial CAS coalesces multiple changes while preserving the newest full draft',async()=>{
  const calls=[],resolvers=[];
  const client={saveState:(_,revision,data)=>{calls.push({revision,data:clone(data)});return new Promise(resolve=>resolvers.push(()=>resolve({revision:revision+1,data:clone(data)})));}};
  const bridge=createStudyAccountBridge({model,initial:{revision:9,data:{}},client});
  bridge.store.transact(edit('one'));bridge.store.transact(edit('two'));bridge.store.transact(edit('three'));
  assert.equal(calls.length,1);resolvers.shift()();await tick();assert.equal(calls.length,2);
  assert.equal(calls[1].revision,10);assert.deepEqual(calls[1].data.sessions.map(s=>s.id),['one','two','three']);
  resolvers.shift()();assert.equal(await bridge.flush(),true);assert.equal(bridge.status().remoteRevision,11);
  assert.equal(bridge.store.read().state.revision,3);
});

test('conflict freezes writes and never silently retries over another account version',async()=>{
  let calls=0;const bridge=createStudyAccountBridge({model,initial:{revision:2,data:{}},client:{saveState:async()=>{calls++;throw Error('State changed; reload before saving');}}});
  bridge.store.transact(edit('one'));assert.equal(await bridge.flush(),false);assert.equal(bridge.status().phase,'conflict');
  assert.equal(bridge.store.transact(edit('two')).ok,false);assert.equal(calls,1);assert.equal(bridge.store.read().state.sessions.length,1);
});

test('uncertain network response freezes without claiming persistence or retrying a possibly applied write',async()=>{
  const bridge=createStudyAccountBridge({model,initial:{revision:0,data:{}},client:{saveState:async()=>{throw Error('Network failure');}}});
  bridge.store.transact(edit('one'));assert.equal(await bridge.flush(),false);assert.equal(bridge.status().phase,'error');assert.equal(bridge.store.read().persisted,false);
});

test('sign out discards memory and a late acknowledgement cannot resurrect private state',async()=>{
  let resolve;const bridge=createStudyAccountBridge({model,initial:{revision:0,data:{}},client:{saveState:(_,revision,data)=>new Promise(done=>{resolve=()=>done({revision:1,data});})}});
  bridge.store.transact(edit('one'));bridge.dispose();resolve();assert.equal(await bridge.flush(),false);
  assert.equal(bridge.store.read().state.sessions.length,0);assert.equal(bridge.store.transact(edit('two')).ok,false);assert.equal(bridge.status().phase,'signed-out');
});

test('a new instance reloads confirmed study and clock without copying a different identity',async()=>{
  let saved={revision:0,data:{}};const client={saveState:async(_,revision,data)=>(saved={revision:revision+1,data:clone(data)})};
  const a=createStudyAccountBridge({model,initial:saved,client});
  a.store.transact(edit('one'));a.store.transact(s=>model.startStudyClock(s,{id:'clock',minutes:15}));await a.flush();
  const reopened=createStudyAccountBridge({model,initial:clone(saved),client});assert.equal(reopened.store.read().state.sessions[0].id,'one');assert.equal(reopened.store.read().state.studyClock.minutes,15);
  const another=createStudyAccountBridge({model,initial:{revision:0,data:{}},client});assert.equal(another.store.read().state.sessions.length,0);
});

test('no entitlement means the connected study store cannot create a write',()=>{
  const bridge=createStudyAccountBridge({model,initial:{revision:0,data:{}},writable:false,client:{saveState(){throw Error('Must not be called');}}});
  assert.equal(bridge.store.transact(edit('one')).ok,false);assert.equal(bridge.store.read().state.sessions.length,0);
});

test('malformed or mismatched acknowledgements never display saved',async()=>{
  for(const reply of [{revision:8,data:{}},{revision:1,data:{modified:true}}]){
    const bridge=createStudyAccountBridge({model,initial:{revision:0,data:{}},client:{saveState:async()=>reply}});
    bridge.store.transact(edit('one'));assert.equal(await bridge.flush(),false);assert.equal(bridge.status().phase,'error');
  }
});
