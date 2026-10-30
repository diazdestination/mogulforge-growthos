import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  activitiesTable, appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, db,
  revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable,
  twilioConsentProofsTable, usersTable, type ActionResult,
} from "@workspace/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { assertOperationalStaff, assertScheduleInterval, assertScheduleVersion, appointmentCustomer, lockContractorSchedule, type ScheduleTransaction } from "./contractor-scheduling";
import { assertSchedulingActor, lockSchedulingConfiguration, readSchedulingContext, SchedulingPolicyError } from "./scheduling-policy";
import { appendSchedulingTransition, prepareSchedulingAdmission, schedulingFailure, type ServerSchedulingAuthority } from "./scheduling-admission";
import { CustomerLifecycleHoldError, getCustomerLifecycleStatus } from "./customer-lifecycle";
import type { SchedulingCandidate } from "@workspace/scheduling-core";
import { resolveCustomerEmailSender, sendCustomerEmail } from "./customer-email";
import { emailAcceptanceEvidence } from "./user-email";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { checkSendEligibility, nextAllowedSendTime } from "./send-gate";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { customerWorkHeld } from "./customer-lifecycle-runtime";
import { getSendingHours } from "./settings";
import { phoneE164, twilioForOrganization } from "./twilio-controls";
import { sendTwilioSms } from "./twilio-delivery";
import { serviceNoticeAt } from "./service-obligations";
import { approveServiceCareSchema, careFingerprint, serviceCareBookingSchema, serviceCareBookingResultSchema, serviceCareSchedulingReadSchema, serviceCareMessage, serviceCareResponseSchema, type ServiceCareSnapshot as Snapshot, type ServiceCareApproval as Approval, type ServiceCareSchedulingRead, type ServiceCareBookingResult } from "./service-care-policy";
import { hasServiceMailboxReplyHold, recordMailboxParentAcceptance, reserveServiceMailboxParent } from "./mailbox-communication";
import { assertServiceCareAuthorizationCurrent } from "./service-care-authorization";
import { lockServiceStanding, ServiceStandingError, standingCompanyProjection } from "./service-standing-policy";
import { assertServiceSmsReplyStorageReady, serviceSmsReplyReference, serviceSmsReplySuffix } from "./service-sms-policy";
import { hasServiceSmsReplyHold, reserveServiceSmsParent } from "./service-sms";
import { markContactTouchDispatchStarted } from "./contact-touch-claim";
import { guardWorkdayService } from "./workday-guards";

const APPROVED = "service.care_reminder_approved";
const RESPONSE = "service.care_response_recorded";
const BOOKED = "service.care_visit_booked";
const EVENT = "service.care_reminder";
type Channel = "email" | "sms";
type Obligation = typeof serviceObligationsTable.$inferSelect;
type Contact = typeof contactsTable.$inferSelect;
type Reader = typeof db | ScheduleTransaction;
export class ServiceCareError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
function fail(code: string, message: string, status = 409): never { throw new ServiceCareError(code, message, status); }
const serviceWhere = (org: string, id: string) => and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id));
async function readService(org: string, id: string, reader: Reader = db, lock?: "share" | "update") {
  const query = reader.select().from(serviceObligationsTable).where(serviceWhere(org, id));
  const [obligation] = await (lock ? query.for(lock) : query);
  if (!obligation) return fail("not_found", "Service is not available in this company.", 404);
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, obligation.contactId)));
  if (!contact) return fail("not_found", "Service customer is not available.", 404);
  return { obligation, contact };
}
async function actorActive(org: string, actor: string) {
  const [user] = await db.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  return !!user && user.isActive && !!user.emailVerifiedAt && !user.id.startsWith("invite:") && hasPermission(user.role, "crm.write");
}
const auditWhere = (org: string, id: string, action: string) => and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "service_obligation"), eq(auditEventsTable.entityId, id), eq(auditEventsTable.action, action));
async function latest(org: string, id: string, action: string, reader: Reader = db) {
  const [row] = await reader.select().from(auditEventsTable).where(auditWhere(org, id, action)).orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id)).limit(1);
  return row ?? null;
}
async function receipt(org: string, scheduledId: string, reader: Reader = db) {
  const [row] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${scheduledId}`)));
  return row ?? null;
}
async function replay(reader: Reader, org: string, id: string, action: string, input: { requestId: string }) {
  const [row] = await reader.select().from(auditEventsTable).where(and(auditWhere(org, id, action), sql`${auditEventsTable.metadata}->>'requestId' = ${input.requestId}`)).limit(1);
  if (row && row.metadata.requestFingerprint !== careFingerprint(input)) fail("request_changed", "This request ID belongs to different details. Refresh and review the saved result.");
  return row;
}
function activeUnbooked(obligation: Obligation) {
  if (obligation.status !== "active") fail("service_inactive", "Only an active service can receive a reminder or new booking.");
}
async function isBooked(org: string, obligation: Obligation, reader: Reader = db) {
  if (!obligation.appointmentId) return false;
  const [row] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, obligation.appointmentId)));
  return !!row && ["scheduled", "confirmed"].includes(row.status);
}
async function transport(org: string, contact: Contact, channel: Channel) {
  if (channel === "email") {
    const sender = await resolveCustomerEmailSender({ organizationId: org });
    const mailboxIdentity = sender.provider === "microsoft" ? await (await import("./mailbox-connector")).getMicrosoftMailboxIdentity(org, sender.userId) : null;
    return { sender, smsBinding: null, ...(mailboxIdentity ? { mailboxIdentity } : {}) };
  }
  const config = await twilioForOrganization(org);
  if (!config?.smsEnabled) fail("sms_not_ready", "This company's SMS registration and sender must be activated before approving a reminder.");
  const phone = phoneE164(contact.phone ?? "");
  const [proof] = await db.select().from(twilioConsentProofsTable).where(and(eq(twilioConsentProofsTable.organizationId, org), eq(twilioConsentProofsTable.contactId, contact.id), eq(twilioConsentProofsTable.phone, phone ?? ""), eq(twilioConsentProofsTable.purpose, "customer_care"))).orderBy(desc(twilioConsentProofsTable.recordedAt), asc(twilioConsentProofsTable.granted)).limit(1);
  if (!phone || !proof?.granted || proof.disclosureVersion !== config.smsDisclosureVersion) fail("sms_consent_required", "Current phone-specific customer-care SMS consent is required.");
  return { sender: null, smsBinding: careFingerprint({ id: config.id, accountSid: config.accountSid, phone: config.phoneNumber, service: config.messagingServiceSid, disclosure: config.smsDisclosureVersion, businessName: config.businessName, origin: config.origin }) };
}
export async function buildServiceCareSnapshot(org: string, obligation: Obligation, contact: Contact, channel: Channel, withSmsReply = true): Promise<Snapshot> {
  if (channel === "sms" && withSmsReply) { try { assertServiceSmsReplyStorageReady(); } catch { fail("sms_reply_storage_unavailable", "Encrypted service SMS reply storage is not configured. No reminder was sent."); } }
  const message = serviceCareMessage({ businessName: (await standingCompanyProjection(db, org)).businessName, equipmentLabel: obligation.equipmentLabel, kind: obligation.kind, dueDate: obligation.dueAt.toISOString().slice(0, 10) });
  if (channel === "sms" && withSmsReply) message.body += `\n${serviceSmsReplySuffix(org, obligation.id)}`;
  return { obligationId: obligation.id, updatedAt: obligation.updatedAt.toISOString(), contactId: contact.id,
    channel, recipient: channel === "email" ? (contact.email ?? "").trim().toLowerCase() : phoneE164(contact.phone ?? "") ?? "",
    ...message, noticeAt: serviceNoticeAt(obligation.dueAt, obligation.noticeDays).toISOString(), ...await transport(org, contact, channel),
    ...(channel === "sms" && withSmsReply ? { smsReply: { version: 1 as const, reference: serviceSmsReplyReference(org, obligation.id) } } : {}) };
}
const snapshot = buildServiceCareSnapshot;
async function eligibility(org: string, contact: Contact, channel: Channel, actionKey?: string) {
  // The stricter outreach gate is deliberately reused for source/reply holds,
  // quiet hours and frequency caps. This does NOT turn expected-service copy
  // into marketing or release imported opportunities for campaigns.
  return checkSendEligibility({ organizationId: org, contact, channel, kind: "outreach", sendingHours: (await standingCompanyProjection(db, org)).hours, serviceCareActionKey: actionKey });
}
export type ServiceCareReadOptions = { actorUserId?: string; appointmentType?: "inspection" | "other" };
async function readServiceScheduling(org: string, id: string, options: ServiceCareReadOptions) {
  return db.transaction(async tx => {
    // A recovery Reader can inspect Care but cannot acquire row locks or offer
    // a writable scheduling review. This mode comes only from PostgreSQL.
    const mode = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS read_only`);
    const readOnly = mode.rows[0]?.read_only === "on";
    const readOptions = readOnly ? { readOnly: true as const } : {};
    if (!readOnly) await lockSchedulingConfiguration(tx, org, false);
    if (options.actorUserId !== undefined) await assertSchedulingActor(tx, { organizationId: org, userId: options.actorUserId }, "crm.read", false, readOptions);
    const { obligation, contact } = await readService(org, id, tx, readOnly ? undefined : "share");
    await appointmentCustomer(tx, org, obligation, readOptions);
    const source = { sourceKind: "direct_customer" as const, leadId: null, contactId: obligation.contactId, propertyId: obligation.propertyId, estimateId: null };
    const appointmentType = options.appointmentType ?? "inspection";
    let review: ServiceCareSchedulingRead["review"] = { state: "held", code: "scheduling_reader_required", message: "Sign in as an accepted staff member to review this booking." };
    if (readOnly) review = { state: "held", code: "scheduling_reader_required", message: "Scheduling review requires a writable database connection." };
    if (options.actorUserId !== undefined && !readOnly) {
      try {
        const current = await readSchedulingContext(tx, org, undefined, { reservationKind: "appointment", appointmentType });
        review = { state: "ready", policy: current.policy, context: { ...current.context, source } };
      } catch (error) {
        if (!(error instanceof SchedulingPolicyError) || error.code !== "invalid_scheduling_policy") throw error;
        review = { state: "held", code: "invalid_scheduling_policy", message: error.message };
      }
    }
    const scheduling = serviceCareSchedulingReadSchema.parse({ organizationId: org, actorUserId: options.actorUserId ?? null, obligationId: obligation.id, expectedUpdatedAt: obligation.updatedAt.toISOString(), appointmentType, source, review });
    return { obligation, contact, scheduling };
  });
}
export async function getServiceCare(org: string, id: string, channel: Channel = "email", options: ServiceCareReadOptions = {}) {
  const { obligation, contact, scheduling } = await readServiceScheduling(org, id, options);
  const approval = await latest(org, id, APPROVED);
  const response = await latest(org, id, RESPONSE);
  const booking = await latest(org, id, BOOKED);
  const accepted = await latest(org, id, "service.care_reminder_accepted");
  let preview: (Snapshot & { fingerprint: string; runAt: string }) | null = null;
  let blockReason: string | null = null;
  let deferredReason: string | null = null;
  try {
    activeUnbooked(obligation);
    if (await hasServiceMailboxReplyHold(org, id) || await hasServiceSmsReplyHold(org, id)) fail("service_reply_held", "A reply to this service reminder requires office follow-up. Review the retained reply evidence; no reminder is rearmed.");
    if (await isBooked(org, obligation)) fail("already_booked", "A visit is already scheduled. Manage it in Appointments.");
    const current = await snapshot(org, obligation, contact, channel);
    const gate = await eligibility(org, contact, channel);
    if (!gate.ok && gate.outcome === "blocked") fail(gate.reason, `Reminder held: ${gate.reason}. Review the customer record and contact policy.`);
    let runAt = new Date(Math.max(Date.now(), new Date(current.noticeAt).getTime(), !gate.ok ? gate.resumeAt.getTime() : 0));
    runAt = nextAllowedSendTime(await getSendingHours(org), runAt) ?? runAt;
    preview = { ...current, fingerprint: careFingerprint(current), runAt: runAt.toISOString() };
    try { assertOutboundDeliveryAllowed(channel === "email" ? { channel: "email", recipient: current.recipient } : undefined); }
    catch { deferredReason = "Outbound activation/recipient hold: the approved reminder stays queued without a send attempt."; }
  } catch (error) { blockReason = error instanceof ServiceCareError ? error.message : "Reminder readiness could not be confirmed. Check the selected customer sender and refresh before approving."; }
  const approved = approval?.metadata as Approval | undefined;
  const execution = approved ? await receipt(org, approved.scheduledActionId) : null;
  const executionState = execution?.state === "processing" && execution.expiresAt.getTime() <= Date.now() ? "indeterminate" : execution?.state;
  const [scheduled] = approved ? await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, approved.scheduledActionId))) : [];
  const [appointment] = obligation.appointmentId ? await db.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, obligation.appointmentId))) : [];
  return { obligationId: id, expectedUpdatedAt: obligation.updatedAt.toISOString(), active: obligation.status === "active", scheduling, preview, blockReason, deferredReason,
    reminder: approval ? { approvalId: approval.id, approvedAt: approval.createdAt.toISOString(), origin: approved!.authorization?.origin ?? "individual", policyRevisionId: approved!.authorization?.origin === "standing" ? approved!.authorization.policyRevisionId : null, channel: approved!.snapshot.channel, recipient: approved!.snapshot.recipient, subject: approved!.snapshot.subject, body: approved!.snapshot.body, agreementNote: approved!.agreementNote, state: executionState ?? scheduled?.status ?? "review_required", runAt: scheduled?.runAt.toISOString() ?? null, detail: execution?.detail ?? scheduled?.lastError ?? null, providerEvidence: accepted?.metadata ?? null, deliveryConfirmed: false } : null,
    response: response ? { id: response.id, recordedAt: response.createdAt.toISOString(), ...response.metadata } : null,
    booking: booking ? { id: booking.id, ...booking.metadata } : null,
    appointment: appointment ? { id: appointment.id, status: appointment.status, scheduledStart: appointment.scheduledStart.toISOString(), scheduledEnd: appointment.scheduledEnd?.toISOString() ?? null, assignedUserId: appointment.assignedUserId } : null,
  };
}

export async function approveServiceCare(org: string, actor: string, id: string, raw: unknown) {
  const input = approveServiceCareSchema.parse(raw);
  const { obligation, contact } = await readService(org, id);
  if (!await actorActive(org, actor)) fail("staff_required", "An active accepted staff member must approve this reminder.", 403);
  const duplicate = await replay(db, org, id, APPROVED, input);
  if (duplicate) return { approvalId: duplicate.id, replayed: true };
  activeUnbooked(obligation);
  assertScheduleVersion(obligation.updatedAt, input.expectedUpdatedAt);
  const saved = await snapshot(org, obligation, contact, input.channel);
  if (careFingerprint(saved) !== input.previewFingerprint) fail("preview_changed", "The customer, service, or sender changed. Refresh and review the exact message again.");
  const gate = await eligibility(org, contact, input.channel);
  if (!gate.ok && gate.outcome === "blocked") fail(gate.reason, `Reminder held: ${gate.reason}.`);
  let runAt = new Date(Math.max(Date.now(), new Date(saved.noticeAt).getTime(), !gate.ok ? gate.resumeAt.getTime() : 0));
  runAt = nextAllowedSendTime(await getSendingHours(org), runAt) ?? runAt;
  return db.transaction(async tx => {
    await lockServiceStanding(tx, org);
    await assertOperationalStaff(tx, org, [actor]);
    const again = await replay(tx, org, id, APPROVED, input);
    if (again) return { approvalId: again.id, replayed: true };
    const current = await readService(org, id, tx);
    assertScheduleVersion(current.obligation.updatedAt, input.expectedUpdatedAt);
    if (current.contact.updatedAt.getTime() !== contact.updatedAt.getTime()) fail("preview_changed", "Customer details changed. Refresh and review again.");
    activeUnbooked(current.obligation);
    if (await isBooked(org, current.obligation, tx)) fail("already_booked", "A visit is already scheduled.");
    if (await (await import("./zapier/zapier-specialist-flows")).otherOpenText(org, "maintain.sms.send", "service_obligation", id, "", tx)) fail("reminder_exists", "A connected phone app reminder already owns this service. Review its receipt.");
    if (await latest(org, id, APPROVED, tx)) fail("reminder_exists", "This service already has a reminder receipt. Review it; another key or channel cannot resend it.");
    if (await latest(org, id, RESPONSE, tx)) fail("response_exists", "A customer response is already recorded. Continue office follow-up instead of another automated reminder.");
    if (await hasServiceMailboxReplyHold(org, id, tx) || await hasServiceSmsReplyHold(org, id, tx)) fail("service_reply_held", "Review the reply to this service before further customer work.");
    const approvalId = randomUUID(), scheduledActionId = randomUUID();
    await tx.insert(auditEventsTable).values({ id: approvalId, organizationId: org, actorUserId: actor, action: APPROVED, entityType: "service_obligation", entityId: id,
      metadata: { snapshot: saved, authorization: { origin: "individual", version: 1 }, requestId: input.requestId, requestFingerprint: careFingerprint(input), agreementNote: input.agreementNote, scheduledActionId } });
    await tx.insert(scheduledActionsTable).values({ id: scheduledActionId, organizationId: org, action: { type: "service_care_reminder", params: { approvalId, obligationId: id } }, context: { event: EVENT, serviceObligationId: id }, runAt });
    return { approvalId, replayed: false };
  });
}

async function approvedClaim(org: string, params: Record<string, unknown>, context: Record<string, unknown>, scheduledActionId: string) {
  const parsed = z.object({ approvalId: z.uuid(), obligationId: z.uuid() }).strict().parse(params);
  const [audit] = await db.select().from(auditEventsTable).where(and(auditWhere(org, parsed.obligationId, APPROVED), eq(auditEventsTable.id, parsed.approvalId)));
  if (!audit?.actorUserId) return fail("invalid_approval", "The reminder approval is unavailable.");
  const approval = audit.metadata as Approval;
  const [scheduled] = await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, scheduledActionId)));
  if (!scheduled || approval.scheduledActionId !== scheduledActionId || scheduled.action.type !== "service_care_reminder" || careFingerprint(scheduled.action.params) !== careFingerprint(parsed) || careFingerprint(scheduled.context) !== careFingerprint(context) || context.event !== EVENT || context.serviceObligationId !== parsed.obligationId) fail("invalid_claim", "The reminder must use its original server-owned scheduled action.");
  return { audit, approval, scheduled };
}
async function reviewCurrent(org: string, claim: Awaited<ReturnType<typeof approvedClaim>>) {
  const saved = claim.approval.snapshot;
  try { await assertServiceCareAuthorizationCurrent(db, org, claim.audit.id, claim.scheduled.id); }
  catch (error) {
    if (!(error instanceof ServiceStandingError)) throw error;
    if (["environment_outbound_hold", "sms_provider_not_ready", "email_provider_not_ready"].includes(error.code)) {
      const retry = new Date(Date.now() + 15 * 60_000), authority = claim.approval.authorization;
      if (authority?.origin !== "standing" || retry.getTime() < Date.parse(authority.expiresAt)) return { blocked: null, resumeAt: retry };
    }
    return { blocked: `Reminder held: ${error.code}.`, resumeAt: null };
  }
  const { obligation, contact } = await readService(org, saved.obligationId);
  if (await hasServiceMailboxReplyHold(org, obligation.id) || await hasServiceSmsReplyHold(org, obligation.id)) return { blocked: "A reply to this service was received. Office review is required; no automated reminder is rearmed.", resumeAt: null };
  if (!await actorActive(org, claim.audit.actorUserId!)) return { blocked: "Approving staff access is no longer valid.", resumeAt: null };
  if (obligation.status !== "active" || await isBooked(org, obligation) || await latest(org, obligation.id, RESPONSE)) return { blocked: "Service is inactive, already booked, or has an office-reviewed response.", resumeAt: null };
  if (obligation.updatedAt.toISOString() !== saved.updatedAt) return { blocked: "Service details changed after approval. Review the service; no reminder was sent.", resumeAt: null };
  let current: Snapshot;
  try { current = await snapshot(org, obligation, contact, saved.channel, Boolean(saved.smsReply)); }
  catch { return { blocked: "The approved sender or SMS consent is no longer ready.", resumeAt: null }; }
  if (careFingerprint(current) !== careFingerprint(saved)) return { blocked: "The approved service, recipient, content or sender changed.", resumeAt: null };
  const gate = await eligibility(org, contact, saved.channel, `scheduled:${claim.scheduled.id}`);
  const standing = claim.approval.authorization?.origin === "standing" ? claim.approval.authorization : null;
  if (!gate.ok && gate.outcome === "deferred" && standing && gate.resumeAt.getTime() >= Date.parse(standing.expiresAt)) return { blocked: "The permitted sending window is after this service reminder expires.", resumeAt: null };
  if (!gate.ok) return gate.outcome === "deferred" ? { blocked: null, resumeAt: gate.resumeAt } : { blocked: `Reminder held: ${gate.reason}.`, resumeAt: null };
  const noticeAt = new Date(saved.noticeAt);
  if (noticeAt.getTime() > Date.now()) return { blocked: null, resumeAt: nextAllowedSendTime(await getSendingHours(org), noticeAt) ?? noticeAt };
  try { assertOutboundDeliveryAllowed(saved.channel === "email" ? { channel: "email", recipient: saved.recipient } : undefined); }
  catch { const resumeAt = new Date(Date.now() + 15 * 60_000); return standing && resumeAt.getTime() >= Date.parse(standing.expiresAt) ? { blocked: "Standing reminder expired before activation.", resumeAt: null } : { blocked: null, resumeAt }; }
  return { blocked: null, resumeAt: null };
}
export async function preflightServiceCareReminder(org: string, params: Record<string, unknown>, context: Record<string, unknown>, scheduledActionId: string): Promise<{ resumeAt: Date | null }> {
  const claim = await approvedClaim(org, params, context, scheduledActionId);
  if (await receipt(org, scheduledActionId)) return { resumeAt: null };
  return { resumeAt: (await reviewCurrent(org, claim)).resumeAt };
}
export async function executeServiceCareReminder(org: string, params: Record<string, unknown>, context: Record<string, unknown>, scheduledActionId: string): Promise<ActionResult> {
  const claim = await approvedClaim(org, params, context, scheduledActionId);
  const ownership = await receipt(org, scheduledActionId);
  if (!ownership || ownership.state !== "processing" || ownership.expiresAt.getTime() <= Date.now() || ownership.fingerprint !== careFingerprint({ action: claim.scheduled.action, context: claim.scheduled.context })) fail("invalid_execution", "The original durable execution does not own this reminder.");
  const current = await reviewCurrent(org, claim);
  if (current.blocked || current.resumeAt || claim.scheduled.status !== "pending") return { type: "service_care_reminder", status: "skipped", detail: current.blocked ?? "Eligibility changed after the preflight. No message was sent; review is required." };
  const saved = claim.approval.snapshot;
  const beforeDispatch = async () => {
    const liveClaim = await approvedClaim(org, params, context, scheduledActionId);
    const live = await reviewCurrent(org, liveClaim);
    const liveReceipt = await receipt(org, scheduledActionId);
    if (live.blocked || live.resumeAt || liveClaim.scheduled.status !== "pending" || liveReceipt?.state !== "processing" || liveReceipt.expiresAt.getTime() <= Date.now() || liveReceipt.fingerprint !== careFingerprint({ action: liveClaim.scheduled.action, context: liveClaim.scheduled.context })) throw new EmailDispatchBlockedError();
    await markContactTouchDispatchStarted(org, `scheduled:${scheduledActionId}`);
  };
  let evidence: Record<string, unknown>;
  try {
    if (saved.channel === "email") {
      const message = { to: saved.recipient, subject: saved.subject, body: saved.body };
      const outboundParentId = saved.mailboxIdentity ? await reserveServiceMailboxParent({ identity: saved.mailboxIdentity, serviceObligationId: saved.obligationId,
        contactId: saved.contactId, approvalId: claim.audit.id, scheduledActionId, expectedUpdatedAt: saved.updatedAt, executionFingerprint: ownership.fingerprint, message }) : undefined;
      const result = await sendCustomerEmail({ organizationId: org, ...message, expectedSender: saved.sender!, beforeDispatch, ...(outboundParentId ? { outboundParentId } : {}) });
      if (outboundParentId) await recordMailboxParentAcceptance(outboundParentId, org);
      evidence = emailAcceptanceEvidence(result);
      if (outboundParentId) evidence = { ...evidence, outboundParentId, replyMonitoring: "original_mailbox_observation_required" };
    } else {
      const serviceSmsParentId = saved.smsReply ? await reserveServiceSmsParent({ organizationId: org, serviceObligationId: saved.obligationId, approvalId: claim.audit.id, scheduledActionId, executionFingerprint: ownership.fingerprint }) : undefined;
      const result = await sendTwilioSms(saved.recipient, saved.body, { organizationId: org, contactId: saved.contactId, purpose: "customer_care", idempotencyKey: `service-care:${saved.obligationId}`, ...(serviceSmsParentId ? { serviceSmsParentId } : {}) }, beforeDispatch);
      evidence = { provider: result.provider, providerMessageId: result.id, acceptance: "accepted", deliveryConfirmed: false };
    }
  } catch (error) {
    if (error && typeof error === "object" && "effectNotAttempted" in error && error.effectNotAttempted === true) return { type: "service_care_reminder", status: "skipped", detail: "Final dispatch guard blocked this reminder before a provider request. Review is required." };
    // Provider timeouts or persistence failures retain an indeterminate receipt.
    throw error;
  }
  await db.transaction(async tx => {
    await lockContractorSchedule(tx, org);
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: claim.audit.actorUserId, action: "service.care_reminder_accepted", entityType: "service_obligation", entityId: saved.obligationId, metadata: { approvalId: claim.audit.id, scheduledActionId, channel: saved.channel, ...evidence } });
    await tx.insert(activitiesTable).values({ organizationId: org, contactId: saved.contactId, type: "automation_message_sent", title: "Service reminder accepted by provider (delivery unconfirmed)", metadata: { serviceObligationId: saved.obligationId, approvalId: claim.audit.id, channel: saved.channel, touchLogicalKey: `scheduled:${scheduledActionId}`, ...evidence } });
    const { obligation } = await readService(org, saved.obligationId, tx);
    if (obligation.status === "active" && !await isBooked(org, obligation, tx) && !await latest(org, obligation.id, RESPONSE, tx)) {
      const [task] = await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, obligation.taskId)));
      // Preserve staff progress, assignments and an earlier promised deadline.
      if (task && ["open", "in_progress"].includes(task.status)) {
        const note = "Reminder accepted by the provider; delivery and response are unconfirmed. Review customer response or follow up manually before booking. No appointment is booked.";
        const description = task.description?.includes(note) ? task.description : task.description ? `${task.description}\n\n${note}` : note;
        await tx.update(crmTasksTable).set({ dueAt: task.dueAt ?? new Date(Date.now() + 3 * 86_400_000), description }).where(eq(crmTasksTable.id, task.id));
      }
    }
  });
  return { type: "service_care_reminder", status: "success", detail: "Provider accepted one service reminder. Delivery is not confirmed; office follow-up remains due." };
}

export async function recordServiceCareResponse(org: string, actor: string, id: string, raw: unknown) {
  const input = serviceCareResponseSchema.parse(raw);
  if (new Date(input.respondedAt).getTime() > Date.now() + 60_000) fail("future_response", "A response cannot be recorded in the future.", 400);
  if (await customerWorkHeld(org)) fail("customer_lifecycle_paused", "Customer work is paused.");
  return db.transaction(async tx => {
    await lockContractorSchedule(tx, org);
    await assertOperationalStaff(tx, org, [actor]);
    const repeated = await replay(tx, org, id, RESPONSE, input);
    if (repeated) return { responseId: repeated.id, replayed: true };
    const { obligation } = await readService(org, id, tx);
    activeUnbooked(obligation);
    assertScheduleVersion(obligation.updatedAt, input.expectedUpdatedAt);
    const approval = await latest(org, id, APPROVED, tx);
    if (approval) {
      const approved = approval.metadata as Approval;
      // Never alter a claimed/unknown effect or erase its receipt.
      if (!await receipt(org, approved.scheduledActionId, tx)) await tx.update(scheduledActionsTable).set({ status: "cancelled", lastError: "Office recorded a customer response before dispatch." }).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, approved.scheduledActionId), eq(scheduledActionsTable.status, "pending")));
    }
    const priorResponse = await latest(org, id, RESPONSE, tx);
    const updatedAt = new Date(Math.max(Date.now(), obligation.updatedAt.getTime() + 1, (priorResponse?.createdAt.getTime() ?? 0) + 1));
    const [row] = await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: RESPONSE, entityType: "service_obligation", entityId: id, createdAt: updatedAt, metadata: { ...input, requestFingerprint: careFingerprint(input), evidence: "staff_attested_not_provider_verified" } }).returning();
    await tx.update(serviceObligationsTable).set({ updatedAt }).where(serviceWhere(org, id));
    if (!await isBooked(org, obligation, tx)) await tx.update(crmTasksTable).set({ status: "open", completedAt: null, dueAt: new Date(), description: `Staff-recorded response: ${input.outcome.replaceAll("_", " ")}. ${input.note}\nReview and confirm the customer's agreed time before booking. This is not a provider-verified reply.` }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, obligation.taskId)));
    return { responseId: row.id, replayed: false };
  });
}

function bookingResult(audit: typeof auditEventsTable.$inferSelect, replayed: boolean): ServiceCareBookingResult {
  const metadata = audit.metadata;
  const stored = serviceCareBookingSchema.safeParse(Object.fromEntries(Object.keys(serviceCareBookingSchema.shape)
    .filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]])));
  if (!stored.success || metadata.requestFingerprint !== careFingerprint(stored.data)) fail("invalid_booking_receipt", "The original booking proof is incomplete. Retain the original request for operator review.");
  const result = serviceCareBookingResultSchema.safeParse({ appointmentId: metadata.appointmentId, replayed, bookingOutcome: {
    formatVersion: 1, status: "committed", organizationId: audit.organizationId, actorUserId: audit.actorUserId,
    obligationId: audit.entityId, bookingId: audit.id, requestId: stored.data.requestId,
    requestFingerprint: metadata.requestFingerprint, responseId: stored.data.responseId,
    expectedUpdatedAt: stored.data.expectedUpdatedAt, appointmentId: metadata.appointmentId,
  } });
  if (!result.success) fail("invalid_booking_receipt", "The original booking proof is incomplete. Retain the original request for operator review.");
  return result.data;
}
export async function bookServiceCareVisit(org: string, actor: string, id: string, raw: unknown): Promise<ServiceCareBookingResult> {
  const input = serviceCareBookingSchema.parse(raw);
  return db.transaction(async tx => {
    await lockSchedulingConfiguration(tx, org, false);
    await assertOperationalStaff(tx, org, [actor]);
    const repeated = await replay(tx, org, id, BOOKED, input);
    if (repeated) return bookingResult(repeated, true);
    if (!(await getCustomerLifecycleStatus(org, tx)).automationAllowed) throw new CustomerLifecycleHoldError();
    const { obligation } = await readService(org, id, tx, "update");
    activeUnbooked(obligation);
    assertScheduleVersion(obligation.updatedAt, input.expectedUpdatedAt);
    if (await isBooked(org, obligation, tx)) fail("already_booked", "This service already has an active appointment. Manage it in Appointments.");
    const response = await latest(org, id, RESPONSE, tx);
    if (!response || response.id !== input.responseId || response.metadata.outcome !== "ready_to_book") fail("response_required", "Review and record the customer's readiness to book first.");
    // A response used for a now-cancelled/no-show visit cannot silently book it
    // again. A fresh customer conversation and response are required.
    const previous = await latest(org, id, BOOKED, tx);
    if (previous?.metadata.responseId === response.id) fail("fresh_response_required", "Record a fresh customer confirmation before rebooking a cancelled or missed visit.");
    const start = new Date(input.scheduledStart), end = new Date(input.scheduledEnd);
    assertScheduleInterval(start, end);
    if (start.getTime() <= Date.now() || end.getTime() - start.getTime() > 24 * 3_600_000) fail("invalid_window", "Choose a future service window no longer than 24 hours.", 400);
    await appointmentCustomer(tx, org, obligation);
    await assertOperationalStaff(tx, org, [actor, input.assignedUserId]);
    if (!input.schedulingReview) schedulingFailure("stale_scheduling_review");
    const source = { sourceKind: "direct_customer" as const, leadId: null, contactId: obligation.contactId, propertyId: obligation.propertyId, estimateId: null };
    const authority: ServerSchedulingAuthority = { organizationId: org, actorUserId: actor, origin: "service_care", sourceId: obligation.id, reviewMode: "reviewed" };
    const candidate: SchedulingCandidate = { kind: "appointment", id: randomUUID(), startAt: start.toISOString(), endAt: end.toISOString(), resourceUserIds: [input.assignedUserId], type: input.type, status: "confirmed", source, reservation: null };
    const admission = await prepareSchedulingAdmission(tx, authority, null, candidate, input.schedulingReview);
    const values = { id: candidate.id, organizationId: org, contactId: obligation.contactId, propertyId: obligation.propertyId, assignedUserId: input.assignedUserId, type: input.type, status: "confirmed" as const, scheduledStart: start, scheduledEnd: end, schedulingReservation: admission.snapshot, notes: `Office-confirmed service visit: ${obligation.equipmentLabel}. Customer confirmation recorded by staff; service completion and warranty coverage are not inferred.` };
    const [appointment] = await tx.insert(appointmentsTable).values(values).returning();
    await guardWorkdayService(tx, org, id, obligation, { appointmentId: appointment.id });
    await tx.update(serviceObligationsTable).set({ appointmentId: appointment.id, updatedAt: new Date(Math.max(Date.now(), obligation.updatedAt.getTime() + 1)) }).where(serviceWhere(org, id));
    await tx.update(crmTasksTable).set({ status: "done", completedAt: new Date(), assignedUserId: input.assignedUserId, description: "Office-confirmed appointment linked. After the visit, explicitly mark the service complete; a booked appointment does not establish completion or warranty coverage." }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, obligation.taskId)));
    const { scheduleAppointmentReminder } = await import("./automation");
    await scheduleAppointmentReminder(org, appointment, undefined, tx);
    await appendSchedulingTransition(tx, authority, null, admission.snapshot, { kind: "appointment", id: appointment.id }, { transition: admission.transition, source, invalidHistoricalEvidenceRetained: false });
    const [audit] = await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: BOOKED, entityType: "service_obligation", entityId: id, metadata: { ...input, requestFingerprint: careFingerprint(input), appointmentId: appointment.id, evidence: "staff_attested_customer_confirmation" } }).returning();
    return bookingResult(audit, false);
  });
}
