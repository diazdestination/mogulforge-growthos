import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, lte, notExists, sql } from "drizzle-orm";
import {
  activitiesTable, auditEventsTable, contactsTable, crmTasksTable, db, leadsTable,
  missedCallHandoffsTable as handoffs, missedCallCareCasesTable as cases, missedCallCarePoliciesTable as policies,
  revenueExecutionsTable as executions, twilioCallsTable as calls, twilioConsentProofsTable as proofs,
  twilioDispatchesTable as dispatches, twilioInboundEventsTable as inbound, usersTable,
  type MissedCallCareSnapshot, type MissedCallCareState,
} from "@workspace/db";
import { hasPermission } from "../lib/permissions";
import { customerWorkAllowedSql, customerWorkHeld } from "./customer-lifecycle-runtime";
import { runDurableAction } from "./durable-execution";
import { checkSendEligibility } from "./send-gate";
import { hasContactReplyHold, hasCustomerReplyHold } from "./response-correlation";
import { outboundDeliveryHeld } from "./outbound-hold";
import { phoneE164, twilioForOrganization } from "./twilio-controls";
import { sendTwilioSms } from "./twilio-delivery";
import { callieIntakesTable } from "../../../../lib/db/src/schema/callie";
import { latestTwilioSmsToPhone } from "./twilio-sms-budget";
import { CARE_BODY, CARE_TEMPLATE_VERSION, DEFAULT_CARE_POLICY, careOperationKey, careOwnerAt, isMissedInbound, missedCallCarePolicySchema, nextCareWindow, type CarePolicyInput } from "./missed-call-care-policy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CareCase = typeof cases.$inferSelect;
const withoutCallie = (callId: typeof calls.id | typeof cases.callId | typeof handoffs.callId) => notExists(db.select({ id: callieIntakesTable.id }).from(callieIntakesTable).where(eq(callieIntakesTable.callId, callId)));
export class MissedCallCareError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}
function deny(code: string, statusCode = 409): never { throw new MissedCallCareError(code, statusCode); }
async function lockCare(tx: Transaction, org: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`missed-call-care:${org}`}))`);
}
async function activeMember(org: string, userId: string | null, permission: "crm.write" | "settings.manage") {
  if (!userId) return false;
  const [user] = await db.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, userId), eq(usersTable.isActive, true)));
  return Boolean(user && !user.id.startsWith("invite:") && user.emailVerifiedAt && hasPermission(user.role, permission));
}
async function audit(tx: Transaction, org: string, callId: string, actor: string | null, action: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: `voice.care.${action}`, entityType: "twilio_call", entityId: callId, metadata });
}
export async function getMissedCallCarePolicy(org: string) {
  const [row] = await db.select().from(policies).where(eq(policies.organizationId, org));
  return { policy: row ? { enabled: row.enabled, timezone: row.timezone, days: row.days, opensAt: row.opensAt, closesAt: row.closesAt,
    businessHoursOwnerId: row.businessHoursOwnerId, afterHoursOwnerId: row.afterHoursOwnerId, responseMinutes: row.responseMinutes } : DEFAULT_CARE_POLICY,
    version: row?.version ?? 0, templateVersion: CARE_TEMPLATE_VERSION, body: CARE_BODY, automaticUnknownCallerEnrollment: false };
}
export async function saveMissedCallCarePolicy(org: string, actor: string, expectedVersion: number, input: CarePolicyInput) {
  const policy = missedCallCarePolicySchema.parse(input);
  if (!(await activeMember(org, actor, "settings.manage"))) deny("permission_denied", 403);
  for (const id of [policy.businessHoursOwnerId, policy.afterHoursOwnerId]) {
    if (id && !(await activeMember(org, id, "crm.write"))) deny("owner_unavailable");
  }
  await db.transaction(async (tx) => {
    await lockCare(tx, org);
    const [current] = await tx.select().from(policies).where(eq(policies.organizationId, org));
    if ((current?.version ?? 0) !== expectedVersion) deny("stale_policy");
    await tx.insert(policies).values({ organizationId: org, ...policy, version: expectedVersion + 1, approvedByUserId: actor })
      .onConflictDoUpdate({ target: policies.organizationId, set: { ...policy, version: expectedVersion + 1, approvedByUserId: actor, approvedAt: new Date(), updatedAt: new Date() } });
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "voice.care.policy_approved", entityType: "organization", entityId: org,
      metadata: { version: expectedVersion + 1, ...policy, templateVersion: CARE_TEMPLATE_VERSION } });
  });
  return getMissedCallCarePolicy(org);
}

/** Signed missed-call intake creates an internal case only, never a send. */
export async function ensureMissedCallCareCase(org: string, callId: string) {
  return db.transaction(async (tx) => {
    await lockCare(tx, org);
    const [call] = await tx.select().from(calls).where(and(eq(calls.organizationId, org), eq(calls.id, callId)));
    if (!call || !isMissedInbound(call)) return null;
    const [callie] = await tx.select({ id: callieIntakesTable.id }).from(callieIntakesTable).where(and(eq(callieIntakesTable.organizationId, org), eq(callieIntakesTable.callId, callId)));
    if (callie) return null;
    const [handoff] = await tx.select().from(handoffs).where(and(eq(handoffs.organizationId, org), eq(handoffs.callId, callId)));
    if (!handoff) return null;
    const [existing] = await tx.select().from(cases).where(and(eq(cases.organizationId, org), eq(cases.callId, callId)));
    if (existing) return existing;
    const [policy] = await tx.select().from(policies).where(eq(policies.organizationId, org));
    const parsed = missedCallCarePolicySchema.safeParse(policy ? { enabled: policy.enabled, timezone: policy.timezone, days: policy.days,
      opensAt: policy.opensAt, closesAt: policy.closesAt, businessHoursOwnerId: policy.businessHoursOwnerId, afterHoursOwnerId: policy.afterHoursOwnerId, responseMinutes: policy.responseMinutes } : DEFAULT_CARE_POLICY);
    let ownerId = parsed.success && parsed.data.enabled ? careOwnerAt(parsed.data, call.createdAt) : null;
    if (ownerId) {
      const [owner] = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, ownerId), eq(usersTable.isActive, true)));
      if (!owner || owner.id.startsWith("invite:") || !owner.emailVerifiedAt || !hasPermission(owner.role, "crm.write")) ownerId = null;
    }
    const dueAt = new Date(call.createdAt.getTime() + (parsed.success ? parsed.data.responseMinutes : 30) * 60_000);
    const [row] = await tx.insert(cases).values({ organizationId: org, callId, ownerUserId: ownerId, dueAt }).returning();
    if (ownerId) await tx.update(crmTasksTable).set({ assignedUserId: ownerId, dueAt })
      .where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, handoff.taskId)));
    await audit(tx, org, callId, null, "case_created", { caseId: row.id, ownerUserId: ownerId, dueAt: dueAt.toISOString(), customerMessageSent: false });
    return row;
  });
}

async function careContext(org: string, callId: string) {
  const [call] = await db.select().from(calls).where(and(eq(calls.organizationId, org), eq(calls.id, callId)));
  if (!call) deny("not_found", 404);
  const [callie] = await db.select({ id: callieIntakesTable.id }).from(callieIntakesTable).where(and(eq(callieIntakesTable.organizationId, org), eq(callieIntakesTable.callId, callId)));
  if (callie) deny("callie_intake_authoritative");
  const [handoff] = await db.select().from(handoffs).where(and(eq(handoffs.organizationId, org), eq(handoffs.callId, callId)));
  const [row] = await db.select().from(cases).where(and(eq(cases.organizationId, org), eq(cases.callId, callId)));
  const [policy] = await db.select().from(policies).where(eq(policies.organizationId, org));
  if (!handoff || !row) deny("not_found", 404);
  if (!isMissedInbound(call)) deny("call_not_missed");
  if (!handoff.reviewedAt || !handoff.contactId || call.contactId !== handoff.contactId) deny("caller_review_required");
  if (!policy?.enabled) deny("care_policy_disabled");
  const config = missedCallCarePolicySchema.parse({ enabled: policy.enabled, timezone: policy.timezone, days: policy.days,
    opensAt: policy.opensAt, closesAt: policy.closesAt, businessHoursOwnerId: policy.businessHoursOwnerId,
    afterHoursOwnerId: policy.afterHoursOwnerId, responseMinutes: policy.responseMinutes });
  const ownerId = careOwnerAt(config, call.createdAt);
  if (!ownerId || !(await activeMember(org, ownerId, "crm.write")) || !(await activeMember(org, policy.approvedByUserId, "settings.manage"))) deny("owner_unavailable");
  const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, handoff.contactId)));
  if (!contact || phoneE164(contact.phone ?? "") !== call.phone) deny("caller_identity_changed");
  if (handoff.leadId) {
    const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, handoff.leadId), eq(leadsTable.contactId, contact.id)));
    if (!lead) deny("opportunity_unavailable");
  }
  const binding = await twilioForOrganization(org);
  if (!binding?.smsEnabled || binding.accountSid !== call.accountSid) deny("sms_not_approved");
  const snapshot: MissedCallCareSnapshot = {
    templateVersion: CARE_TEMPLATE_VERSION, callId, handoffId: handoff.id, contactId: contact.id, leadId: handoff.leadId,
    phone: call.phone, dialStatus: call.dialStatus!, reviewedAt: handoff.reviewedAt.toISOString(), policyVersion: policy.version, responseMinutes: policy.responseMinutes,
    ownerUserId: ownerId, bindingId: binding.id, accountSid: binding.accountSid, sender: binding.phoneNumber,
    messagingServiceSid: binding.messagingServiceSid!, disclosureVersion: binding.smsDisclosureVersion!, businessName: binding.businessName,
    publicOrigin: binding.origin, body: CARE_BODY, renderedMessage: `${binding.businessName}: ${CARE_BODY}\nReply STOP to opt out. HELP for help.`,
  };
  return { call, handoff, row, policy, config, contact, snapshot };
}

async function currentEligibility(context: Awaited<ReturnType<typeof careContext>>, now = new Date()) {
  const { call, handoff, contact, snapshot } = context, org = call.organizationId;
  if (outboundDeliveryHeld()) deny("environment_outbound_hold");
  if (await customerWorkHeld(org)) deny("customer_lifecycle_paused");
  if (now.getTime() - call.createdAt.getTime() > 7 * 86400_000) deny("call_too_old");
  const eligible = await checkSendEligibility({ organizationId: org, contact, channel: "sms", kind: "transactional" });
  if (!eligible.ok) deny(eligible.reason.startsWith("suppressed:") ? "sms_suppressed" : eligible.reason);
  const [proof] = await db.select().from(proofs).where(and(eq(proofs.organizationId, org), eq(proofs.contactId, contact.id), eq(proofs.phone, call.phone), eq(proofs.purpose, "customer_care")))
    .orderBy(desc(proofs.recordedAt), asc(proofs.granted)).limit(1);
  if (!proof?.granted || proof.disclosureVersion !== snapshot.disclosureVersion) deny("customer_care_consent_required");
  if (handoff.leadId ? await hasCustomerReplyHold(org, handoff.leadId) : await hasContactReplyHold(org, contact.id)) deny("customer_reply_requires_review");
  const [reply] = await db.select({ id: inbound.messageSid }).from(inbound).where(and(eq(inbound.organizationId, org), eq(inbound.phone, call.phone),
    inArray(inbound.eventType, ["message", "STOP", "HELP", "CALLIE"]), gt(inbound.receivedAt, call.createdAt))).limit(1);
  if (reply) deny("caller_reply_requires_review");
  const quietUntil = nextCareWindow(context.config, now);
  const recent = await latestTwilioSmsToPhone(db, org, call.phone, new Date(now.getTime() - 86400_000), careOperationKey(call.id));
  const capUntil = recent ? new Date(recent.getTime() + 86400_000 + 60_000) : null;
  const resume = [quietUntil, capUntil].filter((date): date is Date => date !== null).sort((a, b) => b.getTime() - a.getTime())[0];
  return resume ? { resumeAt: nextCareWindow(context.config, resume) ?? resume, reason: capUntil ? "frequency_cap" : "quiet_hours" } : null;
}

export async function previewMissedCallCare(org: string, callId: string) {
  const context = await careContext(org, callId);
  let eligibility: { ready: boolean; reason: string | null; resumeAt?: string };
  try { const deferred = await currentEligibility(context); eligibility = { ready: true, reason: deferred?.reason ?? null, ...(deferred ? { resumeAt: deferred.resumeAt.toISOString() } : {}) }; }
  catch (error) { if (!(error instanceof MissedCallCareError)) throw error; eligibility = { ready: false, reason: error.code }; }
  return { caseId: context.row.id, version: context.row.version, state: context.row.state, snapshot: context.snapshot, eligibility };
}

export async function approveMissedCallCare(org: string, callId: string, actor: string, expectedVersion: number, expectedSnapshot: unknown) {
  if (!(await activeMember(org, actor, "crm.write"))) deny("permission_denied", 403);
  const context = await careContext(org, callId);
  if (!isDeepStrictEqual(context.snapshot, expectedSnapshot)) deny("stale_approval");
  const deferred = await currentEligibility(context);
  return db.transaction(async (tx) => {
    await lockCare(tx, org);
    const [current] = await tx.select().from(cases).where(and(eq(cases.organizationId, org), eq(cases.callId, callId))).for("update");
    const [policy] = await tx.select().from(policies).where(eq(policies.organizationId, org));
    const [receipt] = await tx.select({ id: executions.id }).from(executions).where(and(eq(executions.organizationId, org), eq(executions.actionKey, careOperationKey(callId))));
    if (!current || current.version !== expectedVersion || !policy?.enabled || policy.version !== context.snapshot.policyVersion) deny("stale_approval");
    if (receipt || !["needs_review", "blocked", "escalated"].includes(current.state)) deny("recovery_already_owned");
    const [updated] = await tx.update(cases).set({ state: deferred ? "deferred" : "approved", version: current.version + 1,
      approvedSnapshot: context.snapshot, approvedByUserId: actor, approvedAt: new Date(), ownerUserId: context.snapshot.ownerUserId,
      dueAt: deferred?.resumeAt ?? new Date(), reason: deferred?.reason ?? "approved_waiting_worker", updatedAt: new Date() }).where(eq(cases.id, current.id)).returning();
    await tx.update(crmTasksTable).set({ assignedUserId: context.snapshot.ownerUserId }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, context.handoff.taskId)));
    await audit(tx, org, callId, actor, "response_approved", { caseId: current.id, version: updated.version, snapshot: context.snapshot, customerMessageSent: false });
    return updated;
  });
}

async function transition(row: CareCase, state: MissedCallCareState, reason: string, actor: string | null = null, dueAt?: Date) {
  return db.transaction(async (tx) => {
    await lockCare(tx, row.organizationId);
    const [updated] = await tx.update(cases).set({ state, reason, version: row.version + 1, updatedAt: new Date(), ...(dueAt ? { dueAt } : {}),
      ...(["resolved", "cancelled"].includes(state) ? { resolvedAt: new Date() } : {}) })
      .where(and(eq(cases.organizationId, row.organizationId), eq(cases.id, row.id), eq(cases.version, row.version))).returning();
    if (!updated) return null;
    const [handoff] = await tx.select().from(handoffs).where(and(eq(handoffs.organizationId, row.organizationId), eq(handoffs.callId, row.callId)));
    if (handoff && ["escalated", "reply_needs_review", "indeterminate", "blocked"].includes(state)) {
      await tx.update(crmTasksTable).set({ priority: "high", status: "open", completedAt: null, ...(updated.ownerUserId ? { assignedUserId: updated.ownerUserId } : {}),
        description: `Missed-call recovery needs staff attention: ${reason}. Check Calls for provider/reply evidence. No appointment or emergency dispatch is confirmed.`, dueAt: new Date() })
        .where(and(eq(crmTasksTable.organizationId, row.organizationId), eq(crmTasksTable.id, handoff.taskId)));
    }
    if (handoff && state === "resolved") {
      await tx.update(crmTasksTable).set({ status: "done", completedAt: new Date() })
        .where(and(eq(crmTasksTable.organizationId, row.organizationId), eq(crmTasksTable.id, handoff.taskId)));
    }
    await audit(tx, row.organizationId, row.callId, actor, state, { caseId: row.id, reason, customerMessageSent: false });
    return updated;
  });
}

export async function closeMissedCallCare(org: string, callId: string, actor: string, expectedVersion: number, outcome: "resolved" | "cancelled") {
  if (!(await activeMember(org, actor, "crm.write"))) deny("permission_denied", 403);
  const [row] = await db.select().from(cases).where(and(eq(cases.organizationId, org), eq(cases.callId, callId)));
  if (!row) deny("not_found", 404);
  if (row.version !== expectedVersion) deny("stale_approval");
  if (row.state === "dispatching") deny("provider_reconciliation_required");
  if (row.state === "indeterminate") {
    const [receipt] = await db.select().from(executions).where(and(eq(executions.organizationId, org), eq(executions.actionKey, careOperationKey(callId))));
    if (!receipt || !["confirmed_succeeded", "confirmed_not_performed"].includes(receipt.state)) deny("provider_reconciliation_required");
  }
  const result = await transition(row, outcome, outcome === "resolved" ? "staff_recorded_handled" : "staff_cancelled", actor);
  if (!result) deny("stale_approval");
  return result;
}

async function dispatchCase(row: CareCase) {
  let context: Awaited<ReturnType<typeof careContext>>;
  try {
    context = await careContext(row.organizationId, row.callId);
    if (!row.approvedSnapshot || !row.approvedAt || !isDeepStrictEqual(row.approvedSnapshot, context.snapshot) || Date.now() - row.approvedAt.getTime() > 86400_000) deny("stale_approval");
    if (!(await activeMember(row.organizationId, row.approvedByUserId, "crm.write"))) deny("approver_unavailable");
    const deferred = await currentEligibility(context);
    if (deferred) { await transition(row, "deferred", deferred.reason, null, deferred.resumeAt); return; }
  } catch (error) {
    if (!(error instanceof MissedCallCareError)) throw error;
    await transition(row, "blocked", error.code); return;
  }
  const receipt = await runDurableAction({ organizationId: row.organizationId, actionKey: careOperationKey(row.callId), kind: "missed_call_care_sms",
    payload: row.approvedSnapshot, actorUserId: row.approvedByUserId, leadId: context.handoff.leadId,
    execute: async () => {
      const owned = await transition(row, "dispatching", "provider_handoff_pending");
      if (!owned) return { state: "blocked", detail: "Approval changed before ownership handoff." };
      const guard = async () => {
        const fresh = await careContext(row.organizationId, row.callId);
        if (fresh.row.state !== "dispatching" || fresh.row.version !== owned.version || !isDeepStrictEqual(fresh.row.approvedSnapshot, fresh.snapshot) ||
            !(await activeMember(row.organizationId, fresh.row.approvedByUserId, "crm.write"))) deny("stale_approval");
        if (await currentEligibility(fresh)) deny("sending_window_changed");
      };
      // The transport repeats this immediately before final current consent /
      // binding / environment checks. No external call is held under a DB lock.
      await guard();
      const sent = await sendTwilioSms(context.call.phone, context.snapshot.body, {
        organizationId: row.organizationId, contactId: context.contact.id, purpose: "customer_care", idempotencyKey: careOperationKey(row.callId),
      }, guard);
      await db.transaction(async (tx) => {
        if (context.handoff.leadId) await tx.insert(activitiesTable).values({ organizationId: row.organizationId, leadId: context.handoff.leadId, contactId: context.contact.id,
          type: "missed_call_care_sent", title: "Missed-call reply accepted by SMS provider", metadata: { callId: row.callId, provider: "twilio", providerMessageId: sent.id, acceptance: "accepted", deliveryConfirmed: false } });
        await audit(tx, row.organizationId, row.callId, row.approvedByUserId, "provider_accepted", { provider: "twilio", providerMessageId: sent.id, deliveryConfirmed: false });
      });
      return { state: "succeeded", detail: "Twilio accepted the reviewed response. Delivery and customer response remain separate." };
    },
  });
  const [current] = await db.select().from(cases).where(and(eq(cases.organizationId, row.organizationId), eq(cases.id, row.id)));
  if (!current || current.state !== "dispatching") return;
  if (receipt.state === "succeeded") await transition(current, "awaiting_reply", "provider_accepted", null, new Date(Date.now() + context.policy.responseMinutes * 60_000));
  else if (receipt.state === "indeterminate") await transition(current, "indeterminate", "provider_outcome_unknown");
  else if (receipt.state === "blocked") await transition(current, "blocked", "approval_changed_before_send");
}

async function reconcileCase(row: CareCase, now = new Date()) {
  const [call] = await db.select().from(calls).where(and(eq(calls.organizationId, row.organizationId), eq(calls.id, row.callId)));
  if (!call) return;
  const [reply] = await db.select().from(inbound).where(and(eq(inbound.organizationId, row.organizationId), eq(inbound.phone, call.phone),
    inArray(inbound.eventType, ["message", "STOP", "HELP", "CALLIE"]), gt(inbound.receivedAt, call.createdAt))).orderBy(desc(inbound.receivedAt)).limit(1);
  if (reply && !["reply_needs_review", "indeterminate", "dispatching"].includes(row.state)) {
    await transition(row, "reply_needs_review", reply.eventType === "STOP" ? "caller_opted_out" : "caller_message_received"); return;
  }
  const [receipt] = await db.select().from(executions).where(and(eq(executions.organizationId, row.organizationId), eq(executions.actionKey, careOperationKey(row.callId))));
  const [delivery] = await db.select().from(dispatches).where(and(eq(dispatches.organizationId, row.organizationId), eq(dispatches.idempotencyKey, careOperationKey(row.callId))));
  if (["dispatching", "awaiting_reply"].includes(row.state) && (receipt?.state === "indeterminate" || delivery?.status === "uncertain" ||
      (receipt?.state === "processing" && receipt.expiresAt <= now))) {
    await transition(row, "indeterminate", "provider_outcome_unknown"); return;
  }
  if (row.state === "dispatching" && receipt?.state === "succeeded") {
    await transition(row, "awaiting_reply", "provider_accepted", null, new Date((receipt.completedAt ?? now).getTime() + (row.approvedSnapshot?.responseMinutes ?? 30) * 60_000)); return;
  }
  if (row.state === "awaiting_reply" && delivery && ["failed", "undelivered", "cancelled", "rate_limited"].includes(delivery.status)) {
    await transition(row, "escalated", "sms_not_delivered"); return;
  }
  if (["needs_review", "awaiting_reply"].includes(row.state) && row.dueAt <= now) await transition(row, "escalated", row.state === "needs_review" ? "review_overdue" : "no_reply_deadline");
}

/** Bounded scheduler stage. Default/no policy never sends. No unknown-effect retry. */
export async function processMissedCallCare(organizationId?: string) {
  const missing = await db.select({ organizationId: handoffs.organizationId, callId: handoffs.callId }).from(handoffs)
    .leftJoin(cases, and(eq(cases.organizationId, handoffs.organizationId), eq(cases.callId, handoffs.callId)))
    .where(and(isNull(cases.id), withoutCallie(handoffs.callId), organizationId ? eq(handoffs.organizationId, organizationId) : undefined, customerWorkAllowedSql(handoffs.organizationId)))
    .orderBy(asc(handoffs.createdAt)).limit(20);
  for (const row of missing) await ensureMissedCallCareCase(row.organizationId, row.callId);
  const pending = await db.select().from(cases).where(and(organizationId ? eq(cases.organizationId, organizationId) : undefined,
    inArray(cases.state, ["approved", "deferred"]), lte(cases.dueAt, new Date()), withoutCallie(cases.callId), customerWorkAllowedSql(cases.organizationId)))
    .orderBy(asc(cases.dueAt)).limit(20);
  for (const row of pending) await dispatchCase(row);
  const watching = await db.select().from(cases).where(and(organizationId ? eq(cases.organizationId, organizationId) : undefined,
    inArray(cases.state, ["needs_review", "dispatching", "awaiting_reply", "blocked", "escalated"]), withoutCallie(cases.callId), customerWorkAllowedSql(cases.organizationId)))
    .orderBy(asc(cases.updatedAt)).limit(50);
  for (const row of watching) {
    await reconcileCase(row);
    // Rotate unchanged rows through the bounded monitor. An old blocked case
    // must not permanently hide later customer replies or expired deadlines.
    await db.update(cases).set({ updatedAt: new Date() }).where(and(eq(cases.organizationId, row.organizationId), eq(cases.id, row.id), eq(cases.version, row.version)));
  }
}

export async function listMissedCallCare(org: string) {
  const rows = await db.select({ care: cases, call: calls, handoff: handoffs }).from(cases)
    .innerJoin(calls, and(eq(calls.organizationId, org), eq(calls.id, cases.callId)))
    .innerJoin(handoffs, and(eq(handoffs.organizationId, org), eq(handoffs.callId, cases.callId)))
    .where(and(eq(cases.organizationId, org), withoutCallie(cases.callId))).orderBy(desc(cases.createdAt)).limit(50);
  const items = [];
  for (const row of rows) {
    const [delivery] = await db.select({ status: dispatches.status, providerSid: dispatches.providerSid }).from(dispatches)
      .where(and(eq(dispatches.organizationId, org), eq(dispatches.idempotencyKey, careOperationKey(row.call.id))));
    const replies = await db.select({ messageSid: inbound.messageSid, eventType: inbound.eventType, body: inbound.body, receivedAt: inbound.receivedAt }).from(inbound)
      .where(and(eq(inbound.organizationId, org), eq(inbound.phone, row.call.phone), gt(inbound.receivedAt, row.call.createdAt)))
      .orderBy(desc(inbound.receivedAt)).limit(5);
    items.push({ ...row, delivery: delivery ?? null, replies, replyAssociation: "same_company_phone_after_call_requires_staff_review" });
  }
  return { ...(await getMissedCallCarePolicy(org)), items, companyPaused: await customerWorkHeld(org), environmentHeld: outboundDeliveryHeld() };
}
