/** Inert synthetic evidence for visual QA; this never opens a mailbox or sends mail. */
import { createHash, randomUUID } from "node:crypto";

export async function seedLaunchCommunicationsPreview(client, org, actor) {
  if (client.connectionParameters.host !== "127.0.0.1" || client.connectionParameters.database !== "postgres")
    throw new Error("communications_preview_requires_disposable_loopback");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const one = async (sql, args) => (await client.query(sql, args)).rows[0];
  const service = await one("SELECT * FROM service_obligations WHERE organization_id=$1 ORDER BY created_at LIMIT 1", [org]);
  if (!service) throw new Error("Synthetic service fixture required");
  const contact = await one("SELECT email FROM contacts WHERE id=$1 AND organization_id=$2", [service.contact_id, org]);
  const sender = "runtime-qa@example.invalid", stamp = new Date().toISOString(), connection = randomUUID();
  const connector = await one("INSERT INTO mailbox_connectors(organization_id,user_id,connection_id,connection_revision,mailbox_account_id,mailbox_email,state,version,started_at,last_error_code) VALUES($1,$2,$3,$4::text,'synthetic-account',$5,'disabled',2,$4::text::timestamptz,'synthetic_disabled') RETURNING id", [org, actor, connection, stamp, sender]);
  const parent = await one(`INSERT INTO mailbox_communication_parents
    (organization_id,contact_id,service_obligation_id,context_snapshot,provider,sender_user_id,connection_id,connection_revision,
     mailbox_account_id,mailbox_email,connector_id,connector_version,policy_version,connector_started_at,recipient,
     content_sha256,subject_sha256,body_sha256,correlation_header,action_key,execution_fingerprint,dispatch_started_at,
     provider_message_id,internet_message_id,provider_sent_at,observed_at)
    VALUES($1,$2,$3,$4,'microsoft',$5,$6,$7::text,'synthetic-account',$8,$9,1,1,$7::text,$10,$11,$11,$11,$12,
      'synthetic-local-reply',$11,$7::text::timestamptz,'synthetic-sent','<local-synthetic@example.invalid>',$7::text::timestamptz,$7::text::timestamptz) RETURNING id`,
    [org, service.contact_id, service.id, JSON.stringify({ dueAt: service.due_at.toISOString(), occurrenceIndex: service.occurrence_index,
      createdAt: service.created_at.toISOString(), updatedAt: service.updated_at.toISOString(), approvalId: randomUUID(), scheduledActionId: randomUUID() }),
    actor, connection, stamp, sender, connector.id, contact.email, hash("synthetic-content"), hash("synthetic-local-parent")]);
  await client.query(`INSERT INTO mailbox_service_replies
    (organization_id,parent_id,service_obligation_id,contact_id,connector_id,provider_message_id,internet_message_id,
     payload_sha256,reply_at,received_at,state,hold_active,raw_expires_at,raw_purged_at)
    VALUES($1,$2,$3,$4,$5,'synthetic-inbox','<reply-local-synthetic@example.invalid>',$6,now(),now(),'needs_review',true,now()-interval '1 day',now())`,
    [org, parent.id, service.id, service.contact_id, connector.id, hash("retained synthetic reply digest")]);
  await client.query(`INSERT INTO platform_email_dispatches
    (organization_id,logical_key,purpose,user_id,source_record_id,source_revision,recipient_hash,sender_mailbox,provider_context,
     fingerprint,outcome,outcome_code,finished_at)
    VALUES($1,'synthetic-password-reset','password_reset',$2,$3,'1',$4,$5,$6,$7,'unknown','provider_outcome_unknown',now())`,
    [org, actor, randomUUID(), hash(sender), "no-reply@example.invalid", hash("synthetic-context"), hash("synthetic-attempt")]);
  console.log("Synthetic communications evidence seeded: one retained service reply and one uncertain account-email receipt. No credentials or provider connection.");
}
