/** Synthetic-only CALLIE evidence. No SDK, usable credentials, registration or send. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { fixtureIds } from './restore-drill-fixture.mjs';

const stamp = '2026-10-03T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
export function callieFixtureIds(namespace) {
  return Object.fromEntries(['binding', 'policy', 'disabledPolicy', 'review', 'disabledReview', 'call', 'intake', 'task', 'handoff', 'execution', 'dispatch'].map(name => {
    const value = hash(`callie-recovery-v1:${namespace}:${name}`);
    return [name, `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`];
  }));
}

export async function seedSyntheticCallie(database, { namespace, organizationId: org, actorUserId: actor, codec }) {
  const id = callieFixtureIds(namespace);
  const [user] = (await database.query('SELECT email FROM users WHERE id=$1 AND organization_id=$2', [actor, org])).rows;
  assert.ok(user?.email.endsWith('@example.invalid'));
  await database.query('UPDATE users SET email_verified_at=$3 WHERE id=$1 AND organization_id=$2', [actor, org, stamp]);
  const accountSid = `AC${hash(namespace).slice(0, 32)}`, messageSid = `SM${hash(`${namespace}:trigger`).slice(0, 32)}`;
  const phone = '+12025550177', sender = namespace.endsWith('-b') ? '+12025550179' : '+12025550178';
  const binding = { id: id.binding, accountSid, sender, messagingServiceSid: `MG${hash(namespace).slice(0, 32)}`,
    disclosureVersion: 'SYNTHETIC ONLY', origin: 'https://example.invalid', businessName: 'FICTIONAL CALLIE QA' };
  const { buildCalliePolicySnapshot, callieTriggerHash, callieChallengeHash } = await tsImport('../artifacts/api-server/src/services/callie-contract.ts', import.meta.url);
  const settings = { enabled: true, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6], opensAt: '09:00', closesAt: '18:00', businessHoursOwnerId: actor, afterHoursOwnerId: actor, responseMinutes: 30 };
  await database.query(`INSERT INTO twilio_client_bindings(id,organization_id,account_sid,phone_number,messaging_service_sid,auth_token_secret_ref,public_origin,business_name,sms_disclosure_version)
    VALUES($1,$2,$3,$4,$5,'SYNTHETIC_CALLIE_NOT_A_SECRET',$6,$7,$8)`, [id.binding, org, accountSid, sender, binding.messagingServiceSid, binding.origin, binding.businessName, binding.disclosureVersion]);
  for (const enabled of [true, false]) {
    const snapshot = buildCalliePolicySnapshot({ ...settings, enabled }, binding), review = enabled ? id.review : id.disabledReview;
    const reviewHash = hash(JSON.stringify({ namespace, snapshot, synthetic: true }));
    await database.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      VALUES($1,$2,$3,'callie.policy.previewed','organization',$2,$4,$5)`, [review, org, actor, JSON.stringify({ payloadHash: reviewHash, snapshot, syntheticOnly: true }), stamp]);
    await database.query(`INSERT INTO callie_policy_revisions(id,organization_id,version,enabled,snapshot,review_id,review_payload_hash,approved_by_user_id,approved_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [enabled ? id.policy : id.disabledPolicy, org, enabled ? 1 : 2, enabled, JSON.stringify(snapshot), review, reviewHash, actor, stamp]);
  }
  await database.query(`INSERT INTO twilio_calls(id,organization_id,request_key,direction,phone,staff_phone,account_sid,provider_sid,status,dial_status,authorization_source,created_at)
    VALUES($1,$2,$3,'inbound',$4,$5,$6,$7,'completed','no-answer','synthetic_fixture',$8)`, [id.call, org, `synthetic-callie:${namespace}`, phone, sender, accountSid, `CA${hash(`${namespace}:call`).slice(0, 32)}`, stamp]);
  await database.query(`INSERT INTO crm_tasks(id,organization_id,title,description,status,priority,assigned_user_id,due_at,source_event)
    VALUES($1,$2,'FICTIONAL CALLIE: verify unknown acknowledgment','SYNTHETIC ONLY. Unverified caller requested maintenance and a visit; no appointment booked.','open','high',$3,$4,'missed_call')`, [id.task, org, actor, stamp]);
  await database.query('INSERT INTO missed_call_handoffs(id,organization_id,call_id,task_id) VALUES($1,$2,$3,$4)', [id.handoff, org, id.call, id.task]);
  await database.query(`INSERT INTO twilio_inbound_events(message_sid,organization_id,phone,event_type,body,received_at)
    VALUES($1,$2,$3,'CALLIE',NULL,$4)`, [messageSid, org, phone, stamp]);
  const encrypted = codec.encrypt('12345678', `callie:${org}:${id.intake}:challenge`);
  await database.query(`INSERT INTO callie_intakes(id,organization_id,call_id,policy_revision_id,version,state,stage,binding_id,account_sid,provider_call_sid,from_phone,called_number,owner_user_id,due_at,
    service_intent,request_intent,callback_window,challenge_hash,challenge_encrypted,challenge_expires_at,trigger_message_sid,trigger_account_sid,trigger_from,trigger_to,trigger_payload_hash,confirmed_at,grant_expires_at,reason,created_at)
    VALUES($1,$2,$3,$4,7,'indeterminate','complete',$5,$6,$7,$8,$9,$10,$11,'maintenance','visit','morning',$12,$13,'2026-10-03T12:15:00Z',$14,$6,$8,$9,$15,$11,'2026-10-04T12:00:00Z','synthetic_acknowledgment_unknown',$11)`,
  [id.intake, org, id.call, id.policy, id.binding, accountSid, `CA${hash(`${namespace}:call`).slice(0, 32)}`, phone, sender, actor, stamp, callieChallengeHash('12345678'), encrypted, messageSid, callieTriggerHash({ accountSid, from: phone, to: sender, messageSid, bodyHash: callieChallengeHash('12345678') })]);
  const operationKey = `missed-call-care:${id.call}:sms:v1`;
  await database.query(`INSERT INTO revenue_executions(id,organization_id,action_key,fingerprint,kind,state,detail,actor_user_id,expires_at,created_at)
    VALUES($1,$2,$3,$4,'callie_one_call_acknowledgment','indeterminate','SYNTHETIC ONLY: unknown effect, permanent reservation.',$5,$6,$6)`, [id.execution, org, operationKey, hash(`${namespace}:dispatch`), actor, stamp]);
  for (const state of ['processing', 'indeterminate']) await database.query(`INSERT INTO revenue_execution_events(organization_id,execution_id,state,detail,actor_user_id)
    VALUES($1,$2,$3,'Synthetic one-call acknowledgment evidence only.',$4)`, [org, id.execution, state, actor]);
  await database.query(`INSERT INTO callie_ack_dispatches(id,organization_id,intake_id,call_id,policy_revision_id,trigger_message_sid,receipt_id,operation_key,payload_hash,account_sid,from_phone,to_phone,messaging_service_sid,body_hash,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'uncertain',$15)`, [id.dispatch, org, id.intake, id.call, id.policy, messageSid, id.execution, operationKey, hash(`${namespace}:dispatch`), accountSid, sender, phone, binding.messagingServiceSid, hash('SYNTHETIC ONLY; no message sent'), stamp]);
  return id;
}

export function seedCallieRecoveryFixture(database, slug, codec) {
  const original = fixtureIds(slug);
  return seedSyntheticCallie(database, { namespace: slug, organizationId: original.organization, actorUserId: original.user, codec });
}

export async function assertCallieRecoveryFixture(database, slug, codec) {
  const id = callieFixtureIds(slug), original = fixtureIds(slug);
  const [row] = (await database.query(`SELECT i.*,a.status AS transport_state,a.receipt_id,e.state AS receipt_state,e.action_key,h.reviewed_at,h.contact_id,h.task_id,
    (SELECT enabled FROM callie_policy_revisions p WHERE p.organization_id=i.organization_id ORDER BY version DESC LIMIT 1) AS policy_enabled
    FROM callie_intakes i JOIN callie_ack_dispatches a ON a.intake_id=i.id AND a.organization_id=i.organization_id
    JOIN revenue_executions e ON e.id=a.receipt_id AND e.organization_id=a.organization_id
    JOIN missed_call_handoffs h ON h.call_id=i.call_id AND h.organization_id=i.organization_id WHERE i.id=$1 AND i.organization_id=$2`, [id.intake, original.organization])).rows;
  assert.equal(row.state, 'indeterminate'); assert.equal(row.receipt_state, 'indeterminate'); assert.equal(row.transport_state, 'uncertain');
  assert.equal(row.action_key, `missed-call-care:${id.call}:sms:v1`); assert.equal(row.policy_enabled, false);
  assert.equal(row.reviewed_at, null); assert.equal(row.contact_id, null); assert.equal(row.task_id, id.task); assert.equal(row.appointment_id, null);
  assert.equal(row.service_intent, 'maintenance'); assert.equal(row.request_intent, 'visit'); assert.equal(row.callback_window, 'morning');
  assert.equal(row.trigger_account_sid, row.account_sid); assert.equal(row.trigger_from, row.from_phone); assert.equal(row.trigger_to, row.called_number);
  const context = `callie:${original.organization}:${id.intake}:challenge`;
  assert.equal(codec.decrypt(row.challenge_encrypted, context), '12345678');
  assert.equal(codec.wrongKeyRejects(row.challenge_encrypted, context), true);
  assert.throws(() => codec.decrypt(row.challenge_encrypted, `${context}:wrong`));
  const [binding] = (await database.query('SELECT * FROM twilio_client_bindings WHERE id=$1', [id.binding])).rows;
  for (const flag of ['launch_approved', 'sms_enabled', 'registration_approved', 'advanced_opt_out', 'voice_enabled', 'voice_approved', 'geo_permissions_reviewed']) assert.equal(binding[flag], false);
  assert.equal(binding.daily_sms_limit, 0); assert.equal(binding.daily_call_limit, 0);
}

/** Exact grant and tenant keys are enforced by PostgreSQL, with rollback-only negatives. */
export async function assertCallieRecoveryKeys(database, slug, otherSlug) {
  const id = callieFixtureIds(slug), other = callieFixtureIds(otherSlug), foreign = fixtureIds(otherSlug);
  const checks = [
    ['UPDATE callie_policy_revisions SET approved_by_user_id=$2 WHERE id=$1', [id.policy, foreign.user], '23503'],
    ['UPDATE callie_policy_revisions SET review_id=$2 WHERE id=$1', [id.policy, other.review], '23503'],
    ['UPDATE callie_intakes SET owner_user_id=$2 WHERE id=$1', [id.intake, foreign.user], '23503'],
    ['UPDATE callie_intakes SET binding_id=$2 WHERE id=$1', [id.intake, other.binding], '23503'],
    ['UPDATE callie_ack_dispatches SET receipt_id=$2 WHERE id=$1', [id.dispatch, other.execution], '23503'],
    ['UPDATE callie_ack_dispatches SET policy_revision_id=$2 WHERE id=$1', [id.dispatch, id.disabledPolicy], '23503'],
    ['UPDATE callie_ack_dispatches SET intake_id=$2 WHERE id=$1', [id.dispatch, other.intake], '23503'],
    ["UPDATE callie_ack_dispatches SET operation_key='another-call' WHERE id=$1", [id.dispatch], '23514'],
    ["UPDATE callie_ack_dispatches SET status='unreviewed_retry' WHERE id=$1", [id.dispatch], '23514'],
    ["UPDATE callie_intakes SET trigger_to='+12025550111' WHERE id=$1", [id.intake], '23514'],
    ["UPDATE callie_intakes SET service_intent='invented' WHERE id=$1", [id.intake], '23514'],
    ['UPDATE callie_intakes SET grant_expires_at=confirmed_at WHERE id=$1', [id.intake], '23514'],
  ];
  for (const [sql, values, code] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(sql, values), error => error.code === code); }
    finally { await database.exec('ROLLBACK'); }
  }
  return checks.length;
}
