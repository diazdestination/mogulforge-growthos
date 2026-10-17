/** Import-safe mechanism only. No transport, environment, credentials, files,
 * application imports or hosted entrypoint. Caller owns target admission,
 * reviewed privilege expectations, durable one-attempt reservation and Reader. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { collectSchemaCatalog, catalogDigest, catalogDifferences } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { PRIVILEGE_QUERIES } from './staging-observation-core.mjs';
import { assertProduction75Source } from './production75-source.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const check = (v,code) => { if (!v) fail(code); };
const equal = (a,b,code) => check(isDeepStrictEqual(a,b),code);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const q = v => { check(typeof v === 'string' && /^[a-z_][a-z0-9_]*$/.test(v), 'production75_identifier'); return `"${v}"`; };
const roleName = v => typeof v === 'string' && /^[a-z_][a-z0-9_-]{0,62}$/.test(v);
const roleQ = v => { check(roleName(v),'production75_role'); return `"${v}"`; };
const plans = new WeakSet(), usedPlans = new WeakSet(), usedClients = new WeakSet();
const PHYSICAL75 = new Set(['2ca3d8dbc10313fb7f23bab2e87f61ad13a21e925664e190c087683aad1daf55','2a56e08b2bd331d0eaedea2d504d3fff568bf4e6aaab2279467cf997648d2009']);
const LOGICAL75 = '240c018739be01c7b6faf1236ced7e065d02d1e7e15788bbbd12602bfc777508';
const relaxed = new Set(['estimates.lead_id','projects.lead_id']);
export const ORIGINAL_DEFAULTS = freeze({ organizations: { entitlements: null },
  org_settings: { customer_email_sender_user_id: null },
  leads: { import_source_key: null, external_opportunity_id: null, imported_history: null },
  lead_imports: { updated: 0, conflicts: 0, source_key: null, snapshot_as_of: null },
  estimates: { customer_work_id: null, work_version: null }, projects: { customer_work_id: null, work_version: null } });
export const IDENTITY_SQL = `SELECT current_database() AS database,session_user::text AS login,current_user::text AS role,
  current_setting('server_version_num')::int AS version,pg_backend_pid() AS pid,
  current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only`;
const PRINCIPALS = "SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN ('growthos-restore-reader','growthos-staging-live')";
export const PRODUCTION75_PRIVILEGE_QUERIES = freeze(Object.fromEntries(Object.entries(PRIVILEGE_QUERIES).map(([key,sql]) =>
  [key, sql.replace(PRINCIPALS, 'SELECT oid,rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])')])));
// ACLs cover third parties and grant options independently of effective access.
export const OWNERSHIP_SQL = `SELECT 'relation' AS kind,n.nspname AS schema,c.relname AS name,NULL::text AS sub_name,
  o.rolname AS owner,COALESCE(c.relacl::text,'DEFAULT') AS acl
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles o ON o.oid=c.relowner
  WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f')
  UNION ALL SELECT 'column',n.nspname,c.relname,a.attname,o.rolname,COALESCE(a.attacl::text,'DEFAULT')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles o ON o.oid=c.relowner
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public'
  AND c.relkind IN ('r','p','v','m','f')
  UNION ALL SELECT 'schema',n.nspname,n.nspname,NULL,o.rolname,COALESCE(n.nspacl::text,'DEFAULT')
  FROM pg_namespace n JOIN pg_roles o ON o.oid=n.nspowner WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'
  UNION ALL SELECT 'database','',d.datname,NULL,o.rolname,COALESCE(d.datacl::text,'DEFAULT')
  FROM pg_database d JOIN pg_roles o ON o.oid=d.datdba WHERE d.datname=current_database()
  UNION ALL SELECT 'function',n.nspname,f.proname,pg_get_function_identity_arguments(f.oid),o.rolname,COALESCE(f.proacl::text,'DEFAULT')
  FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace JOIN pg_roles o ON o.oid=f.proowner WHERE n.nspname='public'
  UNION ALL SELECT 'type',n.nspname,t.typname,NULL,o.rolname,COALESCE(t.typacl::text,'DEFAULT')
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles o ON o.oid=t.typowner
  WHERE n.nspname='public' AND t.typtype='e' ORDER BY 1,2,3,4`;

/** Derive only known physical differences: retained ordinals come from actual75;
 * appended column order comes from locally executed source-lineage fixtures.
 * Local rehearsal must independently execute DDL and match these full catalogs. */
export function deriveProduction75Catalogs(catalog75, canonical95, canonical142) {
  check(PHYSICAL75.has(catalogDigest(catalog75,{physical:true})) && catalogDigest(catalog75) === LOGICAL75,
    'production75_baseline_catalog');
  check(canonical95?.tables.length === 95 && canonical142?.tables.length === 142, 'production75_canonical_catalog');
  check(catalogDigest(canonical95,{physical:true}) === '170670b17dfd2b4cbf2b5bc95b4642657294f2e67c92289ea60e9d8058f590c3' &&
    catalogDigest(canonical142,{physical:true}) === '24f33349b2cb443443ce3d670463b98de4aa31cb8b3589396da7c43df1f37b52', 'production75_canonical_catalog');
  const ordinals = new Map(catalog75.columns.map(c => [`${c.table_name}.${c.name}`,c.ordinal]));
  const derive = catalog => { const result=structuredClone(catalog); for (const c of result.columns) {
    if (ordinals.has(`${c.table_name}.${c.name}`)) c.ordinal=ordinals.get(`${c.table_name}.${c.name}`);
  } return result; };
  const catalog95=derive(canonical95), catalog142=derive(canonical142);
  for (const old of catalog75.columns) {
    equal(catalog95.columns.find(c => c.table_name===old.table_name && c.name===old.name),old,'production75_retained_column');
    equal(catalog142.columns.find(c => c.table_name===old.table_name && c.name===old.name),relaxed.has(`${old.table_name}.${old.name}`)?{...old,nullable:true}:old,'production75_retained_column');
  }
  for (const section of ['tables','constraints','indexes','enums','triggers','policies']) {
    for (const row of catalog75[section]) {
      check(catalog95[section].some(r => isDeepStrictEqual(r,row)) && catalog142[section].some(r => isDeepStrictEqual(r,row)), 'production75_retained_definition');
    }
  }
  return { catalog95,catalog142 };
}

function validatePolicy(policy,catalog,target) {
  check(policy && Object.keys(policy).sort().join(',')==='ownership,privileges' && Array.isArray(policy.ownership) &&
    policy.privileges && Object.keys(policy.privileges).sort().join(',')===Object.keys(PRODUCTION75_PRIVILEGE_QUERIES).sort().join(','), 'production75_policy_required');
  for (const rows of [...Object.values(policy.privileges),policy.ownership]) check(Array.isArray(rows) && rows.length<=20000 && Buffer.byteLength(JSON.stringify(rows))<=8000000,'production75_policy_bound');
  const tableNames=new Set(catalog.tables.map(t=>t.name));
  const columnNames=new Set(catalog.columns.map(c=>`${c.table_name}.${c.name}`));
  for(const principal of target.principals) {
    const tables=policy.privileges.tables.filter(r=>r.principal===principal), columns=policy.privileges.columns.filter(r=>r.principal===principal);
    check(tables.length===tableNames.size && new Set(tables.map(t=>t.name)).size===tableNames.size && tables.every(t=>tableNames.has(t.name)), 'production75_table_policy_coverage');
    check(columns.length===columnNames.size && new Set(columns.map(c=>`${c.table_name}.${c.name}`)).size===columnNames.size && columns.every(c=>columnNames.has(`${c.table_name}.${c.name}`)), 'production75_column_policy_coverage');
    check(policy.privileges.roles.some(r=>r.principal===principal && r.name===principal), 'production75_role_policy_coverage');
  }
  check(policy.privileges.tables.every(r=>target.principals.includes(r.principal)) && policy.privileges.columns.every(r=>target.principals.includes(r.principal)), 'production75_policy_principal');
  for (const table of tableNames) check(policy.ownership.some(r=>r.kind==='relation' && r.schema==='public' && r.name===table),'production75_owner_policy_coverage');
  for (const column of columnNames) check(policy.ownership.some(r=>r.kind==='column' && `${r.name}.${r.sub_name}`===column),'production75_acl_policy_coverage');
}
export function prepareProduction75({source,catalog75,canonical95,canonical142,target,policy75,policy95,policy142,until=142}={}) {
  assertProduction75Source(source);
  check(target && Object.keys(target).sort().join(',')==='database,principals,readerLogin,readerRole,writerInitialRoles,writerLogin,writerRole' &&
    [target.database,target.writerLogin,target.writerRole,target.readerLogin,target.readerRole].every(roleName) &&
    Array.isArray(target.writerInitialRoles) && target.writerInitialRoles.length>0 && target.writerInitialRoles.length<=3 && target.writerInitialRoles.every(roleName) &&
    Array.isArray(target.principals) && target.principals.length>=2 && target.principals.length<=8 && target.principals.every(roleName) && new Set(target.principals).size===target.principals.length &&
    target.principals.includes(target.readerLogin) && target.principals.includes(target.writerLogin) &&
    target.readerLogin!==target.writerLogin && target.readerRole!==target.writerRole && [95,142].includes(until), 'production75_explicit_target');
  const {catalog95,catalog142}=deriveProduction75Catalogs(catalog75,canonical95,canonical142);
  validatePolicy(policy75,catalog75,target); validatePolicy(policy95,catalog95,target); validatePolicy(policy142,catalog142,target);
  const plan=freeze({ sourceCommit:source.sourceCommit, target:structuredClone(target), until,
    catalog75:structuredClone(catalog75),catalog95,catalog142,
    policies:{75:structuredClone(policy75),95:structuredClone(policy95),142:structuredClone(policy142)},
    steps:source.steps.slice(0,until===95?3:19).map(s=>({...s})),
    expectedPhysicalNewColumns:catalog142.columns.filter(c=>!catalog75.columns.some(o=>o.table_name===c.table_name && o.name===c.name)).map(c=>({table:c.table_name,column:c.name,ordinal:c.ordinal})) });
  plans.add(plan); return plan;
}
export async function captureProduction75Policy(client,principals) {
  check(Array.isArray(principals) && principals.every(roleName),'production75_role');
  const privileges={};
  for(const [name,sql] of Object.entries(PRODUCTION75_PRIVILEGE_QUERIES)) {
    const rows=(await client.query(sql,sql.includes('$1')?[principals]:undefined)).rows;
    check(Array.isArray(rows) && rows.length<=20000 && Buffer.byteLength(JSON.stringify(rows))<=8000000,'production75_metadata_bound'); privileges[name]=rows;
  }
  const ownership=(await client.query(OWNERSHIP_SQL)).rows;
  check(Array.isArray(ownership) && ownership.length<=20000 && Buffer.byteLength(JSON.stringify(ownership))<=8000000,'production75_metadata_bound');
  return {privileges,ownership};
}
export async function captureProduction75State(client,plan) {
  check(plans.has(plan),'production75_plan_required');
  const catalog=await collectSchemaCatalog(client);
  const phase=[75,95,142].find(n=>catalogDigest(catalog,{physical:true})===catalogDigest(plan[`catalog${n}`],{physical:true}));
  check(phase,'production75_unrecognized_catalog');
  const identity=(await client.query(IDENTITY_SQL)).rows[0],fingerprints=[];
  let totalRows=0,totalBytes=0;
  for(const table of plan.catalog75.tables) {
    const columns=plan.catalog75.columns.filter(c=>c.table_name===table.name).sort((a,b)=>a.ordinal-b.ordinal);
    const projection=`(SELECT ${columns.map(c=>q(c.name)).join(',')} FROM public.${q(table.name)}) AS original`;
    const size=(await client.query(`SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`)).rows[0];
    check(size && /^\d{1,12}$/.test(size.rows) && /^\d{1,12}$/.test(size.bytes),'production75_fingerprint_shape');
    const rows=Number(size.rows),bytes=Number(size.bytes);totalRows+=rows;totalBytes+=bytes;
    check(rows<=1000000 && bytes<=268435456 && totalRows<=5000000 && totalBytes<=536870912,'production75_data_bound');
    const fingerprint=(await client.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`)).rows[0];
    check(fingerprint?.rows===size.rows && /^[a-f0-9]{32}$/.test(fingerprint?.digest??''),'production75_fingerprint_shape');
    fingerprints.push({table:table.name,rows,bytes,digest:fingerprint.digest});
  }
  const policy=await captureProduction75Policy(client,plan.target.principals), defaults=[],newTables=[];
  if(phase!==75) {
    const expectedDefaults=phase===95?{org_settings:ORIGINAL_DEFAULTS.org_settings}:ORIGINAL_DEFAULTS;
    for(const [table,fields] of Object.entries(expectedDefaults)) for(const [column,value] of Object.entries(fields)) {
      const count=(await client.query(`SELECT count(*)::text AS mismatches FROM public.${q(table)} WHERE to_jsonb(${q(column)}) IS DISTINCT FROM $1::jsonb`,[value===null?null:JSON.stringify(value)])).rows[0]?.mismatches;
      check(count==='0','production75_original_default');defaults.push(`${table}.${column}`);
    }
    for(const table of catalog.tables.filter(t=>!plan.catalog75.tables.some(o=>o.name===t.name))) {
      check((await client.query(`SELECT count(*)::text AS rows FROM public.${q(table.name)}`)).rows[0]?.rows==='0','production75_new_table_not_empty');newTables.push(table.name);
    }
  }
  return {identity,catalog,fingerprints,policy,defaults,newTables,phase};
}
export function assertProduction75Preserved(before,after,plan,phase=plan.until) {
  check(plans.has(plan),'production75_plan_required');
  equal(before.catalog,plan.catalog75,'production75_baseline_catalog');equal(after.catalog,plan[`catalog${phase}`],'production75_catalog_changed');
  equal(after.fingerprints,before.fingerprints,'production75_original_data_changed');
  equal(before.policy,plan.policies[75],'production75_baseline_policy');equal(after.policy,plan.policies[phase],'production75_policy_changed');
  const originals=new Set(plan.catalog75.tables.map(t=>t.name)),columns=new Set(plan.catalog75.columns.map(c=>`${c.table_name}.${c.name}`));
  const ownershipKey=r=>JSON.stringify([r.kind,r.schema,r.name,r.sub_name??null]);
  const originalOwnership=new Set(before.policy.ownership.map(ownershipKey));
  const addedOwnership=new Set([
    ...plan[`catalog${phase}`].tables.filter(t=>!originals.has(t.name)).map(t=>ownershipKey({kind:'relation',schema:t.schema,name:t.name,sub_name:null})),
    ...plan[`catalog${phase}`].columns.filter(c=>!columns.has(`${c.table_name}.${c.name}`)).map(c=>ownershipKey({kind:'column',schema:'public',name:c.table_name,sub_name:c.name})),
  ]);
  // Keep every pre-existing object, including provider-owned views/functions and
  // their column ACLs. Exclude only known SQL-added table/column identities;
  // unexpected additions remain in the comparison and cannot be masked.
  const retain=r=>originalOwnership.has(ownershipKey(r))||!addedOwnership.has(ownershipKey(r));
  equal(after.policy.ownership.filter(retain),before.policy.ownership,'production75_original_acl_changed');
  for(const [section,rows] of Object.entries(before.policy.privileges)) {
    const actual=after.policy.privileges[section],retained=section==='tables'?actual.filter(r=>originals.has(r.name)):section==='columns'?actual.filter(r=>columns.has(`${r.table_name}.${r.name}`)):actual;
    equal(retained,rows,'production75_original_privileges_changed');
  }
  for(const old of before.catalog.columns) equal(after.catalog.columns.find(c=>c.table_name===old.table_name&&c.name===old.name),phase===142&&relaxed.has(`${old.table_name}.${old.name}`)?{...old,nullable:true}:old,'production75_retained_column');
  check(after.newTables.length===(phase===95?20:67)&&after.defaults.length===(phase===95?1:13),'production75_coverage');
  return {originalTables:75,originalColumns:849,newTablesEmpty:phase===95?20:67,defaultsVerified:phase===95?1:13};
}
function identityValid(row,target,reader=false) {return row?.database===target.database&&row.login===target[reader?'readerLogin':'writerLogin']&&row.role===target[reader?'readerRole':'writerRole']&&Number.isInteger(row.version)&&row.version>=160000&&row.version<170000&&Number.isInteger(row.pid)&&row.pid>0;}
export async function executeProduction75(client,{plan,expectedBefore,persist,outcome='rollback',operationMs=240000}={}) {
  check(plans.has(plan)&&typeof client?.query==='function'&&typeof persist==='function','production75_arguments');
  check(['rollback','commit'].includes(outcome)&&Number.isInteger(operationMs)&&operationMs>=1000&&operationMs<=240000,'production75_limits');
  check(!usedPlans.has(plan)&&!usedClients.has(client),'production75_attempt_already_used');
  equal(expectedBefore?.catalog,plan.catalog75,'production75_expected_baseline');equal(expectedBefore?.policy,plan.policies[75],'production75_expected_policy');
  check(expectedBefore.fingerprints?.length===75,'production75_expected_fingerprints');
  usedPlans.add(plan);usedClients.add(client);
  const result={status:'failed',commitDispatched:false,commitAcknowledged:false,rollbackAcknowledged:false,stepsAcknowledged:0,requiresFreshReader:false};
  const deadline=Date.now()+operationMs;let began=false;
  const bounded=async(operation,ms,code)=>{let timer;try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>{client.connection?.stream?.destroy();reject(Object.assign(new Error(code),{safeCode:code}));},Math.max(1,ms));})]);}finally{clearTimeout(timer);}};
  const query=(...args)=>{check(Date.now()<deadline,'production75_deadline');return bounded(()=>client.query(...args),Math.min(20000,deadline-Date.now()),'production75_query_timeout');};
  const journal=(event,cleanup=false)=>{check(cleanup||Date.now()<deadline,'production75_deadline');return bounded(()=>Promise.resolve(persist(event)),cleanup?5000:Math.min(5000,deadline-Date.now()),'production75_journal_timeout');};
  const view={query};
  try {
    const initial=(await query(IDENTITY_SQL)).rows[0];
    result.initialIdentityChecks={database:initial?.database===plan.target.database,login:initial?.login===plan.target.writerLogin,
      role:plan.target.writerInitialRoles.includes(initial?.role),version:Number.isInteger(initial?.version)&&initial.version>=160000&&initial.version<170000,pid:Number.isInteger(initial?.pid)&&initial.pid>0};
    check(Object.values(result.initialIdentityChecks).every(Boolean),'production75_identity');
    await journal({phase:'begin-intent'});began=true;
    check((await query('BEGIN ISOLATION LEVEL REPEATABLE READ')).command==='BEGIN','production75_begin_unacknowledged');
    await query(`SET LOCAL statement_timeout='15000ms'; SET LOCAL lock_timeout='3000ms'; SET LOCAL idle_in_transaction_session_timeout='20000ms'; SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off; SET LOCAL ROLE ${roleQ(plan.target.writerRole)}`);
    await journal({phase:'begin-ack',pid:initial.pid});
    await query(`LOCK TABLE ${plan.catalog75.tables.map(t=>`public.${q(t.name)}`).sort().join(',')} IN ACCESS EXCLUSIVE MODE`);
    const identity=(await query(IDENTITY_SQL)).rows[0];
    check(identityValid(identity,plan.target)&&identity.pid===initial.pid&&identity.read_only==='off'&&identity.isolation==='repeatable read','production75_writer_identity');
    const before=await captureProduction75State(view,plan);
    for(const key of ['catalog','fingerprints','policy']) equal(before[key],expectedBefore[key],'production75_baseline_drift');
    result.before=before;
    for(const [index,step] of plan.steps.entries()) {
      await journal({phase:'step-intent',path:step.path,sha256:step.sha256});await query(step.sql);result.stepsAcknowledged++;
      await journal({phase:'step-ack',path:step.path});
      if(index===2) {const checkpoint=await captureProduction75State(view,plan);result.bridgeProof=assertProduction75Preserved(before,checkpoint,plan,95);await journal({phase:'bridge-verified',proof:result.bridgeProof});}
    }
    const after=await captureProduction75State(view,plan);result.proof=assertProduction75Preserved(before,after,plan);result.after=after;
    await journal({phase:'precommit-verified',proof:result.proof});await journal({phase:`${outcome}-intent`});
    if(outcome==='commit') {result.commitDispatched=true;check((await query('COMMIT')).command==='COMMIT','production75_commit_unacknowledged');result.commitAcknowledged=true;began=false;result.requiresFreshReader=true;await journal({phase:'commit-ack'});result.status='committed-awaiting-reader';}
    else {check((await query('ROLLBACK')).command==='ROLLBACK','production75_rollback_unacknowledged');result.rollbackAcknowledged=true;began=false;await journal({phase:'rollback-ack'});result.status='rehearsed-rolled-back';}
  } catch(error) {
    result.errorCode=/^production75_[a-z_]+$/.test(error?.safeCode??'')?error.safeCode:'production75_database_or_journal_failure';
    if(result.commitDispatched){result.status=result.commitAcknowledged?'committed-journal-unconfirmed':'commit-unknown';result.requiresFreshReader=true;}
    else if(began) {try{result.rollbackAcknowledged=(await bounded(()=>client.query('ROLLBACK'),5000,'production75_cleanup_timeout')).command==='ROLLBACK';if(result.rollbackAcknowledged)await journal({phase:'rollback-ack',afterFailure:true},true);}catch{result.cleanupUnconfirmed=true;}}
  }
  return result;
}
/** Unknown COMMIT may only be reconciled by a distinct Reader observation;
 * this function never admits replay or converts it to an acknowledged commit. */
export function verifyProduction75Reader(result,reader,plan) {
  check(plans.has(plan)&&result?.requiresFreshReader&&result.before,'production75_reader_admission');
  check(identityValid(reader?.identity,plan.target,true)&&reader.identity.pid!==result.before.identity.pid&&reader.identity.read_only==='on'&&reader.identity.isolation==='repeatable read','production75_fresh_reader');
  const proof=assertProduction75Preserved(result.before,reader,plan);
  if(result.commitAcknowledged&&result.status==='committed-awaiting-reader') {for(const key of ['catalog','fingerprints','policy','defaults','newTables'])equal(reader[key],result.after[key],'production75_reader_changed');return{status:'verified',...proof,freshReaderVerified:true};}
  check(['commit-unknown','committed-journal-unconfirmed'].includes(result.status),'production75_commit_not_accepted');
  return {status:'reconciled-committed-no-replay',...proof,freshReaderVerified:true,commitAcknowledged:result.commitAcknowledged};
}
