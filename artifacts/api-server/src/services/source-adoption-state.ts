import { auditEventsTable, consentRecordsTable, contactsTable, db, emailResponseReviewsTable, importedOpportunityHistorySchema, leadsTable, usersTable } from "@workspace/db";
import { sourceAdoptionsTable as adoptions, sourceOutreachBatchesTable as batches, sourceOutreachItemsTable as items, type SourceAdoptionSnapshot } from "../../../../lib/db/src/schema/source-adoption";
import { and, asc, desc, eq } from "drizzle-orm";
import { adoptionDeny, SOURCE_EMAIL_DISCLOSURE, sourceFingerprint } from "./source-adoption-contract";

export type SourceStore = Pick<typeof db, "select" | "insert" | "update" | "execute">;
export type SourceReader = Pick<typeof db, "select">;
export async function sourceContactReplyHeld(org: string, contactId: string, store: SourceReader = db) {
  const [held] = await store.select({ id: emailResponseReviewsTable.id }).from(emailResponseReviewsTable).where(and(
    eq(emailResponseReviewsTable.organizationId, org), eq(emailResponseReviewsTable.contactId, contactId), eq(emailResponseReviewsTable.holdActive, true))).limit(1);
  return !!held;
}
export async function sourceManager(org: string, actor: string, store: SourceReader = db) {
  const [user] = await store.select().from(usersTable).where(and(eq(usersTable.id, actor), eq(usersTable.organizationId, org)));
  if (!user?.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !["owner", "admin"].includes(user.role))
    adoptionDeny("source_manager_required", "An active accepted owner or administrator must review this decision.", 403);
  return user;
}
export async function currentSource(org: string, leadId: string, store: SourceReader = db) {
  const [row] = await store.select({ lead: leadsTable, contact: contactsTable }).from(leadsTable)
    .innerJoin(contactsTable, and(eq(contactsTable.id, leadsTable.contactId), eq(contactsTable.organizationId, org)))
    .where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, leadId)));
  if (!row) adoptionDeny("source_not_found", "Opportunity not found in this company.", 404);
  const history = importedOpportunityHistorySchema.safeParse(row.lead.importedHistory);
  if (!history.success || row.lead.creationMethod !== "import" || !row.lead.importSourceKey || !row.lead.externalOpportunityId)
    adoptionDeny("source_identity_incomplete", "Reconcile the stable source/opportunity identity and historical snapshot before adoption.");
  const recipient = row.contact.email?.trim().toLowerCase() ?? "";
  const snapshot: SourceAdoptionSnapshot = {
    leadId, contactId: row.contact.id, importSourceKey: row.lead.importSourceKey, externalOpportunityId: row.lead.externalOpportunityId, importedHistory: history.data,
    sourceSha256: sourceFingerprint({ creationMethod: row.lead.creationMethod, importSourceKey: row.lead.importSourceKey,
      externalOpportunityId: row.lead.externalOpportunityId, importedHistory: history.data, createdAt: row.lead.createdAt,
      source: row.lead.source, sourceDetail: row.lead.sourceDetail, firstTouch: row.lead.firstTouch }),
    operationalSha256: sourceFingerprint({ contact: row.contact, status: row.lead.status, assignedUserId: row.lead.assignedUserId,
      propertyId: row.lead.propertyId, urgency: row.lead.urgency, serviceType: row.lead.serviceType, summary: row.lead.summary,
      estimatedValueCents: row.lead.estimatedValueCents, latestSource: row.lead.latestSource, wonAt: row.lead.wonAt }),
    recipient,
  };
  return { ...row, history: history.data, snapshot };
}
export async function sourceDecision(org: string, leadId: string, store: SourceReader = db) {
  const [decision] = await store.select().from(adoptions).where(and(eq(adoptions.organizationId, org), eq(adoptions.leadId, leadId)));
  return decision ?? null;
}
export async function activeSourceDecision(org: string, leadId: string, store: SourceReader = db) {
  const source = await currentSource(org, leadId, store), decision = await sourceDecision(org, leadId, store);
  if (!decision || decision.state !== "active" || decision.expiresAt.getTime() <= Date.now() ||
      sourceFingerprint(decision.snapshot) !== sourceFingerprint(source.snapshot))
    adoptionDeny("source_review_required", "Source approval is missing, expired, revoked or changed. Review the current opportunity.");
  await sourceManager(org, decision.approvedByUserId, store);
  return { ...source, decision };
}
export async function latestEmailConsent(org: string, contactId: string, store: SourceReader = db) {
  const [row] = await store.select().from(consentRecordsTable).where(and(eq(consentRecordsTable.organizationId, org),
    eq(consentRecordsTable.contactId, contactId), eq(consentRecordsTable.channel, "email")))
    .orderBy(desc(consentRecordsTable.recordedAt), asc(consentRecordsTable.granted), desc(consentRecordsTable.id)).limit(1);
  return row ?? null;
}
/** Staff attestation of explicit marketing permission, not independent provider verification. */
export async function sourceEmailPermission(org: string, contactId: string, recipient: string, store: SourceReader = db) {
  const consent = await latestEmailConsent(org, contactId, store);
  if (!consent?.granted || consent.disclosureVersion !== SOURCE_EMAIL_DISCLOSURE)
    adoptionDeny("email_marketing_permission_required", "Record current explicit email-marketing permission separately from adoption.");
  const [proof] = await store.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org),
    eq(auditEventsTable.entityType, "consent"), eq(auditEventsTable.entityId, consent.id), eq(auditEventsTable.action, "source_email.permission_recorded"))).limit(1);
  if (!proof || proof.metadata.version !== 1 || proof.metadata.recipient !== recipient || proof.metadata.contactId !== contactId ||
      proof.metadata.granted !== true || typeof proof.metadata.evidence !== "string" || proof.metadata.evidence.length < 20)
    adoptionDeny("email_marketing_permission_required", "Marketing permission must be evidenced for this exact current address.");
  return consent;
}
export function batchFingerprint(batch: Pick<typeof batches.$inferSelect, "settings" | "expiresAt">, cohort: Pick<typeof items.$inferSelect, "leadId" | "contactId" | "recipient" | "snapshot">[]) {
  return sourceFingerprint({ settings: batch.settings, expiresAt: batch.expiresAt, cohort: [...cohort].sort((a, b) => a.leadId.localeCompare(b.leadId))
    .map(({ leadId, contactId, recipient, snapshot }) => ({ leadId, contactId, recipient, snapshot })) });
}
/** Only the narrow, saved, approved email cohort can satisfy the imported-source gate. */
export async function approvedSourceItem(org: string, leadId: string, contactId: string, itemId: string, reader: SourceReader = db) {
  const [item] = await reader.select().from(items).where(and(eq(items.id, itemId), eq(items.organizationId, org), eq(items.leadId, leadId), eq(items.contactId, contactId)));
  if (!item) adoptionDeny("source_outreach_unavailable", "The reviewed outreach item is unavailable.");
  const [batch] = await reader.select().from(batches).where(and(eq(batches.id, item.batchId), eq(batches.organizationId, org)));
  if (!batch || batch.state !== "approved" || !batch.approvedByUserId || batch.expiresAt.getTime() <= Date.now())
    adoptionDeny("source_outreach_held", "The campaign is not currently approved or has expired.");
  await sourceManager(org, batch.approvedByUserId, reader);
  const cohort = await reader.select().from(items).where(and(eq(items.organizationId, org), eq(items.batchId, batch.id)));
  if (batchFingerprint(batch, cohort) !== batch.payloadSha256) adoptionDeny("source_outreach_changed", "The frozen campaign changed.");
  const source = await activeSourceDecision(org, leadId, reader);
  if (source.decision.id !== item.adoptionId || source.decision.version !== item.snapshot.adoptionVersion ||
      sourceFingerprint(source.decision) !== item.snapshot.adoptionSha256 ||
      sourceFingerprint(source.snapshot) !== sourceFingerprint(item.snapshot.adoption) || source.snapshot.recipient !== item.recipient)
    adoptionDeny("source_outreach_changed", "The reviewed source or recipient changed.");
  const permission = await sourceEmailPermission(org, contactId, item.recipient, reader);
  if (permission.id !== item.snapshot.permissionRecordId) adoptionDeny("source_permission_changed", "Review the current email permission.");
  return { item, batch, source };
}
