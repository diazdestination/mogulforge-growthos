/** Exclusive, content-free copy custody. No networking or credential access. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PINNED_FILES} from './production75-pins.mjs';

const SOURCE='kzpwm0j18eg04nv3',STAGING='zp2wjrejd2zodn4q';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,ID=/^[a-z0-9]{16}$/;
const plans=new WeakSet(),permits=new WeakMap();
// The exact-byte selector is independently exercised by production75-source tests.
// Its generated step differs from the hash of the full initial source file.
const SQL_JOURNAL_PINS=[{path:'production75-selected-0000',sha256:'0240348d564b0d88860c4dde838949db8cdee81f13221a6dbf31841feb405a51'},...PINNED_FILES.slice(1)];
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const error=code=>Object.assign(new Error(code),{safeCode:code});
const check=(ok,code)=>{if(!ok)throw error(code);};
const keys=(o,allowed)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>allowed.includes(k));
const clone=v=>{try{return structuredClone(v);}catch{throw error('production75_custody_shape');}};
export const operatorPlanDigest=plan=>{check(plans.has(plan),'production75_custody_plan');return hash(plan);};
export function production75ReaderName(runId){
 check(typeof runId==='string'&&UUID.test(runId),'production75_custody_plan');
 return `growthos-reader-${runId.replaceAll('-','')}`;
}

export function prepareOperatorPlan(input={}){
 const p=clone(input),allowed=['runId','backupId','sourceSnapshotSha256','profileSha256','moduleManifestSha256','preparedAt','workMs','cleanupMs','maxCostUsdMicros'];
 check(keys(p,allowed)&&Object.keys(p).length===allowed.length&&UUID.test(p.runId??'')&&/^[a-zA-Z0-9_.-]{1,128}$/.test(p.backupId??'')&&['sourceSnapshotSha256','profileSha256','moduleManifestSha256'].every(k=>HASH.test(p[k]??'')),'production75_custody_plan');
 check(Number.isSafeInteger(p.preparedAt)&&p.preparedAt>0&&Number.isSafeInteger(p.workMs)&&p.workMs>=1000&&p.workMs<=5400000&&Number.isSafeInteger(p.cleanupMs)&&p.cleanupMs>=10000&&p.cleanupMs<=1800000&&p.workMs+p.cleanupMs<=7200000&&Number.isSafeInteger(p.maxCostUsdMicros)&&p.maxCostUsdMicros>0&&p.maxCostUsdMicros<=1000000,'production75_custody_limits');
 const plan=freeze({...p,kind:'PRODUCTION75_ONE_COPY_OPERATOR',account:'diazdestination@gmail.com',organization:'adam-diaz',sourceCluster:SOURCE,protectedClusters:[SOURCE,STAGING],region:'iad',providerVersion:1,plan:'basic',sourceCandidate:'8df64dc72009832f93b2b491031acd1bb2afb903',copyName:`growthos-drill-${p.runId}`,readerName:production75ReaderName(p.runId),workUntil:p.preparedAt+p.workMs,cleanupUntil:p.preparedAt+p.workMs+p.cleanupMs});
 plans.add(plan);return plan;
}

export function validateOperatorMetadata(value){
 const m=clone(value),allowed=['id','name','organization','region','plan','version','status','attachedApps'];
 check(keys(m,allowed)&&Object.keys(m).length===allowed.length&&ID.test(m.id??'')&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(m.name??'')&&/^[a-z0-9-]{1,63}$/.test(m.organization??'')&&/^[a-z]{3}$/.test(m.region??'')&&/^[a-z][a-z0-9-]{0,31}$/.test(m.plan??'')&&[1,2].includes(m.version)&&['ready','creating','restoring','provisioning','deleting','deleted','failed','suspended','not-ready'].includes(m.status)&&Array.isArray(m.attachedApps)&&m.attachedApps.length<=100&&m.attachedApps.every(a=>typeof a==='string'&&/^[a-z0-9-]{1,63}$/.test(a)),'production75_custody_ownership');return freeze(m);
}
function inventoryShape(values){check(Array.isArray(values)&&values.length<=1000,'production75_custody_ownership');const list=values.map(validateOperatorMetadata);check(new Set(list.map(m=>m.id)).size===list.length,'production75_custody_ownership');return freeze(list);}
async function authenticated(plan,verifyOwnerApproval,verifyCapabilityReview,now,resume=false){
 check(plans.has(plan)&&typeof verifyOwnerApproval==='function'&&typeof verifyCapabilityReview==='function'&&typeof now==='function','production75_custody_admission');
 check(now()>=plan.preparedAt&&(resume||now()<plan.workUntil),'production75_custody_admission');
 const call=async fn=>{let timer;const until=now()+15000;try{const value=await Promise.race([Promise.resolve().then(()=>fn(plan)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('production75_custody_admission')),15000);})]);check(now()<until,'production75_custody_admission');return freeze(clone(value));}catch{throw error('production75_custody_admission');}finally{clearTimeout(timer);}};
 const owner=await call(verifyOwnerApproval),review=await call(verifyCapabilityReview),digest=operatorPlanDigest(plan);
 check(owner?.authenticated===true&&owner.kind==='owner-approval'&&owner.planSha256===digest&&HASH.test(owner.receiptSha256??'')&&owner.maxCopies===1&&owner.maxCostUsdMicros===plan.maxCostUsdMicros&&owner.expiresAt===plan.cleanupUntil&&owner.sourceWritesAuthorized===false,'production75_custody_admission');
 check(review?.authenticated===true&&review.kind==='independent-capability-review'&&review.planSha256===digest&&HASH.test(review.receiptSha256??'')&&review.profileSha256===plan.profileSha256&&review.sourceSnapshotSha256===plan.sourceSnapshotSha256&&review.scope==='fixed-query-observation-with-inherited-capabilities'&&review.zeroDdlClusterWideVerified===false,'production75_custody_admission');
 check(now()>=plan.preparedAt&&(resume||now()<plan.workUntil),'production75_custody_admission');
 return {ownerReceiptSha256:owner.receiptSha256,reviewReceiptSha256:review.receiptSha256};
}

const OPERATIONS=new Set(['copy-create','reader-create','upgrade-rollback','upgrade-commit','copy-delete','credentials-source','credentials-writer','credentials-reader']);
export function consumeOperatorPermit(permit,kind,target){
 const p=permits.get(permit);check(p&&!p.consumed&&p.isUsable()&&p.kind===kind&&p.target===target&&p.now()<p.until,'production75_custody_permit');p.consumed=true;return freeze(clone(p.scope));
}
export function describeOperatorPermit(permit,kind){const p=permits.get(permit);check(p&&!p.consumed&&p.isUsable()&&p.kind===kind&&p.now()<p.until,'production75_custody_permit');return freeze({...clone(p.scope),target:p.target});}
export function markOperatorPermitDispatched(permit){const p=permits.get(permit);check(p&&p.consumed&&!p.dispatched&&p.isUsable()&&p.now()<p.until,'production75_custody_permit');p.dispatched=true;}
function construct({root,plan,evidence,now,resume,io}){
 let fd=null,lockFd=null,unusable=false,closed=false,sequence=0,previous='0'.repeat(64),before=null,owned=null,ownership=null,cloneVerified=false,profileVerified=false,rollbackVerified=false,reconciling=resume;
 const used=new Set(),digest=operatorPlanDigest(plan);let directory;
 const failFs=()=>{unusable=true;throw error('production75_custody_filesystem');};
 try{
  check(typeof root==='string'&&path.isAbsolute(root)&&io.lstatSync(root).isDirectory()&&!io.lstatSync(root).isSymbolicLink(),'production75_custody_root');
  const canonical=io.realpathSync(root);check(path.resolve(root).toLowerCase()===canonical.toLowerCase(),'production75_custody_root');directory=path.join(canonical,`operator-${digest}`);
  if(!resume){try{io.mkdirSync(directory,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw error('production75_custody_replay');throw e;}}
  else check(io.lstatSync(directory).isDirectory()&&!io.lstatSync(directory).isSymbolicLink(),'production75_custody_journal');
 }catch(e){if(/^production75_custody_(root|replay|journal)$/.test(e?.safeCode??''))throw e;throw error('production75_custody_filesystem');}
 const audit=path.join(directory,'audit.jsonl');
 const lock=path.join(directory,'active.lock');
 // Never steal a stale lock. An unclean exit requires explicit recovery review.
 // Exclusive creation works across processes, before any journal is read.
 try{lockFd=io.openSync(lock,'wx',0o600);io.fsyncSync(lockFd);}catch(e){if(e.code==='EEXIST')throw error('production75_custody_busy');throw error('production75_custody_filesystem');}
 const owns=m=>{check(used.has('copy-create')&&before&&ID.test(m.id)&&!plan.protectedClusters.includes(m.id)&&!before.some(v=>v.id===m.id)&&m.name===plan.copyName&&m.organization===plan.organization&&m.attachedApps.length===0,'production75_custody_ownership');};
 function apply(event){
  switch(event.kind){
   case 'opened':check(sequence===0&&isDeepStrictEqual(event.plan,plan)&&isDeepStrictEqual(event.evidence,evidence),'production75_custody_journal');break;
   case 'inventory-before':check(!before&&!used.has('copy-create'),'production75_custody_journal');before=inventoryShape(event.inventory);check(plan.protectedClusters.every(id=>before.some(m=>m.id===id&&m.organization===plan.organization&&m.status==='ready'))&&!before.some(m=>m.name===plan.copyName),'production75_custody_journal');break;
   case 'intent':check(OPERATIONS.has(event.operation)&&!used.has(event.operation)&&before&&event.target===(['copy-create','credentials-source'].includes(event.operation)?plan.sourceCluster:owned?.id),'production75_custody_journal');used.add(event.operation);break;
   case 'owned':{check(!owned&&['acknowledged','reconciled-clone'].includes(event.ownership),'production75_custody_journal');const m=validateOperatorMetadata(event.copy);owns(m);owned=m;ownership=event.ownership;reconciling||=ownership==='reconciled-clone';break;}
   case 'clone-verified':check(event.sha256===plan.sourceSnapshotSha256,'production75_custody_journal');cloneVerified=true;break;
   case 'profile-verified':check(event.sha256===plan.profileSha256,'production75_custody_journal');profileVerified=true;break;
   case 'upgrade-result':if(event.outcome==='rollback'&&event.status==='verified-rollback')rollbackVerified=true;break;
   case 'sql':break;
   case 'deleted':break;
   default:throw error('production75_custody_journal');
  }
 }
 function append(event){
  check(!closed&&!unusable,'production75_custody_unusable');const row={sequence,previous,event};row.sha256=hash(row);
  try{const bytes=Buffer.from(JSON.stringify(row)+'\n');check(bytes.length<=1000000,'production75_custody_shape');let offset=0;while(offset<bytes.length){const written=io.writeSync(fd,bytes,offset,bytes.length-offset);check(written>0,'production75_custody_filesystem');offset+=written;}io.fsyncSync(fd);apply(event);sequence++;previous=row.sha256;}catch{failFs();}
 }
 try{
  if(resume){
   check(io.lstatSync(audit).isFile()&&!io.lstatSync(audit).isSymbolicLink()&&io.statSync(audit).size<=8000000,'production75_custody_journal');const bytes=io.readFileSync(audit,'utf8');check(bytes.endsWith('\n'),'production75_custody_journal');const lines=bytes.trimEnd().split('\n');check(lines.length<=25000,'production75_custody_journal');
   for(const text of lines){const row=JSON.parse(text);check(keys(row,['sequence','previous','event','sha256'])&&Object.keys(row).length===4&&row.sequence===sequence&&row.previous===previous&&row.sha256===hash({sequence:row.sequence,previous:row.previous,event:row.event}),'production75_custody_journal');apply(row.event);sequence++;previous=row.sha256;}
   check(sequence>0,'production75_custody_journal');fd=io.openSync(audit,'a',0o600);
  }else{fd=io.openSync(audit,'wx',0o600);append({kind:'opened',plan,evidence});}
 }catch{if(fd!==null)try{io.closeSync(fd);}catch{}try{io.closeSync(lockFd);io.unlinkSync(lock);}catch{}throw error('production75_custody_journal');}
 // A fsynced reservation file survives interruption before its journal row.
 for(const kind of OPERATIONS)if(io.existsSync(path.join(directory,`reserved-${kind}`)))used.add(kind);
 const healthy=()=>check(!closed&&!unusable,'production75_custody_unusable');
 return Object.freeze({
  observeBefore(values){healthy();check(!used.has('copy-create')&&!before&&!reconciling,'production75_custody_phase');const list=inventoryShape(clone(values));check(plan.protectedClusters.every(id=>list.some(m=>m.id===id&&m.organization===plan.organization&&m.status==='ready'))&&!list.some(m=>m.name===plan.copyName),'production75_custody_ownership');append({kind:'inventory-before',inventory:list});},
  bindOwned(value){healthy();check(!owned&&!reconciling,'production75_custody_phase');const m=validateOperatorMetadata(value);owns(m);append({kind:'owned',copy:m,ownership:'acknowledged'});},
  reconcileOwned(value,{inventoryAfter,copySourceSnapshotSha256}={}){healthy();check(!owned,'production75_custody_phase');const m=validateOperatorMetadata(value),after=inventoryShape(inventoryAfter);owns(m);check(copySourceSnapshotSha256===plan.sourceSnapshotSha256&&after.filter(v=>v.name===plan.copyName).length===1&&after.some(v=>isDeepStrictEqual(v,m))&&plan.protectedClusters.every(id=>after.some(v=>v.id===id)),'production75_custody_ownership');append({kind:'owned',copy:m,ownership:'reconciled-clone'});},
  verifyClone(sha256){healthy();check(owned&&sha256===plan.sourceSnapshotSha256,'production75_custody_phase');append({kind:'clone-verified',sha256});},
  verifyProfile(sha256){healthy();check(owned&&used.has('reader-create')&&sha256===plan.profileSha256,'production75_custody_phase');append({kind:'profile-verified',sha256});},
  reserve(kind){
   healthy();check(OPERATIONS.has(kind),'production75_custody_phase');check(!used.has(kind),'production75_custody_replay');check(!reconciling||['copy-delete','credentials-writer'].includes(kind),'production75_custody_reconciliation');
   const cleanup=kind==='copy-delete',until=cleanup?plan.cleanupUntil:plan.workUntil;check(now()<until,'production75_custody_expired');
   if(kind==='copy-create')check(before&&!owned,'production75_custody_phase');
   else if(kind==='credentials-source')check(before,'production75_custody_phase');
   else check(owned,'production75_custody_phase');
   if(owned&&kind!=='copy-delete')check(owned.region===plan.region&&owned.plan===plan.plan&&owned.version===plan.providerVersion,'production75_custody_suitability');
   if(kind==='reader-create')check(cloneVerified,'production75_custody_phase');
   if(kind==='upgrade-rollback'||kind==='upgrade-commit')check(profileVerified,'production75_custody_phase');
   if(kind==='credentials-reader')check(cloneVerified&&used.has('reader-create'),'production75_custody_phase');
   if(kind==='upgrade-commit')check(rollbackVerified,'production75_custody_phase');
   const target=kind==='copy-create'||kind==='credentials-source'?plan.sourceCluster:owned.id;
   let reservationFd;try{reservationFd=io.openSync(path.join(directory,`reserved-${kind}`),'wx',0o600);io.fsyncSync(reservationFd);}catch(e){if(e.code==='EEXIST')throw error('production75_custody_replay');failFs();}finally{if(reservationFd!==undefined)io.closeSync(reservationFd);}
   append({kind:'intent',operation:kind,target});const permit=Object.freeze({});permits.set(permit,{kind,target,until,now,consumed:false,dispatched:false,isUsable:()=>!closed&&!unusable,scope:{planSha256:digest,sourceCluster:plan.sourceCluster,backupId:plan.backupId,copyName:plan.copyName,copyId:owned?.id??null,readerName:plan.readerName,organization:plan.organization,until}});return permit;
  },
  recordUpgrade(outcome,status){healthy();check(['rollback','commit'].includes(outcome)&&used.has(`upgrade-${outcome}`)&&['verified-rollback','verified-commit','reconciled-commit-no-replay','verification-held-no-replay','failed-or-held'].includes(status),'production75_custody_phase');append({kind:'upgrade-result',outcome,status});},
  persistSQL(outcome,value){
   healthy();const event=clone(value),allowed=['phase','pid','path','sha256','proof','afterFailure'];check(['rollback','commit'].includes(outcome)&&used.has(`upgrade-${outcome}`)&&keys(event,allowed)&&['begin-intent','begin-ack','step-intent','step-ack','bridge-verified','precommit-verified','rollback-intent','commit-intent','rollback-ack','commit-ack'].includes(event.phase),'production75_custody_shape');
   if('pid'in event)check(Number.isInteger(event.pid)&&event.pid>0,'production75_custody_shape');
   if('path'in event)check(SQL_JOURNAL_PINS.some(f=>f.path===event.path&&(!('sha256'in event)||f.sha256===event.sha256)),'production75_custody_shape');
   if('proof'in event)check(keys(event.proof,['originalTables','originalColumns','newTablesEmpty','defaultsVerified'])&&Object.keys(event.proof).length===4&&Object.values(event.proof).every(v=>Number.isSafeInteger(v)&&v>=0&&v<=2000),'production75_custody_shape');
   if('afterFailure'in event)check(typeof event.afterFailure==='boolean','production75_custody_shape');append({kind:'sql',outcome,event});
  },
  recordDeleted(){healthy();check(owned&&used.has('copy-delete'),'production75_custody_phase');append({kind:'deleted',copyId:owned.id});},
  status(){return freeze({directory,planSha256:digest,reviewReceiptSha256:evidence.reviewReceiptSha256,copyId:owned?.id??null,ownership,used:[...used],reconciliationOnly:reconciling,unusable,closed});},
  close(){if(closed)return;closed=true;try{io.closeSync(fd);io.closeSync(lockFd);io.unlinkSync(lock);}catch{throw error('production75_custody_filesystem');}}
 });
}
export async function openOperatorCustody({root,plan,verifyOwnerApproval,verifyCapabilityReview,now=Date.now,io=fs}={}){const evidence=await authenticated(plan,verifyOwnerApproval,verifyCapabilityReview,now);return construct({root,plan,evidence,now,resume:false,io});}
export async function resumeOperatorCustody({root,plan,verifyOwnerApproval,verifyCapabilityReview,now=Date.now,io=fs}={}){const evidence=await authenticated(plan,verifyOwnerApproval,verifyCapabilityReview,now,true);return construct({root,plan,evidence,now,resume:true,io});}
