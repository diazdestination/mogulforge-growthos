/** Typed lead evidence survives restore without enabling a reader or sender. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixtureIds } from './restore-drill-fixture.mjs';
import { launchCommunicationIds } from './launch-communications-recovery-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function leadReplyFixtureIds(slug) {
  return Object.fromEntries(['parent', 'reply', 'task', 'receipt', 'proposal'].map(name => {
    const value = hash(`lead-replies-recovery-v1:${slug}:${name}`);
    return [name, `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`];
  }));
}

export async function seedLeadReplyFixture(database, slug) {
  const id = leadReplyFixtureIds(slug), old = fixtureIds(slug), mailbox = launchCommunicationIds(slug);
  const [lead] = (await database.query('SELECT l.*,c.email FROM leads l JOIN contacts c ON c.id=l.contact_id AND c.organization_id=l.organization_id WHERE l.id=$1 AND l.organization_id=$2', [old.lead, old.organization])).rows;
  const [connector] = (await database.query('SELECT * FROM mailbox_connectors WHERE id=$1 AND organization_id=$2', [mailbox.connector, old.organization])).rows;
  assert.ok(lead?.email); assert.equal(connector.state, 'disabled');
  const stamp = new Date().toISOString();
  await database.query(`INSERT INTO mailbox_communication_parents
    (id,organization_id,contact_id,lead_id,context_snapshot,provider,sender_user_id,connection_id,connection_revision,
     mailbox_account_id,mailbox_email,connector_id,connector_version,policy_version,connector_started_at,recipient,
     content_sha256,subject_sha256,body_sha256,correlation_header,action_key,execution_fingerprint,reserved_at,
     dispatch_started_at,accepted_at,observed_at,provider_message_id,internet_message_id,provider_sent_at)
    VALUES($1,$2,$3,$4,$5,'microsoft',$6,$7,$8,$9,$10,$11,1,1,$8,$12,$13,$13,$13,$14,$15,$13,$16,$16,NULL,$16,$17,$18,$16)`,
    [id.parent, old.organization, old.contact, old.lead, JSON.stringify({ kind: 'bie_lead_email', version: 1,
      leadId: old.lead, contactId: old.contact, leadCreatedAt: new Date(lead.created_at).toISOString(),
      leadUpdatedAt: new Date(lead.updated_at).toISOString(), proposalId: id.proposal,
      leadMonitoringApproval: { version: 1, approvedAt: connector.started_at.toISOString() } }),
    old.user, connector.connection_id, connector.connection_revision, connector.mailbox_account_id, connector.mailbox_email,
    connector.id, lead.email.trim().toLowerCase(), hash('synthetic-lead-send'), hash(`lead-parent:${slug}`),
    `bie:${id.proposal}`, stamp, `synthetic-lead-sent-${slug}`, `<lead-sent-${slug}@example.invalid>`]);
  await database.query(`INSERT INTO crm_tasks(id,organization_id,lead_id,contact_id,assigned_user_id,title,description,source_event,status,priority)
    VALUES($1,$2,$3,$4,$5,'Review customer reply','Synthetic retained reply evidence; open the lead to review. No raw email content.',$6,'open','high')`,
    [id.task, old.organization, old.lead, old.contact, old.user, `mailbox.lead_reply:${id.reply}`]);
  await database.query(`INSERT INTO email_response_reviews
    (id,organization_id,mailbox_parent_id,mailbox_connector_id,internet_message_id,external_message_id,payload_sha256,
     state,reason,lead_id,contact_id,reply_at,received_at,hold_active,raw_expires_at,raw_purged_at,task_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed','original_mailbox_observation',$8,$9,$10,$10,true,$10,$10,$11)`,
    [id.reply, old.organization, id.parent, connector.id, `<lead-reply-${slug}@example.invalid>`, `synthetic-lead-inbox-${slug}`,
      hash('synthetic-lead-reply-retained'), old.lead, old.contact, stamp, id.task]);
  await database.query(`INSERT INTO mailbox_receipts(id,organization_id,connector_id,connector_version,folder,provider_message_id,content_sha256,state)
    VALUES($1,$2,$3,1,'inbox',$4,$5,'processed')`,
    [id.receipt, old.organization, connector.id, `synthetic-lead-inbox-${slug}`, hash('synthetic-lead-reply-retained')]);
}

export async function assertLeadReplyFixture(database, slug) {
  const id = leadReplyFixtureIds(slug), old = fixtureIds(slug), mailbox = launchCommunicationIds(slug);
  const [reply] = (await database.query('SELECT * FROM email_response_reviews WHERE organization_id=$1 AND id=$2', [old.organization, id.reply])).rows;
  assert.equal(reply.source_id, null); assert.equal(reply.message_id, null);
  assert.equal(reply.mailbox_parent_id, id.parent); assert.equal(reply.mailbox_connector_id, mailbox.connector);
  assert.equal(reply.state, 'confirmed'); assert.equal(reply.hold_active, true); assert.equal(reply.reviewed_at, null);
  assert.equal(reply.encrypted_text, null); assert.ok(reply.raw_purged_at); assert.equal(reply.version, 1);
  assert.equal(reply.payload_sha256, hash('synthetic-lead-reply-retained')); assert.equal(reply.task_id, id.task);
  const [task] = (await database.query('SELECT lead_id,contact_id,assigned_user_id,status,description FROM crm_tasks WHERE organization_id=$1 AND id=$2', [old.organization, id.task])).rows;
  assert.equal(task.lead_id, old.lead); assert.equal(task.contact_id, old.contact); assert.equal(task.assigned_user_id, old.user); assert.equal(task.status, 'open');
  const [parent] = (await database.query('SELECT * FROM mailbox_communication_parents WHERE organization_id=$1 AND id=$2', [old.organization, id.parent])).rows;
  assert.equal(parent.service_obligation_id, null); assert.equal(parent.lead_id, old.lead); assert.equal(parent.accepted_at, null);
  assert.equal(parent.context_snapshot.kind, 'bie_lead_email'); assert.equal(parent.action_key, `bie:${id.proposal}`);
  assert.notEqual(parent.provider_message_id, parent.internet_message_id);
  const [connector] = (await database.query('SELECT state,lead_monitoring_enabled,encrypted_refresh_token FROM mailbox_connectors WHERE id=$1', [mailbox.connector])).rows;
  assert.equal(connector.state, 'disabled'); assert.equal(connector.lead_monitoring_enabled, false); assert.equal(connector.encrypted_refresh_token, null);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM mailbox_receipts WHERE id=$1', [id.receipt])).rows[0].n, 1);
}

export async function assertLeadReplyTenantKeys(database, slug, foreignSlug) {
  const id = leadReplyFixtureIds(slug), other = leadReplyFixtureIds(foreignSlug), foreign = fixtureIds(foreignSlug), foreignMailbox = launchCommunicationIds(foreignSlug);
  const checks = [
    ['UPDATE email_response_reviews SET mailbox_parent_id=$2 WHERE id=$1', [id.reply, other.parent]],
    ['UPDATE email_response_reviews SET mailbox_connector_id=$2 WHERE id=$1', [id.reply, foreignMailbox.connector]],
    ['UPDATE email_response_reviews SET lead_id=$2 WHERE id=$1', [id.reply, foreign.lead]],
    ['UPDATE email_response_reviews SET contact_id=$2 WHERE id=$1', [id.reply, foreign.contact]],
    ['UPDATE email_response_reviews SET task_id=$2 WHERE id=$1', [id.reply, other.task]],
    ['UPDATE mailbox_communication_parents SET lead_id=$2 WHERE id=$1', [id.parent, foreign.lead]],
  ];
  for (const [query, values] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(query, values), error => error.code === '23503'); }
    finally { await database.exec('ROLLBACK'); }
  }
  await database.exec('BEGIN');
  try {
    await assert.rejects(database.query(`INSERT INTO email_response_reviews
      (organization_id,mailbox_parent_id,mailbox_connector_id,internet_message_id,external_message_id,payload_sha256,reason,lead_id,contact_id,raw_expires_at)
      SELECT organization_id,mailbox_parent_id,mailbox_connector_id,internet_message_id,external_message_id,payload_sha256,reason,lead_id,contact_id,raw_expires_at
      FROM email_response_reviews WHERE id=$1`, [id.reply]), error => error.code === '23505');
  } finally { await database.exec('ROLLBACK'); }
  return checks.length;
}
