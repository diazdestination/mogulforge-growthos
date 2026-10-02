/** Fictional, inert fixture consumed only by the disposable loopback runner. */
import { createHash } from "node:crypto";
export async function seedCustomerCarePreview(client, org, userId) {
  if (client.connectionParameters.host !== "127.0.0.1" || client.connectionParameters.database !== "postgres")
    throw new Error("customer_care_preview_requires_disposable_loopback");
  const one = async (sql, values) => (await client.query(sql, values)).rows[0];
  const contact = await one("INSERT INTO contacts(organization_id,first_name,last_name,email,do_not_contact,do_not_contact_email,do_not_contact_sms) VALUES($1,'FICTIONAL','Service Customer','customer@example.invalid',true,true,true) RETURNING id", [org]);
  const lead = await one("INSERT INTO leads(organization_id,contact_id,assigned_user_id,status,summary) VALUES($1,$2,$3,'won','LOCAL QA ONLY: completed service') RETURNING id", [org, contact.id, userId]);
  const task = await one("INSERT INTO crm_tasks(organization_id,contact_id,title,status,assigned_user_id,due_at) VALUES($1,$2,'LOCAL QA: arrange agreed equipment service','open',$3,now()+interval '2 days') RETURNING id", [org, contact.id, userId]);
  await client.query("INSERT INTO service_obligations(organization_id,contact_id,task_id,kind,equipment_label,due_at,notice_days,source,notes) VALUES($1,$2,$3,'maintenance','FICTIONAL HVAC unit',now()+interval '14 days',14,'manual','Local inert visual fixture; no warranty determination.')", [org, contact.id, task.id]);
  const document = { title: "FICTIONAL service invoice", currency: "USD", issuerName: "LOCAL QA Contractor", issuerAddress: null, customerName: "FICTIONAL Service Customer", customerAddress: null,
    dueDate: null, notes: "LOCAL QA ONLY. Not a real bill.", lineItems: [{ description: "FICTIONAL equipment inspection", quantity: "1", unitPriceCents: 12500, totalCents: 12500 }], subtotalCents: 12500, taxCents: 0, totalCents: 12500 };
  const invoice = await one("INSERT INTO invoices(organization_id,lead_id,status,version,invoice_number,draft_document,issued_document,issued_document_sha256,issued_at,created_by_user_id) VALUES($1,$2,'issued',2,'INV-000001',$3,$3,$5,now(),$4) RETURNING id,issued_document", [org, lead.id, JSON.stringify(document), userId, createHash("sha256").update(JSON.stringify(document)).digest("hex")]);
  await client.query("UPDATE invoices SET issued_document_sha256=$2 WHERE id=$1", [invoice.id, createHash("sha256").update(JSON.stringify(invoice.issued_document)).digest("hex")]);
  await client.query("INSERT INTO invoice_sequences(organization_id,next_number) VALUES($1,2)", [org]);
  const callback = await one("INSERT INTO crm_tasks(organization_id,contact_id,lead_id,title,status,assigned_user_id,due_at) VALUES($1,$2,$3,'LOCAL QA: missed call needs review','open',$4,now()) RETURNING id", [org, contact.id, lead.id, userId]);
  const call = await one("INSERT INTO twilio_calls(organization_id,contact_id,request_key,direction,phone,staff_phone,account_sid,status,dial_status,authorization_source) VALUES($1,$2,'local-qa-only','inbound','+12025550123','+12025550124','synthetic-not-an-account','completed','no-answer','synthetic_fixture') RETURNING id", [org, contact.id]);
  await client.query("INSERT INTO missed_call_handoffs(organization_id,call_id,task_id,contact_id,lead_id,reviewed_by_user_id,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,now())", [org, call.id, callback.id, contact.id, lead.id, userId]);
  await client.query("INSERT INTO missed_call_care_cases(organization_id,call_id,owner_user_id,due_at) VALUES($1,$2,$3,now())", [org, call.id, userId]);
}
