/** Exact existing-staging migration only. Prepare is GET/READ ONLY. Execute
 * requires its own owner-approved packet, never creates a resource, starts an
 * application, publishes an image, or retries DDL/COMMIT. */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { TARGET, flyAuthorization, startProxy, closeClient } from './staging-observation-runner.mjs';
import { machineIdentity, productionInventoryIdentity } from './staging-copy-rehearsal.mjs';
import { prepareMigration, captureMigrationState, executeMigration, verifyCommittedMigration, assertMigrationPreserved } from './staging-migration-core.mjs';
import { observeAdmin } from './staging-admin-preflight.mjs';
import { validateSqlManifest, SOURCE_COMMIT } from './staging-observation-fixtures.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const DIRECTORY='C:/Forge/artifacts/growthos-staging-release-20261010';
const REHEARSAL='C:/Forge/artifacts/growthos-upgrade-rehearsal-20261010';
const COPY_ATTEMPT=`${REHEARSAL}/attempt-4d1598fd-a7e7-4f76-9c3e-04c58fc86b4e`;
const FLY='C:/Forge/tools/flyctl/0.4.115/flyctl.exe';
const PRODUCTION='kzpwm0j18eg04nv3';
const FILES=['scripts/staging-source-migration.mjs','scripts/staging-copy-rehearsal.mjs','scripts/staging-migration-core.mjs',
  'scripts/staging-admin-preflight.mjs','scripts/staging-observation-runner.mjs','scripts/staging-observation-core.mjs',
  'scripts/staging-observation-fixtures.mjs','reports/release-preparation-2026-10-09/schema-catalog.mjs',
  ...['95','142'].map(n=>`reports/staging-observation-2026-10-10/fixtures/catalog-${n}.json`)];
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hashes=()=>Object.fromEntries(FILES.map(p=>[p,sha(fs.readFileSync(resolve(ROOT,p)))]));
const env=()=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|COMSPEC|PROGRAMDATA)$/i.test(k))),NO_COLOR:'1',FLY_NO_UPDATE_CHECK:'1'});
const cli=(args,timeout=20000)=>execFileSync(FLY,args,{env:env(),windowsHide:true,timeout,maxBuffer:4000000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function assertNoExistingFlyProcess(){const count=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name = 'flyctl.exe'\").Count"],{env:env(),windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']});check(count.trim()==='0','source_existing_fly_process');}
function durable(path,value){const fd=fs.openSync(path,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function journal(path){const fd=fs.openSync(path,'wx');let i=0;return {persist:async e=>{fs.writeSync(fd,JSON.stringify({index:i++,at:new Date().toISOString(),...e})+'\n');fs.fsyncSync(fd);},close:()=>fs.closeSync(fd)};}

export function validateSourceApproval(plan,approval,currentHashes,now=Date.now()){
  check(plan?.kind==='EXISTING_STAGING_95_TO_142_ONCE'&&plan.source===TARGET.cluster&&plan.excludedProduction===PRODUCTION&&plan.database===TARGET.database,'source_plan_target');
  check(plan.account===TARGET.account&&plan.organization===TARGET.org&&plan.applicationSource===SOURCE_COMMIT&&plan.machineIdentity?.id===TARGET.machine&&plan.machineIdentity?.state==='stopped','source_plan_identity');
  check(plan.providerMutationsAuthorized===false&&plan.appStartAuthorized===false&&plan.imagePublicationAuthorized===false&&plan.maximumMinutes===15&&plan.workMinutes===12&&plan.cleanupReserveMinutes===3,'source_plan_scope');
  check(/^[a-f0-9-]{36}$/.test(plan.nonce??'')&&now>=Date.parse(plan.preparedAt)&&now<Date.parse(plan.expiresAt),'source_plan_expired');
  check(approval?.ownerApproved===true&&approval.planSha256===sha(JSON.stringify(plan))&&approval.sourceMigrationAuthorized===true&&approval.appStartAuthorized===false&&approval.maximumMinutes===15,'source_owner_approval_required');
  check(isDeepStrictEqual(plan.sourceHashes,currentHashes),'source_code_drift');
}
export function allowedSourceRead(path){
  return [`postgres/${TARGET.cluster}`,`postgres/${TARGET.cluster}/backups`,
    ...[TARGET.reader,'fly-user'].map(u=>`postgres/${TARGET.cluster}/users/${u}/credentials`),
    `apps/${TARGET.app}/machines/${TARGET.machine}`].includes(path);
}
export function compareOriginals(before,after){
  for(const k of ['catalog','fingerprints','privileges','tableAcl'])check(isDeepStrictEqual(before[k],after[k]),'source_baseline_drift');
}
async function context(deadline){
  let inventory;
  const remaining=n=>{check(Date.now()<deadline,'source_deadline');return Math.max(1,Math.min(n,deadline-Date.now()));};
  const get=async path=>{
    check(allowedSourceRead(path),'source_provider_path');
    check(cli(['auth','whoami'],remaining(10000)).trim()===TARGET.account,'source_account');
    inventory=JSON.parse(cli(['mpg','list','--org','personal','--json'],remaining(20000)));
    check(Array.isArray(inventory)&&inventory.every(x=>x.organization?.Slug===TARGET.org)&&[TARGET.cluster,PRODUCTION].every(id=>inventory.some(x=>x.id===id)),'source_inventory');
    const authorization=flyAuthorization(fs.readFileSync('C:/Users/diazd/.fly/config.yml','utf8'));
    const response=await fetch(`https://api.machines.dev/v1/${path}`,{method:'GET',headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(remaining(20000))});
    check(response.status===200,'source_provider_read');const body=await response.text();check(body.length<=4000000,'source_response_bound');return JSON.parse(body);
  };
  return {get,get inventory(){return inventory;},remainingMs:()=>Math.max(0,deadline-Date.now()),setDeadline:d=>{deadline=d;}};
}
function loadMigration(){
  const blob=p=>execFileSync('git',['show',`${SOURCE_COMMIT}:${p}`],{cwd:ROOT,env:env(),windowsHide:true,timeout:20000,maxBuffer:2000000,stdio:['ignore','pipe','pipe']});
  const manifestBytes=blob('reports/release-preparation-2026-10-09/source-manifest.json');
  const entries=validateSqlManifest(JSON.parse(manifestBytes));
  return prepareMigration({manifestBytes,sqlBuffers:entries.slice(3).map(e=>blob(e.path)),
    catalog95:read(resolve(ROOT,FILES.at(-2))),catalog142:read(resolve(ROOT,FILES.at(-1)))});
}
function loadPolicy(){const path=`${REHEARSAL}/admin-policy.json`,bytes=fs.readFileSync(path),policy=JSON.parse(bytes);check(policy.accepted===true&&policy.sourceCluster===TARGET.cluster,'source_policy');return {policy,sha256:sha(bytes)};}
function loadRecovery(){
  const result=read(`${COPY_ATTEMPT}/result.json`),deleted=read(`${COPY_ATTEMPT}/deleted.json`),cross=read(`${COPY_ATTEMPT}/receipt-crosscheck.json`);
  check(result.status==='passed'&&result.copyId==='w8675081vl7r3pk4'&&result.ownedCopyDeleted&&result.sourcePreserved&&!result.protectedStateChanged&&result.proof?.freshReaderVerified&&deleted.terminalStatus==='deleted'&&cross.status==='passed','source_recovery_missing');
  return Object.fromEntries(['result.json','deleted.json','receipt-crosscheck.json'].map(n=>[n,sha(fs.readFileSync(`${COPY_ATTEMPT}/${n}`))]));
}
async function protectedState(c){
  const source=(await c.get(`postgres/${TARGET.cluster}`)).data;
  check(source?.id===TARGET.cluster&&source.plan==='basic'&&source.region==='iad'&&source.organization?.slug===TARGET.org&&String(source.pg_major_version)==='16'&&source.status==='ready','source_cluster');
  const m=await c.get(`apps/${TARGET.app}/machines/${TARGET.machine}`);
  check(m.id===TARGET.machine&&m.state==='stopped','source_app_not_stopped');
  const h=m.config?.env??{};
  check(h.GROWTHOS_OUTBOUND_HOLD==='true'&&h.STAGING_OUTBOUND_APPROVED==='false'&&h.SCHEDULER_AUTOSTART==='false'&&h.AUTO_MIGRATE==='false'&&h.STAGING_SCHEMA_PUSH_APPROVED==='false'&&h.WEB_PUSH_ENABLED==='false','source_app_holds');
  check(Array.isArray(m.config.services)&&m.config.services.every(s=>s.autostart===false&&s.min_machines_running===0),'source_app_autostart');
  return {sourceIdentity:{id:source.id,name:source.name,region:source.region,plan:source.plan,organization:source.organization.slug,version:String(source.pg_major_version),status:source.status},machineIdentity:machineIdentity(m),productionIdentity:productionInventoryIdentity(c.inventory)};
}
async function session(c,user,readOnly,receipt,operation){
  let client,proxy,timer,ownsAgent=false;
  try{
    check([TARGET.reader,'fly-user'].includes(user),'source_login');
    const credentials=(await c.get(`postgres/${TARGET.cluster}/users/${user}/credentials`)).data;
    check(credentials?.username===user&&typeof credentials.password==='string'&&credentials.password.length>=8,'source_credentials');
    check(cli(['auth','whoami'],10000).trim()===TARGET.account,'source_account');
    ownsAgent=true;check(c.remainingMs()>0,'source_deadline');proxy=await startProxy(receipt,{startMs:Math.min(45000,c.remainingMs())});
    const {Client}=createRequire(resolve(ROOT,'artifacts/api-server/package.json'))('pg');
    check(c.remainingMs()>0,'source_deadline');
    client=new Client({host:'127.0.0.1',port:TARGET.port,user,password:credentials.password,database:TARGET.database,ssl:false,connectionTimeoutMillis:Math.max(1,Math.min(10000,c.remainingMs())),query_timeout:20000,
      options:`-c default_transaction_read_only=${readOnly?'on':'off'} -c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=20000`});
    credentials.password=null;client.on('error',()=>{});
    timer=setTimeout(()=>client?.connection?.stream?.destroy(),Math.max(1,Math.min(240000,c.remainingMs())));
    await client.connect();return await operation(client);
  }finally{
    clearTimeout(timer);let failed=false;
    if(client)try{await closeClient(client,receipt);}catch{failed=true;receipt.clientCleanupFailed=true;}
    if(proxy)try{await proxy.close();}catch{failed=true;receipt.proxyCleanupFailed=true;}
    if(ownsAgent)try{cli(['agent','stop']);receipt.ownedAgentStopped=true;}catch{failed=true;receipt.agentCleanupFailed=true;}
    check(!failed,'source_transport_cleanup');
  }
}
async function reader(c,migration,receipt){
  return session(c,TARGET.reader,true,receipt,async client=>{
    let began=false;
    try{
      check((await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).command==='BEGIN','source_reader_begin');began=true;
      await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off");
      const state=await captureMigrationState(client,migration),id=state.identity;
      check(id.database===TARGET.database&&id.login===TARGET.reader&&id.role===TARGET.reader&&id.read_only==='on'&&id.isolation==='repeatable read','source_reader_identity');
      check((await client.query('ROLLBACK')).command==='ROLLBACK','source_reader_rollback');began=false;return state;
    }finally{if(began)try{await client.query('ROLLBACK');}catch{}}
  });
}
function checkPolicy(admin,policy){check(admin.status==='observed-awaiting-policy-review'&&admin.rollbackAcknowledged,'source_admin_read');for(const k of ['roles','schema','owners','eventTriggers','defaultAclRows'])check(sha(JSON.stringify(admin.metadata[k]))===policy.metadataHashes[k],'source_admin_policy_drift');}
async function prepare(){
  fs.mkdirSync(DIRECTORY,{recursive:true});check(!fs.existsSync(`${DIRECTORY}/migration-plan.json`),'source_existing_plan');
  assertNoExistingFlyProcess();
  check(cli(['auth','whoami'],10000).trim()===TARGET.account,'source_account');
  const c=await context(Date.now()+600000),migration=loadMigration(),policy=loadPolicy(),recovery=loadRecovery(),receipt={kind:'STAGING_MIGRATION_READONLY_PREPARATION',startedAt:new Date().toISOString()};
  const protectedBefore=await protectedState(c),baseline=await reader(c,migration,receipt);
  check(isDeepStrictEqual(baseline.catalog,migration.catalog95),'source_not95');
  const admin=await session(c,'fly-user',true,receipt,observeAdmin);checkPolicy(admin,policy.policy);
  check(isDeepStrictEqual(await protectedState(c),protectedBefore),'source_protected_drift');
  const backups=(await c.get(`postgres/${TARGET.cluster}/backups`)).data;
  const backup=backups.filter(x=>x.status==='completed').sort((a,b)=>Date.parse(b.finished_at)-Date.parse(a.finished_at))[0];
  check(backup&&Number.isFinite(Date.parse(backup.finished_at))&&Date.now()-Date.parse(backup.finished_at)<7200000,'source_recent_backup');
  const nonce=randomUUID(),baselinePath=`baseline-${nonce}.json`;
  durable(`${DIRECTORY}/${baselinePath}`,baseline);durable(`${DIRECTORY}/admin-${nonce}.json`,admin);
  const plan={kind:'EXISTING_STAGING_95_TO_142_ONCE',nonce,preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+14400000).toISOString(),
    account:TARGET.account,organization:TARGET.org,source:TARGET.cluster,excludedProduction:PRODUCTION,database:TARGET.database,applicationSource:SOURCE_COMMIT,
    ...protectedBefore,sourceHashes:hashes(),flyBinarySha256:sha(fs.readFileSync(FLY)),adminPolicySha256:policy.sha256,recoveryEvidence:recovery,
    baselinePath,baselineSha256:sha(fs.readFileSync(`${DIRECTORY}/${baselinePath}`)),backupId:backup.id,backupFinishedAt:backup.finished_at,
    sql: migration.steps.map(({path,gitObjectSha256,gitObjectBytes})=>({path,sha256:gitObjectSha256,bytes:gitObjectBytes})),maximumMinutes:15,workMinutes:12,cleanupReserveMinutes:3,
    providerMutationsAuthorized:false,appStartAuthorized:false,imagePublicationAuthorized:false};
  durable(`${DIRECTORY}/migration-plan.json`,plan);durable(`${DIRECTORY}/migration-approval.json`,{ownerApproved:false,planSha256:sha(JSON.stringify(plan)),sourceMigrationAuthorized:false,appStartAuthorized:false,maximumMinutes:15});
  durable(`${DIRECTORY}/preparation-${nonce}.json`,{...receipt,status:'prepared-not-authorized',finishedAt:new Date().toISOString(),nonce,planSha256:sha(JSON.stringify(plan)),providerMutationsIssued:0,sourceWritesIssued:false});
  console.log(JSON.stringify({status:'prepared-not-authorized',nonce,plan:`${DIRECTORY}/migration-plan.json`,tables:baseline.catalog.tables.length,rows:baseline.fingerprints.reduce((n,x)=>n+x.rows,0)}));
}
async function execute(){
  const plan=read(`${DIRECTORY}/migration-plan.json`),approval=read(`${DIRECTORY}/migration-approval.json`);
  validateSourceApproval(plan,approval,hashes());
  assertNoExistingFlyProcess();
  check(sha(fs.readFileSync(FLY))===plan.flyBinarySha256&&loadPolicy().sha256===plan.adminPolicySha256&&isDeepStrictEqual(loadRecovery(),plan.recoveryEvidence),'source_admission_drift');
  check(/^baseline-[a-f0-9-]{36}\.json$/.test(plan.baselinePath)&&sha(fs.readFileSync(`${DIRECTORY}/${plan.baselinePath}`))===plan.baselineSha256,'source_baseline_file');
  const directory=`${DIRECTORY}/migration-attempt-${plan.nonce}`;fs.mkdirSync(directory);
  durable(`${directory}/admitted-plan.json`,plan);durable(`${directory}/admitted-approval.json`,approval);
  const receipt={kind:plan.kind,status:'failed',startedAt:new Date().toISOString(),nonce:plan.nonce,providerMutationsIssued:0,appStarted:false,ddlAttempts:0};
  const attemptDeadline=Date.parse(receipt.startedAt)+900000,workDeadline=Date.parse(receipt.startedAt)+720000;
  let c,result,before,migration;
  try{
    c=await context(Math.min(workDeadline,Date.parse(plan.expiresAt)));migration=loadMigration();
    const protectedExpected={sourceIdentity:plan.sourceIdentity,machineIdentity:plan.machineIdentity,productionIdentity:plan.productionIdentity};
    check(isDeepStrictEqual(await protectedState(c),protectedExpected),'source_protected_drift');
    check((await c.get(`postgres/${TARGET.cluster}/backups`)).data.some(b=>b.id===plan.backupId&&b.status==='completed')&&Date.now()-Date.parse(plan.backupFinishedAt)<7200000,'source_backup_expired');
    before=await reader(c,migration,receipt);compareOriginals(read(`${DIRECTORY}/${plan.baselinePath}`),before);durable(`${directory}/reader-before.json`,before);
    const admin=await session(c,'fly-user',true,receipt,observeAdmin);checkPolicy(admin,loadPolicy().policy);durable(`${directory}/admin-before.json`,admin);
    check(isDeepStrictEqual(await protectedState(c),protectedExpected)&&isDeepStrictEqual(hashes(),plan.sourceHashes),'source_prewrite_drift');
    const log=journal(`${directory}/migration-journal.jsonl`);
    try{await session(c,'fly-user',false,receipt,async client=>{
      const admit=()=>validateSourceApproval(plan,read(`${DIRECTORY}/migration-approval.json`),hashes());
      admit();const operationMs=Math.min(180000,Date.parse(plan.expiresAt)-Date.now(),c.remainingMs());check(operationMs>=1000,'source_plan_expired');
      receipt.ddlAttempts=1;
      result=await executeMigration(client,{plan:migration,expectedBefore:before,persist:async event=>{
        // Failure rollback acknowledgements are cleanup and remain journalable
        // after expiry/revocation. Every new dispatch keeps current authority.
        if(!(event.phase==='rollback-ack'&&event.afterFailure===true))admit();
        await log.persist(event);
      },outcome:'commit',operationMs});
      durable(`${directory}/migration-result.json`,result);
    });}finally{log.close();}
    // Read-only reconciliation and disposal use the reserved cleanup window,
    // including after authority expires. No further write session is possible.
    c.setDeadline(attemptDeadline);
    const after=await reader(c,migration,receipt);durable(`${directory}/reader-after.json`,after);
    if(result.commitAcknowledged&&result.status==='committed-awaiting-reader'){receipt.proof=verifyCommittedMigration(result,after,migration);receipt.status='passed';}
    else if(result.commitDispatched){assertMigrationPreserved(before,after,migration);receipt.status='commit-reconciled-requires-review';receipt.actual142Verified=true;}
    else{compareOriginals(before,after);receipt.original95Preserved=true;receipt.errorCode=result.errorCode??'source_migration_not_committed';}
    check(isDeepStrictEqual(await protectedState(c),protectedExpected),'source_protected_drift');receipt.protectedMetadataUnchanged=true;
  }catch(e){receipt.status='failed';receipt.errorCode=/^(source|migration)_[a-z_]+$/.test(e.safeCode??'')?e.safeCode:'source_migration_failed';receipt.commitMayHaveOccurred=result?.commitDispatched===true;}
  finally{
    receipt.finishedAt=new Date().toISOString();durable(`${directory}/result.json`,receipt);
    console.log(JSON.stringify({status:receipt.status,errorCode:receipt.errorCode,receipt:`${directory}/result.json`,appStarted:false}));
    if(receipt.status!=='passed')process.exitCode=1;
  }
}
export async function main(args=process.argv.slice(2)){check(args.length===1&&['--prepare','--execute'].includes(args[0]),'source_usage');return args[0]==='--prepare'?prepare():execute();}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(/^source_[a-z_]+$/.test(e.safeCode??'')?e.safeCode:'source_refused');process.exitCode=1;});
