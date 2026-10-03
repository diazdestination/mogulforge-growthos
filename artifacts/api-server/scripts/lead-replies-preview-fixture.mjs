/** Inert retained lead reply, distinct from the service customer fixture. */
import { createHash, randomUUID } from 'node:crypto';

export async function seedLeadRepliesPreview(client, org, actor) {
  if (client.connectionParameters.host !== '127.0.0.1' || client.connectionParameters.database !== 'postgres')
    throw new Error('lead_reply_preview_requires_disposable_loopback');
  const one = async (sql, args) => (await client.query(sql, args)).rows[0];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const connector = await one('SELECT * FROM mailbox_connectors WHERE organization_id=$1 AND user_id=$2', [org, actor]);
  if (!connector || connector.state !== 'disabled') throw new Error('lead_reply_preview_requires_disabled_connector');
  const contact = await one("INSERT INTO contacts(organization_id,first_name,last_name,email,do_not_contact,do_not_contact_email,do_not_contact_sms) VALUES($1,'FICTIONAL','Lead Reply Customer','lead-customer@example.invalid',true,true,true) RETURNING id,email", [org]);
  const lead = await one("INSERT INTO leads(organization_id,contact_id,assigned_user_id,status,summary) VALUES($1,$2,$3,'nurture','LOCAL QA ONLY: lead reply awaiting office review') RETURNING *", [org, contact.id, actor]);
  const proposal = randomUUID(), replyId = randomUUID(), stamp = new Date().toISOString();
  const parent = await one(`INSERT INTO mailbox_communication_parents
    (organization_id,contact_id,lead_id,context_snapshot,provider,sender_user_id,connection_id,connection_revision,
     mailbox_account_id,mailbox_email,connector_id,connector_version,policy_version,connector_started_at,recipient,
     content_sha256,subject_sha256,body_sha256,correlation_header,action_key,execution_fingerprint,
     dispatch_started_at,provider_message_id,internet_message_id,provider_sent_at,observed_at)
    VALUES($1,$2,$3,$4,'microsoft',$5,$6,$7,$8,$9,$10,1,1,$7,$11,$12,$12,$12,$13,$14,$12,$15,
      'synthetic-lead-sent','<lead-preview@example.invalid>',$15,$15) RETURNING id`,
    [org, contact.id, lead.id, JSON.stringify({ kind:'bie_lead_email', version:1, leadId:lead.id, contactId:contact.id,
      leadCreatedAt:lead.created_at.toISOString(), leadUpdatedAt:lead.updated_at.toISOString(), proposalId:proposal,
      leadMonitoringApproval:{version:1,approvedAt:connector.started_at.toISOString()} }), actor,
    connector.connection_id, connector.connection_revision, connector.mailbox_account_id, connector.mailbox_email,
    connector.id, contact.email, hash('synthetic-lead-content'), hash('synthetic-lead-preview-parent'), `bie:${proposal}`, stamp]);
  const task = await one(`INSERT INTO crm_tasks(organization_id,lead_id,contact_id,assigned_user_id,title,description,source_event,status,priority,due_at)
    VALUES($1,$2,$3,$4,'Review customer reply','LOCAL QA ONLY. Retained reply evidence; no customer message was sent.',$5,'open','high',now()) RETURNING id`,
    [org, lead.id, contact.id, actor, `mailbox.lead_reply:${replyId}`]);
  await client.query(`INSERT INTO email_response_reviews
    (id,organization_id,mailbox_parent_id,mailbox_connector_id,internet_message_id,external_message_id,payload_sha256,state,reason,
     lead_id,contact_id,reply_at,received_at,hold_active,raw_expires_at,raw_purged_at,task_id,effect_summary)
    VALUES($1,$2,$3,$4,'<lead-reply-preview@example.invalid>','synthetic-lead-inbox',$5,'confirmed','original_mailbox_observation',
      $6,$7,now(),now(),true,now()-interval '1 day',now(),$8,$9)`,
    [replyId, org, parent.id, connector.id, hash('synthetic-retained-lead-reply'), lead.id, contact.id, task.id,
      JSON.stringify({pausedEnrollments:1,cancelledActions:1,blockedProposals:1,reconciliationRequired:1})]);
  console.log(`Synthetic lead reply available at /leads/${lead.id}. Reader disabled, content expired, follow-up held. No provider access.`);
}
