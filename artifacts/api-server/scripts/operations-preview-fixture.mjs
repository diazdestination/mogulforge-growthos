/** Fictional source history for the disposable, provider-free loopback preview. */
import { createHash } from "node:crypto";
export async function seedOperationsPreview(client, organizationId, userId) {
  if (client.connectionParameters.host !== "127.0.0.1" || client.connectionParameters.database !== "postgres")
    throw new Error("operations_preview_requires_disposable_loopback");
  const now = new Date().toISOString();
  const hash = createHash("sha256").update("fictional-operations-source").digest("hex");
  const history = {
    version: 1, kind: "csv_snapshot", originalCreatedAt: "2026-01-01T12:00:00.000Z",
    sourceUpdatedAt: now, statusChangedAt: now, lastContactAt: null, snapshotAsOf: now,
    firstImportedAt: now, lastImportedAt: now, externalCustomerId: "fictional-customer-1",
    externalEstimateId: null, currency: "USD", fingerprint: hash, appliedFingerprint: hash,
    mappedFields: ["firstName", "email", "status", "externalOpportunityId"],
  };
  const { rows: [contact] } = await client.query("INSERT INTO contacts(organization_id,first_name,last_name,email,do_not_contact,do_not_contact_email,do_not_contact_sms) VALUES($1,'FICTIONAL','Imported Customer','imported-customer@example.invalid',true,true,true) RETURNING id", [organizationId]);
  await client.query("INSERT INTO leads(organization_id,contact_id,assigned_user_id,status,summary,creation_method,import_source_key,external_opportunity_id,imported_history) VALUES($1,$2,$3,'lost','LOCAL QA ONLY: historical opportunity, no contact permission','import','fictional-source','FICTIONAL-OPPORTUNITY-1',$4)", [organizationId, contact.id, userId, JSON.stringify(history)]);
}
