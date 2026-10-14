/** Synthetic local recovery only. Actual scheduling decisions come from the built app. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { readVerifiedSchedulingPredecessors, verifySqlPin } from './saved-scheduling-schema-preview.mjs';

export const SCHEDULING_PRODUCTION_BASE = '5f80131a0d4b91be2e55d4eeb3d9145a99bf822c';
export const SCHEDULING_PRODUCTION_TREE = 'effe897dd5531c21b24360522d8a76520a43a466';
const root = fileURLToPath(new URL('../', import.meta.url));
export const schedulingHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const ident = value => { assert.match(value,/^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
const plain = value => JSON.parse(JSON.stringify(value));
const uuid = value => { const h=schedulingHash(`scheduling-recovery-v1:${value}`); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
export const schedulingIds = label => Object.fromEntries(['org','owner','tech','contact','property','lead','legacyAppointment','legacyProject','task','service','binding','policy','policyReview','call','callTask','handoff','intake'].map(key=>[key,uuid(`${label}:${key}`)]));
const token = label => schedulingHash(`synthetic-scheduling-session:${label}`);
const review = (context,duration={kind:'explicit',preset:null}) => ({context,duration,startWallTime:null,endWallTime:null});
const rawTables = ['org_settings','appointments','projects','audit_events','customer_work_roots','customer_work_commands','crm_tasks','scheduled_actions','service_obligations','callie_intakes','missed_call_handoffs','twilio_calls'];

export async function applySchedulingRecoveryDelta(database,executed) {
  const verified=await readVerifiedSchedulingPredecessors();
  const predecessors=await Promise.all(verified.predecessors.map(async pin=>({ ...pin,
    gitBlob:execFileSync('git',['rev-parse',`${SCHEDULING_PRODUCTION_BASE}:${pin.path}`],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
    checkoutSha256:schedulingHash(await readFile(new URL(`../${pin.path}`,import.meta.url))),
  })));
  assert.equal(executed.baseSha256,schedulingHash(verified.buffers.slice(0,2).map(b=>b.toString('utf8')).join('\n')));
  for(const [index,pin] of predecessors.entries()) {
    if(index>=2) assert.equal(executed.migrations[index-2].sha256,pin.gitBlobSha256);
    pin.executedSha256=pin.gitBlobSha256;
  }
  const path='reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql';
  const bytes=execFileSync('git',['show',`${SCHEDULING_PRODUCTION_BASE}:${path}`],{cwd:root,windowsHide:true});
  const checkout=await readFile(new URL(`../${path}`,import.meta.url));
  verifySqlPin({path,gitBlobBytes:bytes.length,gitBlobSha256:schedulingHash(bytes)},checkout,bytes);
  const columns=(await database.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const tables=[...new Set(columns.map(r=>r.table_name))].sort(); assert.equal(tables.length,142);
  const oldRows={};
  for (const table of tables) oldRows[table]=(await database.query(`SELECT to_jsonb(t) AS row FROM ${ident(table)} t ORDER BY to_jsonb(t)::text`)).rows;
  const catalogSql="SELECT c.relname AS table_name,k.conname,k.contype,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname";
  const constraints=(await database.query(catalogSql)).rows;
  await database.exec(bytes.toString('utf8'));
  const additions=[['appointments','scheduling_reservation'],['org_settings','scheduling_policy'],['projects','scheduling_reservation']];
  const after=(await database.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const added=after.filter(a=>!columns.some(b=>a.table_name===b.table_name&&a.column_name===b.column_name));
  assert.deepEqual(added.map(r=>[r.table_name,r.column_name]),additions);
  for(const row of added) assert.deepEqual([row.data_type,row.is_nullable,row.column_default],['jsonb','YES',null]);
  assert.deepEqual(after.filter(a=>!added.includes(a)),columns);
  const newConstraints=(await database.query(catalogSql)).rows;
  const checks=additions.map(([table,column])=>`${table}_${column}_ck`);
  assert.deepEqual(newConstraints.filter(c=>!checks.includes(c.conname)),constraints);
  assert.deepEqual(newConstraints.filter(c=>checks.includes(c.conname)).map(c=>c.contype),['c','c','c']);
  for (const table of tables) {
    const field=additions.find(a=>a[0]===table)?.[1];
    const expression=field?`to_jsonb(t)-'${field}'`:'to_jsonb(t)';
    assert.deepEqual((await database.query(`SELECT ${expression} AS row FROM ${ident(table)} t ORDER BY (${expression})::text`)).rows,oldRows[table]);
    if(field) assert.equal((await database.query(`SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${ident(field)} IS NOT NULL`)).rows[0].n,0);
  }
  const delta={path,gitBlob:execFileSync('git',['rev-parse',`${SCHEDULING_PRODUCTION_BASE}:${path}`],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),gitBlobBytes:bytes.length,gitBlobSha256:schedulingHash(bytes),checkoutSha256:schedulingHash(checkout),executedSha256:schedulingHash(bytes)};
  return {priorRowsUnchanged:true,priorCatalogUnchanged:true,tableCount:142,addedColumns:additions.map(a=>a.join('.')),predecessors,baseExecutedSha256:executed.baseSha256,delta,schemaSha256:schedulingHash({columns:after,constraints:newConstraints}),sqlSha256:schedulingHash([...predecessors,delta])};
}

export async function seedSchedulingPrerequisites(database) {
  const stamp=new Date().toISOString();
  for(const label of ['main','disabled','legacy']) {
    const id=schedulingIds(label);
    await database.query("INSERT INTO organizations(id,name,slug,timezone) VALUES($1,'SYNTHETIC scheduling recovery',$2,'UTC')",[id.org,`synthetic-scheduling-recovery-${label}`]);
    await database.query('INSERT INTO org_settings(organization_id,scheduling_policy) VALUES($1,NULL)',[id.org]);
    for(const user of [id.owner,id.tech]) await database.query("INSERT INTO users(id,organization_id,role,is_active,email,email_verified_at,first_name) VALUES($1,$2,'owner',true,$3,$4,'Synthetic scheduling')",[user,id.org,`${user}@example.invalid`,stamp]);
    await database.query("INSERT INTO contacts(id,organization_id,first_name,phone) VALUES($1,$2,'Synthetic recovery customer','+12025550123')",[id.contact,id.org]);
    await database.query("INSERT INTO properties(id,organization_id,contact_id,address_line_1,city,state,postal_code) VALUES($1,$2,$3,'1 Synthetic Lane','Example','GA','00000')",[id.property,id.org,id.contact]);
    await database.query("INSERT INTO leads(id,organization_id,contact_id) VALUES($1,$2,$3)",[id.lead,id.org,id.contact]);
    await database.query('INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,$3)',[token(label),JSON.stringify({user:{id:id.owner,email:`${id.owner}@example.invalid`,firstName:'Synthetic',lastName:'Recovery',profileImageUrl:null},access_token:'synthetic-no-provider'}),new Date(Date.now()+86400000)]);
    await database.query('INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,$3)',[token(`${label}-tech`),JSON.stringify({user:{id:id.tech,email:`${id.tech}@example.invalid`,firstName:'Synthetic',lastName:'Recovery',profileImageUrl:null},access_token:'synthetic-no-provider'}),new Date(Date.now()+86400000)]);
    await database.query("INSERT INTO appointments(id,organization_id,contact_id,type,status,scheduled_start,scheduled_end,scheduling_reservation) VALUES($1,$2,$3,'other','scheduled','2026-01-01T10:00:00Z',NULL,NULL)",[id.legacyAppointment,id.org,id.contact]);
    await database.query("INSERT INTO projects(id,organization_id,lead_id,name,status,scheduled_start,scheduled_end,scheduling_reservation) VALUES($1,$2,$3,'Synthetic legacy job','scheduled','2026-01-01T10:00:00Z',NULL,NULL)",[id.legacyProject,id.org,id.lead]);
  }
  const id=schedulingIds('main');
  await database.query("INSERT INTO crm_tasks(id,organization_id,contact_id,title,assigned_user_id) VALUES($1,$2,$3,'Synthetic service task',$4)",[id.task,id.org,id.contact,id.owner]);
  await database.query("INSERT INTO service_obligations(id,organization_id,contact_id,property_id,task_id,kind,equipment_label,due_at,updated_at) VALUES($1,$2,$3,$4,$5,'maintenance','Synthetic equipment',$6,$7)",[id.service,id.org,id.contact,id.property,id.task,new Date(Date.now()+86400000*30),stamp]);
  const {buildCalliePolicySnapshot,DEFAULT_CALLIE_POLICY}=await tsImport('../artifacts/api-server/src/services/callie-contract.ts',import.meta.url);
  const binding={id:id.binding,accountSid:`AC${schedulingHash('synthetic-recovery-call').slice(0,32)}`,sender:'+12025550199',messagingServiceSid:`MG${schedulingHash('synthetic-recovery-service').slice(0,32)}`,disclosureVersion:'synthetic.v1',origin:'https://example.invalid',businessName:'Synthetic recovery'};
  await database.query('INSERT INTO twilio_client_bindings(id,organization_id,account_sid,phone_number,messaging_service_sid,auth_token_secret_ref,public_origin,business_name,sms_disclosure_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id.binding,id.org,binding.accountSid,binding.sender,binding.messagingServiceSid,'SYNTHETIC_NEVER_CONFIGURED',binding.origin,binding.businessName,binding.disclosureVersion]);
  const snapshot=buildCalliePolicySnapshot({...DEFAULT_CALLIE_POLICY,enabled:false,businessHoursOwnerId:id.owner,afterHoursOwnerId:id.owner},binding);
  await database.query("INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,'callie.policy.previewed','organization',$2,'{\"synthetic\":true}')",[id.policyReview,id.org,id.owner]);
  await database.query('INSERT INTO callie_policy_revisions(id,organization_id,version,enabled,snapshot,review_id,review_payload_hash,approved_by_user_id) VALUES($1,$2,1,false,$3,$4,$5,$6)',[id.policy,id.org,JSON.stringify(snapshot),id.policyReview,schedulingHash(snapshot),id.owner]);
  await database.query("INSERT INTO twilio_calls(id,organization_id,request_key,direction,phone,staff_phone,account_sid,provider_sid,dial_status,authorization_source) VALUES($1,$2,$3,'inbound','+12025550123',$4,$5,$6,'no-answer','signed-inbound')",[id.call,id.org,uuid('call-request'),binding.sender,binding.accountSid,`CA${schedulingHash('call').slice(0,32)}`]);
  await database.query("INSERT INTO crm_tasks(id,organization_id,title,assigned_user_id,source_event) VALUES($1,$2,'Synthetic caller review',$3,'voice.missed_call')",[id.callTask,id.org,id.owner]);
  await database.query('INSERT INTO missed_call_handoffs(id,organization_id,call_id,task_id) VALUES($1,$2,$3,$4)',[id.handoff,id.org,id.call,id.callTask]);
  await database.query("INSERT INTO callie_intakes(id,organization_id,call_id,policy_revision_id,binding_id,account_sid,provider_call_sid,from_phone,called_number,owner_user_id,due_at,stage,state,service_intent,request_intent,callback_window,reason) VALUES($1,$2,$3,$4,$5,$6,$7,'+12025550123',$8,$9,$10,'complete','blocked','maintenance','visit','morning','caller_declined_text')",[id.intake,id.org,id.call,id.policy,id.binding,binding.accountSid,`CA${schedulingHash('call').slice(0,32)}`,binding.sender,id.owner,stamp]);
}

export async function captureSchedulingState(database) {
  const organizations=['main','disabled','legacy'].map(label=>schedulingIds(label).org), result={};
  for(const table of rawTables) result[table]=(await database.query(`SELECT to_jsonb(t) AS row FROM ${ident(table)} t WHERE organization_id=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,[organizations])).rows.map(r=>r.row);
  return plain(result);
}
async function assertLegacyCompatibility(database) {
  const {effectiveReservation}=await tsImport('../lib/scheduling-core/src/index.ts',import.meta.url);
  const id=schedulingIds('legacy');
  assert.equal((await database.query('SELECT scheduling_policy IS NULL AS sql_null FROM org_settings WHERE organization_id=$1',[id.org])).rows[0].sql_null,true);
  for(const [kind,target] of [['appointment',id.legacyAppointment],['project',id.legacyProject]]) {
    const table=kind==='appointment'?'appointments':'projects';
    const row=(await database.query(`SELECT * FROM ${table} WHERE id=$1`,[target])).rows[0];
    assert.equal(row.scheduling_reservation,null);assert.equal(row.scheduled_end,null);
    const effective=effectiveReservation({kind,id:target,startAt:new Date(row.scheduled_start).toISOString(),endAt:null,resourceUserIds:kind==='appointment'?(row.assigned_user_id?[row.assigned_user_id]:[]):row.crew_user_ids,type:kind==='appointment'?row.type:'project',status:row.status,source:{sourceKind:kind==='appointment'?'direct_customer':'lead',leadId:kind==='project'?row.lead_id:null,contactId:kind==='appointment'?row.contact_id:null,propertyId:null,estimateId:null},reservation:null});
    assert.equal(Date.parse(effective.endAt)-Date.parse(effective.startAt),(kind==='appointment'?2:24)*3600000);
    assert.equal(effective.savedGapMinutes,0);
  }
}
async function writeState(database) {
  const tables=(await database.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
  const out={};
  for(const {table_name:table} of tables) out[table]=(await database.query(`SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),',' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash,count(*)::int AS count FROM ${ident(table)} t`)).rows[0];
  return out;
}
async function replayBaseline(database) {
  return {tables:await writeState(database),rates:(await database.query('SELECT * FROM rate_limit_counters ORDER BY key')).rows};
}
async function assertReplayWrites(database,before) {
  const after=await writeState(database);
  for(const [table,value] of Object.entries(after)) if(table!=='rate_limit_counters') {
    globalThis.__contractorProbeStep=`original_replay_unchanged_${table}`;
    assert.deepEqual(value,before.tables[table]);
  }
  // CALLIE's real route counts every request, including an idempotent replay.
  // Bind the one permitted infrastructure change to this child and exact route.
  const key=`callie-book:127.0.0.1:test-${process.pid}`;
  const rates=(await database.query('SELECT * FROM rate_limit_counters ORDER BY key')).rows;
  globalThis.__contractorProbeStep='original_replay_exact_callie_rate_counter';
  assert.deepEqual(rates.filter(r=>r.key!==key),before.rates.filter(r=>r.key!==key));
  const previous=before.rates.find(r=>r.key===key),row=rates.find(r=>r.key===key);
  assert.ok(row); assert.equal(row.count,previous?previous.count+1:1);
  if(previous) assert.deepEqual(row.reset_at,previous.reset_at);
  else assert.ok(Date.parse(row.reset_at)>Date.now()&&Date.parse(row.reset_at)<=Date.now()+60000);
}
function apiClient(origin,label) {
  return async(method,path,body,status=200)=>{
    globalThis.__contractorProbeStep=`${method}_${path.split('?')[0].replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g,'target')}`.toLowerCase().replace(/[^a-z0-9_]/g,'_');
    const response=await fetch(`${origin}/api/v1${path}`,{method,headers:{authorization:`Bearer ${token(label)}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=response.status===204?null:await response.json();
    assert.equal(response.status,status,`scheduling API ${method} ${path} ${data?.code??data?.error??''}`);
    return data;
  };
}
async function currentReview(api,id,kind='appointment',extra={}) {
  const params=new URLSearchParams({sourceKind:kind==='project'?'lead':'direct_customer',sourceId:kind==='project'?id.lead:id.contact,reservationKind:kind,...(kind==='appointment'?{appointmentType:'other',propertyId:id.property}:{}),...extra});
  return api('GET',`/scheduling/review-context?${params}`);
}
async function savePolicy(api,gap,enabled,presets=[]) {
  const current=await api('GET','/settings/scheduling-policy');
  return api('PUT','/settings/scheduling-policy',{expectedRevision:current.context.policyRevision,expectedCompanyTimeZone:current.context.companyTimeZone,enabled,minimumTravelGapMinutes:gap,maxConcurrentReservations:null,durationPresets:presets});
}
async function manual(api,id,kind,start,extra={},duration) {
  const command={operationId:randomUUID(),kind:`${kind}_create`,body:{...(kind==='appointment'?{contactId:id.contact,propertyId:id.property,assignedUserId:id.owner,type:'other'}:{leadId:id.lead,name:'Synthetic saved-gap project',crewUserIds:[id.owner,id.tech]}),status:'scheduled',scheduledStart:new Date(start).toISOString(),scheduledEnd:new Date(start+3600000).toISOString(),...extra},review:review(await currentReview(api,id,kind),duration)};
  return command;
}
const wire=command=>({...command.body,operationId:command.operationId,schedulingReview:command.review});
const pathFor=command=>command.kind==='appointment_create'?'/appointments':'/projects';
async function createManual(api,command,status=201) { return api('POST',pathFor(command),wire(command),status); }
function stableExport(result) {
  assert.equal(result.manifest.tables.length,28);
  assert.equal(result.manifest.dataSha256,schedulingHash(result.data));
  assert.equal(result.manifest.schedulingPolicySha256,schedulingHash(result.organization.schedulingPolicy));
  assert.equal(result.manifest.schedulingHistorySha256,schedulingHash(result.organization.schedulingHistory));
  assert.equal(result.manifest.rowsPerTableLimit,2000); assert.equal(result.manifest.byteLimit,10*1024*1024);
  const serial=JSON.stringify({organization:result.organization,data:result.data});
  for(const key of ['payloadSha256','requestFingerprint','schedulingReview','sourcePolicyDigest','admittedByUserId','rawInvalidEvidence']) assert.equal(serial.includes(`"${key}"`),false,`private export field ${key}`);
  return {organization:result.organization,data:result.data,manifest:result.manifest};
}

export async function seedSchedulingThroughApp(origin,database) {
  const commands=[], api=apiClient(origin,'main'), id=schedulingIds('main');
  const day=Math.floor(Date.now()/86400000)*86400000+30*86400000;
  const policy=await savePolicy(api,60,true,[{id:null,label:'Synthetic original hour',elapsedMinutes:60}]);
  const oldAppointment=await manual(api,id,'appointment',day+9*3600000,{}, {kind:'preset',preset:policy.policy.durationPresets[0]});
  const appointment=await createManual(api,oldAppointment); commands.push({command:oldAppointment,ack:appointment.schedulingOperation});
  const oldProject=await manual(api,id,'project',day+86400000+9*3600000); const project=await createManual(api,oldProject); commands.push({command:oldProject,ack:project.schedulingOperation});
  const released=await api('PATCH',`/projects/${project.id}`,{crewUserIds:[id.owner],expectedUpdatedAt:project.updatedAt,expectedTargetFingerprint:project.schedulingTargetFingerprint});
  const releasedRow=(await database.query('SELECT scheduling_reservation AS snapshot FROM projects WHERE id=$1',[project.id])).rows[0].snapshot;
  assert.deepEqual(released.schedulingReservation,releasedRow);
  assert.equal(releasedRow.reservationRevision,2); assert.deepEqual(releasedRow.resourceUserIds,[id.owner]);
  for(const key of ['startAt','endAt','minimumTravelGapMinutes','duration','sourcePolicyRevision','sourcePolicyDigest','approvedTimeZone','inspection','admittedAt','admittedByUserId']) assert.deepEqual(releasedRow[key],project.schedulingReservation[key],`release preserves ${key}`);
  const terminalCommand=await manual(api,id,'project',day+2*86400000+9*3600000); const terminal=await createManual(api,terminalCommand); commands.push({command:terminalCommand,ack:terminal.schedulingOperation});
  await api('PATCH',`/projects/${terminal.id}`,{status:'completed'});
  assert.deepEqual((await database.query('SELECT scheduling_reservation AS snapshot FROM projects WHERE id=$1',[terminal.id])).rows[0].snapshot,terminal.schedulingReservation);
  const deletedCommand=await manual(api,id,'project',day+3*86400000+9*3600000); const deleted=await createManual(api,deletedCommand);
  await api('DELETE',`/projects/${deleted.id}`,undefined,204);
  const deletion=(await database.query("SELECT * FROM audit_events WHERE action='scheduling.reservation_deleted.v1' AND entity_id=$1",[deleted.id])).rows;
  assert.equal(deletion.length,1); assert.equal(deletion[0].actor_user_id,null); assert.deepEqual(deletion[0].metadata.before,deleted.schedulingReservation);
  const absent=await api('POST','/scheduling/operations/reconcile',deletedCommand);
  assert.equal(absent.outcome,'committed'); assert.equal(absent.target.available,false); commands.push({command:deletedCommand,ack:absent});
  await savePolicy(api,5,true,[]);
  const refusedCommand=await manual(api,id,'appointment',Date.parse(appointment.scheduledEnd)+59*60000);
  const refused=await assertTravelRefusal(api,database,refusedCommand); commands.push({command:refusedCommand,ack:refused});
  const fencedCommand=await manual(api,id,'appointment',day+7*86400000);
  const fenced=await api('POST','/scheduling/operations/reconcile',fencedCommand); assert.equal(fenced.refusalCode,'original_create_fenced'); commands.push({command:fencedCommand,ack:fenced});
  const disabledApi=apiClient(origin,'disabled'); await savePolicy(disabledApi,30,true); const disabled=await savePolicy(disabledApi,30,false); assert.equal(disabled.policy.revision,2); assert.equal(disabled.policy.enabled,false);
  const legacy=await apiClient(origin,'legacy')('GET','/settings/scheduling-policy'); assert.equal(legacy.policy,null);
  await assertLegacyCompatibility(database);
  for(const label of ['main','disabled','legacy']) {
    const fixture=schedulingIds(label);
    for(const [table,target] of [['appointments',fixture.legacyAppointment],['projects',fixture.legacyProject]]) assert.deepEqual((await database.query(`SELECT scheduled_end IS NULL AS null_end,scheduling_reservation IS NULL AS sql_null FROM ${table} WHERE id=$1`,[target])).rows[0],{null_end:true,sql_null:true});
  }
  // Native source-specific command receipts. No shared manual identity or fabricated root.
  const returningContext=await api('GET',`/scheduling/review-context?${new URLSearchParams({sourceKind:'direct_customer',sourceId:id.contact,propertyId:id.property,reservationKind:'project'})}`);
  const returning={requestId:randomUUID(),confirmed:true,source:{kind:'existing_customer',contactId:id.contact,propertyId:id.property},name:'Synthetic returning recovery',status:'scheduled',scheduledStart:new Date(day+4*86400000).toISOString(),scheduledEnd:new Date(day+4*86400000+3600000).toISOString(),crewUserIds:[id.owner],crewNotes:null,schedulingReview:review(returningContext)};
  const returningResult=await api('POST','/customer-work/projects',returning);
  const carePath=`/service-obligations/${id.service}/care`;
  const beforeCare=await api('GET',`${carePath}?appointmentType=other`);
  const response=await api('POST',`${carePath}/response`,{requestId:randomUUID(),expectedUpdatedAt:beforeCare.expectedUpdatedAt,channel:'phone',outcome:'ready_to_book',respondedAt:new Date().toISOString(),note:'Synthetic customer confirmation for recovery only.',staffAttested:true});
  const care=await api('GET',`${carePath}?appointmentType=other`); assert.equal(care.scheduling.review.state,'ready');
  const careCommand={requestId:randomUUID(),expectedUpdatedAt:care.expectedUpdatedAt,responseId:response.responseId,assignedUserId:id.owner,scheduledStart:new Date(day+5*86400000).toISOString(),scheduledEnd:new Date(day+5*86400000+3600000).toISOString(),type:'other',customerConfirmed:true,schedulingReview:review(care.scheduling.review.context)};
  const careResult=await api('POST',`${carePath}/book`,careCommand);
  const calliePath=`/communications/callie/${id.intake}`;
  const caller=await api('GET',calliePath);
  await api('POST',`${calliePath}/review-caller`,{requestId:randomUUID(),expectedVersion:caller.version,expectedFingerprint:caller.expectedFingerprint,action:'link_contact',contactId:id.contact,staffConfirmed:true});
  const callieContext=await api('GET',`${calliePath}/scheduling-context?appointmentType=other&propertyId=${id.property}`); assert.equal(callieContext.review.state,'ready');
  const callieCommand={requestId:randomUUID(),expectedVersion:callieContext.expectedVersion,expectedFingerprint:callieContext.expectedFingerprint,contactId:id.contact,leadId:null,propertyId:id.property,assignedUserId:id.owner,type:'other',scheduledStart:new Date(day+6*86400000).toISOString(),scheduledEnd:new Date(day+6*86400000+3600000).toISOString(),confirmationNote:'Synthetic exact appointment confirmation for recovery.',customerConfirmed:true,schedulingReview:review(callieContext.review.context)};
  const callieResult=await api('POST',`${calliePath}/book`,callieCommand);
  // Known malformed and foreign raw records survive; the closed export must withhold them.
  const invalidId=randomUUID(),foreignId=randomUUID();
  await database.query("INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,metadata) VALUES($1,$2,$3,'scheduling.manual_operation.v1','project',$4)",[invalidId,id.org,id.owner,JSON.stringify({formatVersion:1,privateCanary:'SYNTHETIC_PRIVATE_INVALID',sourceReview:{contactId:schedulingIds('disabled').contact}})]);
  await database.query("INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,'scheduling.reservation_transition.v1','project',$4,$5)",[foreignId,id.org,id.owner,project.id,JSON.stringify({formatVersion:1,transition:'admission',origin:'manual',sourceId:null,source:{sourceKind:'direct_customer',leadId:null,contactId:schedulingIds('disabled').contact,propertyId:null,estimateId:null},before:null,after:project.schedulingReservation,target:{kind:'project',id:project.id},invalidHistoricalEvidenceRetained:false,recordedAt:new Date().toISOString()})]);
  const exported=stableExport(await api('GET','/customer-lifecycle/export'));
  assert.ok(exported.organization.schedulingHistory.some(row=>row.event==='reservation_deleted'&&row.target.id===deleted.id&&row.target.available===false));
  assert.ok(exported.organization.schedulingHistory.some(row=>row.event==='operation_refused'&&row.reasonCode==='travel_conflict'));
  assert.ok(exported.manifest.schedulingHistory.withheldInvalidRecords>=1);
  assert.ok(exported.manifest.schedulingHistory.withheldInvalidLinks>=1);
  assert.equal(JSON.stringify(exported.organization).includes(schedulingIds('disabled').contact),false);
  assert.equal(JSON.stringify(exported).includes('SYNTHETIC_PRIVATE_INVALID'),false);
  for(const {command} of commands) assert.equal(JSON.stringify(exported).includes(command.operationId),false);
  for(const command of [returning,careCommand,callieCommand]) assert.equal(JSON.stringify(exported).includes(command.requestId),false);
  return {version:1,day,commands,appointmentId:appointment.id,projectId:project.id,deletedId:deleted.id,exported,sources:[
    {path:'/customer-work/projects',command:returning,outcome:returningResult.commandOutcome,key:'commandOutcome'},
    {path:`${carePath}/book`,command:careCommand,outcome:careResult.bookingOutcome,key:'bookingOutcome'},
    {path:`${calliePath}/book`,command:callieCommand,outcome:callieResult.bookingOutcome,key:'bookingOutcome'},
  ]};
}

async function assertTravelRefusal(api,database,command) {
  const before=await writeState(database), auditRows=(await database.query('SELECT id,to_jsonb(t) AS row FROM audit_events t ORDER BY id')).rows, audits=auditRows.map(r=>r.id);
  const result=await createManual(api,command,409);
  globalThis.__contractorProbeStep='travel_refusal_atomic_writes';
  assert.equal(result.code,'manual_scheduling_refused'); assert.equal(result.schedulingOperation.outcome,'no_commit_refused'); assert.equal(result.schedulingOperation.refusalCode,'travel_conflict'); assert.equal(result.schedulingOperation.target,null);
  const after=await writeState(database);
  for(const [table,value] of Object.entries(before)) if(table!=='audit_events') assert.deepEqual(after[table],value,`refused booking changed ${table}`);
  const added=(await database.query('SELECT * FROM audit_events WHERE NOT(id=ANY($1::uuid[])) ORDER BY action',[audits])).rows;
  assert.deepEqual((await database.query('SELECT id,to_jsonb(t) AS row FROM audit_events t WHERE id=ANY($1::uuid[]) ORDER BY id',[audits])).rows,auditRows);
  assert.equal(added.length,2); assert.deepEqual(added.map(r=>r.action),['scheduling.manual_operation.v1','scheduling.operation_refused.v1']); assert.equal(added[0].id,command.operationId);
  assert.equal(added[1].metadata.reason,'travel_conflict');
  return result.schedulingOperation;
}

export async function probeSchedulingThroughApp(origin,database,state,mode) {
  const api=apiClient(origin,'main'),id=schedulingIds('main');
  if(mode==='reconcile') {
    await assertLegacyCompatibility(database);
    const exported=stableExport(await api('GET','/customer-lifecycle/export')); assert.deepEqual(exported,state.exported);
    const before=await replayBaseline(database);
    for(const {command,ack} of state.commands) assert.deepEqual(await api('POST','/scheduling/operations/reconcile',command),ack);
    for(const source of state.sources) {
      const replay=await api('POST',source.path,source.command); globalThis.__contractorProbeStep=`replay_${source.key.toLowerCase()}`; assert.deepEqual(replay[source.key],source.outcome);
    }
    await assertReplayWrites(database,before);
    // A corrupt current policy must not replace already retained original outcomes.
    await database.query("UPDATE org_settings SET scheduling_policy=jsonb_set(scheduling_policy,'{digest}',to_jsonb($2::text)) WHERE organization_id=$1",[id.org,'0'.repeat(64)]);
    const corruptBefore=await replayBaseline(database);
    for(const {command,ack} of state.commands) assert.deepEqual(await api('POST','/scheduling/operations/reconcile',command),ack);
    for(const source of state.sources) {const replay=await api('POST',source.path,source.command);globalThis.__contractorProbeStep=`corrupt_replay_${source.key.toLowerCase()}`;assert.deepEqual(replay[source.key],source.outcome);}
    const changed=structuredClone(state.commands[0].command); changed.body.notes='changed';
    const conflict=await api('POST','/scheduling/operations/reconcile',changed,409); assert.equal(conflict.code,'operation_identity_conflict');
    const wrongActor=await apiClient(origin,'main-tech')('POST','/scheduling/operations/reconcile',state.commands[0].command,409); assert.equal(wrongActor.code,'operation_identity_conflict');
    const foreign=await apiClient(origin,'disabled')('POST','/scheduling/operations/reconcile',state.commands[0].command,400); assert.equal(foreign.code,'invalid_scheduling_context'); assert.equal('schedulingOperation' in foreign,false);
    await assertReplayWrites(database,corruptBefore);
    const invalidExport=stableExport(await api('GET','/customer-lifecycle/export'));
    assert.equal(invalidExport.organization.schedulingPolicy,null);
    assert.equal(invalidExport.manifest.schedulingPolicy.state,'invalid');
    // Exercise the real API's 2000+1 evidence bound. No partial export/audit.
    await database.query("INSERT INTO audit_events(organization_id,actor_user_id,action,entity_type,entity_id,metadata) SELECT $1,$2,'scheduling.manual_operation.v1','organization',$1,'{}'::jsonb FROM generate_series(1,2001)",[id.org,id.owner]);
    const boundedBefore=await writeState(database);
    const bounded=await api('GET','/customer-lifecycle/export',undefined,413);
    assert.equal(bounded.code,'customer_export_limit');
    assert.equal('data' in bounded,false); assert.deepEqual(await writeState(database),boundedBefore);
    return {originalOutcomesPreserved:true,legacyCompatibilityVerified:true,invalidPolicyWithheld:true,exportBoundVerified:true,exportDatasetCount:exported.manifest.tables.length,exportSha256:schedulingHash(exported),manualOutcomes:state.commands.length,sourceOutcomes:state.sources.length,callieReplayRateCounterIncrements:2};
  }
  assert.ok(['reduced','disabled'].includes(mode));
  if(mode==='disabled') await savePolicy(api,5,false,[]);
  const current=await api('GET','/settings/scheduling-policy'); assert.equal(current.policy.enabled,mode==='reduced');
  const cases=[];
  for(const [targetKind,targetId] of [['appointment',state.appointmentId],['project',state.projectId]]) {
    const table=targetKind==='appointment'?'appointments':'projects';
    const old=(await database.query(`SELECT scheduling_reservation AS snapshot FROM ${table} WHERE id=$1`,[targetId])).rows[0].snapshot;
    assert.equal(old.minimumTravelGapMinutes,60);
    const control=await manual(api,id,'appointment',state.day+(targetKind==='appointment'?20:21)*86400000); const created=await createManual(api,control); assert.equal(created.schedulingOperation.outcome,'committed');
    const refused=await manual(api,id,'appointment',Date.parse(old.endAt)+59*60000);
    await assertTravelRefusal(api,database,refused);
    const equality=await manual(api,id,'appointment',Date.parse(old.endAt)+60*60000); const allowed=await createManual(api,equality); assert.equal(allowed.schedulingOperation.outcome,'committed');
    assert.deepEqual((await database.query(`SELECT scheduling_reservation AS snapshot FROM ${table} WHERE id=$1`,[targetId])).rows[0].snapshot,old);
    cases.push({policy:mode,targetKind,controlStatus:201,refusedStatus:409,code:'manual_scheduling_refused',outcome:'no_commit_refused',refusalCode:'travel_conflict',auditInserts:2,otherWrites:0,equalityStatus:201});
  }
  return {cases};
}
