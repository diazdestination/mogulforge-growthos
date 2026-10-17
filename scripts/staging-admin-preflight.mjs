/** Fixed staging-only administrative metadata observation. READ ONLY plus
 * transaction-local role selection; no DDL, writes, function invocation or app. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, flyAuthorization, startProxy, closeClient } from './staging-observation-runner.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const FLY = 'C:/Forge/tools/flyctl/0.4.115/flyctl.exe';
const ARTIFACTS = 'C:/Forge/artifacts/growthos-db-recovery-20261010';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const check = (ok, code) => { if (!ok) fail(code); };
export const QUERIES = Object.freeze({
  identity: `SELECT current_database() AS database,session_user::text AS login,current_user::text AS role,
    current_setting('server_version_num')::int AS version,pg_backend_pid() AS pid,
    current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation`,
  roles: `SELECT p.rolname AS principal,r.rolname AS name,r.rolsuper AS superuser,r.rolcreaterole AS create_role,
    r.rolcreatedb AS create_database,r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,r.rolcanlogin AS login,
    pg_catalog.pg_has_role(p.oid,r.oid,'MEMBER') AS member,pg_catalog.pg_has_role(p.oid,r.oid,'USAGE') AS usable,
    pg_catalog.pg_has_role(p.oid,r.oid,'SET') AS can_set FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles r
    WHERE p.rolname IN ('fly-user','schema_admin') AND (p.oid=r.oid OR pg_catalog.pg_has_role(p.oid,r.oid,'MEMBER')) ORDER BY 1,2`,
  schema: `SELECT n.nspname AS name,owner.rolname AS owner,
    pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') AS usage,
    pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') AS create
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner WHERE n.nspname='public'`,
  owners: `SELECT 'table' AS kind,c.relname AS name,r.rolname AS owner FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
    UNION ALL SELECT 'enum',t.typname,r.rolname FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace JOIN pg_catalog.pg_roles r ON r.oid=t.typowner
    WHERE n.nspname='public' AND t.typtype='e' ORDER BY 1,2`,
  eventTriggers: `SELECT e.evtname AS name,e.evtevent AS event,e.evtenabled::text AS enabled,e.evttags AS tags,
    owner.rolname AS owner,n.nspname AS function_schema,p.proname AS function_name,l.lanname AS language,
    ext.extname AS extension_name,ext.extversion AS extension_version
    FROM pg_catalog.pg_event_trigger e JOIN pg_catalog.pg_roles owner ON owner.oid=e.evtowner
    JOIN pg_catalog.pg_proc p ON p.oid=e.evtfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    LEFT JOIN pg_catalog.pg_depend dep ON dep.classid='pg_catalog.pg_event_trigger'::regclass AND dep.objid=e.oid AND dep.objsubid=0 AND dep.deptype='e' AND dep.refclassid='pg_catalog.pg_extension'::regclass
    LEFT JOIN pg_catalog.pg_extension ext ON ext.oid=dep.refobjid ORDER BY e.evtname`,
  auditFunctions: `SELECT p.proname AS name,n.nspname AS schema,owner.rolname AS owner,p.prosecdef AS security_definer,
    l.lanname AS language,pg_catalog.format_type(p.prorettype,NULL) AS return_type,p.probin AS library,p.prosrc AS symbol,
    p.proconfig AS configuration,ext.extname AS extension_name,ext.extversion AS extension_version
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    JOIN pg_catalog.pg_depend dep ON dep.classid='pg_catalog.pg_proc'::regclass AND dep.objid=p.oid AND dep.objsubid=0 AND dep.deptype='e' AND dep.refclassid='pg_catalog.pg_extension'::regclass
    JOIN pg_catalog.pg_extension ext ON ext.oid=dep.refobjid WHERE ext.extname='pgaudit'
    AND p.proname IN ('pgaudit_ddl_command_end','pgaudit_sql_drop') ORDER BY p.proname`,
  defaultAclRows: `SELECT owner.rolname AS owner,COALESCE(n.nspname,'*') AS schema,d.defaclobjtype::text AS object_type,
    d.defaclacl::text AS acl,cardinality(d.defaclacl) AS acl_entries
    FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace ORDER BY 1,2,3`,
});

export async function observeAdmin(client) {
  const evidence = { status: 'failed', rollbackAcknowledged: false, metadata: {} };
  let dispatched = false;
  try {
    dispatched = true;
    check((await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).command === 'BEGIN', 'admin_begin');
    await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='2000ms'; SET LOCAL idle_in_transaction_session_timeout='15000ms'; SET LOCAL search_path=pg_catalog,public; SET LOCAL ROLE schema_admin");
    const ordered=Object.entries(QUERIES).filter(([name])=>name!=='auditFunctions').concat([['auditFunctions',QUERIES.auditFunctions]]);
    for (const [name, sql] of ordered) {
      const rows = (await client.query(sql)).rows;
      check(Array.isArray(rows) && rows.length < 2000 && JSON.stringify(rows).length < 1000000, 'admin_metadata_bound');
      if(name==='auditFunctions') {
        // Never persist an unexpected SQL body or arbitrary function settings.
        const expected=['pgaudit_ddl_command_end','pgaudit_sql_drop'];
        evidence.auditLinkageChecks=rows.map(r=>({name:expected.includes(r.name)?r.name:'unrecognized',
          schemaMatches:r.schema==='public',languageMatches:r.language==='c',ownerMatches:r.owner==='postgres',
          securityDefinerMatches:r.security_definer===true,returnTypeMatches:r.return_type==='event_trigger',
          libraryMatches:r.library==='$libdir/pgaudit',symbolMatches:r.symbol===r.name,
          extensionMatches:r.extension_name==='pgaudit' && r.extension_version==='16.1',
          configurationMatches:Array.isArray(r.configuration) && r.configuration.length===1 && r.configuration[0]==='search_path="pg_catalog, pg_temp"',
          configurationWhitespaceOnlyDifference:Array.isArray(r.configuration) && r.configuration.length===1 && typeof r.configuration[0]==='string' && r.configuration[0].replace(/\s/g,'')==='search_path=pg_catalog,pg_temp',
          librarySha256:typeof r.library==='string'?sha(r.library):null,
          configurationSha256:sha(JSON.stringify(r.configuration??null))}));
        check(rows.length===2 && expected.every(n=>rows.filter(r=>r.name===n).length===1) && rows.every(r=>
          r.schema==='public' && r.language==='c' && r.owner==='postgres' && r.security_definer===true &&
          r.return_type==='event_trigger' && r.library==='$libdir/pgaudit' && r.symbol===r.name &&
          r.extension_name==='pgaudit' && r.extension_version==='16.1' && Array.isArray(r.configuration) &&
          r.configuration.length===1 && r.configuration[0]==='search_path="pg_catalog, pg_temp"'),'admin_audit_linkage_unrecognized');
      }
      evidence.metadata[name] = rows;
      if (name === 'identity') {
        const i=rows[0];check(rows.length===1 && i.database===TARGET.database && i.login==='fly-user' && i.role==='schema_admin' && i.version>=160000 && i.version<170000 && i.read_only==='on' && i.isolation==='repeatable read','admin_identity');
      }
    }
    evidence.status='observed-awaiting-policy-review';
  } catch (e) { evidence.errorCode = e.safeCode ?? 'admin_query_failed'; }
  finally {
    if(dispatched) try { evidence.rollbackAcknowledged=(await client.query('ROLLBACK')).command==='ROLLBACK'; } catch {}
    if(!evidence.rollbackAcknowledged) evidence.status='failed';
  }
  return evidence;
}

export async function main(args=process.argv.slice(2)) {
  check(args.length===1 && args[0]==='--observe-readonly','admin_explicit_action_required');
  const admission=JSON.parse(readFileSync(`${ARTIFACTS}/admin-preflight-admission.json`,'utf8'));
  const required=['scripts/staging-admin-preflight.mjs','scripts/staging-observation-runner.mjs','scripts/staging-observation-core.mjs','reports/release-preparation-2026-10-09/schema-catalog.mjs'];
  check(admission.kind==='REVIEWED_STAGING_ADMIN_READ_ONLY' && admission.cluster===TARGET.cluster && admission.authorized===true && Object.keys(admission.files).sort().join('|')===required.sort().join('|'),'admin_admission');
  for(const path of required)check(sha(readFileSync(resolve(root,path)))===admission.files[path],'admin_source_drift');
  check(sha(readFileSync(FLY))===admission.flyBinarySha256,'admin_fly_drift');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|COMSPEC|PROGRAMDATA)$/i.test(key)));
  const cli=async a=>(await run(FLY,a,{env,windowsHide:true,timeout:30000,maxBuffer:2000000})).stdout;
  const receipt={kind:'STAGING_ADMIN_READ_ONLY_METADATA',startedAt:new Date().toISOString(),status:'failed',sourceHashes:admission.files};
  let client,proxy,authorization,ownsAgent=false;
  const get=async path=>{const r=await fetch(`https://api.machines.dev/v1/${path}`,{headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(20000)});check(r.ok,'admin_provider_read');const text=await r.text();check(text.length<2000000,'admin_provider_bound');return JSON.parse(text);};
  try {
    const processes=await run('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name = 'flyctl.exe'\").Count"],{env,windowsHide:true,timeout:10000});
    check(processes.stdout.trim()==='0','admin_existing_fly_process');
    check((await cli(['auth','whoami'])).trim()===TARGET.account,'admin_account');
    await cli(['mpg','list','--org','personal','--json']);
    authorization=flyAuthorization(readFileSync('C:/Users/diazd/.fly/config.yml','utf8'));
    const cluster=(await get(`postgres/${TARGET.cluster}`)).data;
    check(cluster.id===TARGET.cluster && cluster.organization?.slug===TARGET.org && cluster.region==='iad' && cluster.status==='ready','admin_cluster');
    const before=await get(`apps/${TARGET.app}/machines/${TARGET.machine}`);
    check(before.id===TARGET.machine && before.state==='stopped','admin_app_not_stopped');
    const baseline={state:before.state,instance:before.instance_id,configSha256:sha(JSON.stringify(before.config))};
    const credentials=(await get(`postgres/${TARGET.cluster}/users/fly-user/credentials`)).data;
    check(credentials?.username==='fly-user' && typeof credentials.password==='string' && credentials.password.length>=8,'admin_credentials');
    ownsAgent=true;proxy=await startProxy(receipt);
    const {Client}=createRequire(resolve(root,'artifacts/api-server/package.json'))('pg');
    client=new Client({host:'127.0.0.1',port:TARGET.port,user:'fly-user',password:credentials.password,database:TARGET.database,
      ssl:false,connectionTimeoutMillis:10000,query_timeout:12000,options:'-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000'});
    credentials.password=null;client.on('error',()=>{});await client.connect();
    const timer=setTimeout(()=>client.connection?.stream?.destroy(),90000);
    try{receipt.observation=await observeAdmin(client);}finally{clearTimeout(timer);}
    const after=await get(`apps/${TARGET.app}/machines/${TARGET.machine}`);
    check(JSON.stringify(baseline)===JSON.stringify({state:after.state,instance:after.instance_id,configSha256:sha(JSON.stringify(after.config))}),'admin_app_changed');
    receipt.machineUnchanged=true;receipt.provider={account:TARGET.account,cluster:TARGET.cluster,region:'iad'};
    receipt.status=receipt.observation.status;
  }catch(e){receipt.errorCode=e.safeCode??'admin_preflight_failed';receipt.status='failed';}
  finally {
    if(client)try{await closeClient(client,receipt);}catch{receipt.status='failed';receipt.clientCleanupFailed=true;}
    if(proxy)try{await proxy.close();}catch{receipt.status='failed';receipt.proxyCleanupFailed=true;}
    if(ownsAgent)try{await cli(['agent','stop']);receipt.ownedAgentStopAcknowledged=true;}catch{receipt.status='failed';receipt.agentCleanupFailed=true;}
    receipt.finishedAt=new Date().toISOString();
    const path=`${ARTIFACTS}/admin-preflight-${receipt.startedAt.replace(/[:.]/g,'-')}.json`;
    writeFileSync(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({status:receipt.status,errorCode:receipt.errorCode,receipt:path,rollbackAcknowledged:receipt.observation?.rollbackAcknowledged,clientEndAcknowledged:receipt.clientEndAcknowledged,socketClosed:receipt.socketClosed,proxyExited:receipt.proxy?.exitAcknowledged,ownedAgentStopped:receipt.ownedAgentStopAcknowledged}));
    if(receipt.status==='failed')process.exitCode=1;
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('admin_preflight_refused');process.exitCode=1;});
