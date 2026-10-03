import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, customerLifecycleTable, db,
  DEFAULT_SENDING_HOURS, emailSenderPreferencesTable, gmailConnectionsTable, microsoftConnectionsTable,
  organizationsTable, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable,
  usersTable, twilioConsentProofsTable, type ServiceObligation,
} from "@workspace/db";
import { serviceStandingEnrollmentsTable as enrollments, serviceStandingPolicyRevisionsTable as revisions,
  type ServiceStandingSettings, type ServiceStandingSnapshot } from "../../../../lib/db/src/schema/service-standing";
import { hasPermission } from "../lib/permissions";
import { lockContractorSchedule } from "./contractor-scheduling";
import { careFingerprint, serviceCareMessage, type ServiceCareApproval } from "./service-care-policy";
import { phoneE164, twilioForOrganization } from "./twilio-controls";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { assertServiceSmsReplyStorageReady } from "./service-sms-policy";
import { serviceStandingApprovalInputSchema, serviceStandingDisableInputSchema, serviceStandingPreviewInputSchema,
  serviceStandingPreviewResponseSchema, serviceStandingSnapshotSchema, STANDING_LINEAGE_LIMIT, STANDING_PREVIEW_MS,
  type ServiceStandingPreviewSnapshot, type ServiceStandingView } from "./service-standing-contract";

export type StandingReader = Pick<typeof db, "select" | "execute">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class ServiceStandingError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code.replaceAll("_", " ")); }
}
export function denyStanding(code: string, status = 409): never { throw new ServiceStandingError(code, status); }
export async function lockServiceStanding(tx: Tx, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx, org);
}
export async function standingMember(reader: StandingReader, org: string, id: string | null, permission: "crm.write" | "settings.manage") {
  if (!id) return false;
  const [user] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, id)));
  return Boolean(user?.isActive && user.emailVerifiedAt && !user.id.startsWith("invite:") && hasPermission(user.role, permission));
}
export async function readStandingService(reader: StandingReader, org: string, id: string, options: { lockTask?: boolean } = {}) {
  // Only explicit transactional send-claim callers may acquire row locks. GET
  // projections and normal readiness reads remain SELECT-only without locks.
  if (options.lockTask && reader === db) denyStanding("service_task_lock_requires_transaction");
  const [obligation] = await reader.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id)));
  if (!obligation) denyStanding("service_not_found", 404);
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, obligation.contactId)));
  const taskQuery = reader.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, obligation.taskId)));
  const [task] = await (options.lockTask ? taskQuery.for("share") : taskQuery);
  if (!contact || !task || task.contactId !== contact.id) denyStanding("service_customer_or_task_unavailable");
  return { obligation, contact, task };
}
/** A bounded canonical predecessor walk, never matching labels or recipient phones. */
export async function standingLineage(reader: StandingReader, org: string, id: string) {
  const rows: ServiceObligation[] = [], seen = new Set<string>();
  let next: string | null = id;
  while (next) {
    if (seen.has(next) || rows.length >= STANDING_LINEAGE_LIMIT) denyStanding("series_lineage_invalid");
    seen.add(next);
    const [row] = await reader.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, next)));
    if (!row) denyStanding("series_lineage_unavailable");
    rows.push(row); next = row.predecessorObligationId;
  }
  return rows.reverse();
}
export async function standingEnrollment(reader: StandingReader, org: string, rootId: string) {
  const [row] = await reader.select().from(enrollments).where(and(eq(enrollments.organizationId, org), eq(enrollments.seriesRootObligationId, rootId)));
  return row ?? null;
}
export async function currentStandingRevision(reader: StandingReader, org: string, enrollmentId: string) {
  const [row] = await reader.select().from(revisions).where(and(eq(revisions.organizationId, org), eq(revisions.enrollmentId, enrollmentId))).orderBy(desc(revisions.version)).limit(1);
  return row ?? null;
}
/** No lazy settings initialization or migration is permitted in policy reads. */
export async function standingCompanyProjection(reader: StandingReader, org: string) {
  const [company] = await reader.select().from(organizationsTable).where(eq(organizationsTable.id, org));
  if (!company) denyStanding("company_unavailable", 404);
  const [settings] = await reader.select().from(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org));
  const hours = { ...DEFAULT_SENDING_HOURS, ...settings?.sendingHours };
  try { new Intl.DateTimeFormat("en-US", { timeZone: hours.timezone }).format(); } catch { hours.timezone = DEFAULT_SENDING_HOURS.timezone; }
  hours.startHour = Math.min(Math.max(Math.trunc(hours.startHour), 0), 23);
  hours.endHour = Math.min(Math.max(Math.trunc(hours.endHour), hours.startHour + 1), 24);
  hours.maxTouchesPerDay = Math.max(Math.trunc(hours.maxTouchesPerDay), 0);
  if (!Array.isArray(hours.days) || !hours.days.length) hours.days = DEFAULT_SENDING_HOURS.days;
  return { businessName: settings?.businessProfile?.businessName?.trim() || company.name.trim() || "our team", hours, settings };
}
export const serviceNoticeInstant = (obligation: Pick<ServiceObligation, "dueAt" | "noticeDays">) => new Date(obligation.dueAt.getTime() - obligation.noticeDays * 86_400_000);
export const standingExpiry = (obligation: ServiceObligation, policy: ServiceStandingSettings) => new Date(Math.min(obligation.dueAt.getTime(), Date.parse(`${policy.agreementEndsOn}T23:59:59.999Z`)));
function scopeFacts(row: ServiceObligation) {
  return { contactId: row.contactId, propertyId: row.propertyId, kind: row.kind, equipmentLabel: row.equipmentLabel, noticeDays: row.noticeDays,
    recurrence: row.recurrence, coverageStartsOn: row.coverageStartsOn, coverageEndsOn: row.coverageEndsOn, coverageEvidence: row.coverageEvidence };
}
function dueForIndex(anchor: string, months: number) {
  const start = new Date(`${anchor}T12:00:00Z`), day = start.getUTCDate();
  start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() + months);
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, last)); return start.toISOString().slice(0, 10);
}
async function senderIdentity(reader: StandingReader, org: string, channel: "email" | "sms"): Promise<ServiceStandingSnapshot["sender"]> {
  if (channel === "sms") {
    const binding = await twilioForOrganization(org, reader);
    if (!binding || !/^AC[\da-f]{32}$/i.test(binding.accountSid) || !/^MG[\da-f]{32}$/i.test(binding.messagingServiceSid ?? "") ||
      phoneE164(binding.phoneNumber) !== binding.phoneNumber || !binding.origin || !binding.smsDisclosureVersion || !binding.businessName) denyStanding("sender_identity_required");
    return { kind: "sms", id: binding.id, accountSid: binding.accountSid, sender: binding.phoneNumber, messagingServiceSid: binding.messagingServiceSid!, disclosureVersion: binding.smsDisclosureVersion!, origin: binding.origin, businessName: binding.businessName };
  }
  const { settings } = await standingCompanyProjection(reader, org), userId = settings?.customerEmailSenderUserId;
  if (!userId || !await standingMember(reader, org, userId, "crm.write")) denyStanding("sender_identity_required");
  const [preference] = await reader.select().from(emailSenderPreferencesTable).where(and(eq(emailSenderPreferencesTable.organizationId, org), eq(emailSenderPreferencesTable.userId, userId)));
  const [microsoft] = await reader.select().from(microsoftConnectionsTable).where(and(eq(microsoftConnectionsTable.organizationId, org), eq(microsoftConnectionsTable.userId, userId)));
  const provider = preference?.provider ?? (microsoft?.encryptedRefreshToken && !microsoft.revokedAt ? null : "gmail");
  if (provider !== "gmail" && provider !== "microsoft") denyStanding("sender_selection_required");
  const [gmail] = provider === "gmail" ? await reader.select().from(gmailConnectionsTable).where(and(eq(gmailConnectionsTable.organizationId, org), eq(gmailConnectionsTable.userId, userId))) : [];
  const connection = provider === "gmail" ? gmail : microsoft;
  if (!connection || !connection.email) denyStanding("sender_identity_required");
  return { kind: "email", userId, source: "company_default", provider, senderEmail: connection.email.trim().toLowerCase(), connectionId: connection.id,
    connectionRevision: connection.connectedAt.toISOString(), accountId: provider === "microsoft" ? microsoft!.accountId : null };
}
async function reviewSnapshot(reader: StandingReader, org: string, id: string, settings: ServiceStandingSettings) {
  const { obligation, contact, task } = await readStandingService(reader, org, id);
  const lineage = await standingLineage(reader, org, id), root = lineage[0];
  const enrollment = await standingEnrollment(reader, org, root.id), anchor = lineage.find(row => row.id === enrollment?.anchorObligationId) ?? obligation;
  if (!obligation.recurrence || obligation.status !== "active" || !task.assignedUserId || !["open", "in_progress"].includes(task.status) ||
    !await standingMember(reader, org, task.assignedUserId, "crm.write")) denyStanding("active_agreed_service_and_owner_required");
  if (obligation.appointmentId) {
    const [appointment] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, obligation.appointmentId)));
    if (!appointment || ["scheduled", "confirmed"].includes(appointment.status)) denyStanding("service_already_booked");
  }
  if (Date.parse(settings.sourceReview.verifiedAt) > Date.now() || (settings.sourceReview.cutoverAt && (Date.parse(settings.sourceReview.cutoverAt) > Date.parse(settings.sourceReview.verifiedAt)))) denyStanding("source_review_time_invalid");
  const imported = root.source !== "manual" && root.source !== "native";
  if (settings.sourceReview.kind !== (imported ? "reconciled_import" : "native") || (imported && !settings.sourceReview.cutoverAt) || (!imported && settings.sourceReview.cutoverAt !== null)) denyStanding("source_review_required");
  const recipient = settings.channel === "email" ? contact.email?.trim().toLowerCase() : phoneE164(contact.phone ?? "");
  if (!recipient || (settings.channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) denyStanding("recipient_required");
  const { businessName, hours } = await standingCompanyProjection(reader, org);
  const scope: ServiceStandingSnapshot["scope"] = { ...scopeFacts(obligation), recurrence: obligation.recurrence,
    seriesRootObligationId: root.id, anchorObligationId: anchor.id, anchorUpdatedAt: anchor.updatedAt.toISOString(), anchorOccurrenceIndex: anchor.occurrenceIndex,
    reviewedObligationId: obligation.id, reviewedUpdatedAt: obligation.updatedAt.toISOString(), reviewedOccurrenceIndex: obligation.occurrenceIndex,
    source: root.source, externalRef: root.externalRef, ownerUserId: task.assignedUserId, recipient, businessName };
  const template = serviceCareMessage({ businessName, equipmentLabel: obligation.equipmentLabel, kind: obligation.kind, dueDate: "[occurrence service date]" });
  if (settings.channel === "sms") template.body += "\nReply SERVICE [occurrence service reference] followed by your message.";
  const snapshot: ServiceStandingSnapshot = { schemaVersion: "service-standing-policy.v1", settings, scope,
    seriesFingerprint: careFingerprint({ root: root.id, anchor: anchor.id, reviewed: obligation.id, facts: scopeFacts(obligation) }),
    sourceReviewFingerprint: careFingerprint({ root: root.id, source: root.source, externalRef: root.externalRef, review: settings.sourceReview }),
    templateVersion: "service-care.v2", template,
    sender: await senderIdentity(reader, org, settings.channel), sendingHours: hours };
  return { snapshot: serviceStandingSnapshotSchema.parse(snapshot) as ServiceStandingSnapshot, enrollment, obligation };
}
/** SELECT-only core authority, safe with a transaction reader and no external calls. */
export async function assertStandingAuthority(reader: StandingReader, org: string, revisionId: string, occurrenceId: string, at = new Date(), checkOperational = true) {
  const [revision] = await reader.select().from(revisions).where(and(eq(revisions.organizationId, org), eq(revisions.id, revisionId)));
  if (!revision || !revision.enabled || !revision.snapshot.settings.enabled) denyStanding("standing_disabled_or_revised");
  const current = await currentStandingRevision(reader, org, revision.enrollmentId);
  if (current?.id !== revision.id || !await standingMember(reader, org, revision.approvedByUserId, "settings.manage")) denyStanding("standing_disabled_or_revised");
  const parsed = serviceStandingSnapshotSchema.safeParse(revision.snapshot);
  if (!parsed.success) denyStanding("standing_snapshot_invalid");
  const saved = revision.snapshot, scope = saved.scope;
  const [review] = await reader.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.id, revision.reviewId), eq(auditEventsTable.actorUserId, revision.approvedByUserId)));
  if (!review || review.action !== "service.standing_previewed" || review.metadata.payloadHash !== revision.reviewPayloadHash ||
    careFingerprint((review.metadata.expectedSnapshot as ServiceStandingPreviewSnapshot | undefined)?.policy) !== careFingerprint(saved)) denyStanding("standing_review_unavailable");
  const [enrollment] = await reader.select().from(enrollments).where(and(eq(enrollments.organizationId, org), eq(enrollments.id, revision.enrollmentId)));
  if (!enrollment || enrollment.anchorObligationId !== scope.anchorObligationId || enrollment.seriesRootObligationId !== scope.seriesRootObligationId) denyStanding("series_identity_changed");
  const lineage = await standingLineage(reader, org, occurrenceId), cutoff = lineage.findIndex(row => row.id === scope.reviewedObligationId), anchor = lineage.findIndex(row => row.id === scope.anchorObligationId);
  if (lineage[0].id !== scope.seriesRootObligationId || cutoff < 0 || anchor < 0 || anchor > cutoff || lineage[0].source !== scope.source || lineage[0].externalRef !== scope.externalRef) denyStanding("series_lineage_changed");
  const facts = { contactId: scope.contactId, propertyId: scope.propertyId, kind: scope.kind, equipmentLabel: scope.equipmentLabel, noticeDays: scope.noticeDays,
    recurrence: scope.recurrence, coverageStartsOn: scope.coverageStartsOn, coverageEndsOn: scope.coverageEndsOn, coverageEvidence: scope.coverageEvidence };
  if (saved.seriesFingerprint !== careFingerprint({ root: scope.seriesRootObligationId, anchor: scope.anchorObligationId, reviewed: scope.reviewedObligationId, facts }) ||
    saved.sourceReviewFingerprint !== careFingerprint({ root: scope.seriesRootObligationId, source: scope.source, externalRef: scope.externalRef, review: saved.settings.sourceReview })) denyStanding("standing_fingerprint_invalid");
  for (let i = cutoff; i < lineage.length; i++) {
    const row = lineage[i];
    if (careFingerprint(scopeFacts(row)) !== careFingerprint(facts) || (i > cutoff && (row.source !== "approved_recurrence" || row.occurrenceIndex !== lineage[i - 1].occurrenceIndex + 1)) ||
      row.dueAt.toISOString().slice(0, 10) !== dueForIndex(scope.recurrence.anchorDate, row.occurrenceIndex * scope.recurrence.intervalMonths)) denyStanding("series_scope_changed");
  }
  const { obligation, contact, task } = await readStandingService(reader, org, occurrenceId);
  if (obligation.id === scope.reviewedObligationId && obligation.updatedAt.toISOString() !== scope.reviewedUpdatedAt) denyStanding("reviewed_occurrence_changed");
  if (obligation.status !== "active" || !["open", "in_progress"].includes(task.status) || task.assignedUserId !== scope.ownerUserId || !await standingMember(reader, org, scope.ownerUserId, "crm.write")) denyStanding("service_or_owner_unavailable");
  if (obligation.appointmentId) { const [appointment] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, obligation.appointmentId))); if (!appointment || ["scheduled", "confirmed"].includes(appointment.status)) denyStanding("service_already_booked"); }
  const recipient = saved.settings.channel === "email" ? contact.email?.trim().toLowerCase() : phoneE164(contact.phone ?? "");
  const { businessName, hours } = await standingCompanyProjection(reader, org);
  if (recipient !== scope.recipient || businessName !== scope.businessName || careFingerprint(hours) !== careFingerprint(saved.sendingHours) || careFingerprint(await senderIdentity(reader, org, saved.settings.channel)) !== careFingerprint(saved.sender)) denyStanding("recipient_sender_or_policy_changed");
  const dueDate = obligation.dueAt.toISOString().slice(0, 10), noticeAt = serviceNoticeInstant(obligation), expiresAt = standingExpiry(obligation, saved.settings);
  if (dueDate < saved.settings.agreementStartsOn || dueDate > saved.settings.agreementEndsOn || (scope.recurrence.endDate && dueDate > scope.recurrence.endDate)) denyStanding("outside_service_agreement");
  if (noticeAt.getTime() < revision.approvedAt.getTime()) denyStanding("historical_notice_requires_individual_review");
  if (at.getTime() >= expiresAt.getTime()) denyStanding("standing_occurrence_expired");
  if (checkOperational) {
    const [lifecycle] = await reader.select().from(customerLifecycleTable).where(eq(customerLifecycleTable.organizationId, org));
    if (lifecycle && lifecycle.state !== "active") denyStanding("customer_lifecycle_paused");
    if (saved.sender.kind === "sms") {
      try { assertServiceSmsReplyStorageReady(); } catch { denyStanding("sms_reply_storage_unavailable"); }
      if (!(await twilioForOrganization(org, reader))?.smsEnabled) denyStanding("sms_provider_not_ready");
      const [proof] = await reader.select().from(twilioConsentProofsTable).where(and(eq(twilioConsentProofsTable.organizationId, org), eq(twilioConsentProofsTable.contactId, contact.id),
        eq(twilioConsentProofsTable.phone, scope.recipient), eq(twilioConsentProofsTable.purpose, "customer_care"))).orderBy(desc(twilioConsentProofsTable.recordedAt), asc(twilioConsentProofsTable.granted)).limit(1);
      if (!proof?.granted || proof.disclosureVersion !== saved.sender.disclosureVersion) denyStanding("sms_consent_required");
    }
    else {
      const configured = saved.sender.provider === "gmail" ? (await import("./gmail-oauth")).gmailOAuthConfigured() : (await import("./microsoft-oauth")).microsoftOAuthConfigured();
      if (!configured) denyStanding("email_provider_not_ready");
      const table = saved.sender.provider === "gmail" ? gmailConnectionsTable : microsoftConnectionsTable;
      const [connection] = await reader.select().from(table).where(and(eq(table.organizationId, org), eq(table.id, saved.sender.connectionId)));
      const scopeReady = saved.sender.provider === "gmail" ? connection?.grantedScopes.includes("https://www.googleapis.com/auth/gmail.send") : connection?.grantedScopes.some(s => /^(https:\/\/graph\.microsoft\.com\/)?mail\.send$/i.test(s));
      if (!connection?.encryptedRefreshToken || connection.revokedAt || !scopeReady) denyStanding("email_provider_not_ready");
    }
    try { assertOutboundDeliveryAllowed(saved.settings.channel === "email" ? { channel: "email", recipient: scope.recipient } : undefined); } catch { denyStanding("environment_outbound_hold"); }
  }
  return { revision, enrollment, snapshot: saved, obligation, contact, task, noticeAt, expiresAt };
}
function signPreview(value: unknown) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) denyStanding("preview_signing_unavailable", 503);
  return createHmac("sha256", secret).update(`service-standing-preview.v1:${careFingerprint(value)}`).digest("hex");
}
export async function previewServiceStanding(org: string, actor: string, id: string, raw: unknown) {
  const input = serviceStandingPreviewInputSchema.parse(raw);
  return db.transaction(async tx => {
    await lockServiceStanding(tx, org);
    if (!await standingMember(tx, org, actor, "settings.manage")) denyStanding("permission_denied", 403);
    const { snapshot, enrollment, obligation } = await reviewSnapshot(tx, org, id, input.policy);
    const current = enrollment ? await currentStandingRevision(tx, org, enrollment.id) : null;
    if ((current?.version ?? 0) !== input.expectedVersion || obligation.updatedAt.toISOString() !== input.expectedUpdatedAt) denyStanding("stale_service_policy");
    const now = new Date(), expectedSnapshot: ServiceStandingPreviewSnapshot = { schemaVersion: "service-standing-preview.v1", organizationId: org, actorUserId: actor,
      reviewId: randomUUID(), enrollmentId: enrollment?.id ?? randomUUID(), expectedVersion: input.expectedVersion, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + STANDING_PREVIEW_MS).toISOString(), policy: snapshot };
    const previewHash = signPreview(expectedSnapshot);
    await tx.insert(auditEventsTable).values({ id: expectedSnapshot.reviewId, organizationId: org, actorUserId: actor, action: "service.standing_previewed", entityType: "service_obligation", entityId: id,
      metadata: { payloadHash: careFingerprint(expectedSnapshot), expectedSnapshot, customerMessageSent: false } });
    return { expectedVersion: input.expectedVersion, expectedSnapshot, previewHash, expiresAt: expectedSnapshot.expiresAt };
  });
}
export async function approveServiceStanding(org: string, actor: string, id: string, raw: unknown) {
  const input = serviceStandingApprovalInputSchema.parse(raw);
  const expected = signPreview(input.expectedSnapshot);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(input.previewHash, "hex"))) denyStanding("invalid_policy_preview");
  // Validate the exact retained snapshot separately from the request wrapper.
  const preview = serviceStandingPreviewResponseSchema.shape.expectedSnapshot.parse(input.expectedSnapshot);
  if (preview.organizationId !== org || preview.actorUserId !== actor || preview.policy.scope.reviewedObligationId !== id || preview.expectedVersion !== input.expectedVersion ||
    Date.parse(preview.expiresAt) <= Date.now() || Date.parse(preview.issuedAt) > Date.now() || Date.parse(preview.expiresAt) - Date.parse(preview.issuedAt) !== STANDING_PREVIEW_MS) denyStanding("stale_policy_preview");
  await db.transaction(async tx => {
    await lockServiceStanding(tx, org);
    if (!await standingMember(tx, org, actor, "settings.manage")) denyStanding("permission_denied", 403);
    const [review] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.id, preview.reviewId), eq(auditEventsTable.actorUserId, actor)));
    if (!review || review.action !== "service.standing_previewed" || review.entityId !== id || review.metadata.payloadHash !== careFingerprint(preview)) denyStanding("invalid_policy_preview");
    const { snapshot, enrollment } = await reviewSnapshot(tx, org, id, preview.policy.settings);
    const current = enrollment ? await currentStandingRevision(tx, org, enrollment.id) : null;
    if ((current?.version ?? 0) !== input.expectedVersion || (enrollment && enrollment.id !== preview.enrollmentId) || careFingerprint(snapshot) !== careFingerprint(preview.policy)) denyStanding("stale_service_policy");
    if (!enrollment) await tx.insert(enrollments).values({ id: preview.enrollmentId, organizationId: org, seriesRootObligationId: snapshot.scope.seriesRootObligationId, anchorObligationId: snapshot.scope.anchorObligationId, createdByUserId: actor });
    const [revision] = await tx.insert(revisions).values({ organizationId: org, enrollmentId: preview.enrollmentId, version: input.expectedVersion + 1, enabled: snapshot.settings.enabled,
      ownerUserId: snapshot.scope.ownerUserId, snapshot, reviewId: preview.reviewId, reviewPayloadHash: careFingerprint(preview), approvedByUserId: actor }).returning();
    await tx.update(enrollments).set({ nextCheckAt: new Date(), lastResultCode: null }).where(and(eq(enrollments.organizationId, org), eq(enrollments.id, preview.enrollmentId)));
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "service.standing_approved", entityType: "service_standing_revision", entityId: revision.id, metadata: { reviewId: preview.reviewId, version: revision.version, forwardOnly: true, customerMessageSent: false } });
  });
  return getServiceStanding(org, id);
}
export async function disableServiceStanding(org: string, actor: string, id: string, raw: unknown) {
  const input = serviceStandingDisableInputSchema.parse(raw);
  await db.transaction(async tx => {
    await lockServiceStanding(tx, org);
    if (!await standingMember(tx, org, actor, "settings.manage")) denyStanding("permission_denied", 403);
    const lineage = await standingLineage(tx, org, id), enrollment = await standingEnrollment(tx, org, lineage[0].id);
    if (!enrollment) denyStanding("standing_policy_not_found", 404);
    const [prior] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.action, "service.standing_disabled"), eq(auditEventsTable.entityId, enrollment.id), sql`${auditEventsTable.metadata}->>'requestId' = ${input.requestId}`));
    if (prior) { if (prior.metadata.requestFingerprint !== careFingerprint(input) || prior.actorUserId !== actor) denyStanding("request_changed"); return; }
    const current = await currentStandingRevision(tx, org, enrollment.id);
    if (!current || current.version !== input.expectedVersion) denyStanding("stale_service_policy");
    const reviewId = randomUUID(), snapshot = { ...current.snapshot, settings: { ...current.snapshot.settings, enabled: false } };
    await tx.insert(auditEventsTable).values({ id: reviewId, organizationId: org, actorUserId: actor, action: "service.standing_disabled", entityType: "service_standing_enrollment", entityId: enrollment.id,
      metadata: { ...input, requestFingerprint: careFingerprint(input), previousRevisionId: current.id, customerMessageSent: false } });
    await tx.insert(revisions).values({ organizationId: org, enrollmentId: enrollment.id, version: current.version + 1, enabled: false, ownerUserId: current.ownerUserId, snapshot,
      reviewId, reviewPayloadHash: careFingerprint(input), approvedByUserId: actor });
  });
  return getServiceStanding(org, id);
}
export async function getServiceStanding(org: string, id: string): Promise<ServiceStandingView> {
  const { obligation, task } = await readStandingService(db, org, id), lineage = await standingLineage(db, org, id);
  const enrollment = await standingEnrollment(db, org, lineage[0].id), revision = enrollment ? await currentStandingRevision(db, org, enrollment.id) : null;
  let reason: string | null = "standing_policy_disabled", eligible = false;
  if (revision) { try { await assertStandingAuthority(db, org, revision.id, id); reason = null; eligible = true; } catch (error) { if (!(error instanceof ServiceStandingError)) throw error; reason = error.code; } }
  if (eligible && revision) {
    const { checkSendEligibility } = await import("./send-gate");
    const { contact } = await readStandingService(db, org, id);
    const gate = await checkSendEligibility({ organizationId: org, contact, channel: revision.snapshot.settings.channel, kind: "outreach", sendingHours: revision.snapshot.sendingHours });
    if (!gate.ok) { reason = gate.reason; eligible = false; }
    const { hasServiceMailboxReplyHold } = await import("./mailbox-communication");
    const { hasServiceSmsReplyHold } = await import("./service-sms");
    if (await hasServiceMailboxReplyHold(org, id) || await hasServiceSmsReplyHold(org, id)) { reason = "service_reply_requires_office"; eligible = false; }
  }
  const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityId, id), eq(auditEventsTable.action, "service.care_reminder_approved"))).orderBy(desc(auditEventsTable.createdAt)).limit(1);
  const approval = audit?.metadata as ServiceCareApproval | undefined;
  const [execution] = approval ? await db.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${approval.scheduledActionId}`))) : [];
  const [scheduled] = approval ? await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, approval.scheduledActionId))) : [];
  return { serviceObligationId: id, expectedUpdatedAt: obligation.updatedAt.toISOString(), enrollmentId: enrollment?.id ?? null, version: revision?.version ?? 0, revisionId: revision?.id ?? null,
    anchorObligationId: enrollment?.anchorObligationId ?? id, seriesRootObligationId: lineage[0].id, policy: revision?.snapshot.settings ?? null, approvedSnapshot: revision?.snapshot ?? null,
    sourceSummary: { source: lineage[0].source, externalRef: lineage[0].externalRef, kind: obligation.kind, equipmentLabel: obligation.equipmentLabel, dueDate: obligation.dueAt.toISOString().slice(0, 10), noticeDays: obligation.noticeDays,
      recurrence: obligation.recurrence, ownerUserId: task.assignedUserId, coverageStartsOn: obligation.coverageStartsOn, coverageEndsOn: obligation.coverageEndsOn },
    readiness: { ready: reason === null, reason }, occurrence: { eligible: eligible && !audit, reason: audit ? "reminder_already_owned" : reason, noticeAt: serviceNoticeInstant(obligation).toISOString(),
      expiresAt: revision ? standingExpiry(obligation, revision.snapshot.settings).toISOString() : null, authorizationId: audit?.id ?? null, scheduledActionId: approval?.scheduledActionId ?? null,
      origin: approval ? approval.authorization?.origin ?? "individual" : null, receiptState: execution ? execution.state === "processing" && execution.expiresAt.getTime() <= Date.now() ? "indeterminate" : execution.state : scheduled?.status ?? null } };
}
