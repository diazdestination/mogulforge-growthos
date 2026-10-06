/** Synthetic CALLIE v2 durability only. Uses the supplied query client and codec.
 * No database construction, provider SDK, credentials, network or customer identity. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';

export const CALLIE_CONVERSATION_RECOVERY_SLUGS = Object.freeze(['restore-drill-reception-a', 'restore-drill-reception-b']);
const DAY = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const jsonHash = value => hash(JSON.stringify(canonical(value)));
const iso = value => new Date(value).toISOString();
const add = (value, milliseconds) => new Date(Date.parse(value) + milliseconds).toISOString();
const credentialSlot = 'SYNTHETIC_RECEPTION_NO_CREDENTIAL';
const voiceFlags = ['launch_approved', 'sms_enabled', 'registration_approved', 'advanced_opt_out', 'voice_enabled', 'voice_approved', 'geo_permissions_reviewed'];

export function callieConversationFixtureIds(namespace) {
  assert.match(namespace, /^[a-z0-9][a-z0-9-]{1,100}$/);
  const names = ['organization', 'user', 'voiceBinding', 'binding', 'policy', 'disabledPolicy', 'review', 'disabledReview', 'call', 'intake', 'task', 'handoff', 'session', 'registration', 'transfer', 'event', 'registrationClaimEvent', 'registrationUnknownEvent', 'transferClaimEvent', 'transferUnknownEvent', 'duplicateEvent'];
  const ids = Object.fromEntries(names.map(name => {
    const value = hash(`callie-conversation-recovery-v1:${namespace}:${name}`);
    return [name, `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`];
  }));
  return { ...ids, authSession: hash(`callie-conversation-recovery-v1:${namespace}:auth-session`) };
}

function recoverySpec(slug) {
  assert.ok(CALLIE_CONVERSATION_RECOVERY_SLUGS.includes(slug), 'reception_recovery_requires_exact_fictional_slug');
  const purged = slug.endsWith('-b');
  return {
    namespace: slug, purged, trade: purged ? 'hvac' : 'roofing',
    stamp: purged ? '2026-09-27T12:00:00.000Z' : '2026-10-05T12:00:00.000Z',
    purgedAt: purged ? '2026-10-05T12:00:00.000Z' : null,
  };
}

export const CALLIE_CONVERSATION_COUNTS = Object.freeze({
  organizations: 1, users: 1, sessions: 1, twilio_client_bindings: 1,
  callie_reception_bindings: 1, audit_events: 2, callie_policy_revisions: 2,
  twilio_calls: 1, crm_tasks: 1, missed_call_handoffs: 1, callie_intakes: 1,
  revenue_executions: 2, revenue_execution_events: 4,
  callie_reception_sessions: 1, callie_reception_events: 1,
});

async function insert(database, table, values) {
  const columns = Object.keys(values);
  // The table/column names are local literals, never caller or provider input.
  assert.match(table, /^[a-z_][a-z0-9_]*$/); columns.forEach(column => assert.match(column, /^[a-z_][a-z0-9_]*$/));
  await database.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(values));
}

function callerFacts(trade) {
  return {
    callerName: 'FICTIONAL unverified caller', describedLocation: '0 FICTIONAL QA Lane, Test City',
    problem: trade === 'hvac' ? 'SYNTHETIC: requests an HVAC maintenance visit; coverage is unverified.' : 'SYNTHETIC: roof leak described by caller; the office must verify details.',
    serviceIntent: trade === 'hvac' ? 'maintenance' : 'repair', requestIntent: 'visit', urgency: 'unspecified', callbackPreference: 'Caller requests a morning callback; no time agreed.',
  };
}

function fixtureContent(spec) {
  const facts = callerFacts(spec.trade);
  return { facts, summary: `FICTIONAL ${spec.trade === 'hvac' ? 'HVAC maintenance' : 'roof repair'} request. Caller statements only; identity, coverage and visit remain unconfirmed.`, eventKey: 'tool:synthetic_facts_v1' };
}

async function assertSyntheticMember(database, org, actor) {
  const [row] = (await database.query(`SELECT u.email,u.is_active,u.email_verified_at,u.role,o.slug,o.name FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2`, [actor, org])).rows;
  assert.ok(row && row.email.endsWith('@example.invalid') && row.is_active && row.email_verified_at && row.role === 'owner', 'reception_fixture_requires_verified_synthetic_owner');
  assert.ok(CALLIE_CONVERSATION_RECOVERY_SLUGS.includes(row.slug) || row.slug === 'local-runtime-qa', 'reception_fixture_requires_isolated_synthetic_company');
  return row;
}

async function disabledVoice(database, org, id, spec) {
  let [binding] = (await database.query('SELECT * FROM twilio_client_bindings WHERE organization_id=$1', [org])).rows;
  if (!binding) {
    const suffix = spec.namespace.endsWith('-b') ? '93' : spec.namespace.startsWith('preview-') ? '95' : '91';
    const value = {
      id: id.voiceBinding, organization_id: org, account_sid: `AC${hash(`${spec.namespace}:voice`).slice(0, 32)}`,
      phone_number: `+120255501${suffix}`, staff_phone: '+12025550190', auth_token_secret_ref: 'SYNTHETIC_RECEPTION_NO_SECRET',
      public_origin: 'https://example.invalid', business_name: `FICTIONAL ${spec.trade === 'hvac' ? 'HVAC' : 'Roofing'} Reception QA`,
      daily_sms_limit: 0, daily_call_limit: 0, ...Object.fromEntries(voiceFlags.map(flag => [flag, false])), created_at: spec.stamp, updated_at: spec.stamp,
    };
    await insert(database, 'twilio_client_bindings', value); binding = value;
  }
  voiceFlags.forEach(flag => assert.equal(binding[flag], false, `synthetic voice gate ${flag}`));
  assert.equal(binding.daily_sms_limit, 0); assert.equal(binding.daily_call_limit, 0);
  assert.match(binding.staff_phone ?? '', /^\+1[2-9]\d{9}$/, 'reception_fixture_existing_voice_staff_identity_incomplete');
  assert.match(binding.phone_number, /^\+1[2-9]\d{9}$/);
  assert.match(binding.auth_token_secret_ref, /^SYNTHETIC_/, 'reception_fixture_refuses_real_voice_credential_reference');
  assert.equal(new URL(binding.public_origin).hostname, 'example.invalid');
  return { id: binding.id, accountSid: binding.account_sid, sender: binding.phone_number, staffPhone: binding.staff_phone, origin: binding.public_origin, businessName: binding.business_name };
}

/** Shared additive seed for the two recovery tenants or the guarded local preview.
 * An existing voice binding is reused only if its exact synthetic identity is
 * complete, all activation flags are false, and both budgets remain zero. */
export async function seedSyntheticCallieConversation(database, { namespace, organizationId: org, actorUserId: actor, codec, stamp = '2026-10-05T12:00:00.000Z', purged = false, purgedAt = null, trade = 'roofing' }) {
  assert.ok(database?.query && codec?.encrypt && codec?.decrypt && codec?.wrongKeyRejects, 'reception_fixture_requires_query_client_and_credential_codec');
  assert.ok(trade === 'roofing' || trade === 'hvac'); assert.equal(purged, purgedAt !== null);
  const id = callieConversationFixtureIds(namespace), spec = { namespace, stamp: iso(stamp), purged, purgedAt: purgedAt && iso(purgedAt), trade };
  await assertSyntheticMember(database, org, actor);
  const voice = await disabledVoice(database, org, id, spec);
  const { buildReceptionSnapshot, DEFAULT_CALLIE_RECEPTION } = await tsImport('../artifacts/api-server/src/services/callie-reception-contract.ts', import.meta.url);
  const pin = { id: id.binding, version: 1, enabled: false, agentId: `synthetic_agent_${hash(namespace).slice(0, 16)}`, agentVersionId: 'synthetic_expected_version_v1', branchId: 'synthetic_branch_v1', environment: 'staging', credentialKey: credentialSlot, configurationSha256: hash(`synthetic-configuration:${namespace}`) };
  await insert(database, 'callie_reception_bindings', { id: id.binding, organization_id: org, version: 1, enabled: false, agent_id: pin.agentId, agent_version_id: pin.agentVersionId, branch_id: pin.branchId, environment: pin.environment, credential_key: pin.credentialKey, configuration_sha256: pin.configurationSha256, updated_by_user_id: actor, created_at: spec.stamp, updated_at: spec.stamp });
  const policy = { ...DEFAULT_CALLIE_RECEPTION, enabled: true, days: [1, 2, 3, 4, 5, 6], businessHoursOwnerId: actor, afterHoursOwnerId: actor,
    businessFacts: `FICTIONAL ${trade === 'hvac' ? 'HVAC maintenance' : 'roof repair'} requests only. The office verifies identity, coverage and availability.`,
    callerDisclosure: 'SYNTHETIC QA: CALLIE is a virtual assistant. Caller statements are unverified; no booking, coverage or emergency arrival is confirmed.',
    maxConversationSeconds: 300, maxToolCalls: 8, retentionDays: 7, businessHoursTransferPhone: '+12025550190', afterHoursTransferPhone: null };
  const [head] = (await database.query('SELECT coalesce(max(version),0)::int AS version FROM callie_policy_revisions WHERE organization_id=$1', [org])).rows;
  const firstVersion = Number(head.version) + 1;
  for (const enabled of [true, false]) {
    const snapshot = buildReceptionSnapshot({ ...policy, enabled }, voice, pin), review = enabled ? id.review : id.disabledReview;
    const reviewHash = jsonHash({ namespace, snapshot, syntheticOnly: true });
    await insert(database, 'audit_events', { id: review, organization_id: org, actor_user_id: actor, action: 'callie.reception.previewed', entity_type: 'organization', entity_id: org, metadata: JSON.stringify({ payloadHash: reviewHash, snapshot, syntheticOnly: true }), created_at: spec.stamp });
    await insert(database, 'callie_policy_revisions', { id: enabled ? id.policy : id.disabledPolicy, organization_id: org, version: firstVersion + (enabled ? 0 : 1), enabled, snapshot: JSON.stringify(snapshot), review_id: review, review_payload_hash: reviewHash, approved_by_user_id: actor, approved_at: spec.stamp, created_at: spec.stamp });
  }
  const fromPhone = '+12025550189', providerSid = `CA${hash(`${namespace}:call`).slice(0, 32)}`, dueAt = add(spec.stamp, 30 * 60_000);
  await insert(database, 'twilio_calls', { id: id.call, organization_id: org, request_key: `synthetic-reception:${namespace}`, direction: 'inbound', phone: fromPhone, staff_phone: voice.staffPhone, account_sid: voice.accountSid, provider_sid: providerSid, status: 'completed', dial_status: 'no-answer', authorization_source: 'synthetic_fixture', created_at: spec.stamp, updated_at: spec.stamp });
  const taskDescription = 'SYNTHETIC office-owned note: verify the actual caller and agree next steps. Unknown original effects must not be retried. Do not replace this staff note with caller text.';
  await insert(database, 'crm_tasks', { id: id.task, organization_id: org, title: 'FICTIONAL CALLIE: office follow-up retained', description: taskDescription, status: 'in_progress', priority: 'high', assigned_user_id: actor, due_at: dueAt, source_event: 'missed_call', created_at: spec.stamp, updated_at: add(spec.stamp, 4 * 60_000) });
  await insert(database, 'missed_call_handoffs', { id: id.handoff, organization_id: org, call_id: id.call, task_id: id.task, created_at: spec.stamp });
  const { facts, summary, eventKey } = fixtureContent(spec);
  await insert(database, 'callie_intakes', { id: id.intake, organization_id: org, call_id: id.call, policy_revision_id: id.policy, version: 2, mode: 'conversation', state: 'office_pending', stage: 'complete', binding_id: voice.id, account_sid: voice.accountSid, provider_call_sid: providerSid, from_phone: fromPhone, called_number: voice.sender, owner_user_id: actor, due_at: dueAt, service_intent: facts.serviceIntent, request_intent: 'visit', step_receipts: '[]', reason: 'synthetic_original_effect_unknown', created_at: spec.stamp, updated_at: add(spec.stamp, 2 * 60_000) });
  const registrationKey = `callie:${id.call}:conversation:v1`, transferKey = `callie:${id.call}:human-transfer:v1`;
  for (const [kind, key, receipt, claimEvent, unknownEvent] of [['registration', registrationKey, id.registration, id.registrationClaimEvent, id.registrationUnknownEvent], ['transfer', transferKey, id.transfer, id.transferClaimEvent, id.transferUnknownEvent]]) {
    await insert(database, 'revenue_executions', { id: receipt, organization_id: org, action_key: key, fingerprint: hash(`${namespace}:${kind}:original`), kind: `callie_reception_${kind}`, state: 'indeterminate', detail: 'SYNTHETIC original effect unknown. Permanent reservation; no retry.', actor_user_id: actor, expires_at: add(spec.stamp, 60_000), created_at: spec.stamp, completed_at: add(spec.stamp, 3 * 60_000) });
    for (const [state, eventId] of [['processing', claimEvent], ['indeterminate', unknownEvent]]) await insert(database, 'revenue_execution_events', { id: eventId, organization_id: org, execution_id: receipt, state, detail: 'Synthetic call-scoped effect evidence only; no provider was contacted.', actor_user_id: actor, created_at: spec.stamp });
  }
  const context = suffix => `callie-reception:${org}:${id.session}:${suffix}`, contentExpiresAt = add(spec.stamp, policy.retentionDays * DAY), conversationId = `synthetic_conversation_${hash(namespace).slice(0, 16)}`;
  assert.ok(!purged || Date.parse(spec.purgedAt) >= Date.parse(contentExpiresAt), 'reception_fixture_purge_precedes_expiry');
  await insert(database, 'callie_reception_sessions', { id: id.session, organization_id: org, intake_id: id.intake, call_id: id.call, policy_revision_id: id.policy, intake_mode: 'conversation', reception_binding_id: id.binding, state: 'indeterminate', reason: 'synthetic_registration_result_unknown', agent_id: pin.agentId, agent_version_id: pin.agentVersionId, environment: pin.environment,
    conversation_id: conversationId, conversation_bound_at: add(spec.stamp, 30_000), capability_hash: purged ? null : hash(`synthetic-expired-capability:${namespace}`), capability_expires_at: purged ? null : add(spec.stamp, policy.maxConversationSeconds * 1000),
    registration_receipt_id: id.registration, registration_key: registrationKey, registration_accepted_at: null, dispatch_started_at: add(spec.stamp, 1000), tools_used: 2,
    facts_encrypted: purged ? null : codec.encrypt(JSON.stringify(facts), context('facts')), summary_encrypted: purged ? null : codec.encrypt(summary, context('summary')), content_expires_at: contentExpiresAt, content_purged_at: spec.purgedAt, conversation_outcome: 'unknown', ended_at: add(spec.stamp, 3 * 60_000),
    transfer_receipt_id: id.transfer, transfer_key: transferKey, transfer_state: 'indeterminate', transfer_target: policy.businessHoursTransferPhone, transfer_requested_at: add(spec.stamp, 60_000), transfer_dispatch_started_at: add(spec.stamp, 61_000), transfer_accepted_at: null, transfer_child_call_sid: null, transfer_completed_at: null, created_at: spec.stamp, updated_at: add(spec.stamp, 3 * 60_000) });
  const payloadHash = jsonHash({ action: 'save_facts', requestId: 'synthetic_facts_v1', agentId: pin.agentId, conversationId, facts });
  await insert(database, 'callie_reception_events', { id: id.event, organization_id: org, session_id: id.session, event_key: eventKey, kind: 'save_facts', payload_hash: payloadHash, content_encrypted: purged ? null : codec.encrypt(JSON.stringify(facts), context(`event:${eventKey}`)), content_expires_at: contentExpiresAt, content_purged_at: spec.purgedAt, created_at: add(spec.stamp, 60_000) });
  return { namespace, ids: { ...id, organization: org, user: actor, voiceBinding: voice.id }, policyVersions: [firstVersion, firstVersion + 1], contentExpiresAt, contentPurgedAt: spec.purgedAt, taskDescription, eventKey, payloadHash, registrationKey, transferKey, facts, summary, contentContextPrefix: `callie-reception:${org}:${id.session}`, providerConnected: false };
}

/** Adds NEW isolated reception tenants, leaving legacy recovery tenants untouched. */
export async function seedCallieConversationRecovery(database, slug, codec) {
  const spec = recoverySpec(slug), id = callieConversationFixtureIds(slug), email = `${slug}.owner@example.invalid`;
  await insert(database, 'organizations', { id: id.organization, name: `FICTIONAL CALLIE Recovery ${slug.endsWith('-b') ? 'B HVAC' : 'A Roofing'}`, slug, timezone: 'America/New_York', created_at: spec.stamp, updated_at: spec.stamp });
  await insert(database, 'users', { id: id.user, organization_id: id.organization, email, first_name: 'FICTIONAL', last_name: 'Reception Recovery Owner', password_hash: null, email_verified_at: spec.stamp, role: 'owner', is_active: true, is_platform_admin: false, created_at: spec.stamp, updated_at: spec.stamp });
  const expiresAt = new Date(Date.now() + DAY).toISOString();
  await insert(database, 'sessions', { sid: id.authSession, sess: JSON.stringify({ user: { id: id.user, email, firstName: 'FICTIONAL', lastName: 'Reception Recovery Owner', profileImageUrl: null }, access_token: 'synthetic-no-provider' }), expire: expiresAt });
  const manifest = await seedSyntheticCallieConversation(database, { ...spec, organizationId: id.organization, actorUserId: id.user, codec });
  return { ...manifest, authSession: { sid: id.authSession, expiresAt }, counts: CALLIE_CONVERSATION_COUNTS };
}

/** SELECT/decrypt-only proof: expiry, uncertainty and staff-owned work survive restore. */
export async function assertCallieConversationRecovery(database, slug, codec) {
  const spec = recoverySpec(slug), id = callieConversationFixtureIds(slug), content = fixtureContent(spec), expectedExpiry = add(spec.stamp, 7 * DAY);
  const member = await assertSyntheticMember(database, id.organization, id.user); assert.equal(member.slug, slug);
  const [row] = (await database.query(`SELECT s.*,i.mode,i.state AS intake_state,i.stage,i.version AS intake_version,i.owner_user_id,i.due_at AS intake_due,i.service_intent,i.request_intent,i.callback_window,i.appointment_id,i.step_receipts,i.challenge_hash,i.challenge_encrypted,i.challenge_expires_at,i.trigger_message_sid,i.trigger_account_sid,i.trigger_from,i.trigger_to,i.trigger_payload_hash,i.confirmed_at,i.grant_expires_at,
    t.status AS task_status,t.assigned_user_id,t.description AS task_description,t.due_at AS task_due,t.updated_at AS task_updated,t.contact_id AS task_contact,t.lead_id AS task_lead,
    h.task_id,h.reviewed_at,h.contact_id,h.lead_id,
    r.state AS registration_state,r.kind AS registration_kind,r.action_key AS original_registration_key,r.actor_user_id AS registration_actor,r.expires_at AS registration_expiry,r.fingerprint AS registration_fingerprint,
    x.state AS original_transfer_state,x.kind AS transfer_kind,x.action_key AS original_transfer_key,x.actor_user_id AS transfer_actor,x.expires_at AS transfer_expiry,x.fingerprint AS transfer_fingerprint
    FROM callie_reception_sessions s JOIN callie_intakes i ON i.organization_id=s.organization_id AND i.id=s.intake_id
    JOIN missed_call_handoffs h ON h.organization_id=s.organization_id AND h.call_id=s.call_id JOIN crm_tasks t ON t.organization_id=h.organization_id AND t.id=h.task_id
    JOIN revenue_executions r ON r.organization_id=s.organization_id AND r.id=s.registration_receipt_id JOIN revenue_executions x ON x.organization_id=s.organization_id AND x.id=s.transfer_receipt_id
    WHERE s.organization_id=$1 AND s.id=$2`, [id.organization, id.session])).rows;
  assert.ok(row, 'reception_recovery_original_record_missing');
  assert.equal(row.call_id, id.call); assert.equal(row.intake_id, id.intake); assert.equal(row.policy_revision_id, id.policy); assert.equal(row.reception_binding_id, id.binding);
  assert.equal(row.mode, 'conversation'); assert.equal(row.intake_mode, 'conversation'); assert.equal(row.intake_state, 'office_pending'); assert.equal(row.stage, 'complete'); assert.equal(row.intake_version, 2);
  assert.equal(row.owner_user_id, id.user); assert.equal(row.assigned_user_id, id.user); assert.equal(row.task_id, id.task); assert.equal(row.task_status, 'in_progress');
  assert.equal(row.task_description, 'SYNTHETIC office-owned note: verify the actual caller and agree next steps. Unknown original effects must not be retried. Do not replace this staff note with caller text.');
  assert.equal(iso(row.task_updated), add(spec.stamp, 4 * 60_000)); assert.equal(iso(row.task_due), add(spec.stamp, 30 * 60_000)); assert.equal(iso(row.intake_due), iso(row.task_due));
  for (const field of ['task_contact', 'task_lead', 'contact_id', 'lead_id', 'reviewed_at', 'appointment_id', 'callback_window', 'challenge_hash', 'challenge_encrypted', 'challenge_expires_at', 'trigger_message_sid', 'trigger_account_sid', 'trigger_from', 'trigger_to', 'trigger_payload_hash', 'confirmed_at', 'grant_expires_at']) assert.equal(row[field], null, field);
  assert.deepEqual(row.step_receipts, []); assert.equal(row.request_intent, 'visit'); assert.equal(row.service_intent, content.facts.serviceIntent);
  assert.equal(row.state, 'indeterminate'); assert.equal(row.registration_state, 'indeterminate'); assert.equal(row.original_transfer_state, 'indeterminate'); assert.equal(row.transfer_state, 'indeterminate');
  assert.equal(row.registration_receipt_id, id.registration); assert.equal(row.transfer_receipt_id, id.transfer);
  assert.equal(row.registration_kind, 'callie_reception_registration'); assert.equal(row.transfer_kind, 'callie_reception_transfer');
  assert.equal(row.registration_key, `callie:${id.call}:conversation:v1`); assert.equal(row.original_registration_key, row.registration_key);
  assert.equal(row.transfer_key, `callie:${id.call}:human-transfer:v1`); assert.equal(row.original_transfer_key, row.transfer_key);
  for (const kind of ['registration', 'transfer']) {
    assert.equal(row[`${kind}_actor`], id.user); assert.equal(iso(row[`${kind}_expiry`]), add(spec.stamp, 60_000));
    assert.equal(row[`${kind}_fingerprint`], hash(`${slug}:${kind}:original`));
  }
  const executionEvents = (await database.query('SELECT id,execution_id,state,actor_user_id FROM revenue_execution_events WHERE organization_id=$1', [id.organization])).rows;
  assert.equal(executionEvents.length, 4);
  for (const [eventId, executionId, state] of [[id.registrationClaimEvent, id.registration, 'processing'], [id.registrationUnknownEvent, id.registration, 'indeterminate'], [id.transferClaimEvent, id.transfer, 'processing'], [id.transferUnknownEvent, id.transfer, 'indeterminate']]) {
    assert.deepEqual(executionEvents.find(event => event.id === eventId), { id: eventId, execution_id: executionId, state, actor_user_id: id.user });
  }
  assert.equal(row.transfer_target, '+12025550190'); assert.equal(row.registration_accepted_at, null); assert.equal(row.transfer_accepted_at, null); assert.equal(row.transfer_child_call_sid, null);
  assert.equal(iso(row.content_expires_at), expectedExpiry); assert.equal(row.content_purged_at && iso(row.content_purged_at), spec.purgedAt);
  const events = (await database.query('SELECT * FROM callie_reception_events WHERE organization_id=$1 AND session_id=$2', [id.organization, id.session])).rows;
  assert.equal(events.length, 1); const event = events[0]; assert.equal(event.id, id.event); assert.equal(event.event_key, content.eventKey); assert.equal(event.kind, 'save_facts');
  assert.equal(iso(event.content_expires_at), expectedExpiry); assert.equal(event.content_purged_at && iso(event.content_purged_at), spec.purgedAt);
  assert.equal(event.payload_hash, jsonHash({ action: 'save_facts', requestId: 'synthetic_facts_v1', agentId: row.agent_id, conversationId: row.conversation_id, facts: content.facts }));
  for (const [cipher, suffix, expected] of [[row.facts_encrypted, 'facts', JSON.stringify(content.facts)], [row.summary_encrypted, 'summary', content.summary], [event.content_encrypted, `event:${content.eventKey}`, JSON.stringify(content.facts)]]) {
    if (spec.purged) { assert.equal(cipher, null); continue; }
    const context = `callie-reception:${id.organization}:${id.session}:${suffix}`;
    assert.ok(cipher && !cipher.includes('FICTIONAL') && !cipher.includes('SYNTHETIC'));
    assert.equal(codec.decrypt(cipher, context), expected); assert.equal(codec.wrongKeyRejects(cipher, context), true);
    assert.throws(() => codec.decrypt(cipher, `${context}:wrong`));
    assert.throws(() => codec.decrypt(cipher, `callie-reception:${callieConversationFixtureIds(CALLIE_CONVERSATION_RECOVERY_SLUGS.find(value => value !== slug)).organization}:${id.session}:${suffix}`));
  }
  if (spec.purged) { assert.equal(row.capability_hash, null); assert.equal(row.capability_expires_at, null); }
  else { assert.equal(row.capability_hash, hash(`synthetic-expired-capability:${slug}`)); assert.equal(iso(row.capability_expires_at), add(spec.stamp, 300_000)); }
  const policies = (await database.query('SELECT * FROM callie_policy_revisions WHERE organization_id=$1 ORDER BY version', [id.organization])).rows;
  assert.equal(policies.length, 2); assert.deepEqual(policies.map(policy => [policy.version, policy.enabled, policy.snapshot.enabled, policy.snapshot.mode]), [[1, true, true, 'conversation'], [2, false, false, 'conversation']]);
  const { buildReceptionSnapshot } = await tsImport('../artifacts/api-server/src/services/callie-reception-contract.ts', import.meta.url);
  for (const policy of policies) {
    const { templateVersion, toolVersion, voiceBinding, receptionBinding, prompt, ...settings } = policy.snapshot;
    assert.deepEqual(buildReceptionSnapshot(settings, voiceBinding, receptionBinding), policy.snapshot); assert.equal(policy.approved_by_user_id, id.user);
    assert.equal(policy.review_payload_hash, jsonHash({ namespace: slug, snapshot: policy.snapshot, syntheticOnly: true }));
    assert.equal(settings.retentionDays, 7); assert.equal(settings.maxConversationSeconds, 300); assert.equal(settings.maxToolCalls, 8);
    assert.equal(settings.businessHoursTransferPhone, '+12025550190'); assert.equal(settings.afterHoursTransferPhone, null);
  }
  const [binding] = (await database.query('SELECT * FROM callie_reception_bindings WHERE organization_id=$1', [id.organization])).rows;
  assert.equal(binding.id, id.binding); assert.equal(binding.enabled, false); assert.equal(binding.credential_key, credentialSlot); assert.equal(binding.updated_by_user_id, id.user);
  const [voice] = (await database.query('SELECT * FROM twilio_client_bindings WHERE organization_id=$1', [id.organization])).rows;
  voiceFlags.forEach(flag => assert.equal(voice[flag], false)); assert.equal(voice.daily_sms_limit, 0); assert.equal(voice.daily_call_limit, 0);
  const [auth] = (await database.query('SELECT sess FROM sessions WHERE sid=$1', [id.authSession])).rows;
  assert.equal(auth.sess.user.id, id.user); assert.equal(auth.sess.user.email, `${slug}.owner@example.invalid`); assert.equal(auth.sess.access_token, 'synthetic-no-provider');
  for (const [table, expected] of Object.entries(CALLIE_CONVERSATION_COUNTS)) {
    if (['organizations', 'sessions'].includes(table)) continue;
    assert.equal(Number((await database.query(`SELECT count(*)::int AS count FROM ${table} WHERE organization_id=$1`, [id.organization])).rows[0].count), expected, `reception fixture count ${table}`);
  }
  for (const table of ['contacts', 'leads', 'appointments', 'twilio_inbound_events', 'callie_ack_dispatches']) assert.equal(Number((await database.query(`SELECT count(*)::int AS count FROM ${table} WHERE organization_id=$1`, [id.organization])).rows[0].count), 0, `no synthetic identity or SMS in ${table}`);
  return { slug, ids: id, counts: CALLIE_CONVERSATION_COUNTS, originalKeys: [row.registration_key, row.transfer_key], rawContentExpiresAt: expectedExpiry, contentPurged: spec.purged, encryptedFieldsVerified: spec.purged ? 0 : 3, unknownEffectsPreserved: 2, disabledPolicyHeadPreserved: true, staffWorkPreserved: true, eventPayloadHash: event.payload_hash };
}

/** SQLSTATE-specific failures; every attempted mutation is rolled back. */
export async function assertCallieConversationKeys(database, slug = CALLIE_CONVERSATION_RECOVERY_SLUGS[0], otherSlug = CALLIE_CONVERSATION_RECOVERY_SLUGS[1]) {
  recoverySpec(slug); recoverySpec(otherSlug); assert.notEqual(slug, otherSlug);
  const id = callieConversationFixtureIds(slug), other = callieConversationFixtureIds(otherSlug);
  const checks = [
    ['binding_actor_tenant', 'UPDATE callie_reception_bindings SET updated_by_user_id=$2 WHERE id=$1', [id.binding, other.user], '23503'],
    ['session_organization_tenant', 'UPDATE callie_reception_sessions SET organization_id=$2 WHERE id=$1', [id.session, other.organization], '23503'],
    ['policy_actor_tenant', 'UPDATE callie_policy_revisions SET approved_by_user_id=$2 WHERE id=$1', [id.policy, other.user], '23503'],
    ['policy_review_tenant', 'UPDATE callie_policy_revisions SET review_id=$2 WHERE id=$1', [id.policy, other.review], '23503'],
    ['session_binding_tenant', 'UPDATE callie_reception_sessions SET reception_binding_id=$2 WHERE id=$1', [id.session, other.binding], '23503'],
    ['session_intake_tenant', 'UPDATE callie_reception_sessions SET intake_id=$2 WHERE id=$1', [id.session, other.intake], '23503'],
    ['session_parent_revision', 'UPDATE callie_reception_sessions SET policy_revision_id=$2 WHERE id=$1', [id.session, id.disabledPolicy], '23503'],
    ['session_intake_mode', "UPDATE callie_reception_sessions SET intake_mode='keypad' WHERE id=$1", [id.session], '23514'],
    ['intake_mode_no_fake_sms', "UPDATE callie_intakes SET mode='keypad' WHERE id=$1", [id.intake], '23514'],
    ['registration_receipt_tenant', 'UPDATE callie_reception_sessions SET registration_receipt_id=$2 WHERE id=$1', [id.session, other.registration], '23503'],
    ['transfer_receipt_tenant', 'UPDATE callie_reception_sessions SET transfer_receipt_id=$2 WHERE id=$1', [id.session, other.transfer], '23503'],
    ['registration_original_key', "UPDATE callie_reception_sessions SET registration_key='another-effect' WHERE id=$1", [id.session], '23514'],
    ['transfer_original_key', "UPDATE callie_reception_sessions SET transfer_key='another-effect' WHERE id=$1", [id.session], '23514'],
    ['registration_null_key', 'UPDATE callie_reception_sessions SET registration_key=NULL WHERE id=$1', [id.session], '23514'],
    ['registration_null_receipt', 'UPDATE callie_reception_sessions SET registration_receipt_id=NULL WHERE id=$1', [id.session], '23514'],
    ['transfer_null_key', 'UPDATE callie_reception_sessions SET transfer_key=NULL WHERE id=$1', [id.session], '23514'],
    ['transfer_null_receipt', 'UPDATE callie_reception_sessions SET transfer_receipt_id=NULL WHERE id=$1', [id.session], '23514'],
    ['capability_hash_null_pair', 'UPDATE callie_reception_sessions SET capability_hash=NULL WHERE id=$1', [id.session], '23514'],
    ['capability_expiry_null_pair', 'UPDATE callie_reception_sessions SET capability_expires_at=NULL WHERE id=$1', [id.session], '23514'],
    ['capability_format', "UPDATE callie_reception_sessions SET capability_hash='not-a-hash' WHERE id=$1", [id.session], '23514'],
    ['conversation_identity_null_pair', 'UPDATE callie_reception_sessions SET conversation_bound_at=NULL WHERE id=$1', [id.session], '23514'],
    ['transfer_target_regex', "UPDATE callie_reception_sessions SET transfer_target='+10000000000' WHERE id=$1", [id.session], '23514'],
    ['tool_limit', 'UPDATE callie_reception_sessions SET tools_used=13 WHERE id=$1', [id.session], '23514'],
    ['event_session_tenant', 'UPDATE callie_reception_events SET session_id=$2 WHERE id=$1', [id.event, other.session], '23503'],
    ['event_hash_format', "UPDATE callie_reception_events SET payload_hash='changed' WHERE id=$1", [id.event], '23514'],
    ['event_exact_dedup', 'INSERT INTO callie_reception_events(id,organization_id,session_id,event_key,kind,payload_hash,content_expires_at) SELECT $2,organization_id,session_id,event_key,kind,payload_hash,content_expires_at FROM callie_reception_events WHERE id=$1', [id.event, id.duplicateEvent], '23505'],
    ['event_changed_payload_dedup', "INSERT INTO callie_reception_events(id,organization_id,session_id,event_key,kind,payload_hash,content_expires_at) SELECT $2,organization_id,session_id,event_key,kind,repeat('f',64),content_expires_at FROM callie_reception_events WHERE id=$1", [id.event, id.duplicateEvent], '23505'],
    ['binding_provider_identity_dedup', 'UPDATE callie_reception_bindings SET agent_id=(SELECT agent_id FROM callie_reception_bindings WHERE id=$2) WHERE id=$1', [id.binding, other.binding], '23505'],
    ['original_conversation_dedup', 'UPDATE callie_reception_sessions SET conversation_id=(SELECT conversation_id FROM callie_reception_sessions WHERE id=$2) WHERE id=$1', [id.session, other.session], '23505'],
  ];
  // Capability NULL-pair negatives require a retained capability row (A), never
  // transform B's purged state to make a check pass.
  assert.equal(slug, CALLIE_CONVERSATION_RECOVERY_SLUGS[0], 'reception_key_checks_require_retained_a');
  for (const [name, sql, values, code] of checks) {
    await database.query('BEGIN');
    try { await assert.rejects(database.query(sql, values), error => error.code === code, `reception constraint ${name} (${code})`); }
    finally { await database.query('ROLLBACK'); }
  }
  return { count: checks.length, checks: checks.map(([name, , , code]) => ({ name, sqlstate: code })) };
}
