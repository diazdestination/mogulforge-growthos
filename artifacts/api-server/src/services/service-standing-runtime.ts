import { randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import { auditEventsTable, db, scheduledActionsTable, serviceObligationsTable } from "@workspace/db";
import { serviceStandingEnrollmentsTable as enrollments } from "../../../../lib/db/src/schema/service-standing";
import { careFingerprint, type ServiceCareAuthorization } from "./service-care-policy";
import { buildServiceCareSnapshot, ServiceCareError } from "./service-care";
import { assertStandingAuthority, currentStandingRevision, denyStanding, lockServiceStanding, ServiceStandingError, type StandingReader } from "./service-standing-policy";
import { STANDING_BATCH_SIZE, STANDING_LINEAGE_LIMIT } from "./service-standing-contract";
import { hasServiceMailboxReplyHold } from "./mailbox-communication";
import { hasServiceSmsReplyHold } from "./service-sms";
import { serviceSmsReplyReference } from "./service-sms-policy";
import { checkSendEligibility, nextAllowedSendTime } from "./send-gate";
import { customerWorkAllowedSql } from "./customer-lifecycle-runtime";

async function latestOccurrence(reader: StandingReader, org: string, rootId: string) {
  let id = rootId;
  const seen = new Set<string>();
  for (let depth = 0; depth < STANDING_LINEAGE_LIMIT; depth++) {
    if (seen.has(id)) denyStanding("series_lineage_invalid");
    seen.add(id);
    const [next] = await reader.select({ id: serviceObligationsTable.id }).from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.predecessorObligationId, id)));
    if (!next) return id;
    id = next.id;
  }
  denyStanding("series_lineage_invalid");
}
type MonitorCheckpoint = Pick<typeof enrollments.$inferSelect, "id" | "organizationId" | "nextCheckAt" | "lastCheckedAt">;
type MonitorResult = { code: string; nextCheckAt: Date; obligationId?: string };
/** A completed old read may never postpone a new policy's immediate wake-up. */
export async function publishStandingMonitorCheckpoint(expected: MonitorCheckpoint, expectedRevisionId: string | null, result: MonitorResult) {
  return db.transaction(async tx => {
    await lockServiceStanding(tx, expected.organizationId);
    const [current] = await tx.select().from(enrollments).where(and(eq(enrollments.organizationId, expected.organizationId), eq(enrollments.id, expected.id))).for("update");
    const revision = await currentStandingRevision(tx, expected.organizationId, expected.id);
    if (!current || (revision?.id ?? null) !== expectedRevisionId || current.nextCheckAt.getTime() !== expected.nextCheckAt.getTime() ||
      (current.lastCheckedAt?.getTime() ?? null) !== (expected.lastCheckedAt?.getTime() ?? null)) return false;
    await tx.update(enrollments).set({ lastCheckedAt: new Date(), nextCheckAt: result.nextCheckAt, lastResultCode: result.code,
      ...(result.code === "queued" && result.obligationId ? { lastMaterializedObligationId: result.obligationId } : {}) }).where(and(eq(enrollments.organizationId, expected.organizationId), eq(enrollments.id, expected.id)));
    return true;
  });
}
/** Preparation outside the transaction; all authority is reread under shared locks. */
export async function admitStandingServiceReminder(org: string, enrollmentId: string, at = new Date()) {
  const [enrollment] = await db.select().from(enrollments).where(and(eq(enrollments.organizationId, org), eq(enrollments.id, enrollmentId)));
  if (!enrollment) denyStanding("standing_policy_not_found", 404);
  const revision = await currentStandingRevision(db, org, enrollmentId);
  if (!revision) denyStanding("standing_policy_disabled");
  const id = await latestOccurrence(db, org, enrollment.seriesRootObligationId);
  const current = await assertStandingAuthority(db, org, revision.id, id, at);
  if (current.noticeAt.getTime() > at.getTime()) return { code: "future_notice", nextCheckAt: current.noticeAt, obligationId: id, approvalId: null };
  let saved;
  try { saved = await buildServiceCareSnapshot(org, current.obligation, current.contact, current.snapshot.settings.channel); }
  catch (error) { if (error instanceof ServiceCareError) denyStanding(error.code); throw error; }
  return db.transaction(async tx => {
    await lockServiceStanding(tx, org);
    const fresh = await assertStandingAuthority(tx, org, revision.id, id, new Date());
    if (await latestOccurrence(tx, org, enrollment.seriesRootObligationId) !== id || fresh.obligation.updatedAt.toISOString() !== saved.updatedAt || fresh.contact.updatedAt.getTime() !== current.contact.updatedAt.getTime()) denyStanding("service_changed_during_admission");
    const [existing] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "service_obligation"), eq(auditEventsTable.entityId, id), eq(auditEventsTable.action, "service.care_reminder_approved"))).limit(1);
    const ownNumber = await (await import("./zapier/zapier-specialist-flows")).otherOpenText(org, "maintain.sms.send", "service_obligation", id, "", tx);
    if (existing || ownNumber) return { code: "reminder_already_owned", nextCheckAt: new Date(Date.now() + 15 * 60_000), obligationId: id, approvalId: existing?.id ?? ownNumber!.id };
    const [response] = await tx.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityId, id), eq(auditEventsTable.action, "service.care_response_recorded"))).limit(1);
    if (response || await hasServiceMailboxReplyHold(org, id, tx) || await hasServiceSmsReplyHold(org, id, tx)) denyStanding("service_reply_requires_office");
    const expectedBody = fresh.snapshot.template.body.replace("[occurrence service date]", fresh.obligation.dueAt.toISOString().slice(0, 10)).replace("[occurrence service reference]", serviceSmsReplyReference(org, id));
    if (saved.subject !== fresh.snapshot.template.subject || saved.body !== expectedBody || saved.recipient !== fresh.snapshot.scope.recipient) denyStanding("reviewed_template_changed");
    if (saved.mailboxIdentity) await (await import("./mailbox-connector")).assertMailboxIdentityCurrent(saved.mailboxIdentity, tx);
    const gate = await checkSendEligibility({ organizationId: org, contact: fresh.contact, channel: saved.channel, kind: "outreach", sendingHours: fresh.snapshot.sendingHours }, tx);
    if (!gate.ok && gate.outcome === "blocked") denyStanding(gate.reason);
    let runAt = !gate.ok ? gate.resumeAt : new Date(Math.max(Date.now(), fresh.noticeAt.getTime()));
    runAt = nextAllowedSendTime(fresh.snapshot.sendingHours, runAt) ?? runAt;
    if (runAt.getTime() >= fresh.expiresAt.getTime()) denyStanding("standing_occurrence_expires_before_window");
    const approvalId = randomUUID(), scheduledActionId = randomUUID(), admittedAt = new Date();
    const authorization: ServiceCareAuthorization = { origin: "standing", version: 1, policyRevisionId: revision.id, anchorObligationId: fresh.snapshot.scope.anchorObligationId,
      policyHash: careFingerprint(fresh.snapshot), seriesFingerprint: fresh.snapshot.seriesFingerprint, sourceReviewFingerprint: fresh.snapshot.sourceReviewFingerprint,
      admittedAt: admittedAt.toISOString(), expiresAt: fresh.expiresAt.toISOString() };
    await tx.insert(auditEventsTable).values({ id: approvalId, organizationId: org, actorUserId: fresh.revision.approvedByUserId, action: "service.care_reminder_approved", entityType: "service_obligation", entityId: id,
      metadata: { snapshot: saved, authorization, scheduledActionId, agreementNote: fresh.snapshot.settings.agreementEvidence } });
    await tx.insert(scheduledActionsTable).values({ id: scheduledActionId, organizationId: org, action: { type: "service_care_reminder", params: { approvalId, obligationId: id } }, context: { event: "service.care_reminder", serviceObligationId: id }, runAt });
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: fresh.revision.approvedByUserId, action: "service.standing_occurrence_admitted", entityType: "service_obligation", entityId: id,
      metadata: { policyRevisionId: revision.id, approvalId, scheduledActionId, automaticallyAdmitted: true, individuallyApproved: false, customerMessageSent: false } });
    return { code: "queued", nextCheckAt: new Date(Date.now() + 15 * 60_000), obligationId: id, approvalId };
  });
}
/** Rotate even held series; one old blocked series cannot monopolize a batch. */
export async function processStandingServiceReminders(organizationId?: string) {
  const now = new Date();
  let hadUnexpectedFailure = false;
  const due = await db.select().from(enrollments).where(and(organizationId ? eq(enrollments.organizationId, organizationId) : undefined,
    customerWorkAllowedSql(enrollments.organizationId), lte(enrollments.nextCheckAt, now))).orderBy(asc(enrollments.nextCheckAt), asc(enrollments.id)).limit(STANDING_BATCH_SIZE);
  for (const enrollment of due) {
    let result: MonitorResult, observedRevisionId: string | null;
    try { observedRevisionId = (await currentStandingRevision(db, enrollment.organizationId, enrollment.id))?.id ?? null; }
    catch { hadUnexpectedFailure = true; continue; }
    try { result = await admitStandingServiceReminder(enrollment.organizationId, enrollment.id); }
    catch (error) {
      if (!(error instanceof ServiceStandingError)) {
        hadUnexpectedFailure = true;
        result = { code: "readiness_check_failed", nextCheckAt: new Date(Date.now() + 15 * 60_000) };
      } else {
        result = { code: error.code, nextCheckAt: new Date(Date.now() + 15 * 60_000) };
      }
    }
    try { await publishStandingMonitorCheckpoint(enrollment, observedRevisionId, result); }
    catch { hadUnexpectedFailure = true; }
  }
  if (hadUnexpectedFailure) throw new Error("One or more standing-service readiness checks failed; other due series were processed.");
}
