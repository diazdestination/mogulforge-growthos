/** Provider-free retained nurture evidence. No working sender, grant or live recipient. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { fixtureIds } from './restore-drill-fixture.mjs';
import { launchCommunicationIds } from './launch-communications-recovery-fixture.mjs';

const stamp = '2026-10-03T12:00:00.000Z', expires = '2026-10-10T12:00:00.000Z';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function sourceNurtureIds(namespace) {
  return Object.fromEntries(['contact', 'lead', 'permission', 'adoption', 'review', 'plan', 'item', 'first', 'second', 'firstAction', 'secondAction', 'execution', 'touch', 'parent', 'reply', 'task', 'cycle', 'receipt', 'start', 'stop'].map(name => {
    const value = hash(`source-nurture-recovery-v1:${namespace}:${name}`);
    return [name, `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`];
  }));
}
const jsonColumns = new Set(['metadata', 'snapshot', 'settings', 'imported_history', 'action', 'context', 'context_snapshot']);
async function insert(database, table, row) {
  const fields = Object.keys(row);
  if (![table, ...fields].every(name => /^[a-z_][a-z0-9_]*$/.test(name))) throw new Error('nurture_fixture_identifier_invalid');
  await database.query(`INSERT INTO "${table}" (${fields.map(name => `"${name}"`).join(',')}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')})`,
    fields.map(name => jsonColumns.has(name) ? JSON.stringify(row[name]) : row[name]));
}

export async function seedSourceNurtureRecovery(database, slug, syntheticContext = null) {
  const id = sourceNurtureIds(slug), original = syntheticContext?.original ?? fixtureIds(slug), mailbox = syntheticContext?.mailbox ?? launchCommunicationIds(slug);
  const org = original.organization, actor = original.user, shared = { organization_id: org };
  const recipient = `${slug}.nurture@example.invalid`;
  const [connector] = (await database.query('SELECT * FROM mailbox_connectors WHERE id=$1 AND organization_id=$2', [mailbox.connector, org])).rows;
  assert.equal(connector.state, 'disabled');
  const history = { version: 1, kind: 'csv_snapshot', originalCreatedAt: null, sourceUpdatedAt: null, statusChangedAt: null, lastContactAt: null, snapshotAsOf: stamp,
    firstImportedAt: stamp, lastImportedAt: stamp, externalCustomerId: `${slug}-synthetic-nurture`, externalEstimateId: null, currency: null,
    fingerprint: hash(`${slug}:source`), appliedFingerprint: hash(`${slug}:applied`), mappedFields: ['firstName', 'email'] };
  await insert(database, 'contacts', { ...shared, id: id.contact, first_name: 'SYNTHETIC Nurture', last_name: 'Recovery', email: recipient,
    do_not_contact: true, do_not_contact_email: true, do_not_contact_sms: true, created_at: stamp, updated_at: stamp });
  await insert(database, 'leads', { ...shared, id: id.lead, contact_id: id.contact, assigned_user_id: actor, creation_method: 'import',
    import_source_key: `${slug}-synthetic-source`, external_opportunity_id: 'synthetic-nurture-only', imported_history: history,
    summary: 'SYNTHETIC stopped nurture; original send unknown. Never contact.', created_at: stamp, updated_at: stamp });
  await insert(database, 'consent_records', { ...shared, id: id.permission, contact_id: id.contact, channel: 'email', granted: false, disclosure_version: 'source-email-marketing.v1', recorded_at: stamp });
  const source = { leadId: id.lead, contactId: id.contact, importSourceKey: `${slug}-synthetic-source`, externalOpportunityId: 'synthetic-nurture-only', importedHistory: history,
    sourceSha256: hash(`${slug}:source-fingerprint`), operationalSha256: hash(`${slug}:operational-fingerprint`), recipient };
  await insert(database, 'source_adoptions', { ...shared, id: id.adoption, lead_id: id.lead, contact_id: id.contact, version: 2, state: 'revoked', snapshot: source,
    source_as_of: stamp, cutover_at: stamp, expires_at: expires, evidence: 'SYNTHETIC retained source review; revoked for restore. No actual marketing permission.',
    approved_by_user_id: actor, approved_at: stamp, revoked_at: stamp, created_at: stamp });
  const settings = { businessName: 'SYNTHETIC RESTORE ONLY', mailingAddress: 'Synthetic non-deliverable address',
    steps: [{ subject: 'Synthetic first review', body: 'Synthetic original message. No delivery authorized.' }, { subject: 'Synthetic follow-up review', body: 'Synthetic cancelled follow-up. Never dispatch.' }],
    timezone: 'UTC', days: ['Mon'], startHour: 9, endHour: 10, dailyLimit: 1 };
  const identity = { organizationId: org, senderUserId: actor, provider: 'microsoft', connectionId: connector.connection_id, connectionRevision: connector.connection_revision,
    mailboxAccountId: connector.mailbox_account_id, mailboxEmail: connector.mailbox_email, connectorId: connector.id, connectorVersion: 1, policyVersion: 1, startedAt: new Date(connector.started_at).toISOString() };
  const snapshot = { version: 1, adoptionId: id.adoption, adoptionVersion: 1, adoptionSha256: hash(`${slug}:adoption`), adoption: source, permissionRecordId: id.permission,
    ownerUserId: actor, propertyId: null, leadCreatedAt: stamp, sender: { userId: actor, source: 'lead_assignee', provider: 'microsoft', senderEmail: connector.mailbox_email },
    mailboxIdentity: identity, nurtureMonitoringApproval: { version: 1, approvedAt: stamp } };
  const { nurturePlanFingerprint } = await tsImport('../artifacts/api-server/src/services/source-nurture-fingerprint.ts', import.meta.url);
  const { sourceFingerprint } = await tsImport('../artifacts/api-server/src/services/source-adoption-contract.ts', import.meta.url);
  const planHash = nurturePlanFingerprint({ id: id.plan, organizationId: org, settings, reviewId: id.review, createdByUserId: actor,
    createdAt: new Date(stamp), previewExpiresAt: new Date('2026-10-03T12:10:00.000Z'), startNotBefore: new Date(stamp), expiresAt: new Date(expires) },
    [{ id: id.item, leadId: id.lead, contactId: id.contact, propertyId: null, ownerUserId: actor, adoptionId: id.adoption, recipient, snapshot }],
    settings.steps.map((message, index) => ({ id: index === 0 ? id.first : id.second, itemId: id.item, stepIndex: index + 1, predecessorId: index === 0 ? null : id.first,
      subject: message.subject, body: message.body, messageHash: sourceFingerprint({ to: recipient, ...message }), expiresAt: new Date(expires) })));
  const executionHash = hash(`${slug}:original-nurture-execution`);
  await insert(database, 'audit_events', { ...shared, id: id.review, actor_user_id: actor, action: 'source_nurture.previewed', entity_type: 'source_nurture_plan', entity_id: id.plan,
    metadata: { syntheticOnly: true, payloadSha256: planHash, expiresAt: '2026-10-03T12:10:00.000Z', noProviderAuthority: true }, created_at: stamp });
  await insert(database, 'source_nurture_plans', { ...shared, id: id.plan, version: 4, state: 'stopped', settings, payload_sha256: planHash, review_id: id.review,
    created_by_user_id: actor, approved_by_user_id: actor, approved_at: stamp, preview_expires_at: '2026-10-03T12:10:00.000Z', start_not_before: stamp, expires_at: expires,
    start_request_id: id.start, start_payload_hash: hash(`${slug}:start`), started_at: stamp, stop_request_id: id.stop, stop_payload_hash: hash(`${slug}:stop`), stopped_at: stamp,
    stop_reason: 'Synthetic stopped plan. Original effect unknown; no replacement key.', created_at: stamp, next_check_at: expires, last_checked_at: stamp, last_code: 'synthetic_unknown_retained' });
  await insert(database, 'source_nurture_items', { ...shared, id: id.item, plan_id: id.plan, lead_id: id.lead, contact_id: id.contact, owner_user_id: actor,
    adoption_id: id.adoption, recipient, snapshot, admitted_at: stamp, stopped_at: stamp, stop_reason: 'Synthetic office reply hold retained.', created_at: stamp });
  for (const index of [1, 2]) {
    const stepId = index === 1 ? id.first : id.second, actionId = index === 1 ? id.firstAction : id.secondAction, message = settings.steps[index - 1];
    await insert(database, 'scheduled_actions', { ...shared, id: actionId, action: { type: 'source_nurture_email', params: { stepId } }, context: { event: 'source.nurture', leadId: id.lead, contactId: id.contact },
      run_at: stamp, status: index === 1 ? 'failed' : 'cancelled', last_error: index === 1 ? 'SYNTHETIC unknown original effect.' : 'SYNTHETIC stopped; never reschedule.' });
    await insert(database, 'source_nurture_steps', { ...shared, id: stepId, plan_id: id.plan, item_id: id.item, lead_id: id.lead, contact_id: id.contact, step_index: index,
      predecessor_id: index === 1 ? null : id.first, scheduled_action_id: actionId, subject: message.subject, body: message.body, message_hash: sourceFingerprint({ to: recipient, ...message }),
      not_before: index === 1 ? stamp : null, expires_at: expires, claimed_at: index === 1 ? stamp : null, cancelled_at: index === 1 ? null : stamp,
      reason: index === 1 ? 'synthetic_unknown_retained' : 'synthetic_reply_stop', created_at: stamp });
  }
  const actionKey = `scheduled:${id.firstAction}`;
  await insert(database, 'revenue_executions', { ...shared, id: id.execution, action_key: actionKey, fingerprint: executionHash, kind: 'source_nurture_email', state: 'indeterminate',
    detail: 'SYNTHETIC original effect unknown; never replay or advance.', actor_user_id: actor, expires_at: stamp, created_at: stamp });
  await insert(database, 'contact_touch_reservations', { ...shared, id: id.touch, logical_key: actionKey, contact_id: id.contact, address: recipient, channel: 'email',
    source_kind: 'nurture', payload_hash: executionHash, reserved_at: stamp, dispatch_started_at: stamp });
  await insert(database, 'mailbox_communication_parents', { ...shared, id: id.parent, contact_id: id.contact, lead_id: id.lead, source_nurture_step_id: id.first,
    context_snapshot: { kind: 'source_nurture_email', version: 1, planId: id.plan, itemId: id.item, stepId: id.first, stepIndex: 1, leadId: id.lead, contactId: id.contact,
      scheduledActionId: id.firstAction, planReviewId: id.review, planFingerprint: planHash, nurtureMonitoringApproval: snapshot.nurtureMonitoringApproval },
    provider: 'microsoft', sender_user_id: actor, connection_id: identity.connectionId, connection_revision: identity.connectionRevision, mailbox_account_id: identity.mailboxAccountId,
    mailbox_email: identity.mailboxEmail, connector_id: identity.connectorId, connector_version: 1, policy_version: 1, connector_started_at: identity.startedAt,
    recipient, content_sha256: sourceFingerprint({ to: recipient, ...settings.steps[0] }), subject_sha256: hash(settings.steps[0].subject), body_sha256: hash(settings.steps[0].body),
    correlation_header: hash(`${slug}:nurture-parent`), action_key: actionKey, execution_fingerprint: executionHash, reserved_at: stamp, dispatch_started_at: stamp,
    observed_at: stamp, provider_message_id: `synthetic-nurture-sent-${slug}`, internet_message_id: `<nurture-sent-${slug}@example.invalid>`, provider_sent_at: stamp });
  await insert(database, 'crm_tasks', { ...shared, id: id.task, lead_id: id.lead, contact_id: id.contact, assigned_user_id: actor, title: 'Review synthetic nurture reply',
    description: 'Synthetic retained exact-parent evidence. No raw customer content or live message.', source_event: `mailbox.lead_reply:${id.reply}`, status: 'open', priority: 'high' });
  await insert(database, 'email_response_reviews', { ...shared, id: id.reply, mailbox_parent_id: id.parent, mailbox_connector_id: connector.id,
    internet_message_id: `<nurture-reply-${slug}@example.invalid>`, external_message_id: `synthetic-nurture-inbox-${slug}`, payload_sha256: hash(`${slug}:nurture-reply`),
    state: 'confirmed', reason: 'original_mailbox_observation', lead_id: id.lead, contact_id: id.contact, reply_at: stamp, received_at: stamp, hold_active: true,
    raw_expires_at: stamp, raw_purged_at: stamp, task_id: id.task });
  await insert(database, 'mailbox_receipts', { ...shared, id: id.receipt, connector_id: connector.id, connector_version: 1, folder: 'inbox',
    provider_message_id: `synthetic-nurture-inbox-${slug}`, content_sha256: hash(`${slug}:nurture-reply`), state: 'processed' });
  await insert(database, 'mailbox_sync_cycles', { ...shared, id: id.cycle, connector_id: connector.id, connector_version: 1, sequence: 1, fresh_boundary: true,
    nurture_monitoring_version: 1, nurture_monitoring_approved_at: stamp, state: 'failed', started_at: stamp, sent_completed_at: stamp,
    failed_at: stamp, error_code: 'synthetic_reader_revoked' });
}

export async function assertSourceNurtureRecovery(database, slug) {
  const id = sourceNurtureIds(slug), org = fixtureIds(slug).organization;
  const [plan] = (await database.query('SELECT * FROM source_nurture_plans WHERE organization_id=$1 AND id=$2', [org, id.plan])).rows;
  assert.equal(plan.state, 'stopped'); assert.equal(plan.version, 4); assert.ok(plan.stopped_at); assert.equal(plan.start_request_id, id.start);
  const [item] = (await database.query('SELECT * FROM source_nurture_items WHERE organization_id=$1 AND id=$2', [org, id.item])).rows;
  assert.equal(item.lead_id, id.lead); assert.ok(item.admitted_at); assert.ok(item.stopped_at);
  const steps = (await database.query(`SELECT s.*,e.state AS receipt_state FROM source_nurture_steps s LEFT JOIN revenue_executions e
    ON e.organization_id=s.organization_id AND e.action_key='scheduled:'||s.scheduled_action_id::text WHERE s.organization_id=$1 AND s.item_id=$2 ORDER BY s.step_index`, [org, id.item])).rows;
  assert.equal(steps.length, 2); assert.equal(steps[0].receipt_state, 'indeterminate'); assert.equal(steps[0].accepted_at, null);
  assert.equal(steps[1].predecessor_id, id.first); assert.equal(steps[1].claimed_at, null); assert.ok(steps[1].cancelled_at); assert.equal(steps[1].receipt_state, null);
  const [touch] = (await database.query('SELECT * FROM contact_touch_reservations WHERE organization_id=$1 AND id=$2', [org, id.touch])).rows;
  assert.equal(touch.logical_key, `scheduled:${id.firstAction}`); assert.ok(touch.dispatch_started_at); assert.equal(touch.accepted_at, null);
  const [cycle] = (await database.query('SELECT * FROM mailbox_sync_cycles WHERE organization_id=$1 AND id=$2', [org, id.cycle])).rows;
  assert.equal(cycle.state, 'failed'); assert.equal(cycle.completed_at, null); assert.equal(cycle.inbox_completed_at, null);
  const [reply] = (await database.query('SELECT * FROM email_response_reviews WHERE organization_id=$1 AND id=$2', [org, id.reply])).rows;
  assert.equal(reply.mailbox_parent_id, id.parent); assert.equal(reply.task_id, id.task); assert.equal(reply.encrypted_text, null); assert.ok(reply.raw_purged_at); assert.equal(reply.hold_active, true);
  const [connector] = (await database.query('SELECT state,nurture_monitoring_enabled,encrypted_refresh_token FROM mailbox_connectors WHERE organization_id=$1', [org])).rows;
  assert.equal(connector.state, 'disabled'); assert.equal(connector.nurture_monitoring_enabled, false); assert.equal(connector.encrypted_refresh_token, null);
}

export async function assertSourceNurtureKeys(database, slug, foreignSlug) {
  const id = sourceNurtureIds(slug), other = sourceNurtureIds(foreignSlug), foreign = fixtureIds(foreignSlug), foreignMailbox = launchCommunicationIds(foreignSlug);
  const checks = [
    ['UPDATE source_nurture_plans SET created_by_user_id=$2 WHERE id=$1', [id.plan, foreign.user], '23503'],
    ['UPDATE source_nurture_plans SET review_id=$2 WHERE id=$1', [id.plan, other.review], '23503'],
    ['UPDATE source_nurture_items SET plan_id=$2 WHERE id=$1', [id.item, other.plan], '23503'],
    ['UPDATE source_nurture_items SET contact_id=$2 WHERE id=$1', [id.item, other.contact], '23503'],
    ['UPDATE source_nurture_items SET owner_user_id=$2 WHERE id=$1', [id.item, foreign.user], '23503'],
    ['UPDATE source_nurture_items SET adoption_id=$2 WHERE id=$1', [id.item, other.adoption], '23503'],
    ['UPDATE source_nurture_steps SET predecessor_id=$2 WHERE id=$1', [id.second, other.first], '23503'],
    ['UPDATE source_nurture_steps SET scheduled_action_id=$2 WHERE id=$1', [id.second, other.secondAction], '23503'],
    ['UPDATE contact_touch_reservations SET contact_id=$2 WHERE id=$1', [id.touch, other.contact], '23503'],
    ['UPDATE mailbox_sync_cycles SET connector_id=$2 WHERE id=$1', [id.cycle, foreignMailbox.connector], '23503'],
    ["UPDATE mailbox_communication_parents SET source_nurture_step_id=$2::uuid,context_snapshot=jsonb_set(context_snapshot,'{stepId}',to_jsonb(($2::uuid)::text)) WHERE id=$1", [id.parent, other.first], '23503'],
    ["UPDATE source_nurture_items SET recipient='UPPER@example.invalid' WHERE id=$1", [id.item], '23514'],
    ['UPDATE source_nurture_steps SET step_index=3 WHERE id=$1', [id.second], '23514'],
    ["UPDATE mailbox_sync_cycles SET state='complete' WHERE id=$1", [id.cycle], '23514'],
    ['UPDATE source_nurture_plans SET started_at=NULL WHERE id=$1', [id.plan], '23514'],
  ];
  for (const [query, values, code] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(query, values), error => error.code === code); }
    finally { await database.exec('ROLLBACK'); }
  }
  return checks.length;
}
