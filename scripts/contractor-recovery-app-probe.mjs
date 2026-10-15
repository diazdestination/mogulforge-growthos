/** Child of the synthetic recovery drill. No arbitrary target or provider configuration. */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { seedSchedulingThroughApp, probeSchedulingThroughApp, schedulingHash } from './saved-scheduling-recovery-fixture.mjs';
import { nativeFixtureIds } from './native-contractor-recovery-fixture.mjs';
import { careFixtureIds } from './customer-care-recovery-fixture.mjs';
import { operationsFixtureIds } from './operations-wave-recovery-fixture.mjs';
import { leadReplyFixtureIds } from './lead-replies-recovery-fixture.mjs';
import { invoiceRecoveryIds } from './invoice-recovery-fixture.mjs';
import { callieFixtureIds } from './callie-recovery-fixture.mjs';
import { standingServiceIds } from './standing-service-recovery-fixture.mjs';
import { sourceNurtureIds } from './source-nurture-recovery-fixture.mjs';
import { customerWorkspaceIds } from './customer-workspace-fixture.mjs';
import { CALLIE_CONVERSATION_RECOVERY_SLUGS, callieConversationFixtureIds } from './callie-conversation-recovery-fixture.mjs';
import { WORKDAY_RECOVERY_SLUGS, workdayFixtureIds, WORKDAY_FIXTURE_PNG } from './contractor-workday-recovery-fixture.mjs';
import { returningCustomerIds } from './returning-customer-recovery-fixture.mjs';

const target = new URL(process.env.DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || target.pathname !== '/postgres' || process.env.CONTRACTOR_SYNTHETIC_RECOVERY !== 'true' || process.env.NODE_ENV !== 'test') throw new Error('contractor_probe_target_invalid');
const fetchLocal = globalThis.fetch;
let externalAttempts=0;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { externalAttempts++; throw new Error('contractor_probe_external_request_forbidden'); }
  return fetchLocal(input, init);
};
https.request=https.get=()=>{ externalAttempts++; throw new Error('contractor_probe_external_request_forbidden'); };
syncBuiltinESMExports();
const { fixtureIds } = await import('./restore-drill-fixture.mjs');
const compiled = resolve(process.env.CONTRACTOR_RECOVERY_APP ?? '');
const artifactRoot = fileURLToPath(new URL('../artifacts/api-server', import.meta.url));
if (dirname(dirname(compiled)) !== artifactRoot || !basename(dirname(compiled)).startsWith('.contractor-recovery-') || basename(compiled) !== 'contractor-recovery-entry.mjs') throw new Error('contractor_probe_build_invalid');
const { default: app, pool } = await import(pathToFileURL(compiled).href);
let databaseFailed = false;
let databaseFailureCode;
let databaseFailureClass, readerContext;
pool.on('connect',client=>{
  const query=client.query;
  client.query=function(...args){
    const result=query.apply(this,args);
    if(result&&typeof result.catch==='function') return result.catch(error=>{
      if(/^[A-Z0-9]{5}$/.test(error.code??'')) databaseFailureCode=error.code;
      const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'';
      databaseFailureClass=/\bfrom\s+"?users"?\b/i.test(sql)&&/\bfor\s+share\b/i.test(sql)?'users_for_share':'other';
      throw error;
    });
    return result;
  };
});
// Keep connection failures observable without dumping driver objects/secrets.
pool.on('error', () => { databaseFailed = true; });
let server, check = 'database_identity';
try {
  const mode=process.env.CONTRACTOR_RECOVERY_PROBE_MODE??'reader';
  assert.ok(['reader','seed','reconcile','reduced','disabled'].includes(mode));
  if(mode!=='reader') {
    assert.equal(process.env.RESTORE_DRILL_ONLY,undefined);
    assert.equal(process.env.RESTORE_DRILL_EXPECTED_CLUSTER_ID,undefined);
    assert.equal(process.env.FLY_APP_NAME,undefined);
    assert.equal(process.env.GROWTHOS_OUTBOUND_HOLD,'true');
    assert.equal(process.env.SCHEDULER_AUTOSTART,'false');
    const identity=(await pool.query("SELECT session_user,current_user,current_database() AS database,current_setting('default_transaction_read_only') AS readonly")).rows[0];
    assert.deepEqual(identity,{session_user:'contractor_recovery_writer',current_user:'contractor_recovery_writer',database:'postgres',readonly:'off'});
    const privileges=(await pool.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=session_user")).rows[0];
    assert.ok(Object.values(privileges).every(value=>value===false));
    await pool.query('BEGIN');
    try { await pool.query("INSERT INTO organizations(name,slug) VALUES('SYNTHETIC writer control','synthetic-writer-control')"); }
    finally { await pool.query('ROLLBACK'); }
    server=app.listen(0,'127.0.0.1'); await new Promise(done=>server.once('listening',done));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const readiness=await fetch(`${origin}/api/readyz`); assert.equal(readiness.status,200);
    const artifactBuildStamp=(await readiness.json()).release;
    const statePath=resolve(dirname(compiled),'scheduling-fixture.json');
    check=`scheduling_${mode}`;
    let result;
    if(mode==='seed') {
      const state=await seedSchedulingThroughApp(origin,pool);
      await writeFile(statePath,JSON.stringify(state),{flag:'wx'});
      result={fixtureSha256:schedulingHash(JSON.stringify(state))};
    } else {
      const raw=await readFile(statePath,'utf8');
      assert.equal(schedulingHash(raw),process.env.CONTRACTOR_RECOVERY_FIXTURE_SHA256);
      result=await probeSchedulingThroughApp(origin,pool,JSON.parse(raw),mode);
    }
    assert.equal(externalAttempts,0);
    process.stdout.write(`${JSON.stringify({...result,artifactBuildStamp,providerCalls:externalAttempts,writerIdentityVerified:true})}\n`);
  } else {
  const databaseIdentity = (await pool.query('SELECT session_user AS username')).rows[0];
  assert.equal(databaseIdentity.username, 'contractor_recovery_reader');
  readerContext=(await pool.query("SELECT session_user,current_user,current_setting('transaction_read_only') AS transaction_read_only,current_setting('default_transaction_read_only') AS default_transaction_read_only,current_setting('transaction_isolation') AS transaction_isolation")).rows[0];
  assert.equal(readerContext.transaction_read_only,'on');
  assert.equal(readerContext.default_transaction_read_only,'on');
  check = 'database_write_rejected';
  await assert.rejects(pool.query("INSERT INTO organizations(name,slug) VALUES('Forbidden','forbidden')"));
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = fixtureIds('restore-drill-contractor-a');
  readerContext.actor=(await pool.query('SELECT id,organization_id,role,is_active FROM users WHERE id=$1',[id.user])).rows[0];
  const other = fixtureIds('restore-drill-contractor-b');
  const native = nativeFixtureIds('restore-drill-contractor-a'), otherNative = nativeFixtureIds('restore-drill-contractor-b');
  const headers = { authorization: `Bearer ${'a'.repeat(64)}` };
  const good = ['/api/healthz', '/api/auth/user', `/api/v1/contacts/${id.contact}`, `/api/v1/leads/${id.lead}`, `/api/v1/projects/${id.project}`, '/api/v1/revenue/value', '/api/v1/customer-lifecycle', '/api/v1/email-intelligence/replies', '/api/v1/contractor/today?date=2026-10-01', '/api/v1/invoices', `/api/v1/invoices/${native.invoice}`, '/api/v1/service-obligations'];
  good.push(`/api/v1/invoices/${native.invoice}/delivery`, `/api/v1/service-obligations/${native.nextService}/care`, '/api/v1/communications/missed-call-care');
  const operations = operationsFixtureIds('restore-drill-contractor-a'), foreignOperations = operationsFixtureIds('restore-drill-contractor-b');
  good.push('/api/v1/service-watch', `/api/v1/service-obligations/${native.nextService}/watch`, '/api/v1/source-adoption',
    `/api/v1/source-adoption/outreach/${operations.batch}`, '/api/v1/financial-migrations', `/api/v1/financial-migrations/${operations.review}`, `/api/v1/invoices/${operations.invoice}`);
  good.push(`/api/v1/service-obligations/${native.nextService}/mailbox-replies`, '/api/v1/staff-invitations/email-deliveries');
  good.push(`/api/v1/leads/${id.lead}/mailbox-replies`);
  good.push('/api/v1/invoices/delivery-worklist');
  const callie = callieFixtureIds('restore-drill-contractor-a'), foreignCallie = callieFixtureIds('restore-drill-contractor-b');
  good.push('/api/v1/communications/callie?scope=attention', '/api/v1/communications/callie/policy', `/api/v1/communications/callie/${callie.intake}`);
  good.push(`/api/v1/service-obligations/${native.nextService}/standing-reminders`, `/api/v1/service-obligations/${native.nextService}/sms-replies`);
  const nurture = sourceNurtureIds('restore-drill-contractor-a'), foreignNurture = sourceNurtureIds('restore-drill-contractor-b');
  good.push('/api/v1/source-nurture?bucket=attention', '/api/v1/source-nurture?bucket=waiting', '/api/v1/source-nurture?bucket=history',
    `/api/v1/source-nurture/${nurture.plan}`, `/api/v1/leads/${nurture.lead}/mailbox-replies`);
  const workspace = customerWorkspaceIds('restore-drill-contractor-a'), foreignWorkspace = customerWorkspaceIds('restore-drill-contractor-b');
  const workspacePath = `/api/v1/contacts/${workspace.contact}/workspace`;
  good.push(workspacePath, ...['properties','appointments','services','leads','projects','estimates','invoices','tasks','activity'].map(section => `${workspacePath}/${section}`),
    `/api/v1/appointments/${workspace.appointments[0]}`);
  for (const route of good) {
    check = `read_${good.indexOf(route)}`;
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200, route);
    if(route===`/api/v1/service-obligations/${native.nextService}/care`) {
      const care=await response.json();
      assert.equal(care.scheduling.organizationId,id.organization);
      assert.equal(care.scheduling.actorUserId,id.user);
      assert.equal(care.scheduling.review.state,'held');
      assert.equal(care.scheduling.review.code,'scheduling_reader_required');
      assert.deepEqual(Object.keys(care.scheduling.review).sort(),['code','message','state']);
    } else await response.arrayBuffer();
    assert.equal(databaseFailed, false);
  }
  const invoice = await (await fetch(`${origin}/api/v1/invoices/${native.invoice}`, { headers })).json();
  check = 'canonical_customer_workspace';
  const readWorkspace = async path => {
    const response = await fetch(`${origin}${path}`, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  const customer = await readWorkspace(workspacePath);
  assert.equal(customer.contact.id, workspace.contact); assert.equal(customer.organizationId, id.organization);
  assert.equal(customer.contact.doNotContact, true); assert.equal(customer.availableSections.length, 9);
  const sites = await readWorkspace(`${workspacePath}/properties`);
  assert.equal(sites.items.length, 25); assert.equal(sites.hasMore, true); assert.ok(sites.nextCursor);
  const nextSites = await readWorkspace(`${workspacePath}/properties?cursor=${sites.nextCursor}`);
  assert.equal(nextSites.items.length, 2); assert.equal(nextSites.hasMore, false);
  assert.equal(new Set([...sites.items, ...nextSites.items].map(row => row.id)).size, 27);
  const services = await readWorkspace(`${workspacePath}/services`);
  assert.equal(services.items.length, 2); assert.equal(services.items.filter(row => row.property === null).length, 1);
  assert.equal((await readWorkspace(`${workspacePath}/leads`)).items.length, 0);
  const exactVisit = await readWorkspace(`/api/v1/appointments/${workspace.appointments[0]}`);
  assert.equal(exactVisit.appointment.contactId, workspace.contact); assert.equal(exactVisit.appointment.id, workspace.appointments[0]);
  assert.equal('notes' in exactVisit.appointment, false);
  const history = await readWorkspace(`${workspacePath}/activity`);
  assert.equal(history.items[0].label, 'Note recorded'); assert.equal(JSON.stringify(history).includes('PRIVATE SYNTHETIC'), false);
  assert.equal((await fetch(`${origin}/api/v1/contacts/${foreignWorkspace.contact}/workspace`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/appointments/${foreignWorkspace.appointments[0]}`, { headers })).status, 404);
  check = 'nurture_stopped_unknown_original';
  const nurtureDetail = await (await fetch(`${origin}/api/v1/source-nurture/${nurture.plan}`, { headers })).json();
  assert.equal(nurtureDetail.state, 'stopped'); assert.equal(nurtureDetail.version, 4); assert.equal(nurtureDetail.readiness.ready, false);
  assert.equal(nurtureDetail.items[0].id, nurture.item); assert.ok(nurtureDetail.items[0].admittedAt);
  assert.equal(nurtureDetail.items[0].steps[0].executionId, nurture.execution); assert.equal(nurtureDetail.items[0].steps[0].executionState, 'indeterminate');
  assert.equal(nurtureDetail.items[0].steps[0].acceptedAt, null); assert.equal(nurtureDetail.items[0].steps[1].state, 'cancelled');
  assert.equal(nurtureDetail.items[0].steps[1].executionId, null); assert.equal(nurtureDetail.items[0].steps[1].claimedAt, null);
  assert.equal((await fetch(`${origin}/api/v1/source-nurture/${foreignNurture.plan}`, { headers })).status, 404);
  check = 'nurture_reply_hold_after_purge';
  const nurtureReplies = await (await fetch(`${origin}/api/v1/leads/${nurture.lead}/mailbox-replies`, { headers })).json();
  assert.equal(nurtureReplies.items.length, 1); assert.equal(nurtureReplies.items[0].id, nurture.reply);
  assert.equal(nurtureReplies.items[0].holdActive, true); assert.equal(nurtureReplies.items[0].content, null);
  assert.equal(nurtureReplies.items[0].context.kind, 'source_nurture_email'); assert.equal(nurtureReplies.items[0].context.planId, nurture.plan);
  assert.equal(nurtureReplies.items[0].monitoringCurrent, false);
  const nurtureToday = await (await fetch(`${origin}/api/v1/contractor/today?date=2026-10-03`, { headers })).json();
  assert.equal(nurtureToday.tasks.items.find(task => task.id === nurture.task)?.actionPath, `/leads/${nurture.lead}?tab=messages`);
  assert.equal((await fetch(`${origin}/api/v1/leads/${foreignNurture.lead}/mailbox-replies`, { headers })).status, 404);
  assert.equal(invoice.recordedPaidCents,0); assert.equal(invoice.balanceDueCents,10000);
  assert.equal(invoice.allocations.length,1); assert.ok(invoice.allocations[0].reversedAt);
  check = 'invoice_recovery_chain';
  const delivery = await (await fetch(`${origin}/api/v1/invoices/${native.invoice}/delivery`, { headers })).json();
  assert.equal(delivery.integrity, 'valid'); assert.equal(delivery.attemptCount, 2); assert.equal(delivery.state, 'uncertain');
  assert.equal(delivery.canPrepare, false); assert.deepEqual(delivery.nextIntents, []);
  assert.equal(delivery.latestExecutionId, invoiceRecoveryIds('restore-drill-contractor-a').secondExecution);
  assert.deepEqual(delivery.attempts.map(row => row.proof), ['not_dispatched', 'none']);
  assert.deepEqual(delivery.attempts.map(row => row.state), ['blocked', 'indeterminate']);
  check = 'invoice_delivery_worklist';
  const worklist = await (await fetch(`${origin}/api/v1/invoices/delivery-worklist`, { headers })).json();
  assert.equal(worklist.pageSize, 25); assert.equal(worklist.total, 4);
  assert.ok(worklist.items.some(row=>row.invoiceId===returningCustomerIds('restore-drill-contractor-a').invoice));
  assert.equal(worklist.items.some(row => row.invoiceId === otherNative.invoice), false);
  const listed = worklist.items.find(row => row.invoiceId === native.invoice);
  assert.equal(listed.delivery.integrity, 'valid'); assert.equal(listed.delivery.attemptCount, 2);
  assert.equal(listed.delivery.latestAttempt.state, 'indeterminate'); assert.deepEqual(listed.delivery.nextIntents, []);
  assert.match(worklist.boundary, /not all delivery exceptions/);
  const foreignPage = await fetch(`${origin}/api/v1/invoices/delivery-worklist?leadId=${other.lead}`, { headers });
  assert.equal(foreignPage.status, 200); assert.deepEqual((await foreignPage.json()).items, []);
  const opening = await (await fetch(`${origin}/api/v1/invoices/${operations.invoice}`, { headers })).json();
  assert.equal(opening.recordedPaidCents,0); assert.equal(opening.balanceDueCents,6000); assert.equal(opening.balanceBasis,'opening_receivable');
  const outreach = await (await fetch(`${origin}/api/v1/source-adoption/outreach/${operations.batch}`, { headers })).json();
  assert.equal(outreach.state,'revoked'); assert.equal(outreach.items[0].delivery.state,'uncertain');
  check = 'service_reply_evidence';
  const serviceReplies = await (await fetch(`${origin}/api/v1/service-obligations/${native.nextService}/mailbox-replies`, { headers })).json();
  assert.equal(serviceReplies.items.length, 1);
  assert.equal(serviceReplies.items[0].holdActive, true);
  assert.equal(serviceReplies.items[0].content, null);
  assert.equal(serviceReplies.items[0].state, 'needs_review');
  check = 'lead_reply_evidence';
  const leadReplies = await (await fetch(`${origin}/api/v1/leads/${id.lead}/mailbox-replies`, { headers })).json();
  assert.equal(leadReplies.items.length, 1);
  assert.equal(leadReplies.items[0].id, leadReplyFixtureIds('restore-drill-contractor-a').reply);
  assert.equal(leadReplies.items[0].holdActive, true);
  assert.equal(leadReplies.items[0].content, null);
  assert.equal(leadReplies.items[0].taskId, leadReplyFixtureIds('restore-drill-contractor-a').task);
  assert.equal(leadReplies.items[0].evidence, 'original_mailbox_observation');
  check = 'callie_restored_request';
  const callieDetail = await (await fetch(`${origin}/api/v1/communications/callie/${callie.intake}`, { headers })).json();
  assert.equal(callieDetail.state, 'indeterminate'); assert.equal(callieDetail.identityReviewed, false);
  assert.equal(callieDetail.appointment, null); assert.equal(callieDetail.task.id, callie.task);
  assert.equal(callieDetail.execution.state, 'indeterminate'); assert.equal(callieDetail.delivery.status, 'uncertain');
  assert.equal(callieDetail.companyHeld, true); assert.equal(callieDetail.actions.canBook, false);
  assert.equal(callieDetail.requestIntent, 'visit');
  for (const key of ['challengeHash', 'challengeEncrypted', 'stepReceipts', 'triggerPayloadHash']) assert.equal(key in callieDetail, false);
  const calliePage = await (await fetch(`${origin}/api/v1/communications/callie?scope=attention`, { headers })).json();
  assert.equal(calliePage.pageSize, 25); assert.equal(calliePage.hasMore, false);
  assert.deepEqual(calliePage.items.map(row => row.id), [callie.intake]);
  const calliePolicy = await (await fetch(`${origin}/api/v1/communications/callie/policy`, { headers })).json();
  assert.equal(calliePolicy.version, 2); assert.equal(calliePolicy.policy.enabled, false); assert.equal(calliePolicy.readiness.ready, false);
  assert.equal((await fetch(`${origin}/api/v1/communications/callie/${foreignCallie.intake}`, { headers })).status, 404);
  check = 'standing_service_disabled_authority';
  const standing = await (await fetch(`${origin}/api/v1/service-obligations/${native.nextService}/standing-reminders`, { headers })).json();
  assert.equal(standing.version, 2); assert.equal(standing.policy.enabled, false); assert.equal(standing.readiness.ready, false);
  assert.equal(standing.occurrence.eligible, false); assert.equal(standing.enrollmentId, standingServiceIds('restore-drill-contractor-a').enrollment);
  assert.equal(standing.occurrence.origin, 'standing'); assert.equal(standing.occurrence.receiptState, 'indeterminate');
  assert.equal(standing.occurrence.authorizationId, standingServiceIds('restore-drill-contractor-a').approval);
  assert.equal(standing.occurrence.scheduledActionId, standingServiceIds('restore-drill-contractor-a').scheduled);
  check = 'service_sms_retained_evidence';
  const smsReplies = await (await fetch(`${origin}/api/v1/service-obligations/${native.nextService}/sms-replies`, { headers })).json();
  assert.equal(smsReplies.held, true); assert.equal(smsReplies.limit, 25); assert.equal(smsReplies.hasMore, false);
  const exactReply = smsReplies.items.find(row => row.id === standingServiceIds('restore-drill-contractor-a').reply);
  assert.ok(exactReply); assert.equal(exactReply.correlation, 'exact_reference'); assert.equal(exactReply.content, null); assert.equal(exactReply.state, 'needs_review');
  for (const suffix of ['standing-reminders', 'sms-replies']) assert.equal((await fetch(`${origin}/api/v1/service-obligations/${otherNative.nextService}/${suffix}`, { headers })).status, 404);
  for (const route of [`/api/v1/contacts/${other.contact}`, `/api/v1/leads/${other.lead}`, `/api/v1/projects/${other.project}`, `/api/v1/invoices/${otherNative.invoice}`, `/api/v1/service-obligations/${otherNative.nextService}/care`, `/api/v1/communications/voice/${careFixtureIds('restore-drill-contractor-b').call}/care`, `/api/v1/invoices/${otherNative.invoice}/delivery`]) {
    check = 'tenant_boundary';
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 404, route); await response.arrayBuffer();
  }
  check = 'http_write_rejected';
  for (const route of [`/api/v1/service-obligations/${otherNative.nextService}/watch`, `/api/v1/source-adoption/outreach/${foreignOperations.batch}`, `/api/v1/financial-migrations/${foreignOperations.review}`, `/api/v1/invoices/${foreignOperations.invoice}`]) {
    const response = await fetch(`${origin}${route}`,{headers}); assert.equal(response.status,404,route); await response.arrayBuffer();
  }
  assert.equal((await fetch(`${origin}/api/v1/service-obligations/${otherNative.nextService}/mailbox-replies`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/leads/${other.lead}/mailbox-replies`, { headers })).status, 404);
  const mutation = await fetch(`${origin}/api/v1/contacts/${id.contact}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ firstName: 'Forbidden' }) });
  assert.equal(mutation.status, 405); await mutation.arrayBuffer();
  const callieMutation = await fetch(`${origin}/api/v1/communications/callie/${callie.intake}/office-action`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(callieMutation.status, 405); await callieMutation.arrayBuffer();
  // Explanation is logically read-only, but restore inspection still denies POST.
  check = 'restored_scheduling_explanation_post_rejected';
  const explanation = await fetch(`${origin}/api/v1/scheduling/conflict-explanation`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(explanation.status, 405);
  assert.equal(explanation.ok, false);
  assert.deepEqual(await explanation.json(), { error: 'Restore drill permits read-only inspection only' });
  let receptionReadChecks = 0;
  for (const [index, slug] of CALLIE_CONVERSATION_RECOVERY_SLUGS.entries()) {
    const reception = callieConversationFixtureIds(slug);
    const otherReception = callieConversationFixtureIds(CALLIE_CONVERSATION_RECOVERY_SLUGS[1 - index]);
    const receptionHeaders = { authorization: `Bearer ${reception.authSession}` };
    const read = async path => {
      const response = await fetch(`${origin}${path}`, { headers: receptionHeaders });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      receptionReadChecks++; return response.json();
    };
    check = `reception_${index}_setup`;
    const setup = await read('/api/v1/communications/callie/reception');
    assert.equal(setup.organizationId, reception.organization); assert.equal(setup.currentMode, 'conversation');
    assert.equal(setup.currentEnabled, false); assert.equal(setup.readiness.ready, false); assert.equal(setup.readiness.state, 'off');
    assert.equal(setup.binding.credentialsConfigured, false); assert.equal(setup.binding.webhookConfigured, false);
    const page = await read('/api/v1/communications/callie?scope=attention');
    assert.ok(page.items.some(row => row.id === reception.intake && row.organizationId === reception.organization && row.mode === 'conversation'));
    check = `reception_${index}_detail`;
    const detail = await read(`/api/v1/communications/callie/${reception.intake}`);
    assert.equal(detail.id, reception.intake); assert.equal(detail.state, 'office_pending'); assert.equal(detail.mode, 'conversation');
    assert.equal(detail.reception.sessionId, reception.session); assert.equal(detail.reception.state, 'indeterminate');
    assert.equal(detail.reception.registration.state, 'indeterminate'); assert.equal(detail.reception.transfer.state, 'indeterminate');
    assert.equal(detail.reception.conversation.outcome, 'unknown'); assert.equal(detail.smsProof, 'not_confirmed'); assert.equal(detail.confirmedAt, null);
    const expired = Date.parse(detail.reception.conversation.contentExpiresAt) <= Date.now() || slug.endsWith('-b');
    assert.equal(detail.reception.conversation.contentExpired, expired);
    if (expired) {
      assert.equal(detail.reception.conversation.facts, null); assert.equal(detail.reception.conversation.summary, null);
    } else {
      assert.equal(detail.reception.conversation.facts.serviceIntent, 'repair');
      assert.match(detail.reception.conversation.facts.problem, /^SYNTHETIC:/);
      assert.match(detail.reception.conversation.summary, /^FICTIONAL/);
    }
    assert.doesNotMatch(JSON.stringify(detail), /capabilityHash|capability_hash|secret__|registration_twiml|SYNTHETIC_RECEPTION_NO_CREDENTIAL/);
    assert.equal((await fetch(`${origin}/api/v1/communications/callie/${otherReception.intake}`, { headers: receptionHeaders })).status, 404);
    const update = await fetch(`${origin}/api/v1/communications/callie/reception/binding`, { method: 'POST', headers: { ...receptionHeaders, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(update.status, 405); await update.arrayBuffer();
    assert.equal(databaseFailed, false);
  }
  let workdayReadChecks = 0;
  for (const [index,slug] of WORKDAY_RECOVERY_SLUGS.entries()) {
    const workday=workdayFixtureIds(slug), foreign=workdayFixtureIds(WORKDAY_RECOVERY_SLUGS[1-index]);
    const workHeaders={authorization:`Bearer ${workday.authSession}`};
    const read=async path=>{
      const response=await fetch(`${origin}${path}`,{headers:workHeaders});
      assert.equal(response.status,200,path); assert.equal(response.headers.get('cache-control'),'no-store');
      workdayReadChecks++; return response.json();
    };
    check=`workday_${index}_assets`;
    const assets=await read(`/api/v1/contacts/${workday.contact}/assets`);
    assert.equal(assets.organizationId,workday.organization); assert.equal(assets.items.length,2);
    assert.ok(assets.items.some(row=>row.id===workday.retiredAsset && row.status==='retired'));
    const catalog=await read('/api/v1/work-checklists');
    assert.equal(catalog.organizationId,workday.organization); assert.equal(catalog.starters.length,2);
    const template=await read(`/api/v1/work-checklists/${workday.template}`);
    assert.equal(template.latestRevision.version,2); assert.equal(template.approvedRevision.id,workday.newRevision);
    check=`workday_${index}_completed_history`;
    const completed=await read(`/api/v1/appointments/${workday.completedVisit}/work`);
    assert.equal(completed.organizationId,workday.organization); assert.equal(completed.completion.id,workday.completion);
    assert.equal(completed.completion.outcome,'needs_followup'); assert.equal(completed.completion.followupTaskId,workday.followupTask);
    assert.equal(completed.entries.length,2); assert.ok(completed.entries.every(row=>row.checklist.version===1 && row.state==='finalized'));
    assert.equal(completed.entries.find(row=>row.id===workday.secondEntry).assetSnapshot.label,'FICTIONAL historical unit / area');
    assert.equal(completed.corrections[0].originalCompletionId,workday.completion);
    assert.equal(completed.completion.services[0].nextObligationId,workday.nextService);
    assert.equal(completed.capabilities.canComplete,false);
    assert.doesNotMatch(JSON.stringify(completed),/PRIVATE SYNTHETIC token|payloadSha256|reservedObjectId|tasksBefore|nativeBefore/);
    const stale=await read(`/api/v1/appointments/${workday.staleVisit}/work`);
    assert.equal(stale.entries[0].state,'draft'); assert.ok(stale.entries[0].holdReasons.includes('workday_asset_changed'));
    assert.equal(stale.entries[0].answers.length,0); assert.equal(stale.entries[0].photos[0].available,false);
    const ready=await read(`/api/v1/appointments/${workday.readyVisit}/work`);
    assert.equal(ready.entries.length,0); assert.equal(ready.completion,null);
    check=`workday_${index}_private_photo`;
    const photo=await fetch(`${origin}/api/v1/appointments/${workday.completedVisit}/work/photos/${workday.photo}/content`,{headers:workHeaders});
    assert.equal(photo.status,200); assert.equal(photo.headers.get('content-type'),'image/png');
    assert.equal(photo.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()),WORKDAY_FIXTURE_PNG); workdayReadChecks++;
    for (const path of [`/api/v1/contacts/${foreign.contact}/assets`,`/api/v1/work-checklists/${foreign.template}`,`/api/v1/appointments/${foreign.completedVisit}/work`,`/api/v1/appointments/${workday.completedVisit}/work/photos/${foreign.photo}/content`]) {
      const denied=await fetch(`${origin}${path}`,{headers:workHeaders}); assert.equal(denied.status,404); await denied.arrayBuffer();
    }
    const deniedWrite=await fetch(`${origin}/api/v1/appointments/${workday.readyVisit}/work/entries`,{method:'POST',headers:{...workHeaders,'content-type':'application/json'},body:'{}'});
    assert.equal(deniedWrite.status,405); await deniedWrite.arrayBuffer();
    assert.equal(databaseFailed,false);
  }
  let returningReadChecks=0;
  for(const[index,slug]of ['restore-drill-contractor-a','restore-drill-contractor-b'].entries()){
    const returning=returningCustomerIds(slug),foreign=returningCustomerIds(index?'restore-drill-contractor-a':'restore-drill-contractor-b');
    const workHeaders={authorization:`Bearer ${(index?'b':'a').repeat(64)}`};
    const read=async path=>{const response=await fetch(`${origin}${path}`,{headers:workHeaders});assert.equal(response.status,200,path);returningReadChecks++;return response.json();};
    check=`returning_${index}_canonical_customer`;
    const workspace=await read(`/api/v1/contacts/${returning.contact}/workspace`);
    assert.equal(workspace.contact.id,returning.contact);assert.equal(workspace.availableSections.length,9);
    const estimates=await read(`/api/v1/contacts/${returning.contact}/workspace/estimates`);
    assert.equal(estimates.items.length,1);assert.equal(estimates.items[0].leadId,null);assert.equal(estimates.items[0].customerWorkId,returning.quoteRoot);
    const projects=await read(`/api/v1/contacts/${returning.contact}/workspace/projects`);
    assert.deepEqual(projects.items.map(row=>row.id).sort(),[returning.project,returning.directProject].sort());
    const invoices=await read(`/api/v1/contacts/${returning.contact}/workspace/invoices`);
    assert.deepEqual(invoices.items.map(row=>row.id).sort(),[returning.invoice,returning.standaloneInvoice].sort());
    const estimate=await read(`/api/v1/estimates/${returning.estimate}`);
    assert.equal(estimate.customerWorkId,returning.quoteRoot);assert.equal(estimate.contactId,returning.contact);assert.equal(estimate.workVersion,2);
    for(const[projectId,root]of [[returning.project,returning.quoteRoot],[returning.directProject,returning.jobRoot]]){
      const project=await read(`/api/v1/projects/${projectId}`);assert.equal(project.leadId,null);assert.equal(project.customerWorkId,root);assert.equal(project.contactId,returning.contact);
    }
    for(const[invoiceId,paid,balance]of [[returning.invoice,9000,11000],[returning.standaloneInvoice,7000,3000]]){
      const invoice=await read(`/api/v1/invoices/${invoiceId}`);assert.equal(invoice.leadId,null);assert.equal(invoice.contactId,returning.contact);assert.equal(invoice.recordedPaidCents,paid);assert.equal(invoice.recordedBalanceCents,balance);assert.equal(invoice.reconciliationRequired,false);
    }
    check=`returning_${index}_held_v3_history`;
    const delivery=await read(`/api/v1/invoices/${returning.invoice}/delivery`);
    assert.equal(delivery.latestExecutionId,returning.execution);assert.equal(delivery.state,'uncertain');
    assert.equal(delivery.integrity,'valid');assert.equal(delivery.attemptCount,1);
    assert.equal(delivery.canPrepare,false);assert.deepEqual(delivery.nextIntents,[]);
    const ledger=await read('/api/v1/revenue/value');
    assert.equal(ledger.sourceBreakdown.find(row=>row.source==='customer_work').netReceiptsCents,16000);
    assert.ok(ledger.entries.filter(row=>row.customerWorkId).every(row=>row.leadId===null&&row.contactId===returning.contact));
    const today=await read('/api/v1/contractor/today?date=2026-10-06&scope=company');
    const direct=today.projects.items.find(row=>row.id===returning.directProject);assert.equal(direct.contactId,returning.contact);assert.equal(direct.customerWorkId,returning.jobRoot);assert.equal(direct.leadId,null);
    for(const path of [`/api/v1/contacts/${foreign.contact}/workspace`,`/api/v1/projects/${foreign.project}`,`/api/v1/invoices/${foreign.invoice}`]){const response=await fetch(`${origin}${path}`,{headers:workHeaders});assert.equal(response.status,404);await response.arrayBuffer();}
    const write=await fetch(`${origin}/api/v1/customer-work/projects`,{method:'POST',headers:{...workHeaders,'content-type':'application/json'},body:'{}'});assert.equal(write.status,405);await write.arrayBuffer();
    assert.equal(databaseFailed,false);
  }
  process.stdout.write(`${JSON.stringify({ appBootVerified: true, readOnlyDatabaseVerified: true, readOnlySchedulingHeldVerified:true, restoredSchedulingExplanationPostStatus: explanation.status, restoredSchedulingExplanationSucceeded: explanation.ok, tenantBoundariesVerified: true, customerWorkspaceVerified: true, callieConversationReadVerified: true, workdayReadVerified: true, returningCustomerReadVerified:true, returningV3UnknownReadVerified:true, readChecks: good.length + receptionReadChecks + workdayReadChecks + returningReadChecks, writeBlocked: true })}\n`);
  }
} catch (error) {
  // No response body, URL with credentials, SQL parameters or record content.
  const step=globalThis.__contractorProbeStep??check;
  if(readerContext) process.stderr.write(`CONTRACTOR_READER_DIAGNOSTIC:${JSON.stringify({...readerContext,step,sqlstate:databaseFailureCode??null,queryClass:databaseFailureClass??null})}\n`);
  process.stderr.write(`CONTRACTOR_APP_PROBE_FAILED:${step}:${error.code === 'ERR_ASSERTION' ? 'assertion' : 'unavailable'}${Number.isInteger(error.actual) ? `:status_${error.actual}` : ''}${databaseFailureCode?`:sql_${databaseFailureCode}`:/^[A-Z0-9]{5}$/.test(error.code??'')?`:sql_${error.code}`:''}\n`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((done) => server.close(done));
  await pool.end();
}
