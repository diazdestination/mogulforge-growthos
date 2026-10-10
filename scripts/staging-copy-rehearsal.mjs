/** New one-copy rehearsal; historical resource grants and operators are never
 * imported or replayed. --prepare is read-only. --execute requires a separately
 * owner-approved, exact-source packet and reserves its single attempt on disk. */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, flyAuthorization, startProxy, closeClient } from './staging-observation-runner.mjs';
import { prepareMigration, captureMigrationState, executeMigration, verifyCommittedMigration } from './staging-migration-core.mjs';
import { observeAdmin } from './staging-admin-preflight.mjs';
import { validateSqlManifest, SOURCE_COMMIT } from './staging-observation-fixtures.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory='C:/Forge/artifacts/growthos-upgrade-rehearsal-20261010';
const FLY='C:/Forge/tools/flyctl/0.4.115/flyctl.exe';
const PRODUCTION='kzpwm0j18eg04nv3';
const PLAN_PATH=`${directory}/plan.json`;
const APPROVAL_PATH=`${directory}/approval.json`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const SOURCE_FILES=['scripts/staging-copy-rehearsal.mjs','scripts/staging-migration-core.mjs','scripts/staging-admin-preflight.mjs',
  'scripts/staging-observation-runner.mjs','scripts/staging-observation-core.mjs','scripts/staging-observation-fixtures.mjs','scripts/local-dev.mjs',
  'reports/release-preparation-2026-10-09/schema-catalog.mjs',...['95','142'].map(n=>`reports/staging-observation-2026-10-10/fixtures/catalog-${n}.json`)];
const environment=()=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|COMSPEC|PROGRAMDATA)$/i.test(k))),NO_COLOR:'1',FLY_NO_UPDATE_CHECK:'1'});
const cli=args=>execFileSync(FLY,args,{env:environment(),windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:4000000,stdio:['ignore','pipe','pipe']});
function durable(path,value) {
  const fd=fs.openSync(path,'wx');
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function journal(path) {
  const fd=fs.openSync(path,'wx');let index=0;
  return {persist:async event=>{fs.writeSync(fd,JSON.stringify({index:index++,at:new Date().toISOString(),...event})+'\n');fs.fsyncSync(fd);},close:()=>fs.closeSync(fd)};
}
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const machineIdentity=m=>({id:m.id,state:m.state,region:m.region,instance:m.instance_id,configSha256:sha(JSON.stringify(stable(m.config)))});
const clusterIdentity=c=>({id:c.id,name:c.name,plan:c.plan,region:c.region,organization:c.organization?.slug,version:String(c.pg_major_version),status:c.status});
function validSource(c){check(c.id===TARGET.cluster&&c.plan==='basic'&&c.region==='iad'&&c.organization?.slug===TARGET.org&&String(c.pg_major_version)==='16'&&c.status==='ready','copy_source_identity');}

// The existing production cluster uses the legacy provider generation and is
// absent from the v2 detail endpoint. Preserve its independently listed metadata.
export function productionInventoryIdentity(list) {
  check(Array.isArray(list),'copy_production_inventory');
  const matches=list.filter(c=>c.id===PRODUCTION);check(matches.length===1,'copy_production_inventory');
  const c=matches[0];
  check(c.name==='mogulforge-growthos-db'&&c.region==='iad'&&c.plan==='basic'&&c.status==='ready'&&c.version===1&&c.organization?.Slug===TARGET.org,'copy_production_identity');
  check(Array.isArray(c.attached_apps)&&c.attached_apps.every(a=>Number.isSafeInteger(a.id)&&typeof a.name==='string'),'copy_production_attachments');
  return {id:c.id,name:c.name,region:c.region,status:c.status,plan:c.plan,providerVersion:c.version,organization:c.organization.Slug,
    attachedApps:c.attached_apps.map(a=>({id:a.id,name:a.name})).sort((a,b)=>a.id-b.id||a.name.localeCompare(b.name))};
}

export function validateApproval(plan,approval,hashes,now=Date.now()) {
  check(plan?.kind==='ONE_MANAGED_COPY_95_TO_142_REHEARSAL'&&plan.source===TARGET.cluster&&plan.excludedProduction===PRODUCTION&&plan.maxCopies===1,'copy_plan_identity');
  check(plan.account===TARGET.account&&plan.organization===TARGET.org&&plan.region==='iad'&&plan.plan==='basic'&&plan.sourceWritesAuthorized===false&&plan.workMinutes===90&&plan.cleanupReserveMinutes===30,'copy_plan_identity');
  check(/^[a-f0-9-]{36}$/.test(plan.nonce??'')&&plan.name===`growthos-upgrade-${plan.nonce.slice(0,8)}`&&typeof plan.backupId==='string','copy_plan_shape');
  check(now<Date.parse(plan.expiresAt)&&now>=Date.parse(plan.preparedAt),'copy_plan_expired');
  check(approval?.ownerApproved===true&&approval.planSha256===sha(JSON.stringify(plan))&&approval.maxCopies===1&&approval.maximumDurationMinutes===120&&approval.sourceWritesAuthorized===false,'copy_owner_approval_required');
  check(JSON.stringify(plan.sourceHashes)===JSON.stringify(hashes),'copy_source_drift');
}

export function assertOwnedCopy(copy,owned,plan) {
  check(copy&&copy.id===owned.copyId&&/^[a-z0-9]{16}$/.test(copy.id)&&![TARGET.cluster,PRODUCTION].includes(copy.id)&&!owned.beforeIds.includes(copy.id),'copy_protected_identity');
  check(copy.name===plan.name&&copy.organization?.slug===TARGET.org&&copy.plan==='basic'&&copy.region==='iad'&&String(copy.pg_major_version)==='16','copy_identity');
  check(Array.isArray(copy.attached_apps)&&copy.attached_apps.length===0,'copy_attached');
  const created=Date.parse(copy.created_at),started=Date.parse(owned.startedAt);
  check(Number.isFinite(created)&&Number.isFinite(started)&&created>=started-10000&&created<=started+90000,'copy_creation_window');
}

export function deletionComplete(status,body,activeIds,copyId) {
  return !activeIds.includes(copyId)&&(status===404||(status===200&&body?.data?.id===copyId&&body.data.status==='deleted'));
}

export async function providerRequest(path,method,body,{authorization,deadline=Infinity,fetchImpl=fetch}={}) {
  check(Date.now()<deadline,'copy_phase_deadline');
  const response=await fetchImpl(`https://api.machines.dev/v1/${path}`,{method,headers:{Authorization:authorization,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now())))});
  const text=await response.text();check(text.length<=4000000,'copy_response_bound');
  let parsed;try{parsed=text?JSON.parse(text):null;}catch{check(false,'copy_response_invalid');}
  return {status:response.status,body:parsed};
}

/** Exactly one DELETE. Unknown acknowledgments lead only to bounded reads.
 * Protected-source drift is reported but cannot strand a positively owned copy. */
export async function deleteOwnedCopy({owned,plan,request,listActive,persist,verifyProtected,now=Date.now,pause=wait,deadline=Date.now()+1200000}) {
  const current=await request(`postgres/${owned.copyId}`,'GET');
  check(current.status===200,'copy_cleanup_identity_unavailable');assertOwnedCopy(current.body?.data,owned,plan);
  let protectedStateChanged=false,journalFailed=false;
  try{await verifyProtected();}catch{protectedStateChanged=true;}
  await persist('delete-intent',{copyId:owned.copyId,at:new Date(now()).toISOString()});
  let deleteStatus=null;
  try{deleteStatus=(await request(`postgres/${owned.copyId}`,'DELETE')).status;}catch{}
  try{await persist('delete-response',{status:deleteStatus,at:new Date(now()).toISOString()});}catch{journalFailed=true;}
  while(now()<deadline){
    let state,active;
    try{state=await request(`postgres/${owned.copyId}`,'GET');active=await listActive();}catch{await pause(15000);continue;}
    if(state.status===200)assertOwnedCopy(state.body?.data,owned,plan);
    check(Array.isArray(active),'copy_cleanup_inventory');
    if(deletionComplete(state.status,state.body,active.map(x=>x.id),owned.copyId)){
      const originalsPresent=[TARGET.cluster,PRODUCTION].every(id=>active.some(x=>x.id===id));
      try{await verifyProtected();check(originalsPresent,'copy_original_missing');}catch{protectedStateChanged=true;}
      const proof={at:new Date(now()).toISOString(),copyId:owned.copyId,httpStatus:state.status,terminalStatus:state.body?.data?.status??null,activeOriginalsPresent:originalsPresent};
      try{await persist('deleted',proof);}catch{journalFailed=true;}
      return {deleted:true,protectedStateChanged,journalFailed,...proof};
    }
    await pause(15000);
  }
  check(false,'copy_cleanup_unconfirmed');
}

export async function closeOwnedTransport(client,proxy,receipt,close=closeClient) {
  let failed=false;
  if(client)try{await close(client,receipt);}catch{receipt.clientCleanupFailed=true;failed=true;}
  if(proxy)try{await proxy.close();}catch{receipt.proxyCleanupFailed=true;failed=true;}
  check(!failed,'copy_transport_cleanup');
}

async function context({deadline=Infinity}={}) {
  check(cli(['auth','whoami']).trim()===TARGET.account,'copy_account');
  const inventory=JSON.parse(cli(['mpg','list','--org','personal','--json']));
  check(Array.isArray(inventory)&&[TARGET.cluster,PRODUCTION].every(id=>inventory.some(c=>c.id===id)),'copy_original_inventory');
  const auth=flyAuthorization(fs.readFileSync('C:/Users/diazd/.fly/config.yml','utf8'));
  const request=(path,method='GET',body)=>providerRequest(path,method,body,{authorization:auth,deadline});
  const get=async path=>{const r=await request(path);check(r.status===200,'copy_provider_read');return r.body;};
  return {inventory,request,get,setDeadline:value=>{deadline=value;}};
}
const hashes=()=>Object.fromEntries(SOURCE_FILES.map(p=>[p,sha(fs.readFileSync(resolve(root,p)))]));
function readPolicy() {
  const bytes=fs.readFileSync(`${directory}/admin-policy.json`),policy=JSON.parse(bytes);
  const required=['roles','schema','owners','eventTriggers','defaultAclRows'];
  check(policy.accepted===true&&policy.sourceCluster===TARGET.cluster&&required.every(k=>/^[a-f0-9]{64}$/.test(policy.metadataHashes?.[k]??'')),'copy_admin_policy_invalid');
  return {policy,sha256:sha(bytes)};
}
function migrationPlan() {
  const blob=p=>execFileSync('git',['show',`${SOURCE_COMMIT}:${p}`],{cwd:root,env:environment(),windowsHide:true,timeout:30000,maxBuffer:2000000,stdio:['ignore','pipe','pipe']});
  const manifestBytes=blob('reports/release-preparation-2026-10-09/source-manifest.json');
  const entries=validateSqlManifest(JSON.parse(manifestBytes));
  return prepareMigration({manifestBytes,sqlBuffers:entries.slice(3).map(e=>blob(e.path)),
    catalog95:JSON.parse(fs.readFileSync(resolve(root,SOURCE_FILES.at(-2)))),catalog142:JSON.parse(fs.readFileSync(resolve(root,SOURCE_FILES.at(-1))))});
}

async function prepare() {
  check(!fs.existsSync(PLAN_PATH),'copy_existing_plan');
  const policy=readPolicy();
  const c=await context();
  const source=(await c.get(`postgres/${TARGET.cluster}`)).data;validSource(source);
  const m=await c.get(`apps/${TARGET.app}/machines/${TARGET.machine}`);check(m.id===TARGET.machine&&m.state==='stopped','copy_app_not_stopped');
  const machine=machineIdentity(m);
  check(machine.region==='iad'&&machine.instance==='01M4CAG4E3M3JDYNGMGS2C9YVJ'&&machine.configSha256==='5bf548738a455d2fc602c30919282f5229b35813c519df0cd0c8553da8194d09','copy_historical_machine_drift');
  const backups=(await c.get(`postgres/${TARGET.cluster}/backups`)).data;
  check(Array.isArray(backups),'copy_backup_inventory');
  const backup=backups.filter(b=>b.status==='completed'&&Number.isFinite(Date.parse(b.finished_at))).sort((a,b)=>Date.parse(b.finished_at)-Date.parse(a.finished_at))[0];
  check(backup&&Date.now()-Date.parse(backup.finished_at)<7200000,'copy_recent_backup_missing');
  const nonce=randomUUID();
  const plan={kind:'ONE_MANAGED_COPY_95_TO_142_REHEARSAL',nonce,name:`growthos-upgrade-${nonce.slice(0,8)}`,source:TARGET.cluster,excludedProduction:PRODUCTION,
    account:TARGET.account,organization:TARGET.org,region:'iad',plan:'basic',maxCopies:1,preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+14400000).toISOString(),
    backupId:backup.id,backupFinishedAt:backup.finished_at,sourceIdentity:clusterIdentity(source),machineIdentity:machine,
    productionIdentity:productionInventoryIdentity(c.inventory),sourceHashes:hashes(),flyBinarySha256:sha(fs.readFileSync(FLY)),
    adminPolicySha256:policy.sha256,
    workMinutes:90,cleanupReserveMinutes:30,estimatedUsdForTwoHours:0.15,finalMeteredChargeUnverified:true,sourceWritesAuthorized:false};
  fs.mkdirSync(directory,{recursive:true});durable(PLAN_PATH,plan);
  durable(APPROVAL_PATH,{ownerApproved:false,planSha256:sha(JSON.stringify(plan)),maxCopies:1,maximumDurationMinutes:120,sourceWritesAuthorized:false});
  console.log(JSON.stringify({status:'prepared-not-authorized',name:plan.name,backupId:plan.backupId,planPath:PLAN_PATH,estimatedUsd:plan.estimatedUsdForTwoHours}));
}

async function execute() {
  const plan=JSON.parse(fs.readFileSync(PLAN_PATH,'utf8')),approval=JSON.parse(fs.readFileSync(APPROVAL_PATH,'utf8'));
  validateApproval(plan,approval,hashes());
  check(sha(fs.readFileSync(FLY))===plan.flyBinarySha256,'copy_fly_drift');
  const admittedPolicy=readPolicy();
  check(admittedPolicy.sha256===plan.adminPolicySha256,'copy_admin_policy_drift');
  const attemptPath=`${directory}/attempt-${plan.nonce}`;
  fs.mkdirSync(attemptPath); // exclusive reservation: same plan can never rerun.
  const startedAt=new Date().toISOString(),workDeadline=Date.now()+5400000;
  const receipt={kind:plan.kind,status:'failed',startedAt,planSha256:sha(JSON.stringify(plan)),sourceWritesIssued:false,createdCopies:0,ownedCopyDeleted:false};
  let c,owned,proxy,client,createIntent,ownsAgent=false;
  const closeTransport=async()=>{
    const closingClient=client,closingProxy=proxy;client=null;proxy=null;
    await closeOwnedTransport(closingClient,closingProxy,receipt);
  };
  const protectedUnchanged=async()=>{
    const source=(await c.get(`postgres/${TARGET.cluster}`)).data;validSource(source);
    const production=productionInventoryIdentity(JSON.parse(cli(['mpg','list','--org','personal','--json'])));
    const machine=await c.get(`apps/${TARGET.app}/machines/${TARGET.machine}`);
    check(JSON.stringify(clusterIdentity(source))===JSON.stringify(plan.sourceIdentity)&&JSON.stringify(production)===JSON.stringify(plan.productionIdentity)&&JSON.stringify(machineIdentity(machine))===JSON.stringify(plan.machineIdentity),'copy_original_changed');
  };
  const open=async(cluster,user,readOnly=true)=>{
    check(Date.now()<workDeadline,'copy_work_deadline');
    check([TARGET.cluster,owned?.copyId].includes(cluster)&&cluster!==PRODUCTION,'copy_sql_target');
    check(cluster!==TARGET.cluster||readOnly,'copy_source_write_forbidden');
    if(cluster!==TARGET.cluster)assertOwnedCopy((await c.get(`postgres/${cluster}`)).data,owned,plan);
    const credentials=(await c.get(`postgres/${cluster}/users/${user}/credentials`)).data;
    check(credentials?.username===user&&typeof credentials.password==='string'&&credentials.password.length>=8,'copy_credentials');
    ownsAgent=true;
    proxy=await startProxy(receipt,{spawnChild:()=>spawn(FLY,['mpg','proxy',cluster,'--bind-addr','127.0.0.1','--local-port',String(TARGET.port)],{env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']})});
    const {Client}=createRequire(resolve(root,'artifacts/api-server/package.json'))('pg');
    client=new Client({host:'127.0.0.1',port:TARGET.port,user,password:credentials.password,database:TARGET.database,ssl:false,connectionTimeoutMillis:10000,query_timeout:20000,
      options:`-c default_transaction_read_only=${readOnly?'on':'off'} -c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=20000`});
    credentials.password=null;client.on('error',()=>{});await client.connect();return client;
  };
  const read=async cluster=>{
    await open(cluster,TARGET.reader,true);let state;
    const timer=setTimeout(()=>client?.connection?.stream?.destroy(),Math.max(1,Math.min(180000,workDeadline-Date.now())));
    try{
      check((await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).command==='BEGIN','copy_reader_begin');
      await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off");
      const identity=(await client.query("SELECT current_database() AS database,session_user::text AS login,current_user::text AS role,current_setting('server_version_num')::int AS version,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
      check(identity?.database===TARGET.database&&identity.login===TARGET.reader&&identity.role===TARGET.reader&&identity.read_only==='on'&&identity.isolation==='repeatable read'&&identity.version>=160000&&identity.version<170000,'copy_reader_identity');
      state=await captureMigrationState(client,migrationPlan());
      check(state.identity.database===TARGET.database&&state.identity.login===TARGET.reader&&state.identity.role===TARGET.reader&&state.identity.read_only==='on','copy_reader_identity');
      check((await client.query('ROLLBACK')).command==='ROLLBACK','copy_reader_rollback');
    }finally{clearTimeout(timer);await closeTransport();}
    return state;
  };
  try {
    const count=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name = 'flyctl.exe'\").Count"],{env:environment(),windowsHide:true,encoding:'utf8',timeout:10000});
    check(count.trim()==='0','copy_existing_fly_process');
    c=await context({deadline:workDeadline});await protectedUnchanged();
    check(!c.inventory.some(x=>x.name===plan.name),'copy_name_exists');
    check((await c.get(`postgres/${TARGET.cluster}/backups`)).data.some(b=>b.id===plan.backupId&&b.status==='completed'),'copy_backup_missing');
    const source=await read(TARGET.cluster);durable(`${attemptPath}/source-before.json`,source);
    await protectedUnchanged();
    check(JSON.stringify(hashes())===JSON.stringify(plan.sourceHashes),'copy_source_drift');
    const intent={name:plan.name,backupId:plan.backupId,startedAt:new Date().toISOString(),beforeIds:c.inventory.map(x=>x.id)};
    durable(`${attemptPath}/create-intent.json`,intent);
    createIntent=intent;
    const response=await c.request(`postgres/${TARGET.cluster}/restore`,'POST',{backup_id:plan.backupId,name:plan.name});
    check(response.status===201,'copy_create_unknown');
    const created=response.body?.data;
    owned={...intent,copyId:created?.id};assertOwnedCopy(created,owned,plan);
    durable(`${attemptPath}/owned-copy.json`,owned);receipt.createdCopies=1;receipt.copyId=owned.copyId;
    while(true){check(Date.now()<workDeadline,'copy_work_deadline');const copy=(await c.get(`postgres/${owned.copyId}`)).data;assertOwnedCopy(copy,owned,plan);if(copy.status==='ready')break;check(!['deleted','deleting','failed'].includes(copy.status),'copy_provision_failed');await wait(15000);}
    const before=await read(owned.copyId);
    for(const key of ['catalog','fingerprints','privileges','tableAcl'])check(JSON.stringify(before[key])===JSON.stringify(source[key]),'copy_backup_preservation_mismatch');
    durable(`${attemptPath}/copy-before.json`,before);
    await open(owned.copyId,'fly-user',true);
    const adminTimer=setTimeout(()=>client?.connection?.stream?.destroy(),Math.max(1,Math.min(90000,workDeadline-Date.now())));
    let admin;try{admin=await observeAdmin(client);}finally{clearTimeout(adminTimer);await closeTransport();}durable(`${attemptPath}/copy-admin.json`,admin);
    check(admin.status==='observed-awaiting-policy-review'&&admin.rollbackAcknowledged,'copy_admin_preflight');
    // Policy acceptance uses exact previously reviewed source metadata, except
    // session PID and generated observation diagnostics.
    const admittedAdmin=admittedPolicy.policy;
    check(admittedAdmin.accepted===true,'copy_admin_policy_required');
    for(const key of ['roles','schema','owners','eventTriggers','defaultAclRows'])check(sha(JSON.stringify(admin.metadata[key]))===admittedAdmin.metadataHashes[key],'copy_admin_policy_changed');
    const migration=migrationPlan();
    for(const outcome of ['rollback','commit']) {
      check(Date.now()<workDeadline,'copy_work_deadline');await protectedUnchanged();
      check(JSON.stringify(hashes())===JSON.stringify(plan.sourceHashes),'copy_source_drift');
      await open(owned.copyId,'fly-user',false);
      const log=journal(`${attemptPath}/${outcome}-journal.jsonl`);let result;
      try{result=await executeMigration(client,{plan:migration,expectedBefore:before,persist:log.persist,outcome,operationMs:Math.max(1000,Math.min(180000,workDeadline-Date.now()))});}finally{log.close();await closeTransport();}
      durable(`${attemptPath}/${outcome}-result.json`,result);
      const fresh=await read(owned.copyId);durable(`${attemptPath}/${outcome}-reader.json`,fresh);
      if(outcome==='rollback'){
        check(result.status==='rehearsed-rolled-back'&&result.rollbackAcknowledged,'copy_rollback_rehearsal');
        for(const key of ['catalog','fingerprints','privileges','tableAcl'])check(JSON.stringify(fresh[key])===JSON.stringify(before[key]),'copy_rollback_preservation');
      }else receipt.proof=verifyCommittedMigration(result,fresh,migration);
    }
    const sourceAfter=await read(TARGET.cluster);
    durable(`${attemptPath}/source-after.json`,sourceAfter);
    for(const key of ['catalog','fingerprints','privileges','tableAcl'])check(JSON.stringify(sourceAfter[key])===JSON.stringify(source[key]),'copy_source_changed');
    check(JSON.stringify(hashes())===JSON.stringify(plan.sourceHashes),'copy_source_drift');
    receipt.sourcePreserved=true;receipt.status='passed';
  } catch(e){receipt.status='failed';receipt.errorCode=e.safeCode??'copy_rehearsal_failed';}
  finally {
    try{await closeTransport();}catch{receipt.status='failed';receipt.transportCleanupFailed=true;}
    // Cleanup retains its own bounded window even after the work budget expires.
    if(c)c.setDeadline(Date.now()+1500000);
    // An uncertain POST is never repeated. Attribute a new copy only from its
    // unique approved name, creation window, private org and pre-create absence.
    if(c&&createIntent&&receipt.createdCopies===0)try{
      const until=Date.now()+180000;
      while(Date.now()<until){
        const active=JSON.parse(cli(['mpg','list','--org','personal','--json']));
        const matches=active.filter(x=>x.name===plan.name&&!createIntent.beforeIds.includes(x.id));
        check(matches.length<=1,'copy_creation_ambiguous');
        if(matches.length===1){
          const candidate=(await c.get(`postgres/${matches[0].id}`)).data;
          const recovered={...createIntent,copyId:candidate.id};assertOwnedCopy(candidate,recovered,plan);
          owned=recovered;receipt.createdCopies=1;receipt.copyId=owned.copyId;receipt.creationReconciled=true;
          durable(`${attemptPath}/reconciled-owned-copy.json`,owned);break;
        }
        await wait(15000);
      }
      if(receipt.createdCopies===0)receipt.creationUnconfirmed=true;
    }catch(e){receipt.creationReconciliationError=e.safeCode??'copy_creation_unconfirmed';}
    if(c&&owned&&receipt.createdCopies===1)try {
      const deleted=await deleteOwnedCopy({owned,plan,request:c.request,listActive:async()=>JSON.parse(cli(['mpg','list','--org','personal','--json'])),
        persist:async(name,value)=>durable(`${attemptPath}/${name}.json`,value),verifyProtected:protectedUnchanged});
      receipt.ownedCopyDeleted=deleted.deleted;receipt.protectedStateChanged=deleted.protectedStateChanged;
      receipt.cleanupJournalFailed=deleted.journalFailed;
      if(deleted.protectedStateChanged||deleted.journalFailed)receipt.status='failed';
    }catch(e){receipt.status='failed';receipt.cleanupError=e.safeCode??'copy_cleanup_unconfirmed';}
    if(ownsAgent)try{cli(['agent','stop']);receipt.ownedAgentStopped=true;}catch{receipt.status='failed';receipt.agentCleanupFailed=true;}
    receipt.finishedAt=new Date().toISOString();durable(`${attemptPath}/result.json`,receipt);
    console.log(JSON.stringify({status:receipt.status,errorCode:receipt.errorCode,cleanupError:receipt.cleanupError,copyId:receipt.copyId,deleted:receipt.ownedCopyDeleted,result:`${attemptPath}/result.json`}));
    if(receipt.status!=='passed')process.exitCode=1;
  }
}

export async function main(args=process.argv.slice(2)) {
  check(args.length===1&&['--prepare','--execute'].includes(args[0]),'copy_usage');
  if(args[0]==='--prepare')return prepare();
  return execute();
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(/^copy_[a-z_]+$/.test(e.safeCode??'')?e.safeCode:'copy_refused');process.exitCode=1;});
