import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {mergeStates} from './sync.mjs';

// Execute the real session/sync controller with a minimal DOM and controlled network.
const source=readFileSync(new URL('./app.mjs',import.meta.url),'utf8').split('\nfunction navigate(')[0].replace(/^import .*;\n/gm,'');
function harness(){
  const elements=new Map();
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',hidden:false,open:false,dataset:{},close(){this.open=false;}});return elements.get(selector);};
  const context=vm.createContext({document:{querySelector:element},location:{pathname:'/saldos',search:'',hash:''},history:{replaceState(){}},crypto:globalThis.crypto,structuredClone,Date,Intl,clearTimeout,setTimeout,todayISO:()=> '2026-10-14',monthStart:()=> '2026-10-01',mergeStates,renderAuth(){},authPaths:new Set(['/login']),fetch(){throw Error('Unexpected fetch');}});
  vm.runInContext(source,context);
  vm.runInContext("account={id:'A'};csrfToken='csrf-A';state={revision:1};refreshFinance=()=>{};toast=()=>{};",context);
  return {context,run:code=>vm.runInContext(code,context),element};
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const response=(status,data,json)=>({status,ok:status>=200&&status<300,headers:{get:()=>null},json:json||(async()=>data),clone(){return this;}});

test('logout clears nested financial drafts and hidden financial modal content',()=>{
  const h=harness();h.run("returnDraft={draft:{description:'private A'}};editing={sourceId:'A'};");h.element('#modal').innerHTML='private A';h.run('showLogin()');
  assert.equal(h.run('returnDraft'),null);assert.equal(h.run('editing'),null);assert.equal(h.element('#modal').innerHTML,'');assert.equal(h.run('state'),undefined);
});
test('session change during conflict read cannot PUT previous account state',async()=>{
  const h=harness(),body=deferred(),ready=deferred();let calls=0;
  h.context.fetch=async()=>{calls++;if(calls===1)return response(409,{});return response(200,null,()=>{ready.resolve();return body.promise;});};
  const saving=h.run("saveCandidate({revision:1},{revision:1},'saved')");await ready.promise;
  h.run("authEpoch++;account={id:'B'};csrfToken='csrf-B'");body.resolve({revision:2});
  assert.equal(await saving,false);assert.equal(calls,2);
});
test('late polling result cannot replace a more recent save or create pending old state',async()=>{
  const h=harness(),body=deferred(),ready=deferred();h.context.fetch=async()=>{return response(200,null,()=>{ready.resolve();return body.promise;});};
  const polling=h.run('synchronize()');await ready.promise;h.run('state={revision:3};formDirty=true');body.resolve({revision:2});await polling;
  assert.equal(h.run('state.revision'),3);assert.equal(h.run('pendingRemote'),null);
});
