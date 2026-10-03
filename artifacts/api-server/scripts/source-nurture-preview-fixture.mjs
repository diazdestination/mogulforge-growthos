/** Actual local retained rows for UI QA, with no credentials or dispatch authority. */
import { randomUUID } from 'node:crypto';
import { seedSourceNurtureRecovery, sourceNurtureIds } from '../../../scripts/source-nurture-recovery-fixture.mjs';

export async function seedSourceNurturePreview(client, organizationId, actorUserId) {
  if (client.connectionParameters.host !== '127.0.0.1' || client.connectionParameters.database !== 'postgres')
    throw new Error('nurture_preview_requires_disposable_loopback');
  const existing = (await client.query('SELECT id FROM mailbox_connectors WHERE organization_id=$1 AND user_id=$2', [organizationId, actorUserId])).rows[0];
  const connector = existing ?? (await client.query(`INSERT INTO mailbox_connectors
    (organization_id,user_id,connection_id,connection_revision,mailbox_account_id,mailbox_email,state,version,started_at,last_error_code)
    VALUES($1,$2,$3,'2026-10-03T11:00:00.000Z','synthetic-nurture-account','nurture-qa@example.invalid','disabled',2,'2026-10-03T11:00:00.000Z','synthetic_disabled') RETURNING id`,
    [organizationId, actorUserId, randomUUID()])).rows[0];
  const slug = 'local-runtime-nurture';
  await seedSourceNurtureRecovery(client, slug, { original: { organization: organizationId, user: actorUserId }, mailbox: { connector: connector.id } });
  const id = sourceNurtureIds(slug);
  console.log(`Synthetic retained nurture: /reactivation?nurtureId=${id.plan}; reply: /leads/${id.lead}?tab=messages. Stopped, original unknown, all DNC flags true, reader disabled.`);
}
