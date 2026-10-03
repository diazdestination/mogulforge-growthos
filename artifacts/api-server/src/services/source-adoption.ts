import { activitiesTable, auditEventsTable, consentRecordsTable, db, leadsTable, organizationsTable, revenueExecutionsTable } from "@workspace/db";
import { and, desc, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { sourceAdoptionsTable as adoptions, sourceOutreachBatchesTable as batches, sourceOutreachItemsTable as items } from "../../../../lib/db/src/schema/source-adoption";
import { activeSourceDecision, approvedSourceItem, batchFingerprint, currentSource, latestEmailConsent, sourceContactReplyHeld, sourceDecision, sourceEmailPermission, sourceManager, type SourceStore } from "./source-adoption-state";
import { adoptionDeny, adoptionReviewSchema, outreachApproveSchema, outreachDraftSchema, SOURCE_BATCH_MAX, SOURCE_DAILY_MAX, SOURCE_EMAIL_DISCLOSURE, sourceApprovalSchema, sourceFingerprint, sourceOutreachKey, sourcePermissionSchema, sourceRevokeSchema, SourceAdoptionError } from "./source-adoption-contract";
import { checkOutreachTiming, checkSendEligibility, isWithinWindow, publicBaseUrl, unsubscribeFooter } from "./send-gate";
import { hasContactReplyHold } from "./response-correlation";
import { assertCustomerLifecycleActive } from "./customer-lifecycle";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { assertCapabilityForActor } from "./entitlements";
import { resolveCustomerEmailSender, sendCustomerEmail } from "./customer-email";
import { emailAcceptanceEvidence } from "./user-email";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { runDurableAction } from "./durable-execution";
import { acquireNurtureLocks, assertSourceSlotAvailable } from "./source-outreach-ownership";
import { assertContactTouchCurrent, reserveContactTouch, acceptContactTouch, markContactTouchDispatchStarted } from "./contact-touch-claim";
import { sourceNurtureItemsTable } from "../../../../lib/db/src/schema/source-nurture";

const HOUR = 3_600_000, DAY = 24 * HOUR, REVIEW_MS = 10 * 60_000;
const decisionPreviewAction = "source_adoption.previewed";
async function sourceLock(tx: SourceStore, org: string) {
  await tx.execute(sql`select set_config('lock_timeout', '3000ms', true), set_config('statement_timeout', '15000ms', true)`);
  await acquireNurtureLocks(tx, org);
}
function reviewChanged(): never { return adoptionDeny("source_review_changed", "This exact review changed or expired. Refresh and review it again."); }
async function audit(store: SourceStore, org: string, actor: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  await store.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action, entityType, entityId, metadata });
}
function validDates(input: z.infer<typeof adoptionReviewSchema>) {
  const asOf = Date.parse(input.sourceAsOf), cutover = Date.parse(input.cutoverAt), expires = Date.parse(input.expiresAt), now = Date.now();
  if (asOf > cutover || cutover > now || asOf < now - 30 * DAY || expires <= now || expires > now + 30 * DAY)
    adoptionDeny("source_dates_invalid", "Use a reconciled source review from the last 30 days, a completed cutover, and an expiry within 30 days.");
}
export async function getSourceAdoption(org: string, leadId: string) {
  const value = await currentSource(org, leadId), decision = await sourceDecision(org, leadId);
  const consent = await latestEmailConsent(org, value.contact.id);
  let marketingPermission = false;
  try { await sourceEmailPermission(org, value.contact.id, value.snapshot.recipient); marketingPermission = true; } catch { /* Default denied. */ }
  return { ...value.snapshot, name: [value.contact.firstName, value.contact.lastName].filter(Boolean).join(" "), status: value.lead.status,
    importedHistory: value.history, adoption: decision, consentId: consent?.id ?? null, marketingPermission,
    current: !!decision && decision.state === "active" && decision.expiresAt.getTime() > Date.now() && sourceFingerprint(decision.snapshot) === sourceFingerprint(value.snapshot),
    permissionEvidenceType: "staff_recorded_not_provider_verified" as const };
}
export async function listSourceAdoptions(org: string, page = 0, campaignPage = 0) {
  if (![page, campaignPage].every(value => Number.isInteger(value) && value >= 0 && value <= 100_000)) adoptionDeny("source_invalid_page", "Choose a valid page.", 400);
  const candidates = await db.select({ id: leadsTable.id, status: leadsTable.status, importSourceKey: leadsTable.importSourceKey,
    externalOpportunityId: leadsTable.externalOpportunityId }).from(leadsTable).where(and(eq(leadsTable.organizationId, org),
    or(eq(leadsTable.creationMethod, "import"), isNotNull(leadsTable.importedHistory)))).orderBy(desc(leadsTable.createdAt), desc(leadsTable.id)).limit(101).offset(page * 100);
  const campaigns = await db.select().from(batches).where(eq(batches.organizationId, org)).orderBy(desc(batches.createdAt), desc(batches.id)).limit(26).offset(campaignPage * 25);
  return { candidates: candidates.slice(0, 100), campaigns: campaigns.slice(0, 25), page, campaignPage, hasMore: candidates.length > 100, hasMoreCampaigns: campaigns.length > 25,
    limits: { cohort: SOURCE_BATCH_MAX, rollingCompanyLimit: SOURCE_DAILY_MAX, oneAddressLifetimeTouch: true },
    detail: "Adoption preserves import history and grants no contact permission. Reviewed email only; no SMS or automatic playbook enrollment." };
}
export async function previewSourceAdoption(org: string, actor: string, leadId: string, raw: unknown) {
  const input = adoptionReviewSchema.parse(raw); validDates(input);
  await sourceManager(org, actor); await assertCustomerLifecycleActive(org);
  const value = await currentSource(org, leadId), decision = await sourceDecision(org, leadId);
  if ((decision?.version ?? 0) !== input.expectedVersion) reviewChanged();
  if (await hasContactReplyHold(org, value.contact.id)) adoptionDeny("source_reply_review_required", "Review the unresolved customer reply before adoption.");
  const payload = { snapshot: value.snapshot, input }, payloadSha256 = sourceFingerprint(payload);
  const expiresAt = new Date(Date.now() + REVIEW_MS).toISOString();
  const [review] = await db.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: decisionPreviewAction,
    entityType: "lead", entityId: leadId, metadata: { payload, payloadSha256, expiresAt } }).returning({ id: auditEventsTable.id });
  return { previewId: review!.id, payloadSha256, expiresAt, ...payload, detail: "Approval adopts management only. It does not grant marketing permission or send." };
}
export async function approveSourceAdoption(org: string, actor: string, leadId: string, raw: unknown) {
  const input = sourceApprovalSchema.parse(raw);
  await sourceManager(org, actor); await assertCustomerLifecycleActive(org);
  const [review] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.id, input.previewId), eq(auditEventsTable.organizationId, org),
    eq(auditEventsTable.actorUserId, actor), eq(auditEventsTable.action, decisionPreviewAction), eq(auditEventsTable.entityId, leadId)));
  if (!review || review.metadata.payloadSha256 !== input.payloadSha256 || sourceFingerprint(review.metadata.payload) !== input.payloadSha256 ||
      typeof review.metadata.expiresAt !== "string" || !Number.isFinite(Date.parse(review.metadata.expiresAt)) || Date.parse(review.metadata.expiresAt) <= Date.now()) reviewChanged();
  const payload = review.metadata.payload as { input: unknown; snapshot: unknown }, reviewed = adoptionReviewSchema.parse(payload.input); validDates(reviewed);
  const value = await currentSource(org, leadId);
  if (await hasContactReplyHold(org, value.contact.id)) adoptionDeny("source_reply_review_required", "Review the unresolved customer reply before adoption.");
  await db.transaction(async tx => {
    await sourceLock(tx, org); await sourceManager(org, actor, tx);
    const current = await currentSource(org, leadId, tx), previous = await sourceDecision(org, leadId, tx);
    if ((previous?.version ?? 0) !== reviewed.expectedVersion || sourceFingerprint(current.snapshot) !== sourceFingerprint(payload.snapshot)) reviewChanged();
    if (await sourceContactReplyHeld(org, current.contact.id, tx)) adoptionDeny("source_reply_review_required", "Review the unresolved customer reply before adoption.");
    const fields = { contactId: current.contact.id, version: reviewed.expectedVersion + 1, state: "active" as const, snapshot: current.snapshot,
      sourceAsOf: new Date(reviewed.sourceAsOf), cutoverAt: new Date(reviewed.cutoverAt), expiresAt: new Date(reviewed.expiresAt),
      evidence: reviewed.evidence, approvedByUserId: actor, approvedAt: new Date(), revokedAt: null };
    const [saved] = previous ? await tx.update(adoptions).set(fields).where(and(eq(adoptions.id, previous.id), eq(adoptions.organizationId, org))).returning() :
      await tx.insert(adoptions).values({ organizationId: org, leadId, ...fields }).returning();
    await audit(tx, org, actor, "source_adoption.approved", "source_adoption", saved!.id, { decision: saved, previewId: review.id, payloadSha256: input.payloadSha256 });
  });
  return getSourceAdoption(org, leadId);
}
export async function revokeSourceAdoption(org: string, actor: string, leadId: string, raw: unknown) {
  const input = sourceRevokeSchema.parse(raw);
  await db.transaction(async tx => {
    await sourceLock(tx, org); await sourceManager(org, actor, tx); const source = await currentSource(org, leadId, tx);
    await (await import("./source-nurture-authority")).stopSourceNurtureForContact(tx, org, source.contact.id, "source_adoption_revoked");
    const decision = await sourceDecision(org, leadId, tx);
    if (!decision || decision.version !== input.expectedVersion || decision.state !== "active") reviewChanged();
    await tx.update(adoptions).set({ state: "revoked", version: decision.version + 1, revokedAt: new Date() }).where(eq(adoptions.id, decision.id));
    await audit(tx, org, actor, "source_adoption.revoked", "source_adoption", decision.id, { previous: decision, reason: input.reason, version: decision.version + 1 });
  });
  return getSourceAdoption(org, leadId);
}
export async function recordSourceEmailPermission(org: string, actor: string, leadId: string, raw: unknown) {
  const input = sourcePermissionSchema.parse(raw);
  if (Date.parse(input.observedAt) > Date.now()) adoptionDeny("permission_date_invalid", "Permission cannot be observed in the future.");
  await db.transaction(async tx => {
    await sourceLock(tx, org); await sourceManager(org, actor, tx);
    const source = await currentSource(org, leadId, tx), previous = await latestEmailConsent(org, source.contact.id, tx);
    if (input.expectedSourceSha256 !== source.snapshot.sourceSha256 || input.expectedRecipient.trim().toLowerCase() !== source.snapshot.recipient ||
        input.expectedConsentId !== (previous?.id ?? null)) reviewChanged();
    await (await import("./source-nurture-authority")).stopSourceNurtureForContact(tx, org, source.contact.id, "source_permission_changed");
    const [consent] = await tx.insert(consentRecordsTable).values({ organizationId: org, contactId: source.contact.id, channel: "email",
      granted: input.granted, disclosureVersion: SOURCE_EMAIL_DISCLOSURE }).returning();
    await audit(tx, org, actor, "source_email.permission_recorded", "consent", consent!.id, { version: 1, contactId: source.contact.id,
      recipient: source.snapshot.recipient, granted: input.granted, observedAt: input.observedAt, evidence: input.evidence,
      disclosure: "Explicit permission for this contractor's promotional email, withdrawable using the included unsubscribe link.",
      evidenceType: "staff_recorded_not_provider_verified" });
  });
  return getSourceAdoption(org, leadId);
}

async function campaignAuthority(org: string, actor: string) {
  await sourceManager(org, actor);
  await assertCapabilityForActor(org, actor, "revenue.autopilot", "settings.manage");
  await assertCustomerLifecycleActive(org);
}
function batchWindow(batch: Pick<typeof batches.$inferSelect, "settings" | "expiresAt">) {
  if (batch.expiresAt.getTime() <= Date.now()) adoptionDeny("source_campaign_expired", "This campaign expired. It cannot dispatch.");
  if (!isWithinWindow({ ...batch.settings, quietHoursEnabled: true, maxTouchesPerDay: 1 }, new Date()))
    adoptionDeny("source_campaign_quiet_hours", "This campaign is outside its explicitly approved sending window.");
}
async function currentCampaignSource(org: string, actor: string, leadId: string, touchLogicalKey?: string) {
  await campaignAuthority(org, actor);
  const source = await activeSourceDecision(org, leadId);
  if (["won", "disqualified"].includes(source.lead.status)) adoptionDeny("source_stage_ineligible", "This opportunity is not eligible for recovery outreach.");
  if (await hasContactReplyHold(org, source.contact.id)) adoptionDeny("source_reply_review_required", "A customer reply requires review before outreach.");
  const consent = await sourceEmailPermission(org, source.contact.id, source.snapshot.recipient);
  assertOutboundDeliveryAllowed({ channel: "email", recipient: source.snapshot.recipient });
  // A draft cannot satisfy the approved-source gate. All other gate failures remain fatal.
  const gate = await checkSendEligibility({ organizationId: org, leadId, contact: source.contact, channel: "email", kind: "outreach" });
  if (!gate.ok && gate.reason !== "imported_source_requires_current_review") adoptionDeny("source_outreach_held", `Outreach is held (${gate.reason}).`);
  const timing = await checkOutreachTiming({ organizationId: org, contact: source.contact, touchLogicalKey });
  if (!timing.ok) adoptionDeny("source_outreach_held", `Outreach is held (${timing.reason}).`);
  let sender: Awaited<ReturnType<typeof resolveCustomerEmailSender>>;
  try { sender = await resolveCustomerEmailSender({ organizationId: org, leadId }); }
  catch { adoptionDeny("source_sender_unavailable", "Connect the selected assigned/company Gmail or Microsoft mailbox. No fallback is used."); }
  return { source, consent, sender };
}
async function execution(org: string, leadId: string) {
  const [row] = await db.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, sourceOutreachKey(leadId))));
  return row;
}
async function assertUnreserved(org: string, leadId: string, recipient: string, store: SourceStore = db) {
  await assertSourceSlotAvailable(store, org, leadId, recipient);
}
export async function previewSourceOutreach(org: string, actor: string, raw: unknown) {
  const input = outreachDraftSchema.parse(raw), expiresAt = new Date(input.expiresAt);
  if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + DAY) adoptionDeny("source_campaign_expiry_invalid", "A bounded campaign must expire within 24 hours.");
  await campaignAuthority(org, actor);
  const [company] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, org));
  if (company?.name !== input.businessName) adoptionDeny("source_business_identity_changed", "Use the exact saved company name in marketing identification.");
  const origin = new URL(publicBaseUrl());
  if (origin.protocol !== "https:" || origin.hostname === "localhost") adoptionDeny("source_unsubscribe_unavailable", "A configured HTTPS unsubscribe origin is required.");
  const { leadIds, expiresAt: _, ...settings } = input;
  const cohort: (typeof items.$inferInsert)[] = [];
  for (const leadId of [...leadIds].sort()) {
    const { source, consent, sender } = await currentCampaignSource(org, actor, leadId);
    if (source.decision.expiresAt < expiresAt) adoptionDeny("source_review_expires_first", "Campaign expiry must not outlive its source approval.");
    await assertUnreserved(org, leadId, source.snapshot.recipient);
    if (cohort.some(row => row.recipient === source.snapshot.recipient)) adoptionDeny("source_duplicate_recipient", "Choose only one opportunity per email address.");
    cohort.push({ organizationId: org, batchId: "", leadId, contactId: source.contact.id, adoptionId: source.decision.id, recipient: source.snapshot.recipient,
      snapshot: { version: 1, adoptionId: source.decision.id, adoptionVersion: source.decision.version, adoptionSha256: sourceFingerprint(source.decision),
        adoption: source.snapshot, permissionRecordId: consent.id, sender, subject: input.subject,
        body: `${input.body}\n\nPromotional email from ${input.businessName}\n${input.mailingAddress}${unsubscribeFooter(org, source.contact.id)}` } });
  }
  const payloadSha256 = batchFingerprint({ settings, expiresAt }, cohort);
  const batch = await db.transaction(async tx => {
    await sourceLock(tx, org); await sourceManager(org, actor, tx);
    const [saved] = await tx.insert(batches).values({ organizationId: org, settings, payloadSha256, createdByUserId: actor,
      previewExpiresAt: new Date(Date.now() + REVIEW_MS), expiresAt }).returning();
    await tx.insert(items).values(cohort.map(item => ({ ...item, batchId: saved!.id })));
    await audit(tx, org, actor, "source_outreach.previewed", "source_outreach_batch", saved!.id, { payloadSha256, count: cohort.length });
    return saved!;
  });
  return getSourceOutreach(org, batch.id);
}
export async function getSourceOutreach(org: string, id: string) {
  const [batch] = await db.select().from(batches).where(and(eq(batches.organizationId, org), eq(batches.id, id)));
  if (!batch) adoptionDeny("source_campaign_not_found", "Campaign not found in this company.", 404);
  const cohort = await db.select().from(items).where(and(eq(items.organizationId, org), eq(items.batchId, id))).orderBy(items.leadId);
  return { ...batch, items: await Promise.all(cohort.map(async item => {
    const receipt = await execution(org, item.leadId);
    const [otherOwner] = await db.select({ id: items.id }).from(items).where(and(eq(items.organizationId, org), ne(items.id, item.id), isNotNull(items.claimedAt),
      or(eq(items.leadId, item.leadId), eq(items.recipient, item.recipient)))).limit(1);
    const [nurtureOwner] = await db.select({ id: sourceNurtureItemsTable.id }).from(sourceNurtureItemsTable).where(and(eq(sourceNurtureItemsTable.organizationId, org), isNotNull(sourceNurtureItemsTable.admittedAt), or(eq(sourceNurtureItemsTable.leadId, item.leadId), eq(sourceNurtureItemsTable.recipient, item.recipient)))).limit(1);
    const state = !item.claimedAt ? otherOwner || nurtureOwner || receipt ? "reserved_elsewhere" : "not_sent" : !receipt || receipt.state === "indeterminate" || (receipt.state === "processing" && receipt.expiresAt.getTime() <= Date.now()) ? "uncertain" :
      receipt.state === "processing" ? "processing" : receipt.state === "blocked" ? "held" : receipt.state === "succeeded" ? "accepted" : "reconciled";
    return { ...item, delivery: { state, executionId: receipt?.id ?? null, detail: state === "reserved_elsewhere" ? "Another campaign already owns this opportunity or address. Inspect its evidence; this campaign cannot resend it." : receipt?.detail ?? (item.claimedAt ? "Reserved before provider execution; outcome uncertain. Never retry." : "No send is reserved for this item."), deliveryConfirmed: false } };
  })), detail: "Exact reviewed one-touch email. Provider acceptance is not inbox delivery. Reserved/unknown effects cannot be retried or reset with a new campaign." };
}
async function checkFrozenItem(org: string, actor: string, batch: typeof batches.$inferSelect, item: typeof items.$inferSelect, approved: boolean) {
  const { source, consent, sender } = await currentCampaignSource(org, actor, item.leadId, approved ? sourceOutreachKey(item.leadId) : undefined);
  const [company] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, org));
  if (company?.name !== batch.settings.businessName || source.decision.id !== item.adoptionId || sourceFingerprint(source.decision) !== item.snapshot.adoptionSha256 ||
      consent.id !== item.snapshot.permissionRecordId || sourceFingerprint(sender) !== sourceFingerprint(item.snapshot.sender) ||
      sourceFingerprint(source.snapshot) !== sourceFingerprint(item.snapshot.adoption) || item.recipient !== source.snapshot.recipient ||
      item.snapshot.subject !== batch.settings.subject || item.snapshot.body !== `${batch.settings.body}\n\nPromotional email from ${batch.settings.businessName}\n${batch.settings.mailingAddress}${unsubscribeFooter(org, source.contact.id)}`)
    reviewChanged();
  if (approved) {
    const verified = await approvedSourceItem(org, item.leadId, item.contactId, item.id);
    if (verified.batch.version !== batch.version || verified.batch.payloadSha256 !== batch.payloadSha256) reviewChanged();
    batchWindow(verified.batch);
    const gate = await checkSendEligibility({ organizationId: org, leadId: item.leadId, contact: source.contact, channel: "email", kind: "outreach", sourceOutreachItemId: item.id, touchLogicalKey: sourceOutreachKey(item.leadId) });
    if (!gate.ok) adoptionDeny("source_outreach_held", `Outreach is held (${gate.reason}).`);
  }
  return source;
}
export async function approveSourceOutreach(org: string, actor: string, id: string, raw: unknown) {
  const input = outreachApproveSchema.parse(raw); await campaignAuthority(org, actor);
  const preview = await getSourceOutreach(org, id);
  if (preview.createdByUserId !== actor || preview.state !== "draft" || preview.version !== input.expectedVersion || preview.payloadSha256 !== input.payloadSha256 ||
      batchFingerprint(preview, preview.items) !== input.payloadSha256 || preview.previewExpiresAt.getTime() <= Date.now()) reviewChanged();
  batchWindow(preview);
  for (const item of preview.items) { await assertUnreserved(org, item.leadId, item.recipient); await checkFrozenItem(org, actor, preview, item, false); }
  await db.transaction(async tx => {
    await sourceLock(tx, org); await sourceManager(org, actor, tx);
    for (const item of preview.items) {
      const current = await activeSourceDecision(org, item.leadId, tx), permission = await sourceEmailPermission(org, item.contactId, item.recipient, tx);
      if (sourceFingerprint(current.decision) !== item.snapshot.adoptionSha256 || permission.id !== item.snapshot.permissionRecordId ||
          await sourceContactReplyHeld(org, item.contactId, tx)) reviewChanged();
      await assertUnreserved(org, item.leadId, item.recipient, tx);
    }
    const [saved] = await tx.update(batches).set({ state: "approved", approvedByUserId: actor, approvedAt: new Date(), version: input.expectedVersion + 1 })
      .where(and(eq(batches.id, id), eq(batches.organizationId, org), eq(batches.state, "draft"), eq(batches.version, input.expectedVersion))).returning();
    if (!saved) reviewChanged();
    // Actor-bound immutable review and every exact item remain saved, separate from send.
    await audit(tx, org, actor, "source_outreach.approved", "source_outreach_batch", id, { payloadSha256: input.payloadSha256, version: saved.version, count: preview.items.length });
  });
  return getSourceOutreach(org, id);
}
export async function revokeSourceOutreach(org: string, actor: string, id: string, raw: unknown) {
  const input = sourceRevokeSchema.parse(raw);
  await db.transaction(async tx => {
    await sourceLock(tx, org); await sourceManager(org, actor, tx);
    const [saved] = await tx.update(batches).set({ state: "revoked", version: input.expectedVersion + 1, revokedAt: new Date() })
      .where(and(eq(batches.id, id), eq(batches.organizationId, org), eq(batches.version, input.expectedVersion), ne(batches.state, "revoked"))).returning();
    if (!saved) reviewChanged();
    await audit(tx, org, actor, "source_outreach.revoked", "source_outreach_batch", id, { version: saved.version, reason: input.reason, payloadSha256: saved.payloadSha256 });
  });
  return getSourceOutreach(org, id);
}
export async function sendSourceOutreach(org: string, actor: string, id: string, raw: unknown) {
  const input = outreachApproveSchema.parse(raw); await campaignAuthority(org, actor);
  const batch = await getSourceOutreach(org, id);
  if (batch.version !== input.expectedVersion || batch.payloadSha256 !== input.payloadSha256 || batch.state !== "approved") reviewChanged();
  // A batch is bounded by persisted cohort, never an arbitrary client recipient or request key.
  for (const item of batch.items) {
    if (item.claimedAt) continue;
    await checkFrozenItem(org, actor, batch, item, true);
    const claimed = await db.transaction(async tx => {
      await sourceLock(tx, org); await sourceManager(org, actor, tx);
      const [freshBatch] = await tx.select().from(batches).where(and(eq(batches.organizationId, org), eq(batches.id, id)));
      if (!freshBatch || freshBatch.state !== "approved" || freshBatch.version !== batch.version) reviewChanged();
      const [freshItem] = await tx.select().from(items).where(and(eq(items.id, item.id), eq(items.organizationId, org)));
      if (freshItem?.claimedAt) return false;
      const decision = await activeSourceDecision(org, item.leadId, tx);
      const permission = await sourceEmailPermission(org, item.contactId, item.recipient, tx);
      if (sourceFingerprint(decision.decision) !== item.snapshot.adoptionSha256 || permission.id !== item.snapshot.permissionRecordId ||
          await sourceContactReplyHeld(org, item.contactId, tx)) reviewChanged();
      batchWindow(freshBatch);
      await assertUnreserved(org, item.leadId, item.recipient, tx);
      const { sourceCompanyTouchCount } = await import("./source-nurture-authority");
      if (await sourceCompanyTouchCount(tx, org) >= Math.min(SOURCE_DAILY_MAX, batch.settings.dailyLimit)) adoptionDeny("source_daily_limit", "The rolling company send reservation limit is reached.");
      const allowance = await reserveContactTouch(tx, { organizationId: org, logicalKey: sourceOutreachKey(item.leadId), contactId: item.contactId, address: item.recipient, channel: "email", sourceKind: "source", leadId: item.leadId,
        payload: { itemId: item.id, batchId: id, payloadSha256: batch.payloadSha256 } });
      if (!allowance.created) adoptionDeny("source_touch_reserved", "Original allowance is already owned; no automatic replay.");
      const [owned] = await tx.update(items).set({ claimedAt: new Date() }).where(and(eq(items.id, item.id), eq(items.organizationId, org), isNull(items.claimedAt))).returning();
      if (owned) await audit(tx, org, actor, "source_outreach.reserved", "source_outreach_item", item.id, { batchId: id, leadId: item.leadId, payloadSha256: batch.payloadSha256 });
      return !!owned;
    });
    if (!claimed) continue;
    // A crash before this receipt exists still leaves the permanent item reservation.
    await runDurableAction({ organizationId: org, actionKey: sourceOutreachKey(item.leadId), kind: "source_outreach_email", actorUserId: actor, leadId: item.leadId,
      payload: { itemId: item.id, batchId: id, payloadSha256: batch.payloadSha256 }, execute: async () => {
        let dispatchRejected = false;
        const check = async () => {
          await checkFrozenItem(org, actor, batch, item, true);
          await assertContactTouchCurrent(db, { organizationId: org, logicalKey: sourceOutreachKey(item.leadId), contactId: item.contactId, address: item.recipient, channel: "email", sourceKind: "source", leadId: item.leadId,
            payload: { itemId: item.id, batchId: id, payloadSha256: batch.payloadSha256 } });
          const receipt = await execution(org, item.leadId);
          if (!receipt || receipt.state !== "processing" || receipt.expiresAt.getTime() <= Date.now() ||
              receipt.fingerprint !== sourceFingerprint({ itemId: item.id, batchId: id, payloadSha256: batch.payloadSha256 }))
            adoptionDeny("source_execution_not_owned", "This effect is no longer owned for dispatch. Reconcile it; never retry.");
        };
        try { await check(); } catch (error) {
          if (error instanceof SourceAdoptionError || error instanceof EmailDispatchBlockedError) return { state: "blocked", detail: "Reserved email held before provider dispatch. Review required; no automatic retry." };
          throw error;
        }
        let result: Awaited<ReturnType<typeof sendCustomerEmail>>;
        try {
          result = await sendCustomerEmail({ organizationId: org, leadId: item.leadId, to: item.recipient, subject: item.snapshot.subject, body: item.snapshot.body,
            expectedSender: item.snapshot.sender, beforeDispatch: async () => { try { await check(); await markContactTouchDispatchStarted(org, sourceOutreachKey(item.leadId)); } catch (error) { dispatchRejected = true; throw error; } } });
        } catch (error) {
          if (dispatchRejected || error instanceof EmailDispatchBlockedError) return { state: "blocked", detail: "Current review/permission/hold changed at provider boundary. No email sent; reservation retained." };
          throw error;
        }
        const evidence = { ...emailAcceptanceEvidence(result, { organizationId: org, leadId: item.leadId, recipientEmail: item.recipient }),
          sourceOutreachItemId: item.id, batchId: id, payloadSha256: batch.payloadSha256, senderUserId: result.senderUserId };
        await db.transaction(async tx => {
          await audit(tx, org, actor, "source_outreach.provider_accepted", "source_outreach_item", item.id, evidence);
          await tx.insert(activitiesTable).values({ organizationId: org, leadId: item.leadId, contactId: item.contactId, actorUserId: actor,
            type: "email_sent", title: "Reviewed recovery email accepted by provider (delivery unconfirmed)", metadata: evidence });
          // Existing outreach timing counts this family, while email_sent supplies canonical reply correlation.
          await tx.insert(activitiesTable).values({ organizationId: org, leadId: item.leadId, contactId: item.contactId, actorUserId: actor,
            type: "automation_message_sent", title: "Reviewed source recovery touch", metadata: { channel: "email", sourceOutreachItemId: item.id, batchId: id, touchLogicalKey: sourceOutreachKey(item.leadId) } });
        });
        await acceptContactTouch(org, sourceOutreachKey(item.leadId));
        return { state: "succeeded", detail: "Selected provider accepted the reviewed email. Inbox delivery is unconfirmed." };
      } });
  }
  return getSourceOutreach(org, id);
}
