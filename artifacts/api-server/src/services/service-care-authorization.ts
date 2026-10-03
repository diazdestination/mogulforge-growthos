import { and, eq } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, scheduledActionsTable } from "@workspace/db";
import { z } from "zod";
import { careFingerprint, type ServiceCareApproval } from "./service-care-policy";
import { assertStandingAuthority, denyStanding, readStandingService, standingMember, type StandingReader } from "./service-standing-policy";
import { phoneE164 } from "./twilio-controls";

/** Dependency-neutral authorization kernel shared by both physical transports. */
export async function readServiceCareAuthorization(reader: StandingReader, org: string, approvalId: string, scheduledActionId: string, options: { lockTask?: boolean } = {}) {
  if (!z.uuid().safeParse(approvalId).success || !z.uuid().safeParse(scheduledActionId).success) denyStanding("invalid_service_claim");
  const [audit] = await reader.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.id, approvalId), eq(auditEventsTable.action, "service.care_reminder_approved"), eq(auditEventsTable.entityType, "service_obligation")));
  if (!audit?.actorUserId || !audit.entityId) denyStanding("invalid_service_approval");
  const approval = audit.metadata as ServiceCareApproval;
  const [scheduled] = await reader.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, scheduledActionId)));
  if (!approval.snapshot || approval.scheduledActionId !== scheduledActionId || approval.snapshot.obligationId !== audit.entityId || !scheduled || scheduled.action.type !== "service_care_reminder" ||
    careFingerprint(scheduled.action.params) !== careFingerprint({ approvalId, obligationId: audit.entityId }) ||
    careFingerprint(scheduled.context) !== careFingerprint({ event: "service.care_reminder", serviceObligationId: audit.entityId })) denyStanding("invalid_service_claim");
  const current = await readStandingService(reader, org, audit.entityId, options);
  return { audit, approval, scheduled, ...current };
}
export async function assertServiceCareAuthorizationCurrent(reader: StandingReader, org: string, approvalId: string, scheduledActionId: string, options: { at?: Date; lockTask?: boolean } = {}) {
  const claim = await readServiceCareAuthorization(reader, org, approvalId, scheduledActionId, options), { obligation, contact, task, approval, audit, scheduled } = claim;
  const saved = approval.snapshot, at = options.at ?? new Date();
  if (scheduled.status !== "pending" || obligation.status !== "active" || obligation.updatedAt.toISOString() !== saved.updatedAt || contact.id !== saved.contactId ||
    (saved.channel === "email" ? contact.email?.trim().toLowerCase() : phoneE164(contact.phone ?? "")) !== saved.recipient || !["open", "in_progress"].includes(task.status) ||
    !await standingMember(reader, org, audit.actorUserId!, "crm.write")) denyStanding("service_authority_changed");
  if (task.assignedUserId && !await standingMember(reader, org, task.assignedUserId, "crm.write")) denyStanding("service_owner_unavailable");
  if (obligation.appointmentId) {
    const [appointment] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, obligation.appointmentId)));
    if (!appointment || ["scheduled", "confirmed"].includes(appointment.status)) denyStanding("service_already_booked");
  }
  const [response] = await reader.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityId, obligation.id), eq(auditEventsTable.action, "service.care_response_recorded"))).limit(1);
  if (response) denyStanding("service_response_requires_office");
  const authority = approval.authorization;
  if (authority && (authority.version !== 1 || !["individual", "standing"].includes(authority.origin))) denyStanding("service_authorization_invalid");
  if (authority?.origin === "standing") {
    const current = await assertStandingAuthority(reader, org, authority.policyRevisionId, obligation.id, at);
    if (authority.anchorObligationId !== current.snapshot.scope.anchorObligationId || authority.policyHash !== careFingerprint(current.snapshot) ||
      authority.seriesFingerprint !== current.snapshot.seriesFingerprint || authority.sourceReviewFingerprint !== current.snapshot.sourceReviewFingerprint ||
      !Number.isFinite(Date.parse(authority.admittedAt)) || Date.parse(authority.admittedAt) < current.revision.approvedAt.getTime() || Date.parse(authority.admittedAt) > at.getTime() ||
      authority.expiresAt !== current.expiresAt.toISOString() || at.getTime() >= Date.parse(authority.expiresAt) || saved.channel !== current.snapshot.settings.channel ||
      audit.actorUserId !== current.revision.approvedByUserId) denyStanding("standing_proof_changed");
  }
  return claim;
}
