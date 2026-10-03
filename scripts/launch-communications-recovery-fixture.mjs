/** Synthetic reply and identity evidence; no working credential or recipient. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixtureIds } from './restore-drill-fixture.mjs';
import { nativeFixtureIds } from './native-contractor-recovery-fixture.mjs';
const stamp = '2026-10-02T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
export function launchCommunicationIds(slug) {
  return Object.fromEntries(['connector', 'receipt', 'parent', 'reply', 'connection', 'dispatch', 'event', 'provider', 'source'].map(name => {
    const value = hash(`launch-communications-recovery-v1:${slug}:${name}`);
    return [name, `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`];
  }));
}
export function launchCommunicationRows(slug) {
  const old = fixtureIds(slug), service = nativeFixtureIds(slug).nextService, id = launchCommunicationIds(slug);
  const shared = { organization_id: old.organization };
  const mailbox = `${slug}.mailbox@example.invalid`, recipient = `${slug}.customer@example.invalid`;
  return [
    ['mailbox_connectors', { ...shared, id: id.connector, user_id: old.user, provider: 'microsoft', connection_id: id.connection,
      connection_revision: stamp, mailbox_account_id: `synthetic-${slug}`, mailbox_email: mailbox, state: 'disabled', version: 2,
      encrypted_refresh_token: null, encrypted_cursors: null, started_at: stamp, last_error_code: 'synthetic_disabled_for_restore' }],
    ['mailbox_receipts', { ...shared, id: id.receipt, connector_id: id.connector, connector_version: 1, folder: 'inbox',
      provider_message_id: `synthetic-inbox-${slug}`, content_sha256: hash('retained after body purge'), state: 'review' }],
    ['mailbox_communication_parents', { ...shared, id: id.parent, contact_id: old.contact, service_obligation_id: service,
      context_snapshot: { dueAt: stamp, occurrenceIndex: 1, createdAt: stamp, updatedAt: stamp, approvalId: id.source, scheduledActionId: id.source },
      provider: 'microsoft', sender_user_id: old.user, connection_id: id.connection, connection_revision: stamp,
      mailbox_account_id: `synthetic-${slug}`, mailbox_email: mailbox, connector_id: id.connector, connector_version: 1,
      policy_version: 1, connector_started_at: stamp, recipient, content_sha256: hash('synthetic-content'), subject_sha256: hash('synthetic-subject'),
      body_sha256: hash('synthetic-body'), correlation_header: hash(`synthetic-parent:${slug}`), action_key: `synthetic-mail:${slug}`,
      execution_fingerprint: hash('synthetic-uncertain-execution'), reserved_at: stamp, dispatch_started_at: stamp,
      accepted_at: null, observed_at: stamp, provider_message_id: `synthetic-sent-${slug}`,
      internet_message_id: `<synthetic-${slug}@example.invalid>`, provider_sent_at: stamp }],
    ['mailbox_service_replies', { ...shared, id: id.reply, parent_id: id.parent, service_obligation_id: service, contact_id: old.contact,
      connector_id: id.connector, provider_message_id: `synthetic-inbox-${slug}`, internet_message_id: `<reply-${slug}@example.invalid>`,
      payload_sha256: hash('retained after body purge'), reply_at: stamp, received_at: stamp, state: 'needs_review', historical: false,
      hold_active: true, encrypted_text: null, raw_expires_at: stamp, raw_purged_at: stamp }],
    ['platform_email_dispatches', { ...shared, id: id.dispatch, logical_key: `password_reset:${id.source}`, purpose: 'password_reset',
      user_id: old.user, source_record_id: id.source, source_revision: '1', recipient_hash: hash(recipient), sender_mailbox: mailbox,
      provider_context: hash(`synthetic-platform:${slug}`), fingerprint: hash('synthetic-platform-attempt'), outcome: 'unknown',
      outcome_code: 'provider_outcome_unknown', claimed_at: stamp, finished_at: stamp }],
    ['platform_email_events', { id: id.event, provider_context: hash(`synthetic-platform:${slug}`), provider_message_id: id.provider,
      event_id: `synthetic-unbound-${slug}`, payload_hash: hash('synthetic-event'), recipient_hash: hash(recipient), sender_mailbox: mailbox,
      signal: 'delivered', occurred_at: stamp, received_at: stamp }],
  ];
}
export async function assertLaunchCommunications(database, slug) {
  const id = launchCommunicationIds(slug), old = fixtureIds(slug);
  const [connector] = (await database.query('SELECT state,encrypted_refresh_token,encrypted_cursors FROM mailbox_connectors WHERE id=$1 AND organization_id=$2', [id.connector, old.organization])).rows;
  assert.equal(connector.state, 'disabled'); assert.equal(connector.encrypted_refresh_token, null); assert.equal(connector.encrypted_cursors, null);
  const [reply] = (await database.query('SELECT * FROM mailbox_service_replies WHERE id=$1 AND organization_id=$2', [id.reply, old.organization])).rows;
  assert.equal(reply.state, 'needs_review'); assert.equal(reply.hold_active, true); assert.equal(reply.encrypted_text, null);
  assert.equal(reply.payload_sha256, hash('retained after body purge')); assert.ok(reply.raw_purged_at);
  const [parent] = (await database.query('SELECT lead_id,accepted_at,provider_message_id,internet_message_id FROM mailbox_communication_parents WHERE id=$1', [id.parent])).rows;
  assert.equal(parent.lead_id, null); assert.equal(parent.accepted_at, null);
  assert.notEqual(parent.provider_message_id, parent.internet_message_id);
  const [dispatch] = (await database.query('SELECT outcome,provider_message_id FROM platform_email_dispatches WHERE id=$1', [id.dispatch])).rows;
  assert.equal(dispatch.outcome, 'unknown'); assert.equal(dispatch.provider_message_id, null);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM platform_email_events WHERE id=$1', [id.event])).rows[0].n, 1);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM mailbox_receipts WHERE id=$1', [id.receipt])).rows[0].n, 1);
}
/** Freeze the actual synthetic occurrence, including database-created timestamps. */
export async function sealLaunchCommunicationFixture(database, slug) {
  const id = launchCommunicationIds(slug), old = fixtureIds(slug), serviceId = nativeFixtureIds(slug).nextService;
  const [service] = (await database.query('SELECT s.*,c.email FROM service_obligations s JOIN contacts c ON c.id=s.contact_id AND c.organization_id=s.organization_id WHERE s.organization_id=$1 AND s.id=$2', [old.organization, serviceId])).rows;
  assert.ok(service?.email);
  await database.query('UPDATE mailbox_communication_parents SET recipient=$3,context_snapshot=$4 WHERE organization_id=$1 AND id=$2',
    [old.organization, id.parent, service.email.trim().toLowerCase(), JSON.stringify({ dueAt: new Date(service.due_at).toISOString(),
      occurrenceIndex: service.occurrence_index, createdAt: new Date(service.created_at).toISOString(), updatedAt: new Date(service.updated_at).toISOString(),
      approvalId: id.source, scheduledActionId: id.source })]);
}
export async function assertLaunchCommunicationKeys(database, slug, foreignSlug) {
  const id = launchCommunicationIds(slug), other = launchCommunicationIds(foreignSlug), foreign = fixtureIds(foreignSlug);
  const checks = [
    ['UPDATE mailbox_connectors SET user_id=$2 WHERE id=$1', [id.connector, foreign.user]],
    ['UPDATE mailbox_receipts SET connector_id=$2 WHERE id=$1', [id.receipt, other.connector]],
    ['UPDATE mailbox_communication_parents SET connector_id=$2 WHERE id=$1', [id.parent, other.connector]],
    ['UPDATE mailbox_communication_parents SET contact_id=$2 WHERE id=$1', [id.parent, foreign.contact]],
    ['UPDATE mailbox_service_replies SET parent_id=$2 WHERE id=$1', [id.reply, other.parent]],
    ['UPDATE mailbox_service_replies SET contact_id=$2 WHERE id=$1', [id.reply, foreign.contact]],
  ];
  for (const [query, values] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(query, values), error => error.code === '23503'); }
    finally { await database.exec('ROLLBACK'); }
  }
  await database.exec('BEGIN');
  try {
    await assert.rejects(database.query('INSERT INTO platform_email_dispatches (logical_key,purpose,source_record_id,source_revision,recipient_hash,sender_mailbox,provider_context,fingerprint) SELECT logical_key,purpose,source_record_id,source_revision,recipient_hash,sender_mailbox,provider_context,fingerprint FROM platform_email_dispatches WHERE id=$1', [id.dispatch]), error => error.code === '23505');
  } finally { await database.exec('ROLLBACK'); }
  return checks.length;
}
