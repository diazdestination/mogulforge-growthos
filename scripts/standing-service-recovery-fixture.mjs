/** Synthetic retained standing authority and SMS evidence. Never authorizes contact. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixtureIds } from './restore-drill-fixture.mjs';
import { nativeFixtureIds } from './native-contractor-recovery-fixture.mjs';
import { callieFixtureIds } from './callie-recovery-fixture.mjs';

const stamp = '2026-10-03T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
export function standingServiceIds(namespace) {
  return Object.fromEntries(['enrollment', 'policy', 'disabledPolicy', 'review', 'disabledReview', 'approval', 'scheduled', 'execution', 'dispatch', 'parent', 'reply', 'ambiguous'].map(name => {
    const value = hash(`standing-service-recovery-v1:${namespace}:${name}`);
    return [name, `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`];
  }));
}

export async function seedStandingServiceRecovery(database, slug) {
  const id = standingServiceIds(slug), original = fixtureIds(slug), native = nativeFixtureIds(slug), callie = callieFixtureIds(slug);
  const org = original.organization, actor = original.user;
  const [service] = (await database.query('SELECT * FROM service_obligations WHERE id=$1 AND organization_id=$2', [native.nextService, org])).rows;
  const [binding] = (await database.query('SELECT * FROM twilio_client_bindings WHERE id=$1 AND organization_id=$2', [callie.binding, org])).rows;
  assert.ok(service && binding);
  const recipient = '+12025550188', actionKey = `scheduled:${id.scheduled}`, operationKey = `service-care:${service.id}`;
  const reference = hash(`growthos-service-sms-v1:${org}:${service.id}`).slice(0, 16);
  const snapshot = {
    schemaVersion: 'service-standing-policy.v1',
    settings: { enabled: true, channel: 'sms', agreementStartsOn: '2026-01-01', agreementEndsOn: '2027-12-31', agreementEvidence: 'SYNTHETIC agreement only; no customer authority.',
      sourceReview: { kind: 'native', verifiedAt: stamp, cutoverAt: null, evidence: 'SYNTHETIC source reviewed; no original system.' } },
    scope: { seriesRootObligationId: native.priorService, anchorObligationId: service.id, anchorUpdatedAt: new Date(service.updated_at).toISOString(), anchorOccurrenceIndex: service.occurrence_index,
      reviewedObligationId: service.id, reviewedUpdatedAt: new Date(service.updated_at).toISOString(), reviewedOccurrenceIndex: service.occurrence_index,
      contactId: service.contact_id, propertyId: service.property_id, kind: service.kind, equipmentLabel: service.equipment_label, noticeDays: service.notice_days,
      source: service.source, externalRef: service.external_ref, recurrence: service.recurrence, coverageStartsOn: service.coverage_starts_on, coverageEndsOn: service.coverage_ends_on,
      coverageEvidence: service.coverage_evidence, ownerUserId: actor, recipient, businessName: 'SYNTHETIC contractor' },
    seriesFingerprint: hash(`${slug}:series`), sourceReviewFingerprint: hash(`${slug}:source`), templateVersion: 'service-care.v2',
    template: { subject: 'SYNTHETIC service only', body: 'SYNTHETIC service reminder. No delivery authorized.' },
    sender: { kind: 'sms', id: binding.id, accountSid: binding.account_sid, sender: binding.phone_number, messagingServiceSid: binding.messaging_service_sid,
      disclosureVersion: binding.sms_disclosure_version, origin: binding.public_origin, businessName: binding.business_name },
    sendingHours: { quietHoursEnabled: true, timezone: 'America/New_York', startHour: 9, endHour: 18, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], maxTouchesPerDay: 1 },
  };
  await database.query(`INSERT INTO service_standing_enrollments(id,organization_id,series_root_obligation_id,anchor_obligation_id,created_by_user_id,created_at,next_check_at,last_checked_at,last_result_code,last_materialized_obligation_id)
    VALUES($1,$2,$3,$4,$5,$6,$6,$6,'synthetic_disabled_unknown_retained',$4)`, [id.enrollment, org, native.priorService, service.id, actor, stamp]);
  for (const enabled of [true, false]) {
    const policy = { ...snapshot, settings: { ...snapshot.settings, enabled } }, reviewId = enabled ? id.review : id.disabledReview;
    const payloadHash = hash(JSON.stringify(policy));
    await database.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      VALUES($1,$2,$3,'service.standing.previewed','service_obligation',$4,$5,$6)`, [reviewId, org, actor, service.id, JSON.stringify({ syntheticOnly: true, payloadHash, policy }), stamp]);
    await database.query(`INSERT INTO service_standing_policy_revisions(id,organization_id,enrollment_id,version,enabled,owner_user_id,snapshot,review_id,review_payload_hash,approved_by_user_id,approved_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10,$10)`, [enabled ? id.policy : id.disabledPolicy, org, id.enrollment, enabled ? 1 : 2, enabled, actor, JSON.stringify(policy), reviewId, payloadHash, stamp]);
  }
  const action = { type: 'service_care_reminder', params: { approvalId: id.approval, obligationId: service.id } }, context = { event: 'service.care_reminder', serviceObligationId: service.id };
  const executionHash = hash(`${slug}:standing-execution`), authorizationHash = hash(`${slug}:standing-authorization`);
  const approval = { snapshot: { obligationId: service.id, updatedAt: new Date(service.updated_at).toISOString(), contactId: service.contact_id, recipient, channel: 'sms', subject: snapshot.template.subject,
    body: `${snapshot.template.body} Reply SERVICE ${reference} followed by your message.`, noticeAt: stamp, sender: null, smsBinding: hash(`${slug}:sms-binding`), smsReply: { version: 1, reference } },
    scheduledActionId: id.scheduled, agreementNote: snapshot.settings.agreementEvidence,
    authorization: { origin: 'standing', version: 1, policyRevisionId: id.policy, anchorObligationId: service.id, policyHash: hash(JSON.stringify(snapshot)), seriesFingerprint: snapshot.seriesFingerprint,
      sourceReviewFingerprint: snapshot.sourceReviewFingerprint, admittedAt: stamp, expiresAt: stamp } };
  await database.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
    VALUES($1,$2,$3,'service.care_reminder_approved','service_obligation',$4,$5,$6)`, [id.approval, org, actor, service.id, JSON.stringify(approval), stamp]);
  await database.query(`INSERT INTO scheduled_actions(id,organization_id,action,context,run_at,status,last_error)
    VALUES($1,$2,$3,$4,$5,'failed','SYNTHETIC unknown original effect; never replay.')`, [id.scheduled, org, JSON.stringify(action), JSON.stringify(context), stamp]);
  await database.query(`INSERT INTO revenue_executions(id,organization_id,action_key,fingerprint,kind,state,detail,actor_user_id,expires_at,created_at)
    VALUES($1,$2,$3,$4,'service_care_reminder','indeterminate','SYNTHETIC unknown service reminder; permanent original ownership.',$5,$6,$6)`, [id.execution, org, actionKey, executionHash, actor, stamp]);
  await database.query(`INSERT INTO twilio_dispatches(id,organization_id,contact_id,idempotency_key,payload_hash,phone,purpose,account_sid,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'customer_care',$7,'uncertain',$8)`, [id.dispatch, org, service.contact_id, operationKey, hash(`${slug}:dispatch`), recipient, binding.account_sid, stamp]);
  await database.query(`INSERT INTO service_sms_parents(id,organization_id,service_obligation_id,contact_id,binding_id,approval_id,scheduled_action_id,action_key,execution_id,execution_fingerprint,authorization_fingerprint,context_snapshot,
    reference,template_version,account_sid,sender,recipient,messaging_service_sid,disclosure_version,binding_fingerprint,body_sha256,operation_key,dispatch_id,dispatch_payload_hash,reserved_at,dispatch_started_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)`,
    [id.parent, org, service.id, service.contact_id, binding.id, id.approval, id.scheduled, actionKey, id.execution, executionHash, authorizationHash,
      JSON.stringify({ version: 1, dueAt: new Date(service.due_at).toISOString(), occurrenceIndex: service.occurrence_index, createdAt: new Date(service.created_at).toISOString(), updatedAt: new Date(service.updated_at).toISOString(), authorizationOrigin: 'standing' }),
      reference, binding.account_sid, binding.phone_number, recipient, binding.messaging_service_sid, binding.sms_disclosure_version, hash(`${slug}:sms-binding`), hash(approval.snapshot.body), operationKey, id.dispatch, hash(`${slug}:dispatch`), stamp]);
  for (const exact of [true, false]) {
    const replyId = exact ? id.reply : id.ambiguous, sid = `SM${hash(`${slug}:${replyId}`).slice(0, 32)}`;
    await database.query(`INSERT INTO twilio_inbound_events(message_sid,organization_id,phone,event_type,body,received_at) VALUES($1,$2,$3,'SERVICE',NULL,$4)`, [sid, org, recipient, stamp]);
    await database.query(`INSERT INTO service_sms_replies(id,organization_id,binding_id,message_sid,account_sid,from_number,to_number,messaging_service_sid,payload_sha256,body_sha256,
      parent_id,service_obligation_id,contact_id,correlation,reason,candidate_parent_ids,candidate_count,received_at,hold_active,encrypted_text,raw_expires_at,raw_purged_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17,true,NULL,$17,$17)`,
      [replyId, org, binding.id, sid, binding.account_sid, recipient, binding.phone_number, binding.messaging_service_sid, hash(`${slug}:${replyId}:envelope`), hash(`${slug}:${replyId}:body`),
        exact ? id.parent : null, exact ? service.id : null, exact ? service.contact_id : null, exact ? 'exact_reference' : 'ambiguous', exact ? 'synthetic_exact_reference' : 'synthetic_missing_reference', JSON.stringify([id.parent]), stamp]);
  }
}

export async function assertStandingServiceRecovery(database, slug) {
  const id = standingServiceIds(slug), org = fixtureIds(slug).organization;
  const revisions = (await database.query('SELECT version,enabled,snapshot FROM service_standing_policy_revisions WHERE organization_id=$1 AND enrollment_id=$2 ORDER BY version', [org, id.enrollment])).rows;
  assert.deepEqual(revisions.map(row => [row.version, row.enabled]), [[1, true], [2, false]]);
  assert.equal(revisions[1].snapshot.settings.enabled, false);
  const [parent] = (await database.query(`SELECT p.*,e.state AS receipt_state,d.status AS dispatch_state FROM service_sms_parents p
    JOIN revenue_executions e ON e.organization_id=p.organization_id AND e.id=p.execution_id
    JOIN twilio_dispatches d ON d.organization_id=p.organization_id AND d.id=p.dispatch_id WHERE p.organization_id=$1 AND p.id=$2`, [org, id.parent])).rows;
  assert.equal(parent.receipt_state, 'indeterminate'); assert.equal(parent.dispatch_state, 'uncertain');
  assert.equal(parent.action_key, `scheduled:${id.scheduled}`); assert.equal(parent.context_snapshot.authorizationOrigin, 'standing');
  const replies = (await database.query('SELECT * FROM service_sms_replies WHERE organization_id=$1 ORDER BY correlation', [org])).rows;
  assert.equal(replies.length, 2);
  for (const row of replies) { assert.equal(row.state, 'needs_review'); assert.equal(row.hold_active, true); assert.equal(row.encrypted_text, null); assert.ok(row.raw_purged_at); }
  assert.equal(replies[0].correlation, 'ambiguous'); assert.equal(replies[0].service_obligation_id, null);
  assert.equal(replies[1].parent_id, id.parent);
}

export async function assertStandingServiceKeys(database, slug, otherSlug) {
  const id = standingServiceIds(slug), other = standingServiceIds(otherSlug), foreign = fixtureIds(otherSlug), foreignNative = nativeFixtureIds(otherSlug);
  const checks = [
    ['UPDATE service_standing_enrollments SET anchor_obligation_id=$2 WHERE id=$1', [id.enrollment, foreignNative.nextService], '23503'],
    ['UPDATE service_standing_enrollments SET created_by_user_id=$2 WHERE id=$1', [id.enrollment, foreign.user], '23503'],
    ['UPDATE service_standing_policy_revisions SET enrollment_id=$2 WHERE id=$1', [id.policy, other.enrollment], '23503'],
    ['UPDATE service_standing_policy_revisions SET review_id=$2 WHERE id=$1', [id.policy, other.review], '23503'],
    ['UPDATE service_standing_policy_revisions SET owner_user_id=$2 WHERE id=$1', [id.policy, foreign.user], '23503'],
    ['UPDATE service_standing_policy_revisions SET enabled=false WHERE id=$1', [id.policy], '23514'],
    ['UPDATE service_sms_parents SET contact_id=$2 WHERE id=$1', [id.parent, foreign.contact], '23503'],
    ['UPDATE service_sms_parents SET execution_id=$2 WHERE id=$1', [id.parent, other.execution], '23503'],
    ['UPDATE service_sms_parents SET dispatch_id=$2 WHERE id=$1', [id.parent, other.dispatch], '23503'],
    ['UPDATE service_sms_replies SET parent_id=$2 WHERE id=$1', [id.reply, other.parent], '23503'],
    ['UPDATE service_sms_replies SET contact_id=$2 WHERE id=$1', [id.reply, foreign.contact], '23503'],
    ["UPDATE service_sms_replies SET correlation='exact_reference' WHERE id=$1", [id.ambiguous], '23514'],
    ['UPDATE service_sms_replies SET historical=true WHERE id=$1', [id.reply], '23514'],
    ["UPDATE service_sms_parents SET reference='not-a-reference' WHERE id=$1", [id.parent], '23514'],
  ];
  for (const [query, values, code] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(query, values), error => error.code === code); }
    finally { await database.exec('ROLLBACK'); }
  }
  return checks.length;
}
