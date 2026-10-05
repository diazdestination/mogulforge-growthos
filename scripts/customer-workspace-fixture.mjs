/** Fictional, provider-free records shared by isolated visual QA and restore proof. */
import { createHash } from 'node:crypto';
export function customerWorkspaceIds(slug) {
  const id = name => {
    const h = createHash('sha256').update(`customer-workspace-v1:${slug}:${name}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  return { contact: id('contact'), sameName: id('same-name'), properties: Array.from({ length: 27 }, (_, i) => id(`property-${i}`)),
    appointments: Array.from({ length: 28 }, (_, i) => id(`appointment-${i}`)), tasks: [id('task-0'), id('task-1')],
    services: [id('service-0'), id('service-1')], activity: id('activity') };
}
export async function seedCustomerWorkspaceFixture(database, slug, { organization, user, completed = false }) {
  const id = customerWorkspaceIds(slug);
  for (const contact of [id.contact, id.sameName]) await database.query(`INSERT INTO contacts
    (id,organization_id,first_name,last_name,email,do_not_contact,do_not_contact_email,do_not_contact_sms)
    VALUES($1,$2,'Jordan','SYNTHETIC Service Customer','workspace-qa@example.invalid',true,true,true)`, [contact, organization]);
  for (const [index, property] of id.properties.entries()) await database.query(`INSERT INTO properties
    (id,organization_id,contact_id,address_line_1,city,state,postal_code,property_type,created_at)
    VALUES($1,$2,$3,$4,'Example','GA','00000','Synthetic service site',$5)`,
    [property, organization, id.contact, `${100 + index} Fictional Service Lane`, `2026-10-01T12:00:${String(index).padStart(2, '0')}.000Z`]);
  for (const [index, appointment] of id.appointments.entries()) await database.query(`INSERT INTO appointments
    (id,organization_id,contact_id,property_id,assigned_user_id,type,status,scheduled_start,scheduled_end,notes,created_at)
    VALUES($1,$2,$3,$4,$5,'inspection','scheduled',$6,$7,'PRIVATE SYNTHETIC notes: not projected in customer history',$8)`,
    [appointment, organization, id.contact, index === 1 ? null : id.properties[index % 2], user,
      `2028-06-${String(index + 1).padStart(2, '0')}T14:00:00.000Z`, `2028-06-${String(index + 1).padStart(2, '0')}T15:00:00.000Z`,
      `2026-10-01T12:01:${String(index).padStart(2, '0')}.000Z`]);
  for (const [index, task] of id.tasks.entries()) {
    await database.query(`INSERT INTO crm_tasks(id,organization_id,contact_id,assigned_user_id,title,source_event,due_at)
      VALUES($1,$2,$3,$4,$5,'service.obligation_due','2028-05-15T12:00:00.000Z')`,
      [task, organization, id.contact, user, index ? 'FICTIONAL: confirm unlinked service address' : 'FICTIONAL: prepare maintenance visit']);
    await database.query(`INSERT INTO service_obligations
      (id,organization_id,contact_id,property_id,appointment_id,task_id,kind,equipment_label,due_at,notice_days,coverage_starts_on,coverage_ends_on,coverage_evidence)
      VALUES($1,$2,$3,$4,$5,$6,'maintenance',$7,'2028-06-01T12:00:00.000Z',14,'2026-01-01','2029-01-01','Synthetic recorded dates only; not manufacturer verification')`,
      [id.services[index], organization, id.contact, index ? null : id.properties[0], id.appointments[index], task,
        index ? 'Unlinked equipment — confirm address' : 'Recorded heat pump — synthetic']);
  }
  await database.query(`INSERT INTO activities(id,organization_id,contact_id,actor_user_id,type,title,body,metadata)
    VALUES($1,$2,$3,$4,'note','PRIVATE SYNTHETIC title','PRIVATE SYNTHETIC body','{"syntheticPrivate":"not for projection"}')`, [id.activity, organization, id.contact, user]);
  // Recovery's global inertness guard admits no additional active work. Keep it
  // unchanged: historical QA rows are completed, never granted a send exception.
  if (completed) {
    await database.query("UPDATE service_obligations SET status='completed',completed_at='2028-06-01T16:00:00Z' WHERE organization_id=$1 AND id=ANY($2::uuid[])", [organization, id.services]);
    await database.query("UPDATE crm_tasks SET status='done',completed_at='2028-06-01T16:00:00Z' WHERE organization_id=$1 AND id=ANY($2::uuid[])", [organization, id.tasks]);
    await database.query("UPDATE appointments SET status='completed' WHERE organization_id=$1 AND id=ANY($2::uuid[])", [organization, id.appointments]);
  }
  return id;
}
