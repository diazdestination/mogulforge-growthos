/** Caller-supplied verification contract. No transport, credentials or admission. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {executeProduction75,verifyProduction75Reader} from './production75-core.mjs';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const sections=['roles','roleSettings','extensions','extensionObjects','databases'];
const attempts=new Set();
function shape(extra){return extra&&Object.keys(extra).sort().join(',')===[...sections].sort().join(',')&&sections.every(k=>Array.isArray(extra[k]));}
function readerIdentity(state,plan,writerPid){
 const i=state?.identity,t=plan?.target;
 check(t&&t.readerLogin!==t.writerLogin&&t.readerRole!==t.writerRole&&i?.database===t.database&&i.login===t.readerLogin&&i.role===t.readerRole&&Number.isInteger(i.version)&&i.version>=160000&&i.version<170000&&Number.isInteger(i.pid)&&i.pid>0&&i.read_only==='on'&&i.isolation==='repeatable read'&&(writerPid===undefined||Number.isInteger(writerPid)&&writerPid>0&&i.pid!==writerPid),'production75_verification_reader_identity');
}
async function callback(operation,ms=240000){let timer;const until=Date.now()+ms;try{const value=await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),ms);})]);check(Date.now()<until,'production75_verification_callback');return value;}catch{throw Object.assign(new Error('production75_verification_callback'),{safeCode:'production75_verification_callback'});}finally{clearTimeout(timer);}}
function capabilityIdentity(evidence,review,plan){const c=evidence?.capabilities,i=evidence?.state?.identity,t=plan?.target;check(t&&c?.readerLogin===t.readerLogin&&c.readerRole===t.readerRole&&review?.readerLogin===t.readerLogin&&review.readerRole===t.readerRole&&c.readerLogin===i?.login&&c.readerRole===i?.role,'production75_verification_capability_identity');}
export function verifyProduction75Evidence({baseline,observed,expectedExtra,capabilityReview}={}){
 check(shape(baseline?.extra)&&shape(observed?.extra)&&shape(expectedExtra)&&isDeepStrictEqual(baseline.extra,expectedExtra)&&isDeepStrictEqual(observed.extra,expectedExtra),'production75_verification_extra');
 const r=capabilityReview,c=observed?.capabilities;
 check(r?.status==='reviewed'&&r.scope==='fixed-query-observation-with-inherited-capabilities'&&r.zeroDdlClusterWideVerified===false&&/^[a-f0-9]{64}$/.test(r.receiptSha256??'')&&c?.directApplicationWritesDenied===true&&c.zeroDdlClusterWideVerified===false&&c.capabilityScopeReviewRequired===true&&r.readerLogin===c.readerLogin&&r.readerRole===c.readerRole&&r.capabilitiesSha256===sha(c)&&isDeepStrictEqual(c,baseline?.capabilities)&&r.extraSha256===sha(expectedExtra),'production75_verification_capability');
 const others=baseline.otherDatabases;
 check(Array.isArray(others)&&others.length===2&&new Set(others.map(d=>d?.name)).size===2&&others.every(d=>typeof d?.name==='string'&&Array.isArray(d.catalog?.tables)&&Array.isArray(d.catalog?.columns)&&Array.isArray(d.fingerprints)&&d.fingerprints.length===d.catalog.tables.length&&new Set(d.fingerprints.map(f=>f.table)).size===d.fingerprints.length&&d.fingerprints.every(f=>d.catalog.tables.some(t=>t.name===f.table)&&Number.isSafeInteger(f.rows)&&f.rows>=0&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&/^[a-f0-9]{32}$/.test(f.digest??''))&&d.policy?.privileges&&Array.isArray(d.policy.ownership)&&shape(d.extra))&&isDeepStrictEqual(observed.otherDatabases,others),'production75_verification_other_database');
 return {extraPreserved:true,nonTargetDatabasesPreserved:true,zeroDdlClusterWideVerified:false,capabilityScope:r.scope};
}
export async function runProduction75Verification({writer,plan,baseline,expectedExtra,capabilityReview,outcome,attemptId,reserve,persist,readFresh}={}){
 // This is evidence binding only: caller authenticates the independent review,
 // exact copy/identity, cost/admission and durable reserve before supplying it.
 try{baseline=structuredClone(baseline);expectedExtra=structuredClone(expectedExtra);capabilityReview=structuredClone(capabilityReview);}catch{check(false,'production75_verification_input');}
 verifyProduction75Evidence({baseline,observed:baseline,expectedExtra,capabilityReview});capabilityIdentity(baseline,capabilityReview,plan);
 check(['commit','rollback'].includes(outcome)&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attemptId??'')&&typeof reserve==='function'&&typeof persist==='function'&&typeof readFresh==='function','production75_verification_input');
 check(!attempts.has(attemptId),'production75_verification_replay');attempts.add(attemptId);
 readerIdentity(baseline.state,plan);
 const before=await callback(()=>readFresh(plan));readerIdentity(before?.state,plan);capabilityIdentity(before,capabilityReview,plan);verifyProduction75Evidence({baseline,observed:before,expectedExtra,capabilityReview});
 check(isDeepStrictEqual(before.state?.catalog,baseline.state?.catalog)&&isDeepStrictEqual(before.state?.fingerprints,baseline.state?.fingerprints)&&isDeepStrictEqual(before.state?.policy,baseline.state?.policy),'production75_verification_baseline');
 const intent=Object.freeze({kind:'PRODUCTION75_TRANSACTION_RESERVATION',attemptId,database:plan?.target?.database,sourceCommit:plan?.sourceCommit,outcome});
 check(await callback(()=>reserve(intent),5000)===true,'production75_verification_reservation');
 const result=await executeProduction75(writer,{plan,expectedBefore:baseline.state,outcome,persist});
 if(!['rehearsed-rolled-back','committed-awaiting-reader','commit-unknown','committed-journal-unconfirmed'].includes(result.status))return {status:'failed-or-held',mechanism:result};
 try{
  const observed=await callback(()=>readFresh(plan));readerIdentity(observed?.state,plan,result.before?.identity?.pid);capabilityIdentity(observed,capabilityReview,plan);const extraProof=verifyProduction75Evidence({baseline,observed,expectedExtra,capabilityReview});
  if(result.status==='rehearsed-rolled-back'){
   check(observed.state?.phase===75&&isDeepStrictEqual(observed.state.catalog,baseline.state.catalog)&&isDeepStrictEqual(observed.state.fingerprints,baseline.state.fingerprints)&&isDeepStrictEqual(observed.state.policy,baseline.state.policy),'production75_verification_rollback');
   return {status:'verified-rollback',mechanism:result,proof:extraProof};
  }
  const dataProof=verifyProduction75Reader(result,observed.state,plan);
  return {status:dataProof.status==='verified'?'verified-commit':'reconciled-commit-no-replay',mechanism:result,proof:{...dataProof,...extraProof}};
 }catch(e){return {status:'verification-held-no-replay',mechanism:result,errorCode:/^production75_[a-z_]+$/.test(e?.safeCode??'')?e.safeCode:'production75_verification_reader_failure'};}
}
