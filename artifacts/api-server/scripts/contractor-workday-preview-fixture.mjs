/** Exact fictional, query-client-only workday scenario for the isolated runner. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { seedSyntheticWorkday } from '../../../scripts/contractor-workday-recovery-fixture.mjs';

export async function seedContractorWorkdayPreview(client,organizationId,actorUserId) {
  const [row]=(await client.query('SELECT o.slug,u.email FROM organizations o JOIN users u ON u.organization_id=o.id WHERE o.id=$1 AND u.id=$2',[organizationId,actorUserId])).rows;
  assert.equal(row?.slug,'local-runtime-qa'); assert.equal(row?.email,'runtime-qa@example.invalid');
  const seeded=await seedSyntheticWorkday(client,{namespace:'preview-workday-hvac',organizationId,actorUserId,trade:'hvac',preview:true});
  const roof=await seedSyntheticWorkday(client,{namespace:'preview-workday-roof',organizationId,actorUserId,trade:'roofing',preview:true});
  // Put the actual HVAC asset property beyond the first native property page.
  // These extra addresses belong only to the exact fictional preview customer.
  for(let index=0;index<26;index++) {
    const hex=createHash('sha256').update(`preview-workday-property-page:${index}`).digest('hex');
    const propertyId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    await client.query('INSERT INTO properties(id,organization_id,contact_id,address_line_1,city,state,postal_code,property_type,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now())',[propertyId,organizationId,seeded.ids.contact,`${index+1} FICTIONAL Later-Page Test Lane`,'Synthetic City','GA','00000','residential']);
  }
  return { customer:`/contacts/${seeded.ids.contact}?organizationId=${organizationId}`,
    visit:`/appointments?appointmentId=${seeded.ids.readyVisit}&organizationId=${organizationId}`,
    history:`/appointments?appointmentId=${seeded.ids.completedVisit}&organizationId=${organizationId}`,
    service:`/service?serviceObligationId=${seeded.ids.nextService}&organizationId=${organizationId}`,ids:seeded.ids,
    roof:{customer:`/contacts/${roof.ids.contact}?organizationId=${organizationId}`,visit:`/appointments?appointmentId=${roof.ids.readyVisit}&organizationId=${organizationId}`,history:`/appointments?appointmentId=${roof.ids.completedVisit}&organizationId=${organizationId}`,ids:roof.ids} };
}
