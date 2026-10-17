import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { ManualSourceRef, SchedulingCandidate } from "@workspace/scheduling-core";
import { appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, db, leadsTable, missedCallHandoffsTable, propertiesTable, revenueExecutionsTable, twilioCallsTable, usersTable, type UserRole } from "@workspace/db";
import { callieAckDispatchesTable, callieIntakesTable, calliePolicyRevisionsTable } from "../../../../lib/db/src/schema/callie";
import { callieReceptionSessionsTable } from "../../../../lib/db/src/schema/callie-reception";
import { readCallieReceptionEvidence } from "./callie-reception-runtime";
import { hasPermission, type Permission } from "../lib/permissions";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { assertOperationalStaff, assertScheduleInterval, appointmentCustomer, lockContractorSchedule, type ScheduleTransaction } from "./contractor-scheduling";
import { readSchedulingContext, SchedulingPolicyError } from "./scheduling-policy";
import { appendSchedulingTransition, prepareSchedulingAdmission, type ServerSchedulingAuthority } from "./scheduling-admission";
import { careFingerprint } from "./service-care-policy";
import { careOperationKey } from "./missed-call-care-policy";
import { phoneE164 } from "./twilio-controls";
import { reviewMissedCallInTransaction } from "./missed-call-handoff";
import { CALLIE_PAGE_SIZE, callieBookingSchema, callieCallerReviewSchema, callieListQuery, callieOfficeActionSchema, callieSchedulingContextQuerySchema, callieSchedulingContextReadSchema, callieBookingOutcomeSchema, canonicalCallieBookingInput, type CallieBooking, type CallieBookingOutcome, type CallieSchedulingContextQuery, type CallieSchedulingContextRead, type CallieListQuery } from "./callie-office-contract";

type Reader = typeof db | ScheduleTransaction;
type Intake = typeof callieIntakesTable.$inferSelect;
const terminal = ["resolved", "cancelled", "booked"] as const;
const terminalState = (state: string) => (terminal as readonly string[]).includes(state);
const writeRoles = ["owner", "admin", "sales_manager", "sales_rep", "inspector", "production", "office"] as UserRole[];
const intakeWhere = (org: string, id: string) => and(eq(callieIntakesTable.organizationId, org), eq(callieIntakesTable.id, id));
export class CallieOfficeError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
function fail(code: string, message: string, status = 409): never { throw new CallieOfficeError(code, message, status); }
export async function assertCallieStaff(org: string, actor: string, permission: Permission = "crm.read", reader: Reader = db, lock = false) {
  const query = reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  const [user] = await (lock ? query.for("share") : query);
  if (!user || !user.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, permission)) fail("staff_required", "Accepted active company staff access is required.", 403);
  return user;
}
function eligible(user: typeof usersTable.$inferSelect | null | undefined) {
  return !!user && user.isActive && !!user.emailVerifiedAt && !user.id.startsWith("invite:") && hasPermission(user.role, "crm.write");
}
function label(user: { firstName: string | null; lastName: string | null; email: string | null }) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Company staff";
}
/** Lifecycle precedes schedule and CALLIE; no network work happens in this transaction. */
async function officeLock(tx: ScheduleTransaction, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx, org);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`callie:${org}`}))`);
}
async function observe(reader: Reader, org: string, id: string) {
  const [intake] = await reader.select().from(callieIntakesTable).where(intakeWhere(org, id));
  if (!intake) fail("not_found", "CALLIE request is not available in this company.", 404);
  const [call] = await reader.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, intake.callId)));
  const [handoff] = await reader.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, org), eq(missedCallHandoffsTable.callId, intake.callId)));
  if (!call || !handoff) fail("not_found", "This call does not have an office missed-call request.", 404);
  const [task] = await reader.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, handoff.taskId)));
  if (!task) fail("task_unavailable", "The original callback task is unavailable; operator review is required.");
  const [owner] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, intake.ownerUserId)));
  const [contact] = handoff.contactId ? await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, handoff.contactId))) : [];
  const [lead] = handoff.leadId ? await reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, handoff.leadId))) : [];
  const [appointment] = intake.appointmentId ? await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, intake.appointmentId))) : [];
  const [delivery] = await reader.select().from(callieAckDispatchesTable).where(and(eq(callieAckDispatchesTable.organizationId, org), eq(callieAckDispatchesTable.intakeId, id)));
  const [receipt] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, careOperationKey(intake.callId))));
  const [policy] = await reader.select().from(calliePolicyRevisionsTable).where(and(eq(calliePolicyRevisionsTable.organizationId, org), eq(calliePolicyRevisionsTable.id, intake.policyRevisionId)));
  const properties = contact ? await reader.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.contactId, contact.id))).orderBy(asc(propertiesTable.id)).limit(101) : [];
  const staff = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.isActive, true), inArray(usersTable.role, writeRoles))).orderBy(asc(usersTable.id)).limit(201);
  const lifecycle = await getCustomerLifecycleStatus(org, reader);
  const identityReviewed = !!handoff.reviewedAt && !!contact && call.contactId === contact.id && phoneE164(contact.phone ?? "") === call.phone && call.phone === intake.fromPhone && (!handoff.leadId || !!lead && lead.contactId === contact.id);
  const source = { intake: { version: intake.version, state: intake.state, stage: intake.stage, serviceIntent: intake.serviceIntent, requestIntent: intake.requestIntent, callbackWindow: intake.callbackWindow, ownerUserId: intake.ownerUserId, appointmentId: intake.appointmentId },
    call: { updatedAt: call.updatedAt.toISOString(), contactId: call.contactId, phone: call.phone, status: call.status, dialStatus: call.dialStatus },
    handoff: { id: handoff.id, contactId: handoff.contactId, leadId: handoff.leadId, reviewedAt: handoff.reviewedAt?.toISOString() ?? null, reviewedByUserId: handoff.reviewedByUserId },
    task: { updatedAt: task.updatedAt.toISOString(), assignedUserId: task.assignedUserId, status: task.status },
    contact: contact ? { id: contact.id, updatedAt: contact.updatedAt.toISOString(), phone: contact.phone } : null,
    lead: lead ? { id: lead.id, updatedAt: lead.updatedAt.toISOString(), contactId: lead.contactId } : null,
    appointment: appointment ? { id: appointment.id, updatedAt: appointment.updatedAt.toISOString(), status: appointment.status } : null,
    staff: staff.map(user => ({ id: user.id, role: user.role, updatedAt: user.updatedAt.toISOString(), accepted: eligible(user) })),
    // Pin the reviewed worksite itself; JS timestamps alone can collide after
    // PostgreSQL sub-millisecond values are materialized as a Date.
    properties: properties.map(property => ({ id: property.id, contactId: property.contactId, updatedAt: property.updatedAt.toISOString(),
      addressLine1: property.addressLine1, addressLine2: property.addressLine2, city: property.city, state: property.state, postalCode: property.postalCode })),
    receipt: receipt ? { id: receipt.id, state: receipt.state } : null,
    delivery: delivery ? { id: delivery.id, status: delivery.status, updatedAt: delivery.updatedAt.toISOString() } : null,
    lifecycle: { state: lifecycle.state, version: lifecycle.version }, identityReviewed };
  const reception = intake.mode === "conversation" ? await readCallieReceptionEvidence(reader, org, intake.id) : null;
  return { intake, call, handoff, task, owner, contact, lead, appointment, delivery, receipt, policy, properties, staff, lifecycle, identityReviewed, reception, fingerprint: careFingerprint({ ...source, reception }) };
}
type Observation = Awaited<ReturnType<typeof observe>>;
function smsProof(intake: Intake, now: Date) {
  if (intake.confirmedAt) return "single_call_confirmed" as const;
  if (intake.challengeExpiresAt && intake.challengeExpiresAt <= now) return "confirmation_expired" as const;
  if (intake.state === "awaiting_sms") return "awaiting_caller_confirmation" as const;
  return "not_confirmed" as const;
}
function rowSummary(row: { intake: Intake; call: typeof twilioCallsTable.$inferSelect; handoff: typeof missedCallHandoffsTable.$inferSelect; task: typeof crmTasksTable.$inferSelect; owner: typeof usersTable.$inferSelect | null | undefined }, now = new Date()) {
  const { intake, call, handoff, task, owner } = row;
  const ownerEligible = eligible(owner) && task.assignedUserId === intake.ownerUserId;
  return { id: intake.id, organizationId: intake.organizationId, mode: intake.mode, callId: intake.callId, version: intake.version, state: intake.state, stage: intake.stage, reason: intake.reason,
    phone: intake.fromPhone, createdAt: call.createdAt.toISOString(), dueAt: intake.dueAt.toISOString(), overdue: !terminalState(intake.state) && intake.dueAt <= now,
    owner: { id: intake.ownerUserId, label: owner ? label(owner) : "Owner unavailable", eligible: ownerEligible },
    task: { id: task.id, status: task.status }, leadId: handoff.leadId, callerReviewed: !!handoff.reviewedAt,
    serviceIntent: intake.serviceIntent, requestIntent: intake.requestIntent, callbackWindow: intake.callbackWindow,
    smsProof: smsProof(intake, now), confirmedAt: intake.confirmedAt?.toISOString() ?? null, appointmentId: intake.appointmentId };
}
function mutableReason(value: Observation) {
  if (!value.lifecycle.automationAllowed) return "company_held";
  if (terminalState(value.intake.state)) return "office_work_closed";
  if (value.intake.state === "dispatching" || value.receipt?.state === "processing") return "dispatch_in_progress";
  if (value.receipt?.state === "indeterminate" || value.intake.state === "indeterminate" && !["confirmed_succeeded", "confirmed_not_performed"].includes(value.receipt?.state ?? "")) return "provider_reconciliation_required";
  return null;
}
function ownerNeedsReview(value: Observation) {
  return !eligible(value.owner) || value.task.assignedUserId !== value.intake.ownerUserId;
}
function assertCurrentOwner(value: Observation) {
  if (ownerNeedsReview(value)) fail("owner_review_required", "The original task owner changed or is unavailable. Explicitly assign this CALLIE request before reviewing the caller, booking or closing it.");
}
function detail(value: Observation) {
  const optionsComplete = value.properties.length <= 100 && value.staff.length <= 200;
  const writeBlock = mutableReason(value);
  return { ...rowSummary(value), reception: value.reception, expectedFingerprint: value.fingerprint, companyHeld: !value.lifecycle.automationAllowed,
    timezone: value.policy?.snapshot.timezone ?? "UTC", identityReviewed: value.identityReviewed,
    contact: value.contact ? { id: value.contact.id, name: `${value.contact.firstName} ${value.contact.lastName ?? ""}`.trim(), phone: value.contact.phone } : null,
    reviewedAt: value.handoff.reviewedAt?.toISOString() ?? null,
    bookingOptions: { complete: optionsComplete, properties: value.properties.slice(0, 100).map(property => ({ id: property.id, label: [property.addressLine1, property.city, property.state, property.postalCode].filter(Boolean).join(", ") })),
      staff: value.staff.filter(eligible).slice(0, 200).map(user => ({ id: user.id, label: label(user) })) },
    appointment: value.appointment ? { id: value.appointment.id, status: value.appointment.status, scheduledStart: value.appointment.scheduledStart.toISOString(), scheduledEnd: value.appointment.scheduledEnd?.toISOString() ?? null, assignedUserId: value.appointment.assignedUserId } : null,
    delivery: value.delivery ? { status: value.delivery.status, providerSid: value.delivery.providerSid, updatedAt: value.delivery.updatedAt.toISOString() } : null,
    execution: value.receipt ? { id: value.receipt.id, state: value.receipt.state } : null,
    actions: { canReviewCaller: !writeBlock && !ownerNeedsReview(value) && !value.handoff.reviewedAt, canAssign: !writeBlock, canClose: !writeBlock && !ownerNeedsReview(value),
      canBook: !writeBlock && !ownerNeedsReview(value) && value.identityReviewed && value.intake.requestIntent === "visit" && optionsComplete, blockReason: writeBlock ?? (ownerNeedsReview(value) ? "owner_review_required" : null) },
    evidence: "caller_choices_are_requests_not_identity_or_confirmed_appointments" as const };
}
export type CallieOfficeDetail = ReturnType<typeof detail>;
export type CallieBookingResult = { detail: CallieOfficeDetail | null; replayed: boolean; bookingOutcome: CallieBookingOutcome };
export async function getCallieOfficeDetail(org: string, actor: string, id: string) {
  return db.transaction(async tx => { await assertCallieStaff(org, actor, "crm.read", tx); return detail(await observe(tx, org, id)); }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function listCallieOffice(org: string, actor: string, raw: CallieListQuery) {
  const query = callieListQuery.parse(raw);
  await assertCallieStaff(org, actor);
  const lifecycle = await getCustomerLifecycleStatus(org);
  const waiting = and(inArray(callieIntakesTable.state, ["admitted", "collecting", "awaiting_sms", "confirmed", "deferred", "accepted", "office_pending"]),
    sql`(${callieIntakesTable.mode} = 'keypad' or not exists (select 1 from ${callieReceptionSessionsTable} where ${callieReceptionSessionsTable.organizationId} = ${callieIntakesTable.organizationId} and ${callieReceptionSessionsTable.intakeId} = ${callieIntakesTable.id} and (${callieReceptionSessionsTable.state} in ('blocked','indeterminate','interrupted','expired') or ${callieReceptionSessionsTable.transferState} in ('failed','indeterminate','blocked','not_answered'))))`,
    sql`${callieIntakesTable.dueAt} > now()`, eq(usersTable.isActive, true), sql`${usersTable.emailVerifiedAt} is not null`,
    sql`${usersTable.id} not like 'invite:%'`, inArray(usersTable.role, writeRoles), eq(crmTasksTable.assignedUserId, callieIntakesTable.ownerUserId), inArray(crmTasksTable.status, ["open", "in_progress"]));
  const scope = query.scope === "history" ? inArray(callieIntakesTable.state, [...terminal])
    : query.scope === "waiting" ? and(notInArray(callieIntakesTable.state, [...terminal]), waiting, sql`${lifecycle.automationAllowed}`)
    : and(notInArray(callieIntakesTable.state, [...terminal]), lifecycle.automationAllowed ? sql`not coalesce(${waiting}, false)` : undefined);
  const rows = await db.select({ intake: callieIntakesTable, call: twilioCallsTable, handoff: missedCallHandoffsTable, task: crmTasksTable, owner: usersTable }).from(callieIntakesTable)
    .innerJoin(twilioCallsTable, and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, callieIntakesTable.callId)))
    .innerJoin(missedCallHandoffsTable, and(eq(missedCallHandoffsTable.organizationId, org), eq(missedCallHandoffsTable.callId, callieIntakesTable.callId)))
    .innerJoin(crmTasksTable, and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, missedCallHandoffsTable.taskId)))
    .leftJoin(usersTable, and(eq(usersTable.organizationId, org), eq(usersTable.id, callieIntakesTable.ownerUserId)))
    .where(and(eq(callieIntakesTable.organizationId, org), scope))
    .orderBy(query.scope === "history" ? desc(callieIntakesTable.updatedAt) : asc(callieIntakesTable.dueAt), asc(callieIntakesTable.id)).limit(CALLIE_PAGE_SIZE + 1).offset(query.offset);
  return { scope: query.scope, offset: query.offset, pageSize: CALLIE_PAGE_SIZE, hasMore: rows.length > CALLIE_PAGE_SIZE,
    items: rows.slice(0, CALLIE_PAGE_SIZE).map(row => rowSummary(row)), companyHeld: !lifecycle.automationAllowed,
    boundary: "This page contains only this company's admitted missed-call requests; it is not a global count." };
}
async function lockOfficeParticipants(tx: ScheduleTransaction, org: string, id: string, mode: "share" | "update") {
  // Freeze the exact customer/staff/task facts through the commit, not just the
  // CALLIE row. Other CRM writers do not take CALLIE's advisory lock.
  const [intake] = await tx.select().from(callieIntakesTable).where(intakeWhere(org, id)).for(mode);
  if (!intake) fail("not_found", "CALLIE request is not available in this company.", 404);
  await tx.select({ id: twilioCallsTable.id }).from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, intake.callId))).for("share");
  const [handoff] = await tx.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, org), eq(missedCallHandoffsTable.callId, intake.callId))).for(mode);
  if (handoff) {
    await tx.select({ id: crmTasksTable.id }).from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, handoff.taskId))).for(mode);
    if (handoff.contactId) {
      await tx.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, handoff.contactId))).for("share");
      await tx.select({ id: propertiesTable.id }).from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.contactId, handoff.contactId))).orderBy(asc(propertiesTable.id)).limit(101).for("share");
    }
    if (handoff.leadId) await tx.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, handoff.leadId))).for("share");
  }
  await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.isActive, true), inArray(usersTable.role, writeRoles))).orderBy(asc(usersTable.id)).limit(201).for("share");
}
function bookingSource(value: Observation, propertyId: string | null): ManualSourceRef {
  if (!value.identityReviewed || !value.contact) fail("caller_review_required", "First review the actual caller and canonical customer.");
  if (propertyId && !value.properties.some(property => property.id === propertyId)) fail("property_mismatch", "Choose a property belonging to the reviewed customer.", 400);
  return { sourceKind: value.handoff.leadId ? "lead" : "direct_customer", leadId: value.handoff.leadId, contactId: value.contact.id, propertyId, estimateId: null };
}
export async function getCallieSchedulingContext(org: string, actor: string, id: string, raw: CallieSchedulingContextQuery): Promise<CallieSchedulingContextRead> {
  const query = callieSchedulingContextQuerySchema.parse(raw);
  return db.transaction(async tx => {
    await officeLock(tx, org);
    await assertCallieStaff(org, actor, "crm.read", tx, true);
    await lockOfficeParticipants(tx, org, id, "share");
    const value = await observe(tx, org, id);
    // A saved but broken canonical link is not an unreviewed caller.
    if (value.handoff.reviewedAt && !value.identityReviewed) fail("caller_source_changed", "The reviewed caller's canonical source changed. Review the source before scheduling.");
    const base = { organizationId: org, actorUserId: actor, intakeId: id, expectedVersion: value.intake.version, expectedFingerprint: value.fingerprint, appointmentType: query.appointmentType };
    if (!value.identityReviewed) return callieSchedulingContextReadSchema.parse({ ...base, source: null, review: { state: "held", code: "caller_review_required", message: "Review the actual caller and customer before scheduling." } });
    const source = bookingSource(value, query.propertyId ?? null);
    await appointmentCustomer(tx, org, source);
    try {
      const current = await readSchedulingContext(tx, org, undefined, { reservationKind: "appointment", appointmentType: query.appointmentType });
      return callieSchedulingContextReadSchema.parse({ ...base, source, review: { state: "ready", policy: current.policy, context: { ...current.context, source } } });
    } catch (error) {
      if (!(error instanceof SchedulingPolicyError) || error.code !== "invalid_scheduling_policy") throw error;
      return callieSchedulingContextReadSchema.parse({ ...base, source, review: { state: "held", code: "invalid_scheduling_policy", message: error.message } });
    }
  });
}
async function assertFresh(tx: ScheduleTransaction, org: string, actor: string, id: string, input: { expectedVersion: number; expectedFingerprint: string }) {
  await lockOfficeParticipants(tx, org, id, "update");
  await assertCallieStaff(org, actor, "crm.write", tx);
  const value = await observe(tx, org, id);
  if (value.intake.version !== input.expectedVersion || value.fingerprint !== input.expectedFingerprint) fail("stale_review", "This call, customer, staff assignment or saved request changed. Refresh and review it before another action.");
  const blocked = mutableReason(value);
  if (blocked) fail(blocked, blocked === "provider_reconciliation_required" ? "An owner must reconcile the original unknown send before this office action. Reconciliation never authorizes a resend." : blocked === "dispatch_in_progress" ? "The provider handoff is in progress. Refresh its saved result before changing office ownership or closing the request." : "This office action is unavailable while the company is held or the request is closed.");
  return value;
}
async function replay(tx: ScheduleTransaction, org: string, actor: string, id: string, input: { requestId: string }, action: string) {
  await assertCallieStaff(org, actor, "crm.write", tx, true);
  const [record] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "callie_intake"), eq(auditEventsTable.entityId, id), sql`${auditEventsTable.metadata}->>'requestId' = ${input.requestId}`)).limit(1);
  if (!record) return null;
  if (record.action !== action || record.actorUserId !== actor || record.metadata.requestFingerprint !== careFingerprint(input)) fail("request_changed", "This operation identity belongs to different reviewed details. Inspect the saved result; do not retry it with changed contents.");
  return record;
}
async function audit(tx: ScheduleTransaction, org: string, actor: string, id: string, action: string, input: { requestId: string }, extra: Record<string, unknown> = {}) {
  return (await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, entityType: "callie_intake", entityId: id, action,
    metadata: { ...input, requestFingerprint: careFingerprint(input), ...extra } }).returning())[0];
}
function bookingFingerprint(input: CallieBooking): string {
  const hash = createHash("sha256").update(canonicalCallieBookingInput(input)).digest("hex");
  if (hash !== careFingerprint(input)) throw new Error("CALLIE source canonicalization disagreement");
  return hash;
}
function bookingOutcome(record: typeof auditEventsTable.$inferSelect, org: string, actor: string, id: string, input: CallieBooking): CallieBookingOutcome {
  const { requestFingerprint, appointmentId, evidence, noAutomaticResend, ...body } = record.metadata;
  const stored = callieBookingSchema.safeParse(body);
  if (!stored.success || record.organizationId !== org || record.actorUserId !== actor || record.entityType !== "callie_intake" || record.entityId !== id || record.action !== "voice.callie.visit_booked" ||
    evidence !== "staff_attested_exact_customer_confirmation" || noAutomaticResend !== true || requestFingerprint !== bookingFingerprint(stored.data) || requestFingerprint !== bookingFingerprint(input)) fail("booking_proof_invalid", "The original booking proof is incomplete. Preserve this request for operator review.");
  const outcome = callieBookingOutcomeSchema.safeParse({ formatVersion: 1, status: "committed", organizationId: record.organizationId, actorUserId: record.actorUserId, intakeId: record.entityId, bookingId: record.id,
    requestId: stored.data.requestId, requestFingerprint, expectedVersion: stored.data.expectedVersion, expectedFingerprint: stored.data.expectedFingerprint, customerConfirmed: stored.data.customerConfirmed, appointmentId });
  if (!outcome.success) fail("booking_proof_invalid", "The original booking proof is incomplete. Preserve this request for operator review.");
  return outcome.data;
}
export async function updateCallieOffice(org: string, actor: string, id: string, raw: unknown) {
  const input = callieOfficeActionSchema.parse(raw), action = `voice.callie.office_${input.action}`;
  return db.transaction(async tx => {
    await officeLock(tx, org);
    if (await replay(tx, org, actor, id, input, action)) return { detail: detail(await observe(tx, org, id)), replayed: true };
    const value = await assertFresh(tx, org, actor, id, input);
    if (input.action === "assign") {
      await assertOperationalStaff(tx, org, [input.assignedUserId]);
      await tx.update(callieIntakesTable).set({ ownerUserId: input.assignedUserId, state: "blocked", reason: "owner_changed_office_only", version: value.intake.version + 1, updatedAt: new Date() }).where(intakeWhere(org, id));
      await tx.update(crmTasksTable).set({ assignedUserId: input.assignedUserId, status: "open", completedAt: null, priority: "high" }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, value.task.id)));
    } else {
      assertCurrentOwner(value);
      await tx.update(callieIntakesTable).set({ state: input.action, reason: `staff_${input.action}`, version: value.intake.version + 1, officeRequestId: input.requestId, officePayloadHash: careFingerprint({ actor, input }), resolvedAt: new Date(), updatedAt: new Date() }).where(intakeWhere(org, id));
      // Cancel CALLIE automation without quietly completing the callback work.
      if (input.action === "resolved") await tx.update(crmTasksTable).set({ status: "done", completedAt: new Date() }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, value.task.id)));
    }
    await audit(tx, org, actor, id, action, input, { customerMessageSent: false, bookingCreated: false, retainedSendIdentity: careOperationKey(value.intake.callId) });
    return { detail: detail(await observe(tx, org, id)), replayed: false };
  });
}
export async function reviewCallieCaller(org: string, actor: string, id: string, raw: unknown) {
  const input = callieCallerReviewSchema.parse(raw), action = "voice.callie.caller_reviewed";
  return db.transaction(async tx => {
    await officeLock(tx, org);
    if (await replay(tx, org, actor, id, input, action)) return { detail: detail(await observe(tx, org, id)), replayed: true };
    const value = await assertFresh(tx, org, actor, id, input);
    assertCurrentOwner(value);
    if (value.handoff.reviewedAt) fail("already_reviewed", "This caller is already reviewed. Refresh the linked customer.");
    const result = await reviewMissedCallInTransaction(tx, org, value.intake.callId, actor, input);
    if ("error" in result) fail(result.error, result.error === "choose_existing_contact" ? "This phone matches an existing customer. Choose that customer instead of making another record." : "Caller review could not be saved. Choose the actual matching customer or record the confirmed caller's name.");
    await tx.update(callieIntakesTable).set({ version: value.intake.version + 1, updatedAt: new Date() }).where(intakeWhere(org, id));
    await audit(tx, org, actor, id, action, input, { evidence: "explicit_staff_identity_review_not_caller_id", contactId: result.handoff.contactId, leadId: result.handoff.leadId, customerMessageSent: false });
    return { detail: detail(await observe(tx, org, id)), replayed: false };
  });
}
export async function bookCallieVisit(org: string, actor: string, id: string, raw: unknown): Promise<CallieBookingResult> {
  const input = callieBookingSchema.parse(raw), action = "voice.callie.visit_booked";
  return db.transaction(async tx => {
    await officeLock(tx, org);
    const original = await replay(tx, org, actor, id, input, action);
    if (original) return { detail: null, replayed: true, bookingOutcome: bookingOutcome(original, org, actor, id, input) };
    const value = await assertFresh(tx, org, actor, id, input);
    assertCurrentOwner(value);
    if (value.intake.requestIntent !== "visit") fail("visit_request_required", "This call contains a callback request, not a visit request. Arrange any other work through the normal office process.");
    if (!value.identityReviewed || !value.contact || input.contactId !== value.contact.id || input.leadId !== value.handoff.leadId) fail("caller_review_required", "First explicitly review and link this caller to the correct canonical customer and opportunity.");
    if (value.properties.length > 100 || value.staff.length > 200) fail("booking_options_exceeded", "This office booking exceeds the bounded review. An operator must review the customer and staffing records.");
    if (input.propertyId && !value.properties.some(property => property.id === input.propertyId)) fail("property_mismatch", "Choose a property belonging to the reviewed customer.", 400);
    if (value.intake.appointmentId) fail("already_booked", "This request already owns an appointment. Manage its existing visit instead of creating another.");
    if (!input.schedulingReview) throw new SchedulingPolicyError("stale_scheduling_review", "Review the current scheduling context before confirming a new visit.", 409);
    const start = new Date(input.scheduledStart), end = new Date(input.scheduledEnd);
    assertScheduleInterval(start, end);
    if (start.getTime() <= Date.now() || end.getTime() - start.getTime() > 24 * 3600_000) fail("invalid_window", "Choose a future agreed window no longer than 24 hours.", 400);
    await assertOperationalStaff(tx, org, [input.assignedUserId]);
    await appointmentCustomer(tx, org, input);
    const source = bookingSource(value, input.propertyId);
    const authority: ServerSchedulingAuthority = { organizationId: org, actorUserId: actor, origin: "callie", sourceId: id, reviewMode: "reviewed" };
    const appointmentId = randomUUID();
    const candidate: SchedulingCandidate = { kind: "appointment", id: appointmentId, startAt: start.toISOString(), endAt: end.toISOString(), status: "confirmed", type: input.type, resourceUserIds: [input.assignedUserId], source, reservation: null };
    const admission = await prepareSchedulingAdmission(tx, authority, null, candidate, input.schedulingReview);
    const values = { id: appointmentId, schedulingReservation: admission.snapshot, organizationId: org, contactId: input.contactId, leadId: input.leadId, propertyId: input.propertyId, assignedUserId: input.assignedUserId, type: input.type,
      status: "confirmed" as const, scheduledStart: start, scheduledEnd: end, notes: `Office-confirmed CALLIE visit. ${input.confirmationNote}\nCustomer confirmation is staff-recorded; caller keypad choices alone did not book this appointment. No completion or warranty determination is implied.` };
    const [appointment] = await tx.insert(appointmentsTable).values(values).returning();
    await tx.update(callieIntakesTable).set({ state: "booked", reason: "office_confirmed_visit", appointmentId: appointment.id, officeRequestId: input.requestId,
      officePayloadHash: careFingerprint({ actor, input }), version: value.intake.version + 1, resolvedAt: new Date(), updatedAt: new Date() }).where(intakeWhere(org, id));
    await tx.update(crmTasksTable).set({ status: "done", completedAt: new Date(), description: "Office-confirmed CALLIE appointment linked. The exact time was agreed with the customer and conflicts checked. Service completion remains separate." })
      .where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, value.task.id)));
    const { scheduleAppointmentReminder } = await import("./automation");
    await scheduleAppointmentReminder(org, appointment, undefined, tx);
    await appendSchedulingTransition(tx, authority, null, admission.snapshot, { kind: "appointment", id: appointment.id }, { transition: admission.transition, source, invalidHistoricalEvidenceRetained: false });
    const record = await audit(tx, org, actor, id, action, input, { appointmentId: appointment.id, evidence: "staff_attested_exact_customer_confirmation", noAutomaticResend: true });
    return { detail: detail(await observe(tx, org, id)), replayed: false, bookingOutcome: bookingOutcome(record, org, actor, id, input) };
  });
}
