/** Fictional CALLIE visual QA, with all credentials excluded and outbound held. */
import { seedSyntheticCallie } from '../../../scripts/callie-recovery-fixture.mjs';
import { credentialCodec } from '../../../scripts/restore-drill-fixture.mjs';

export async function seedCalliePreview(client, organizationId, actorUserId) {
  if (client.connectionParameters.host !== '127.0.0.1' || client.connectionParameters.database !== 'postgres')
    throw new Error('callie_preview_requires_disposable_loopback');
  const codec = await credentialCodec(Buffer.alloc(32, 63).toString('base64'));
  const fixture = await seedSyntheticCallie(client, { namespace: organizationId, organizationId, actorUserId, codec });
  const [customer] = (await client.query(`INSERT INTO contacts(organization_id,first_name,last_name,email,phone)
    VALUES($1,'FICTIONAL','CALLIE Customer','callie-office@example.invalid','+12025550176') RETURNING id`, [organizationId])).rows;
  await client.query(`INSERT INTO properties(organization_id,contact_id,address_line_1,city,state,postal_code)
    VALUES($1,$2,'100 Fictional QA Lane','Test City','GA','30301')`, [organizationId, customer.id]);
  const [call] = (await client.query(`INSERT INTO twilio_calls(organization_id,request_key,direction,phone,staff_phone,account_sid,provider_sid,status,dial_status,authorization_source,created_at)
    SELECT organization_id,'synthetic-callie-office-review','inbound','+12025550176',staff_phone,account_sid,'CA00000000000000000000000000000007','completed','no-answer','synthetic_fixture',now()-interval '3 hours'
    FROM twilio_calls WHERE id=$1 RETURNING id`, [fixture.call])).rows;
  const [task] = (await client.query(`INSERT INTO crm_tasks(organization_id,title,description,status,priority,assigned_user_id,due_at,source_event)
    VALUES($1,'FICTIONAL: arrange requested repair visit','Caller selected repair and requested a visit. Office must confirm identity and agree a time. No customer message or booking exists.','open','high',$2,now()-interval '2 hours','missed_call') RETURNING id`, [organizationId, actorUserId])).rows;
  await client.query('INSERT INTO missed_call_handoffs(organization_id,call_id,task_id) VALUES($1,$2,$3)', [organizationId, call.id, task.id]);
  const [intake] = (await client.query(`INSERT INTO callie_intakes(organization_id,call_id,policy_revision_id,version,state,stage,binding_id,account_sid,provider_call_sid,from_phone,called_number,owner_user_id,due_at,service_intent,request_intent,callback_window,reason)
    SELECT organization_id,$2,policy_revision_id,5,'blocked','complete',binding_id,account_sid,'CA00000000000000000000000000000007','+12025550176',called_number,owner_user_id,now()-interval '2 hours','repair','visit','afternoon','caller_declined_text'
    FROM callie_intakes WHERE id=$1 RETURNING id`, [fixture.intake, call.id])).rows;
  console.log(`Synthetic CALLIE: /calls?callieId=${fixture.intake} (unknown send), /calls?callieId=${intake.id} (office-confirmed booking QA). No provider connected; outbound held.`);
}
