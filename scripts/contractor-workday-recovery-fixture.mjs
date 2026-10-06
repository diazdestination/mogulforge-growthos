/** Fictional captured records only; supplied query client, no DB/provider construction. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';

export const WORKDAY_RECOVERY_SLUGS = Object.freeze(['restore-drill-workday-a', 'restore-drill-workday-b']);
const stamp = '2026-10-05T12:00:00.000Z', performedAt = '2026-10-05T13:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = value => hash(canonical(value));
export const WORKDAY_FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT8sAAAAASUVORK5CYII=', 'base64');
const jsonColumns = new Set(['facts','definition','snapshot','parent_snapshot','asset_snapshot','answers','recurrence','metadata']);
async function insert(database, table, row) {
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  const columns = Object.keys(row); columns.forEach(column => assert.match(column, /^[a-z_][a-z0-9_]*$/));
  return database.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_,index) => `$${index+1}`).join(',')})`, columns.map(column => jsonColumns.has(column) && row[column] !== null ? JSON.stringify(row[column]) : row[column]));
}
export function workdayFixtureIds(namespace) {
  assert.ok(WORKDAY_RECOVERY_SLUGS.includes(namespace) || ['preview-workday-hvac','preview-workday-roof'].includes(namespace));
  const names = ['organization','user','contact','property','asset','retiredAsset','template','revision','newRevision','completedVisit','staleVisit','readyVisit','entry','secondEntry','staleEntry','completion','correction','photo','expiredPhoto','object','reservedObject','foreignUnusedObject','task','nextTask','followupTask','service','nextService','completionRequest','correctionRequest','photoRequest','expiredRequest'];
  const ids = Object.fromEntries(names.map(name => { const value = hash(`workday-fixture-v1:${namespace}:${name}`); return [name, `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`]; }));
  return { ...ids, authSession: hash(`workday-fixture-v1:${namespace}:session`) };
}
function assetFacts(trade, label) {
  return { category: trade === 'hvac' ? 'hvac_equipment' : 'roof_system', label,
    manufacturer: null, model: null, serial: null, location: 'FICTIONAL recorded site area', installedOn: null,
    notes: 'SYNTHETIC records only; no physical work or warranty eligibility is established.',
    warrantyStartsOn: null, warrantyEndsOn: null, warrantySource: null,
    attributes: [{label:'Recorded company field', value:'FICTIONAL optional description'}] };
}
function answers(definition, attention = false) {
  return definition.items.filter(item => item.required || item.key === 'airflow_observation').map(item => ({ itemKey:item.key,
    result:attention && item.key === 'airflow_observation' ? 'needs_attention' : 'done',
    value:item.kind === 'text' ? 'FICTIONAL staff-recorded scope and findings; no actual customer service occurred.' : null,
    reason:attention && item.key === 'airflow_observation' ? 'FICTIONAL condition needs an accountable office review.' : null }));
}
/** Shared only by exact recovery tenants and the guarded loopback preview. */
export async function seedSyntheticWorkday(database, { namespace, organizationId: org, actorUserId: actor, trade = 'hvac', preview = false }) {
  const id = { ...workdayFixtureIds(namespace), organization:org, user:actor };
  const [member] = (await database.query('SELECT u.email,u.role,u.is_active,u.email_verified_at,o.name,o.slug FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2',[actor,org])).rows;
  assert.ok(member?.email?.endsWith('@example.invalid') && member.is_active && member.email_verified_at && member.role === 'owner');
  assert.ok(member.name.toLowerCase().includes('fictional') && (WORKDAY_RECOVERY_SLUGS.includes(member.slug) || ['local-runtime-qa','local-workday-roof-qa'].includes(member.slug)));
  const { getWorkdayChecklistStarters } = await tsImport('../artifacts/api-server/src/services/contractor-workday-baselines.ts', import.meta.url);
  const starter = getWorkdayChecklistStarters().find(row => row.definition.trade === trade);
  assert.ok(starter);
  const definition = starter.definition, newer = structuredClone(definition);
  newer.description = 'FICTIONAL revised company instructions; earlier work retains its original revision.';
  newer.items[0].label = 'FICTIONAL current-revision scope confirmation';
  const originalFacts = assetFacts(trade, trade === 'hvac' ? 'FICTIONAL upstairs unit' : 'FICTIONAL main roof area');
  const retiredFacts = assetFacts(trade, 'FICTIONAL historical unit / area');
  const currentFacts = { ...originalFacts, model:'SYNTHETIC-RECORDED-MODEL', attributes:[...originalFacts.attributes,{label:'Literal note',value:'<b>Recorded text, not markup</b>'}] };
  await insert(database,'contacts',{ id:id.contact,organization_id:org,first_name:'FICTIONAL',last_name:trade === 'hvac' ? 'HVAC returning customer' : 'Roofing returning customer',email:`${namespace}.customer@example.invalid`,phone:'+12025550188',do_not_contact:true,do_not_contact_email:true,do_not_contact_sms:true,created_at:stamp,updated_at:stamp });
  await insert(database,'properties',{ id:id.property,organization_id:org,contact_id:id.contact,address_line_1:'0 FICTIONAL Workday Lane',city:'Synthetic City',state:'GA',postal_code:'00000',property_type:'residential',created_at:stamp,updated_at:stamp });
  for (const [assetId,facts,status,version] of [[id.asset,currentFacts,'active',2],[id.retiredAsset,{...retiredFacts,label:'FICTIONAL retired asset — current label'},'retired',2]])
    await insert(database,'property_assets',{ id:assetId,organization_id:org,contact_id:id.contact,property_id:id.property,version,status,facts,created_by_user_id:actor,created_at:stamp,updated_at:performedAt });
  await insert(database,'work_checklist_templates',{ id:id.template,organization_id:org,version:2,status:'reviewed',created_by_user_id:actor,created_at:stamp,updated_at:performedAt });
  for (const [revisionId,version,content] of [[id.revision,1,definition],[id.newRevision,2,newer]])
    await insert(database,'work_checklist_revisions',{ id:revisionId,organization_id:org,template_id:id.template,version,definition:content,definition_sha256:digest(content),baseline_id:starter.id,baseline_version:1,created_by_user_id:actor,reviewed_by_user_id:actor,reviewed_at:stamp,created_at:stamp });
  const upcoming = new Date(Date.now()+86_400_000).toISOString();
  for (const [visitId,status,start] of [[id.completedVisit,'completed',stamp],[id.staleVisit,'scheduled',upcoming],[id.readyVisit,'scheduled',preview ? new Date(Date.now()-60_000).toISOString() : upcoming]])
    await insert(database,'appointments',{ id:visitId,organization_id:org,contact_id:id.contact,property_id:id.property,assigned_user_id:actor,type:'other',status,scheduled_start:start,scheduled_end:new Date(Date.parse(start)+3_600_000).toISOString(),notes:'FICTIONAL original office scheduling note; do not replace it with field observations.',created_at:stamp,updated_at:stamp });
  for (const [taskId,status,title] of [[id.task,'done','FICTIONAL original service task'],[id.nextTask,'open','FICTIONAL next agreed service'],[id.followupTask,'open','FICTIONAL recorded finding: office action']])
    await insert(database,'crm_tasks',{ id:taskId,organization_id:org,contact_id:id.contact,title,description:'FICTIONAL staff-owned plan, notes and due date retained.',status,priority:'normal',assigned_user_id:actor,due_at:'2026-12-30T12:00:00Z',source_event:'manual',created_at:stamp,updated_at:stamp });
  const recurrence = {mode:'calendar_months',intervalMonths:6,anchorDate:'2026-06-30',endDate:'2027-12-31',agreementNote:'FICTIONAL explicit agreement only; not an industry default.',approvedByUserId:actor,approvedAt:stamp};
  for (const [serviceId,taskId,status,due,index,predecessor,visitId] of [[id.service,id.task,'completed','2026-06-30',0,null,id.completedVisit],[id.nextService,id.nextTask,'active','2026-12-30',1,id.service,preview ? id.readyVisit : null]])
    await insert(database,'service_obligations',{ id:serviceId,organization_id:org,contact_id:id.contact,property_id:id.property,appointment_id:visitId,task_id:taskId,kind:'maintenance',equipment_label:'FICTIONAL historical free-text label remains unchanged',due_at:`${due}T12:00:00Z`,notice_days:7,status,source:predecessor ? 'approved_recurrence' : 'manual',recurrence,predecessor_obligation_id:predecessor,occurrence_index:index,completion_note:status === 'completed' ? 'FICTIONAL captured service record, no live work.' : null,completed_at:status === 'completed' ? performedAt : null,created_at:stamp,updated_at:stamp });
  const completionResult = { id:id.completion,appointmentId:id.completedVisit,contactId:id.contact,propertyId:id.property,requestId:id.completionRequest,performedAt,recordedAt:performedAt,recordedByUserId:actor,performerUserId:actor,actingNote:null,summary:'FICTIONAL historical work record with an accountable finding; no physical work occurred.',outcome:'needs_followup',followupTaskId:id.followupTask,
    entries:[{id:id.entry,version:2,checklistRevisionId:id.revision,assetId:id.asset},{id:id.secondEntry,version:2,checklistRevisionId:id.revision,assetId:id.retiredAsset}],services:[{id:id.service,nextObligationId:id.nextService}],nativeAppointmentStatus:'completed' };
  await insert(database,'appointment_work_completions',{ id:id.completion,organization_id:org,appointment_id:id.completedVisit,contact_id:id.contact,property_id:id.property,request_id:id.completionRequest,payload_sha256:digest({synthetic:true}),actor_user_id:actor,snapshot:{result:completionResult,services:completionResult.services,parent:{synthetic:true},nativeBefore:{notes:'PRIVATE SYNTHETIC internal context'},tasksBefore:[],previewToken:'PRIVATE SYNTHETIC token must never enter core export'},created_at:performedAt });
  await insert(database,'appointment_work_completions',{ id:id.correction,organization_id:org,appointment_id:id.completedVisit,contact_id:id.contact,property_id:id.property,original_completion_id:id.completion,request_id:id.correctionRequest,payload_sha256:digest({note:'fictional'}),actor_user_id:actor,snapshot:{note:'FICTIONAL append-only clarification; original answers/effects are unchanged.',actingNote:'PRIVATE SYNTHETIC staff attestation'},created_at:'2026-10-05T14:00:00Z' });
  for (const [entryId,visitId,assetId,facts,state,completionId,serviceId] of [[id.entry,id.completedVisit,id.asset,originalFacts,'finalized',id.completion,id.service],[id.secondEntry,id.completedVisit,id.retiredAsset,retiredFacts,'finalized',id.completion,null],[id.staleEntry,id.staleVisit,id.asset,originalFacts,'draft',null,null]])
    await insert(database,'appointment_work_entries',{ id:entryId,organization_id:org,appointment_id:visitId,contact_id:id.contact,property_id:id.property,asset_id:assetId,service_obligation_id:serviceId,checklist_revision_id:id.revision,version:state === 'finalized' ? 2 : 1,state,parent_snapshot:{syntheticHistoricalScope:true,appointmentId:visitId,contactId:id.contact,propertyId:id.property},asset_snapshot:{...facts,id:assetId,version:1},answers:state === 'finalized' ? answers(definition,trade === 'hvac') : [],notes:'FICTIONAL field notes remain separate from original scheduling notes.',completion_id:completionId,created_by_user_id:actor,created_at:stamp,updated_at:performedAt });
  await insert(database,'stored_objects',{ id:id.object,organization_id:org,data:WORKDAY_FIXTURE_PNG,content_type:'image/png',size_bytes:WORKDAY_FIXTURE_PNG.length,metadata:{syntheticOnly:true},created_at:stamp });
  await insert(database,'appointment_work_photos',{ id:id.photo,organization_id:org,appointment_id:id.completedVisit,entry_id:id.entry,reserved_object_id:id.object,object_id:id.object,request_id:id.photoRequest,payload_sha256:digest({syntheticPhoto:true}),state:'attached',item_key:'visit_photos',caption:'FICTIONAL tiny PNG, not a customer roof/unit photo',content_type:'image/png',size_bytes:WORKDAY_FIXTURE_PNG.length,object_sha256:hash(WORKDAY_FIXTURE_PNG),created_by_user_id:actor,expires_at:performedAt,attached_at:performedAt,created_at:stamp });
  await insert(database,'appointment_work_photos',{ id:id.expiredPhoto,organization_id:org,appointment_id:id.staleVisit,entry_id:id.staleEntry,reserved_object_id:id.reservedObject,request_id:id.expiredRequest,payload_sha256:digest({expired:true}),state:'expired',content_type:'image/png',size_bytes:WORKDAY_FIXTURE_PNG.length,created_by_user_id:actor,expires_at:stamp,created_at:stamp });
  return { ids:id,trade,definition,completionResult };
}
export async function seedWorkdayRecovery(database, slug) {
  assert.ok(WORKDAY_RECOVERY_SLUGS.includes(slug));
  const id=workdayFixtureIds(slug),email=`${slug}.owner@example.invalid`;
  await insert(database,'organizations',{id:id.organization,name:`FICTIONAL Workday Recovery ${slug.endsWith('-a') ? 'HVAC' : 'Roofing'}`,slug,timezone:'America/New_York',created_at:stamp,updated_at:stamp});
  await insert(database,'users',{id:id.user,organization_id:id.organization,email,first_name:'FICTIONAL',last_name:'Workday Owner',role:'owner',email_verified_at:stamp,is_active:true,is_platform_admin:false,created_at:stamp,updated_at:stamp});
  await insert(database,'sessions',{sid:id.authSession,sess:JSON.stringify({user:{id:id.user,email,firstName:'FICTIONAL',lastName:'Workday Owner',profileImageUrl:null},access_token:'synthetic-no-provider'}),expire:new Date(Date.now()+86_400_000).toISOString()});
  return seedSyntheticWorkday(database,{namespace:slug,organizationId:id.organization,actorUserId:id.user,trade:slug.endsWith('-a') ? 'hvac' : 'roofing'});
}
export async function assertWorkdayRecovery(database, slug) {
  const id=workdayFixtureIds(slug);
  const [original]=(await database.query('SELECT * FROM appointment_work_completions WHERE id=$1 AND organization_id=$2',[id.completion,id.organization])).rows;
  assert.equal(original.snapshot.result.id,id.completion); assert.equal(original.snapshot.result.nativeAppointmentStatus,'completed');
  assert.equal(original.snapshot.result.entries.length,2); assert.equal(original.snapshot.result.services[0].nextObligationId,id.nextService);
  assert.equal(original.snapshot.result.outcome,'needs_followup'); assert.equal(original.snapshot.result.followupTaskId,id.followupTask);
  const entries=(await database.query('SELECT * FROM appointment_work_entries WHERE organization_id=$1 ORDER BY id',[id.organization])).rows;
  assert.equal(entries.length,3); assert.equal(entries.filter(row=>row.state === 'finalized').length,2);
  assert.equal(entries.find(row=>row.id === id.secondEntry).asset_snapshot.label,'FICTIONAL historical unit / area');
  assert.equal(entries.find(row=>row.id === id.staleEntry).answers.length,0);
  const [current]=(await database.query('SELECT * FROM property_assets WHERE id=$1',[id.retiredAsset])).rows;
  assert.equal(current.status,'retired'); assert.equal(current.version,2); assert.notEqual(current.facts.label,entries.find(row=>row.id === id.secondEntry).asset_snapshot.label);
  const [revision]=(await database.query('SELECT * FROM work_checklist_revisions WHERE id=$1',[id.revision])).rows;
  assert.equal(revision.definition_sha256,digest(revision.definition)); assert.equal(revision.version,1);
  const [correction]=(await database.query('SELECT * FROM appointment_work_completions WHERE id=$1',[id.correction])).rows;
  assert.equal(correction.original_completion_id,id.completion); assert.match(correction.snapshot.note,/append-only/);
  const [photo]=(await database.query('SELECT * FROM appointment_work_photos WHERE id=$1',[id.photo])).rows;
  assert.equal(photo.state,'attached'); assert.equal(photo.object_id,id.object); assert.equal(photo.object_sha256,hash(WORKDAY_FIXTURE_PNG));
  const [object]=(await database.query("SELECT encode(data,'hex') AS content FROM stored_objects WHERE id=$1 AND organization_id=$2",[id.object,id.organization])).rows;
  assert.equal(object.content,WORKDAY_FIXTURE_PNG.toString('hex'));
  assert.equal((await database.query('SELECT count(*)::int AS n FROM leads WHERE organization_id=$1',[id.organization])).rows[0].n,0);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM service_obligations WHERE predecessor_obligation_id=$1',[id.service])).rows[0].n,1);
  assert.equal((await database.query('SELECT equipment_label FROM service_obligations WHERE id=$1',[id.service])).rows[0].equipment_label,'FICTIONAL historical free-text label remains unchanged');
}
export async function assertWorkdayKeys(database) {
  const a=workdayFixtureIds(WORKDAY_RECOVERY_SLUGS[0]),b=workdayFixtureIds(WORKDAY_RECOVERY_SLUGS[1]);
  const checks=[
    ["UPDATE property_assets SET version=0 WHERE id=$1",[a.asset],'23514'],
    ["UPDATE property_assets SET contact_id=$1 WHERE id=$2",[b.contact,a.asset],'23503'],
    ["UPDATE work_checklist_revisions SET reviewed_at=NULL WHERE id=$1",[a.revision],'23514'],
    ["UPDATE work_checklist_revisions SET baseline_version=NULL WHERE id=$1",[a.revision],'23514'],
    ["UPDATE work_checklist_revisions SET template_id=$1 WHERE id=$2",[b.template,a.revision],'23503'],
    ["UPDATE appointment_work_entries SET completion_id=NULL WHERE id=$1",[a.entry],'23514'],
    ["UPDATE appointment_work_entries SET asset_snapshot=NULL WHERE id=$1",[a.entry],'23514'],
    ["UPDATE appointment_work_entries SET asset_id=$1 WHERE id=$2",[b.asset,a.entry],'23503'],
    ["UPDATE appointment_work_entries SET completion_id=$1 WHERE id=$2",[b.completion,a.entry],'23503'],
    ["UPDATE appointment_work_completions SET original_completion_id=id WHERE id=$1",[a.correction],'23514'],
    ["UPDATE appointment_work_completions SET original_completion_id=$1 WHERE id=$2",[b.completion,a.correction],'23503'],
    ["UPDATE appointment_work_photos SET attached_at=NULL WHERE id=$1",[a.photo],'23514'],
    ["UPDATE appointment_work_photos SET size_bytes=10485761 WHERE id=$1",[a.photo],'23514'],
    ["UPDATE appointment_work_photos SET content_type='image/svg+xml' WHERE id=$1",[a.photo],'23514'],
    ["UPDATE appointment_work_photos SET object_id=$1,reserved_object_id=$1 WHERE id=$2",[b.foreignUnusedObject,a.photo],'23503'],
    ["DELETE FROM stored_objects WHERE id=$1",[a.object],'23503'],
  ];
  for (const [index,[sql,params,code]] of checks.entries()) {
    await database.exec('BEGIN');
    try {
      // Isolate the tenant FK from the independent global reservation unique.
      // Reusing B's already-reserved object would fail23505 before testing23503.
      if (index===14) await database.query('INSERT INTO stored_objects(id,organization_id,data,content_type,size_bytes,metadata) SELECT $1,organization_id,data,content_type,size_bytes,metadata FROM stored_objects WHERE id=$2',[b.foreignUnusedObject,b.object]);
      let failure; try { await database.query(sql,params); } catch(error) { failure=error; }
      assert.equal(failure?.code,code,`workday_constraint_${index}`);
    }
    finally { await database.exec('ROLLBACK'); }
  }
  return checks.length;
}
