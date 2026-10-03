/** Fictional future series for UI review only. No credentials, consent or sending. */
import { randomUUID } from 'node:crypto';

export async function seedStandingServicePreview(client, organizationId, actorUserId) {
  if (client.connectionParameters.host !== '127.0.0.1' || client.connectionParameters.database !== 'postgres')
    throw new Error('standing_service_preview_requires_disposable_loopback');
  const one = async (query, values) => (await client.query(query, values)).rows[0];
  const contact = await one(`INSERT INTO contacts(organization_id,first_name,last_name,email,phone,do_not_contact,do_not_contact_email,do_not_contact_sms)
    VALUES($1,'FICTIONAL','Standing Service Customer','standing-service@example.invalid','+12025550188',true,true,true) RETURNING id`, [organizationId]);
  const property = await one(`INSERT INTO properties(organization_id,contact_id,address_line_1,city,state,postal_code)
    VALUES($1,$2,'100 Fictional Service Lane','Test City','GA','30301') RETURNING id`, [organizationId, contact.id]);
  const binding = await one(`INSERT INTO twilio_client_bindings(organization_id,account_sid,phone_number,messaging_service_sid,auth_token_secret_ref,public_origin,business_name,sms_disclosure_version)
    VALUES($1,'AC00000000000000000000000000000091','+12025550189','MG00000000000000000000000000000091','SYNTHETIC_NO_SECRET','https://example.invalid','FICTIONAL Service Company','SYNTHETIC ONLY') RETURNING id`, [organizationId]);
  for (const [label, futureDays] of [['Future HVAC service', 60], ['Older HVAC service', 7]]) {
    const due = new Date(); due.setUTCDate(due.getUTCDate() + futureDays); due.setUTCHours(12, 0, 0, 0);
    const anchorDate = due.toISOString().slice(0, 10), id = randomUUID();
    const task = await one(`INSERT INTO crm_tasks(organization_id,contact_id,title,status,assigned_user_id,due_at)
      VALUES($1,$2,$3,'open',$4,$5) RETURNING id`, [organizationId, contact.id, `FICTIONAL: ${label}`, actorUserId, new Date(due.getTime() - 30 * 86_400_000)]);
    const recurrence = { mode: 'calendar_months', intervalMonths: 6, anchorDate, endDate: null,
      agreementNote: 'SYNTHETIC agreement for local UI review only.', approvedByUserId: actorUserId, approvedAt: new Date().toISOString() };
    await client.query(`INSERT INTO service_obligations(id,organization_id,contact_id,property_id,task_id,kind,equipment_label,due_at,notice_days,source,recurrence,notes)
      VALUES($1,$2,$3,$4,$5,'service_plan',$6,$7,30,'manual',$8,'FICTIONAL only. Outbound held, all do-not-contact flags true, no provider credentials.')`,
      [id, organizationId, contact.id, property.id, task.id, `FICTIONAL ${label}`, due, JSON.stringify(recurrence)]);
    console.log(`Synthetic standing service: /service?serviceObligationId=${id}&organizationId=${organizationId} (${label}). Sender ${binding.id} is NOT activated.`);
  }
}
