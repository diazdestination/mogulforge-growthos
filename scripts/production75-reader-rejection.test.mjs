import {test,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareOperatorPlan,openOperatorCustody,operatorPlanDigest} from './production75-custody.mjs';
import {createProduction75V1Client,production75V1FailureMetadata} from './production75-fly-v1.mjs';
const secret='synthetic-rejection-secret-never-persist';
const original=(id,name)=>({id,name,organization:'adam-diaz',version:1,region:'iad',plan:'basic',status:'ready',attachedApps:[]});
async function fixture(extra={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'production75-rejection-'));
 const plan=prepareOperatorPlan({runId:randomUUID(),backupId:'backup_fixture',sourceSnapshotSha256:'a'.repeat(64),profileSha256:'b'.repeat(64),moduleManifestSha256:'c'.repeat(64),preparedAt:Date.now(),workMs:90000,cleanupMs:30000,maxCostUsdMicros:150000});
 const digest=operatorPlanDigest(plan),custody=await openOperatorCustody({root,plan,verifyOwnerApproval:async()=>({authenticated:true,kind:'owner-approval',planSha256:digest,receiptSha256:'d'.repeat(64),maxCopies:1,maxCostUsdMicros:150000,expiresAt:plan.cleanupUntil,sourceWritesAuthorized:false}),verifyCapabilityReview:async()=>({authenticated:true,kind:'independent-capability-review',planSha256:digest,receiptSha256:'e'.repeat(64),profileSha256:plan.profileSha256,sourceSnapshotSha256:plan.sourceSnapshotSha256,scope:'fixed-query-observation-with-inherited-capabilities',zeroDdlClusterWideVerified:false})});
 custody.observeBefore([original('kzpwm0j18eg04nv3','production'),original('zp2wjrejd2zodn4q','staging')]);
 custody.reserve('copy-create');custody.bindOwned(original('abcdefghijklmnop',plan.copyName));custody.verifyClone(plan.sourceSnapshotSha256);
 let dispatches=0;
 const api=createProduction75V1Client({organization:'adam-diaz',getAuthorization:async()=> 'Bearer synthetic-fixture',fetchFn:async(...args)=>{dispatches++;return extra.response(...args);},...extra.client});
 const permit=custody.reserve('reader-create');
 return {api,permit,plan,dispatches:()=>dispatches,close(){custody.close();const real=fs.realpathSync(root);if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('production75-rejection-'))throw Error('Owned test cleanup held');fs.rmSync(real,{recursive:true});}};
}
async function failure(promise){try{await promise;throw Error('Expected rejection');}catch(e){expect(e.safeCode).toBe('production75_v1_status');expect(e.message).toBe('production75_v1_status');expect(e.cause).toBeUndefined();return e;}}
function privateProof(error,category){const p=production75V1FailureMetadata(error);expect(p).toMatchObject({operation:'create-reader',method:'POST',httpStatus:422,safeCode:'production75_v1_rejected_'+category});expect(Object.keys(p)).toHaveLength(5);expect(Object.isFrozen(p)).toBe(true);expect(JSON.stringify(error)+JSON.stringify(p)).not.toContain(secret);return p;}

test.each([
 [{errors:{user_name:['has invalid format'],password:secret}},'user_name_invalid'],
 [{errors:{user_name:['has already been taken']}},'user_name_conflict'],
 [{errors:{role:['is invalid']}},'role_invalid'],
 [{errors:{detail:'Role system is not enabled'}},'role_system_disabled'],
 [{errors:{detail:'Cluster is not ready'}},'cluster_not_ready'],
 [{errors:{detail:'Permission denied'}},'permission_denied'],
 [{errors:{detail:secret},password:secret},'unknown'],
 [{data:{name:secret,role:'reader'},message:secret},'unknown'],
 [{errors:{user_name:[secret]}},'unknown'],
 [{errors:{user_name:['has invalid format'],role:['is invalid']}},'multiple'],
 [{errors:{user_name:{password:secret},detail:{toString:null}}},'unknown'],
])('Reader rejection gives a fixed hint without exposing body values: %j',async(body,category)=>{
 const f=await fixture({response:()=>new Response(JSON.stringify(body),{status:422})});
 try{privateProof(await failure(f.api.createReader(f.permit)),category);await expect(f.api.createReader(f.permit)).rejects.toMatchObject({safeCode:'production75_custody_permit'});expect(f.dispatches()).toBe(1);}finally{f.close();}
});

test.each([
 [secret,'malformed_json'],['','empty'],['null','unexpected_shape'],['true','unexpected_shape'],['[]','unexpected_shape'],[JSON.stringify(secret),'unexpected_shape'],
])('non-object rejection is private and never acknowledged: %s',async(body,category)=>{
 const f=await fixture({response:()=>new Response(body,{status:422})});try{privateProof(await failure(f.api.createReader(f.permit)),category);}finally{f.close();}
});

test('Reader rejection consumes its stream and cancels it without retaining arbitrary text',async()=>{
 let reads=0,cancelled=0,released=0;const bytes=new TextEncoder().encode(JSON.stringify({errors:{role:['is invalid']},password:secret}));
 const f=await fixture({response:()=>({status:422,redirected:false,headers:new Headers(),body:{getReader:()=>({read:async()=>{reads++;return reads===1?{done:false,value:bytes}:{done:true};},cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}})}})});
 try{privateProof(await failure(f.api.createReader(f.permit)),'role_invalid');expect(reads).toBe(2);expect(cancelled).toBe(1);expect(released).toBe(1);}finally{f.close();}
});

test.each([false,true])('oversized rejection stops reading under the existing byte bound (declared %s)',async declared=>{
 let reads=0,cancelled=0,released=0;
 const f=await fixture({client:{limits:{bodyBytes:50}},response:()=>({status:422,redirected:false,headers:new Headers(declared?{'content-length':'51'}:{}),body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(51)};},cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}}),cancel:async()=>{cancelled++;}}})});
 try{privateProof(await failure(f.api.createReader(f.permit)),'bound');expect(reads).toBe(declared?0:1);expect(cancelled).toBe(1);expect(released).toBe(declared?0:1);}finally{f.close();}
});

test('stalled rejection body shares the original total request deadline and closes the reader',async()=>{
 let signal,cancelled=0,released=0;
 const f=await fixture({client:{limits:{requestMs:15}},response:(_url,options)=>{
  signal=options.signal;
  return {status:422,redirected:false,headers:new Headers(),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}})}};
 }});
 try{privateProof(await failure(f.api.createReader(f.permit)),'deadline');expect(signal.aborted).toBe(true);expect(cancelled).toBe(1);expect(released).toBe(1);await expect(f.api.createReader(f.permit)).rejects.toMatchObject({safeCode:'production75_custody_permit'});expect(f.dispatches()).toBe(1);}finally{f.close();}
});

test('rejection read errors and forged diagnostic properties never escape',async()=>{
 const f=await fixture({response:()=>({status:422,redirected:false,headers:new Headers(),body:{getReader:()=>({read:async()=>{throw Object.assign(Error(secret),{safeCode:'production75_v1_rejected_permission_denied',cause:secret});},cancel:async()=>{},releaseLock:()=>{}})}})});
 try{privateProof(await failure(f.api.createReader(f.permit)),'unreadable');}finally{f.close();}
});

test('Reader success still requires exact identity and role; error-shaped 200 never grants acceptance',async()=>{
 const f=await fixture({response:()=>new Response(JSON.stringify({errors:{role:['is invalid']},password:secret}),{status:200})});
 try{await expect(f.api.createReader(f.permit)).rejects.toMatchObject({safeCode:'production75_v1_response'});expect(f.dispatches()).toBe(1);}finally{f.close();}
});
test.each(['wrong-name','legacy-name','wrong-role'])('successful HTTP status refuses Reader identity mismatch %s with one consumed dispatch',async kind=>{
 let expected;const f=await fixture({response:()=>new Response(JSON.stringify({data:{name:kind==='wrong-name'?'growthos-reader-00000000000000000000000000000000':kind==='legacy-name'?expected.replace('growthos-reader-','growthos_reader_'):expected,role:kind==='wrong-role'?'writer':'reader'}}),{status:200})});expected=f.plan.readerName;
 try{await expect(f.api.createReader(f.permit)).rejects.toMatchObject({safeCode:'production75_v1_response'});await expect(f.api.createReader(f.permit)).rejects.toMatchObject({safeCode:'production75_custody_permit'});expect(f.dispatches()).toBe(1);}finally{f.close();}
});
