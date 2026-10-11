/** Explicit local-only PG16 rehearsal. No provider calls or environment URLs. */
import { spawn,execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,openSync,writeSync,fsyncSync,closeSync } from 'node:fs';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { localEnvironment,withWslDockerSession,parseLoopbackPort } from './local-dev.mjs';
import { PINNED_FILES,SOURCE_COMMIT } from './production75-pins.mjs';
import { buildProduction75Source } from './production75-source.mjs';
import { collectSchemaCatalog,catalogDigest,catalogDifferences } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { prepareProduction75,deriveProduction75Catalogs,captureProduction75State,captureProduction75Policy,executeProduction75,verifyProduction75Reader } from './production75-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),directory=resolve(root,'reports/production75-recovery-2026-10-11');
const sha=v=>createHash('sha256').update(v).digest('hex');
const check=(v,code)=>{if(!v)throw Object.assign(new Error(code),{safeCode:code});};
const q=v=>{check(/^[a-z_][a-z0-9_]*$/.test(v),'production75_local_identifier');return `"${v}"`;};
const literal=v=>`'${v.replaceAll("'","''")}'`;
function fixtureSql(catalog) {
  const sql=[];
  for(const type of catalog.enums)sql.push(`CREATE TYPE public.${q(type.name)} AS ENUM(${type.labels.map(literal).join(',')});`);
  for(const table of catalog.tables){const columns=catalog.columns.filter(c=>c.table_name===table.name).sort((a,b)=>a.ordinal-b.ordinal);
    check(columns.every(c=>c.identity===''&&c.generated===''),'production75_local_unsupported_fixture');
    sql.push(`CREATE TABLE public.${q(table.name)}(${columns.map(c=>`${q(c.name)} ${c.formatted_type}${c.default_expression!==null?' DEFAULT '+c.default_expression:''}${c.nullable?'':' NOT NULL'}`).join(',')});`);
  }
  for(const c of catalog.constraints.filter(c=>c.kind!=='f'))sql.push(`ALTER TABLE public.${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`);
  const backed=new Set(catalog.constraints.filter(c=>['p','u','x'].includes(c.kind)).map(c=>`${c.table_name}.${c.name}`));
  check(backed.size===80,'production75_local_backed_index_mapping');
  for(const ix of catalog.indexes.filter(i=>!backed.has(`${i.table_name}.${i.name}`)))sql.push(`${ix.definition};`);
  for(const c of catalog.constraints.filter(c=>c.kind==='f'))sql.push(`ALTER TABLE public.${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`);
  return sql.join('\n');
}
async function docker(args,{allowFailure=false}={}) {
  let program='docker';if(process.platform==='win32'&&existsSync('C:/Forge/tools/local-dev/docker-wsl.mjs')){program=process.execPath;args=['C:/Forge/tools/local-dev/docker-wsl.mjs',...args];}
  return new Promise((done,reject)=>{const child=spawn(program,args,{cwd:root,env:localEnvironment(),windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',tooLarge=false;
    const timer=setTimeout(()=>{child.kill();reject({safeCode:'production75_local_docker_timeout'});},60000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>2*1024*1024){tooLarge=true;child.kill();}});child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject({safeCode:'production75_local_docker_unavailable'});});
    child.once('close',code=>{clearTimeout(timer);if(tooLarge||(code!==0&&!allowFailure))reject({safeCode:'production75_local_docker_failed'});else done({code,output:output.trim()});});
  });
}
function own(inspection,identity) {check(/^[a-f0-9]{64}$/.test(identity.id??'')&&inspection?.Name===`/${identity.name}`&&inspection?.Id===identity.id&&inspection.Config?.Labels?.['com.forge.local-test']===identity.runId&&inspection.Config?.Labels?.['com.forge.fixture-purpose']==='production75-local','production75_local_container_ownership');}
export function recordProduction75RunResponse(identity,output) {
  check(identity?.id===null&&typeof output==='string'&&/^[a-f0-9]{64}$/.test(output),'production75_local_run_response');
  identity.id=output;
}
/** Reconcile a lost create/run acknowledgment only through one exact-name
 * candidate with BOTH nonce/task labels. Removal always uses the verified ID,
 * never the mutable name. Any collision, malformed ID or ambiguity fails closed. */
export async function cleanupProduction75Container(identity,command=docker) {
  check(identity&&/^production75-local-\d+-[a-f0-9]{8}$/.test(identity.name??'')&&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.runId??'')&&
    identity.name.endsWith(`-${identity.runId.slice(0,8)}`)&&(identity.id===null||/^[a-f0-9]{64}$/.test(identity.id??''))&&typeof command==='function','production75_local_cleanup_identity');
  const inventory=async()=>{
    const output=(await command(['ps','--all','--quiet','--no-trunc','--filter',`name=^/${identity.name}$`])).output;
    check(typeof output==='string','production75_local_cleanup_inventory');
    const candidates=output.trim()?output.trim().split(/\r?\n/):[];
    check(candidates.length<=1&&candidates.every(id=>/^[a-f0-9]{64}$/.test(id)),'production75_local_cleanup_ambiguous');return candidates;
  };
  const candidates=await inventory();
  if(candidates.length===0)return{containerRemoved:true,idRecovered:false,containerAbsent:true};
  const records=JSON.parse((await command(['inspect',identity.name])).output);
  check(Array.isArray(records)&&records.length===1,'production75_local_cleanup_ambiguous');
  const inspection=records[0],recovered={...identity,id:identity.id??candidates[0]};
  check(inspection?.Id===candidates[0]&&(identity.id===null||identity.id===candidates[0]),'production75_local_container_ownership');
  own(inspection,recovered);
  const idRecovered=identity.id===null;identity.id=recovered.id;
  await command(['rm','--force',identity.id]);
  check((await inventory()).length===0,'production75_local_cleanup');
  return{containerRemoved:true,idRecovered,containerAbsent:false,removedId:identity.id};
}
function safeState(state){return{phase:state.phase,identity:state.identity,physicalSha256:catalogDigest(state.catalog,{physical:true}),logicalSha256:catalogDigest(state.catalog),fingerprints:state.fingerprints,policySha256:sha(JSON.stringify(state.policy)),defaults:state.defaults,newTables:state.newTables};}
function safeResult(result){const{before,after,...rest}=result;return{...rest,...(before?{before:safeState(before)}:{}),...(after?{after:safeState(after)}:{})};}
async function seed(admin) {
  for(let i=1;i<=2;i++) {
    const org=(await admin.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id',[`Fictional preserved tenant ${i}`,`synthetic-production75-${i}`])).rows[0].id;
    const user=`fictional-user-${i}`;await admin.query('INSERT INTO users(id,organization_id) VALUES($1,$2)',[user,org]);
    await admin.query("INSERT INTO org_settings(organization_id,business_profile,lead_scoring,ai_instructions) VALUES($1,$2,NULL,$3)",[org,JSON.stringify({fixture:true,service:'fictional',nested:{nullValue:null,labels:['one','two']}}),`Preserve Unicode Ω and quote ' ${i}`]);
    const contact=(await admin.query('INSERT INTO contacts(organization_id,first_name,last_name,do_not_contact_email) VALUES($1,$2,NULL,$3) RETURNING id',[org,`Fictional contact ${i}`,i===2])).rows[0].id;
    const lead=(await admin.query('INSERT INTO leads(organization_id,contact_id,score_reasons,summary) VALUES($1,$2,$3,$4) RETURNING id',[org,contact,JSON.stringify([{reason:'synthetic',score:i}]),i===1?'Preserved active work':null])).rows[0].id;
    await admin.query('INSERT INTO lead_imports(organization_id,file_name,total_rows,errors) VALUES($1,$2,$3,$4)',[org,`fictional-${i}.csv`,i*7,JSON.stringify([{row:i,message:'fictional historical import error'}])]);
    await admin.query('INSERT INTO estimates(organization_id,lead_id,title,line_items,total_cents,notes) VALUES($1,$2,$3,$4,$5,NULL)',[org,lead,`Preserved estimate ${i}`,JSON.stringify([{name:'fictional work',quantity:2}]),i*13579]);
    await admin.query('INSERT INTO projects(organization_id,lead_id,name,crew_notes) VALUES($1,$2,$3,$4)',[org,lead,`Preserved project ${i}`,i===1?'Keep historical note':null]);
    for(const status of ['pending','failed','done'])await admin.query("INSERT INTO scheduled_actions(organization_id,action,context,run_at,status,attempts,last_error) VALUES($1,$2,$3,'2026-01-02T03:04:05Z',$4,$5,$6)",[org,JSON.stringify({type:'synthetic-held-effect'}),JSON.stringify({unknownExternalOutcome:status==='failed',fixture:true}),status,status==='failed'?1:0,status==='failed'?'Synthetic unknown effect: never replay':null]);
  }
}
async function runLocal() {
  const runId=randomUUID(),name=`production75-local-${process.pid}-${runId.slice(0,8)}`,identity={runId,name,id:null};
  const journalDirectory=resolve(directory,'journals',runId);await mkdir(journalDirectory,{recursive:true});
  const files=PINNED_FILES.map(pin=>({...pin,bytes:execFileSync('git',['show',`${SOURCE_COMMIT}:${pin.path}`],{cwd:root,env:localEnvironment(),windowsHide:true,maxBuffer:2*1024*1024})}));
  const source=buildProduction75Source(files),canonical95=JSON.parse(await readFile(resolve(root,'reports/staging-observation-2026-10-10/fixtures/catalog-95.json'))),canonical142=JSON.parse(await readFile(resolve(root,'reports/staging-observation-2026-10-10/fixtures/catalog-142.json')));
  await writeFile(resolve(directory,'source-manifest.json'),JSON.stringify({...source,steps:source.steps.map(({sql:_sql,...s})=>s)},null,2)+'\n');
  await writeFile(resolve(directory,'selected-0000-bridge.sql'),source.steps[0].sql);
  const coreFiles=['production75-core.mjs','production75-source.mjs','production75-pins.mjs','production75-local.mjs'];
  const sourceHashes=Object.fromEntries(await Promise.all(coreFiles.map(async f=>[f,sha(await readFile(resolve(root,'scripts',f)))])));
  const receipt={kind:'LOCAL_POSTGRES16_PRODUCTION75_REHEARSAL',startedAt:new Date().toISOString(),runId,sourceCommit:SOURCE_COMMIT,sourceHashes,status:'FAILED',hostedAccess:false,rawRowsRecorded:false,variants:{},checks:{},cleanup:{clientsClosed:0,socketsClosed:0,containerRemoved:false}};
  const clients=[];let created=false,error,stage='image';
  try {
    const image=JSON.parse((await docker(['image','inspect','postgres:16-alpine'])).output)[0];check(/^sha256:[a-f0-9]{64}$/.test(image?.Id??''),'production75_local_image');receipt.imageId=image.Id;
    // Real daemon creation followed by an intentionally discarded acknowledgment
    // exercises the unknown-ID path without any database, credential or port.
    const lostRunId=randomUUID(),lostIdentity={runId:lostRunId,name:`production75-local-${process.pid}-${lostRunId.slice(0,8)}`,id:null};let lostAttempted=false;
    try {
      lostAttempted=true;await docker(['run','--detach','--rm','--pull=never','--name',lostIdentity.name,'--label',`com.forge.local-test=${lostRunId}`,'--label','com.forge.fixture-purpose=production75-local','--network','none','--read-only','--memory','64m','--cpus','0.1',image.Id,'sleep','300']);
      throw Object.assign(new Error('production75_local_synthetic_run_response_lost'),{safeCode:'production75_local_synthetic_run_response_lost'});
    } catch(caught){check(caught.safeCode==='production75_local_synthetic_run_response_lost','production75_local_lost_run_probe');}
    finally {if(lostAttempted)receipt.lostRunResponseCleanup={name:lostIdentity.name,...await cleanupProduction75Container(lostIdentity)};}
    receipt.checks.lostRunResponseRecovered=receipt.lostRunResponseCleanup?.containerRemoved===true&&receipt.lostRunResponseCleanup?.idRecovered===true;
    check(receipt.checks.lostRunResponseRecovered,'production75_local_lost_run_cleanup');
    created=true;
    const runResponse=await docker(['run','--detach','--rm','--pull=never','--name',name,'--label',`com.forge.local-test=${runId}`,'--label','com.forge.fixture-purpose=production75-local','--memory','1g','--cpus','2','--publish','127.0.0.1::5432','--env','POSTGRES_USER=postgres','--env','POSTGRES_PASSWORD=fictional-local-admin','--env','POSTGRES_DB=production75_control',image.Id]);
    // Invalid/empty acknowledgments keep id=null so owned cleanup can recover.
    recordProduction75RunResponse(identity,runResponse.output);
    own(JSON.parse((await docker(['inspect',name])).output)[0],identity);receipt.container={name,id:identity.id};
    const port=parseLoopbackPort((await docker(['port',name,'5432/tcp'])).output);receipt.loopback={host:'127.0.0.1',port};
    // The image's initialization server uses only a Unix socket and then exits.
    // Require TCP readiness so a temporary startup server cannot satisfy this.
    let ready=false;for(let i=0;i<30;i++){if((await docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','production75_control'],{allowFailure:true})).code===0){ready=true;break;}await new Promise(done=>setTimeout(done,500));}check(ready,'production75_local_ready');
    const require=createRequire(resolve(root,'artifacts/api-server/package.json')),{Client}=require('pg');
    const connect=async(database,user='postgres')=>{const client=new Client({host:'127.0.0.1',port,database,user,password:user==='postgres'?'fictional-local-admin':user==='production75-writer'?'fictional-local-writer':'fictional-local-reader',ssl:false,application_name:'production75-owned-local',connectionTimeoutMillis:10000,query_timeout:35000,statement_timeout:30000,idle_in_transaction_session_timeout:30000});client.on('error',()=>{});clients.push(client);await client.connect();return client;};
    stage='control-connect';const control=await connect('production75_control');stage='roles';
    await control.query(`CREATE ROLE production75_owner NOLOGIN; CREATE ROLE "production75-writer" LOGIN PASSWORD 'fictional-local-writer'; GRANT production75_owner TO "production75-writer"; ALTER ROLE "production75-writer" SET role TO production75_owner;
      CREATE ROLE "production75-reader" LOGIN PASSWORD 'fictional-local-reader'; GRANT pg_read_all_data TO "production75-reader"; CREATE ROLE production75_rogue NOLOGIN;`);
    for(const [variant,database] of [['fly-db','production75_fly_db'],['growthos_staging','production75_legacy']]) {
      stage=`${variant}-fixture`;const catalog75=JSON.parse(await readFile(resolve(directory,`catalog75-${variant}.json`)));
      const expected=deriveProduction75Catalogs(catalog75,canonical95,canonical142);
      await control.query(`CREATE DATABASE ${q(database)}`);const admin=await connect(database);
      await admin.query(`ALTER SCHEMA public OWNER TO production75_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMP ON DATABASE ${q(database)} FROM PUBLIC; SET ROLE production75_owner; SET search_path=public,pg_catalog; SET timezone='UTC'`);
      const fixture=fixtureSql(catalog75);await writeFile(resolve(directory,`fixture75-${variant}.sql`),fixture);await admin.query(fixture);
      const actual75=await collectSchemaCatalog(admin);check(isDeepStrictEqual(actual75,catalog75),'production75_local_fixture_catalog');
      // Begin with explicit owner ACLs so GRANT/REVOKE negatives return to an
      // exactly representable baseline (NULL ACL would become an explicit ACL).
      await admin.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO production75_owner; GRANT SELECT(name) ON organizations TO production75_owner');
      await admin.query('RESET ROLE');await seed(admin);
      const target={database,writerLogin:'production75-writer',writerInitialRoles:['production75-writer','production75_owner'],writerRole:'production75_owner',readerLogin:'production75-reader',readerRole:'production75-reader',principals:['production75-reader','production75-writer']};
      const policy75=await captureProduction75Policy(admin,target.principals);
      // Independent oracle transaction creates the source-defined schema then rolls
      // back; its full catalog is checked against canonical logical definitions
      // and actual retained ordinals before becoming an executor expectation.
      await admin.query('BEGIN; SET LOCAL ROLE production75_owner');
      for(const step of source.steps.slice(0,3))await admin.query(step.sql);
      const actual95=await collectSchemaCatalog(admin);check(isDeepStrictEqual(actual95,expected.catalog95),'production75_local_catalog95');const policy95=await captureProduction75Policy(admin,target.principals);
      for(const step of source.steps.slice(3))await admin.query(step.sql);
      const actual142=await collectSchemaCatalog(admin);check(isDeepStrictEqual(actual142,expected.catalog142),'production75_local_catalog142');const policy142=await captureProduction75Policy(admin,target.principals);await admin.query('ROLLBACK');
      await writeFile(resolve(directory,`catalog95-${variant}.json`),JSON.stringify(actual95,null,2)+'\n');await writeFile(resolve(directory,`catalog142-${variant}.json`),JSON.stringify(actual142,null,2)+'\n');
      const input={source,catalog75,canonical95,canonical142,target,policy75,policy95,policy142};const newPlan=until=>prepareProduction75({...input,until:until??142});
      const capture=async(plan)=>{const reader=await connect(database,'production75-reader');await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off");try{return await captureProduction75State(reader,plan);}finally{check((await reader.query('ROLLBACK')).command==='ROLLBACK','production75_local_reader_rollback');}};
      const baseline=await capture(newPlan()),entry={baseline:safeState(baseline),cases:{},checks:{}};receipt.variants[variant]=entry;
      const run=async(label,{until=142,outcome='rollback',inject}={})=>{const plan=newPlan(until),client=await connect(database,'production75-writer'),path=resolve(journalDirectory,`${variant}-${label}.jsonl`),fd=openSync(path,'wx');let dispatches=[];
        const wrapped={connection:client.connection,query:async(...args)=>{dispatches.push(args[0]);return inject?inject(args,client,plan):client.query(...args);}};
        try{const result=await executeProduction75(wrapped,{plan,expectedBefore:baseline,outcome,persist:async event=>{writeSync(fd,JSON.stringify(event)+'\n');fsyncSync(fd);}});entry.cases[label]={...safeResult(result),journal:`journals/${runId}/${variant}-${label}.jsonl`};return{result,plan,client,dispatches};}finally{closeSync(fd);}};
      const restored=async()=>{const after=await capture(newPlan());check(isDeepStrictEqual(after.catalog,baseline.catalog)&&isDeepStrictEqual(after.fingerprints,baseline.fingerprints)&&isDeepStrictEqual(after.policy,baseline.policy),'production75_local_rollback_preservation');};
      const refusal=async(label,mutate,repair)=>{await admin.query(mutate);const{result}=await run(label);check(result.status==='failed'&&result.stepsAcknowledged===0&&result.rollbackAcknowledged&&!result.commitDispatched,'production75_local_negative');await admin.query(repair);await restored();entry.checks[label]=true;};
      await refusal('same-count-data',"UPDATE organizations SET name='Fictional altered value' WHERE slug='synthetic-production75-1'","UPDATE organizations SET name='Fictional preserved tenant 1' WHERE slug='synthetic-production75-1'");
      await refusal('column-type','ALTER TABLE contacts ALTER COLUMN first_name TYPE varchar','ALTER TABLE contacts ALTER COLUMN first_name TYPE text');
      await refusal('column-default',"ALTER TABLE organizations ALTER COLUMN name SET DEFAULT 'drift'",'ALTER TABLE organizations ALTER COLUMN name DROP DEFAULT');
      await refusal('new-table-collision','CREATE TABLE service_obligations(id text)','DROP TABLE service_obligations');
      await refusal('table-acl','GRANT SELECT ON organizations TO production75_rogue','REVOKE SELECT ON organizations FROM production75_rogue');
      await refusal('column-acl','GRANT SELECT(name) ON organizations TO production75_rogue','REVOKE SELECT(name) ON organizations FROM production75_rogue');
      await refusal('reader-permission','REVOKE pg_read_all_data FROM "production75-reader"','GRANT pg_read_all_data TO "production75-reader"');
      const wrongOrdinal=structuredClone(catalog75);wrongOrdinal.columns.find(c=>c.table_name==='users'&&c.name==='id').ordinal=999;
      let refused=false;try{prepareProduction75({...input,catalog75:wrongOrdinal});}catch{refused=true;}check(refused,'production75_local_ordinal_negative');entry.checks['physical-ordinal-input']=true;
      for(const [label,until] of [['bridge-rollback',95],['full-rollback',142]]){const{result}=await run(label,{until});check(result.status==='rehearsed-rolled-back'&&result.stepsAcknowledged===(until===95?3:19),'production75_local_rehearsal');await restored();entry.checks[label]=true;}
      for(const [label,until,step] of [['late-bridge-error',95,2],['late-0018-error',142,18]]){const{result}=await run(label,{until,inject:(args,client,plan)=>args[0]===plan.steps[step].sql?client.query('SELECT 1/0'):client.query(...args)});check(result.status==='failed'&&result.stepsAcknowledged===step&&result.rollbackAcknowledged&&!result.commitDispatched,'production75_local_late_failure');await restored();entry.checks[label]=true;}
      // Wrong target/role and journal failure must refuse before migration SQL.
      const wrong=await run('wrong-target',{inject:async(args,client)=>{const value=await client.query(...args);if(args[0].includes('current_database() AS database'))value.rows[0].database='fictional-wrong-target';return value;}});check(wrong.result.status==='failed'&&wrong.result.stepsAcknowledged===0&&wrong.dispatches.length===1,'production75_local_wrong_target');entry.checks['wrong-target']=true;
      // A transaction-created unauthorized grant is caught at complete precommit
      // policy verification, despite valid old-table and schema fingerprints.
      const newGrant=await run('new-table-grant',{inject:async(args,client,plan)=>{const answer=await client.query(...args);if(args[0]===plan.steps.at(-1).sql)await client.query('GRANT SELECT ON staff_lead_alert_coverage TO production75_rogue');return answer;}});
      check(newGrant.result.status==='failed'&&newGrant.result.stepsAcknowledged===19&&newGrant.result.rollbackAcknowledged&&!newGrant.result.commitDispatched,'production75_local_new_grant');await restored();entry.checks['new-table-grant']=true;
      if(variant==='fly-db')for(const [caseName,until,loseCommit] of [['bridge-commit',95,false],['lost-commit',142,true]]) {
        const specialDatabase=`production75_${caseName.replaceAll('-','_')}`;
        await control.query(`CREATE DATABASE ${q(specialDatabase)}`);const specialAdmin=await connect(specialDatabase);
        await specialAdmin.query(`ALTER SCHEMA public OWNER TO production75_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMP ON DATABASE ${q(specialDatabase)} FROM PUBLIC; SET ROLE production75_owner; SET search_path=public,pg_catalog; SET timezone='UTC'`);
        await specialAdmin.query(fixture);await specialAdmin.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO production75_owner; GRANT SELECT(name) ON organizations TO production75_owner; RESET ROLE');await seed(specialAdmin);
        const specialTarget={...target,database:specialDatabase},special75=await captureProduction75Policy(specialAdmin,target.principals);
        await specialAdmin.query('BEGIN; SET LOCAL ROLE production75_owner');for(const step of source.steps.slice(0,3))await specialAdmin.query(step.sql);const special95=await captureProduction75Policy(specialAdmin,target.principals);
        for(const step of source.steps.slice(3))await specialAdmin.query(step.sql);const special142=await captureProduction75Policy(specialAdmin,target.principals);await specialAdmin.query('ROLLBACK');
        const specialInput={...input,target:specialTarget,policy75:special75,policy95:special95,policy142:special142,until};
        const plan=prepareProduction75(specialInput),captureSpecial=async()=>{const reader=await connect(specialDatabase,'production75-reader');await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off");try{return await captureProduction75State(reader,plan);}finally{await reader.query('ROLLBACK');}};
        const specialBaseline=await captureSpecial(),specialWriter=await connect(specialDatabase,'production75-writer'),dispatches=[],fd=openSync(resolve(journalDirectory,`${variant}-${caseName}.jsonl`),'wx');
        const wrapped={connection:specialWriter.connection,query:async(...args)=>{dispatches.push(args[0]);const answer=await specialWriter.query(...args);if(loseCommit&&args[0]==='COMMIT')throw new Error('synthetic lost acknowledgment');return answer;}};
        let result;try{result=await executeProduction75(wrapped,{plan,expectedBefore:specialBaseline,outcome:'commit',persist:async event=>{writeSync(fd,JSON.stringify(event)+'\n');fsyncSync(fd);}});}finally{closeSync(fd);}
        check(result.status===(loseCommit?'commit-unknown':'committed-awaiting-reader')&&result.commitDispatched&&result.commitAcknowledged===!loseCommit&&dispatches.filter(sql=>sql==='COMMIT').length===1&&!dispatches.includes('ROLLBACK'),'production75_local_special_commit');
        const specialReader=await captureSpecial(),verified=verifyProduction75Reader(result,specialReader,plan);check(verified.status===(loseCommit?'reconciled-committed-no-replay':'verified'),'production75_local_special_reader');
        const anotherWriter=await connect(specialDatabase,'production75-writer');let replayRefused=false;
        try{await executeProduction75(anotherWriter,{plan,expectedBefore:specialBaseline,outcome:'commit',persist:async()=>{}});}catch(e){replayRefused=e.safeCode==='production75_attempt_already_used';}
        check(replayRefused,'production75_local_special_replay');
        // Even a newly prepared object with the stale75 expectation cannot replay
        // committed SQL: actual catalog comparison fails before its first step.
        const stale=await executeProduction75(anotherWriter,{plan:prepareProduction75(specialInput),expectedBefore:specialBaseline,outcome:'commit',persist:async()=>{}});
        check(stale.status==='failed'&&stale.stepsAcknowledged===0&&stale.rollbackAcknowledged&&!stale.commitDispatched,'production75_local_stale_replay');
        entry.cases[caseName]={...safeResult(result),freshReader:safeState(specialReader),verified,planReplayRefused:replayRefused,stalePlanReplayRefused:true,commitDispatches:1,journal:`journals/${runId}/${variant}-${caseName}.jsonl`};entry.checks[caseName]=true;
      }
      const committed=await run('commit',{outcome:'commit'});check(committed.result.status==='committed-awaiting-reader'&&committed.result.stepsAcknowledged===19&&committed.result.commitAcknowledged,'production75_local_commit');
      const reader=await capture(committed.plan);entry.freshReader=safeState(reader);entry.verified=verifyProduction75Reader(committed.result,reader,committed.plan);entry.checks.commit=true;entry.checks.freshReader=entry.verified.status==='verified';
      await writeFile(resolve(directory,`local-policy-${variant}.json`),JSON.stringify({target,policy75,policy95,policy142},null,2)+'\n');
      entry.checks.syntheticRows=baseline.fingerprints.filter(r=>r.rows>0).length===9&&baseline.fingerprints.reduce((n,r)=>n+r.rows,0)===22;
      check(Object.values(entry.checks).every(Boolean),'production75_local_checks');
    }
  } catch(caught){error=caught;receipt.failureDetail={stage,name:caught.name,code:caught.code,safeCode:caught.safeCode,stackLocation:caught.stack?.split('\n')[1]?.replace(root,'WORKTREE')};}
  finally {
    receipt.cleanup.expectedClients=clients.length;
    for(const client of clients){let timer;try{await Promise.race([client.end(),new Promise((_,reject)=>{timer=setTimeout(()=>{client.connection?.stream?.destroy();reject(new Error('end-timeout'));},5000);})]);receipt.cleanup.clientsClosed++;if(!client.connection?.stream||client.connection.stream.destroyed)receipt.cleanup.socketsClosed++;}catch{error={safeCode:'production75_local_client_cleanup'};}finally{clearTimeout(timer);}}
    if(created)try{Object.assign(receipt.cleanup,await cleanupProduction75Container(identity));}catch{error={safeCode:'production75_local_container_cleanup'};}
  }
  receipt.sourceHashesAfter=Object.fromEntries(await Promise.all(coreFiles.map(async f=>[f,sha(await readFile(resolve(root,'scripts',f)))])));
  receipt.checks.sourceUnchanged=isDeepStrictEqual(receipt.sourceHashesAfter,sourceHashes);
  receipt.checks.cleanup=receipt.cleanup.clientsClosed===clients.length&&receipt.cleanup.socketsClosed===clients.length&&receipt.cleanup.containerRemoved;
  if(!Object.values(receipt.checks).every(Boolean))error={safeCode:'production75_local_cleanup_or_source'};
  receipt.finishedAt=new Date().toISOString();receipt.status=error?'FAILED':'PASS';if(error)receipt.failureCode=/^production75_[a-z_]+$/.test(error.safeCode??'')?error.safeCode:'production75_local_failed';
  await writeFile(resolve(directory,`local-${runId}.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});await writeFile(resolve(directory,'local-acceptance.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
}
export async function main(args=process.argv.slice(2)){check(args.length===1&&args[0]==='--run-local','production75_local_explicit_action');return withWslDockerSession(runLocal);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(r=>{console.log(JSON.stringify({status:r.status,failureCode:r.failureCode,failureDetail:r.failureDetail,checks:r.checks,variants:Object.fromEntries(Object.entries(r.variants).map(([k,v])=>[k,{checks:v.checks,verified:v.verified}])),cleanup:r.cleanup}));if(r.status!=='PASS')process.exitCode=1;}).catch(e=>{console.error(/^production75_[a-z_]+$/.test(e.safeCode??'')?e.safeCode:'production75_local_failed');process.exitCode=1;});
