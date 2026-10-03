import type { Request } from "express";
import { z } from "zod/v4";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { auditEventsTable, contactsTable, crmTasksTable, db, missedCallHandoffsTable, revenueExecutionEventsTable as events,
  revenueExecutionsTable as executions, suppressionsTable, twilioCallsTable, twilioDispatchesTable, twilioInboundEventsTable } from "@workspace/db";
import { callieIntakesTable as intakes, callieAckDispatchesTable as acknowledgments, type CallieState } from "../../../../lib/db/src/schema/callie";
import { assertCallieCurrentAuthority, CallieError, denyCallie, lockCallie, type CallieReader } from "./callie-policy";
import { callieHash, callieOperationKey, callieTriggerHash } from "./callie-contract";
import { deliveryFingerprint } from "./invoice-delivery-contract";
import { isMissedInbound, nextCareWindow } from "./missed-call-care-policy";
import { addSuppression, normalizePhone } from "./send-gate";
import { customerWorkAllowedSql } from "./customer-lifecycle-runtime";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { phoneE164, twilioForOrganization, twilioRequestValid } from "./twilio-controls";
import { countTwilioSmsOperations, latestTwilioSmsToPhone, lockTwilioSmsBudget } from "./twilio-sms-budget";
import { postCallieAcknowledgment } from "./callie-ack-transport";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Intake = typeof intakes.$inferSelect;
type Acknowledgment = typeof acknowledgments.$inferSelect;
const TERMINAL = new Set<CallieState>(["resolved", "cancelled", "booked"]);
const attentionDescription = (reason: string) => `CALLIE needs office attention: ${reason}. Review the original call and caller-supplied choices. No visit or emergency dispatch is confirmed. Do not resend an uncertain acknowledgment.`;

async function audit(tx: Transaction, intake: Intake, action: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEventsTable).values({ organizationId: intake.organizationId, action: `callie.${action}`, entityType: "callie_intake", entityId: intake.id, metadata });
}
async function officeAttention(tx: Transaction, intake: Intake, reason: string) {
  const [handoff] = await tx.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, intake.organizationId), eq(missedCallHandoffsTable.callId, intake.callId)));
  const description = attentionDescription(reason);
  // Escalation must not undo human progress or invalidate an unchanged review.
  // Keep the original callback deadline, but avoid the updatedAt hook on no-ops.
  if (handoff) await tx.update(crmTasksTable).set({ priority: "high", description, dueAt: intake.dueAt })
    .where(and(eq(crmTasksTable.organizationId, intake.organizationId), eq(crmTasksTable.id, handoff.taskId), sql`${crmTasksTable.status} not in ('done','cancelled')`,
      sql`(${crmTasksTable.priority} is distinct from 'high'
        or ${crmTasksTable.description} is distinct from ${description}
        or ${crmTasksTable.dueAt} is distinct from ${sql.param(intake.dueAt, crmTasksTable.dueAt)})`));
}
async function changeIntake(tx: Transaction, intake: Intake, state: CallieState, reason: string, attention = true) {
  if (TERMINAL.has(intake.state)) return null;
  const [changed] = await tx.update(intakes).set({ state, reason, version: intake.version + 1, updatedAt: new Date() })
    .where(and(eq(intakes.organizationId, intake.organizationId), eq(intakes.id, intake.id), eq(intakes.version, intake.version))).returning();
  if (!changed) return null;
  if (attention) await officeAttention(tx, changed, reason);
  await audit(tx, changed, "state_changed", { from: intake.state, state, reason, customerMessageSent: false });
  return changed;
}
async function blockIntake(intake: Intake, reason: string, state: CallieState = "blocked") {
  return db.transaction(async tx => { await lockCallie(tx, intake.organizationId); return changeIntake(tx, intake, state, reason); });
}

/** No identity/consent is invented: this validates one exact signed SMS grant. */
async function exactGrant(reader: CallieReader, org: string, intakeId: string, now: Date, allowedStates: CallieState[]) {
  const [intake] = await reader.select().from(intakes).where(and(eq(intakes.organizationId, org), eq(intakes.id, intakeId)));
  if (!intake || !allowedStates.includes(intake.state) || intake.stage !== "complete" || intake.appointmentId || intake.resolvedAt) denyCallie("intake_not_sendable");
  const [call] = await reader.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, intake.callId)));
  if (!call || !isMissedInbound(call) || ["failed", "busy", "no-answer", "canceled"].includes(call.status) || call.accountSid !== intake.accountSid || call.providerSid !== intake.providerCallSid ||
      call.phone !== intake.fromPhone) denyCallie("original_call_changed");
  const [handoff] = await reader.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, org), eq(missedCallHandoffsTable.callId, intake.callId)));
  const [task] = handoff ? await reader.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, handoff.taskId))) : [];
  if (!task || !["open", "in_progress"].includes(task.status) || task.assignedUserId !== intake.ownerUserId) denyCallie("office_callback_changed");
  const authority = await assertCallieCurrentAuthority(org, intake.policyRevisionId, { reader, at: call.createdAt });
  const { binding, revision } = authority;
  if (intake.ownerUserId !== authority.ownerUserId) denyCallie("owner_changed");
  if (intake.bindingId !== binding.id || intake.accountSid !== binding.accountSid || intake.calledNumber !== binding.phoneNumber ||
      call.createdAt < revision.approvedAt || !/^CA[a-f0-9]{32}$/i.test(intake.providerCallSid)) denyCallie("original_binding_changed");
  if (!intake.triggerMessageSid || !intake.triggerPayloadHash || !intake.confirmedAt || !intake.grantExpiresAt ||
      !intake.challengeHash || !intake.challengeExpiresAt || intake.grantExpiresAt <= now || intake.confirmedAt > now ||
      intake.triggerAccountSid !== binding.accountSid || intake.triggerFrom !== intake.fromPhone || intake.triggerTo !== intake.calledNumber) denyCallie("one_call_grant_unavailable");
  const [trigger] = await reader.select().from(twilioInboundEventsTable).where(and(eq(twilioInboundEventsTable.organizationId, org), eq(twilioInboundEventsTable.messageSid, intake.triggerMessageSid)));
  if (!trigger || trigger.eventType !== "CALLIE" || trigger.body !== null || trigger.phone !== intake.fromPhone ||
      trigger.receivedAt < call.createdAt || trigger.receivedAt > intake.challengeExpiresAt || trigger.receivedAt > intake.confirmedAt ||
      callieTriggerHash({ accountSid: intake.triggerAccountSid, from: intake.triggerFrom, to: intake.triggerTo, messageSid: intake.triggerMessageSid, bodyHash: intake.challengeHash }) !== intake.triggerPayloadHash) denyCallie("one_call_grant_changed");
  const matchingContacts = await reader.select({ id: contactsTable.id, doNotContact: contactsTable.doNotContact, doNotContactSms: contactsTable.doNotContactSms }).from(contactsTable)
    .where(and(eq(contactsTable.organizationId, org), sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${intake.fromPhone.slice(1)}, ${intake.fromPhone.slice(2)})`));
  if (matchingContacts.some(contact => contact.doNotContact || contact.doNotContactSms)) denyCallie("phone_do_not_contact");
  if (matchingContacts.length > 1) denyCallie("caller_phone_ambiguous");
  // Same normalized-address suppression survives deletion and re-import.
  // This check uses the provided transaction rather than borrowing a DB client.
  const [suppression] = await reader.select({ id: suppressionsTable.id }).from(suppressionsTable).where(and(
    eq(suppressionsTable.organizationId, org), eq(suppressionsTable.channel, "sms"), eq(suppressionsTable.value, normalizePhone(intake.fromPhone))));
  if (suppression) denyCallie("phone_suppressed");
  const [other] = await reader.select({ id: twilioInboundEventsTable.messageSid }).from(twilioInboundEventsTable).where(and(
    eq(twilioInboundEventsTable.organizationId, org), eq(twilioInboundEventsTable.phone, intake.fromPhone),
    ne(twilioInboundEventsTable.messageSid, intake.triggerMessageSid), gte(twilioInboundEventsTable.receivedAt, call.createdAt))).limit(1);
  if (other) denyCallie("another_inbound_requires_review");
  const message = `${binding.businessName}: ${authority.snapshot.acknowledgmentBody}\nReply STOP to opt out. HELP for help.`;
  const payload = { intakeId: intake.id, callId: intake.callId, policyRevisionId: intake.policyRevisionId, triggerMessageSid: intake.triggerMessageSid,
    triggerPayloadHash: intake.triggerPayloadHash, confirmedAt: intake.confirmedAt.toISOString(), grantExpiresAt: intake.grantExpiresAt.toISOString(),
    accountSid: binding.accountSid, sender: binding.phoneNumber, phone: intake.fromPhone, service: binding.messagingServiceSid,
    origin: binding.origin, disclosureVersion: binding.smsDisclosureVersion, ownerUserId: intake.ownerUserId, message };
  return { intake, call, authority, message, payload, payloadHash: deliveryFingerprint(payload) };
}

async function timing(reader: CallieReader, grant: Awaited<ReturnType<typeof exactGrant>>, now: Date) {
  const snapshot = grant.authority.snapshot;
  const settings = { enabled: snapshot.enabled, timezone: snapshot.timezone, days: snapshot.days, opensAt: snapshot.opensAt,
    closesAt: snapshot.closesAt, businessHoursOwnerId: snapshot.businessHoursOwnerId, afterHoursOwnerId: snapshot.afterHoursOwnerId, responseMinutes: snapshot.responseMinutes };
  const quiet = nextCareWindow(settings, now);
  const recent = await latestTwilioSmsToPhone(reader, grant.intake.organizationId, grant.intake.fromPhone, new Date(now.getTime() - 86400_000), callieOperationKey(grant.intake.callId));
  const cap = recent ? new Date(recent.getTime() + 86400_000 + 60_000) : null;
  const resumes = [quiet, cap].filter((at): at is Date => at !== null).sort((a, b) => b.getTime() - a.getTime());
  if (!resumes.length) return null;
  const at = nextCareWindow(settings, resumes[0]!) ?? resumes[0]!;
  if (at >= grant.intake.grantExpiresAt!) denyCallie("grant_expires_before_safe_window");
  return { at, reason: cap ? "frequency_cap" : "quiet_hours" };
}

async function claimAcknowledgment(org: string, intakeId: string) {
  return db.transaction(async tx => {
    await lockCallie(tx, org);
    const grant = await exactGrant(tx, org, intakeId, new Date(), ["confirmed", "deferred"]);
    await lockTwilioSmsBudget(tx, org);
    const key = callieOperationKey(grant.intake.callId);
    const [existing] = await tx.select().from(executions).where(and(eq(executions.organizationId, org), eq(executions.actionKey, key)));
    const [legacy] = await tx.select({ id: twilioDispatchesTable.id }).from(twilioDispatchesTable).where(and(eq(twilioDispatchesTable.organizationId, org), eq(twilioDispatchesTable.idempotencyKey, key)));
    const [ack] = await tx.select({ id: acknowledgments.id }).from(acknowledgments).where(and(eq(acknowledgments.organizationId, org), eq(acknowledgments.operationKey, key)));
    if (existing || legacy || ack) {
      await changeIntake(tx, grant.intake, existing && ["processing", "indeterminate"].includes(existing.state) ? "indeterminate" : "blocked", "logical_response_already_owned");
      return null;
    }
    const deferred = await timing(tx, grant, new Date());
    if (deferred) {
      if (grant.intake.state !== "deferred" || grant.intake.reason !== deferred.reason) await changeIntake(tx, grant.intake, "deferred", deferred.reason, false);
      else await tx.update(intakes).set({ updatedAt: new Date() }).where(and(eq(intakes.id, grant.intake.id), eq(intakes.version, grant.intake.version)));
      await tx.update(intakes).set({ ackDueAt: deferred.at }).where(and(eq(intakes.organizationId, org), eq(intakes.id, grant.intake.id)));
      return null;
    }
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    if (await countTwilioSmsOperations(tx, org, day) >= grant.authority.binding.dailySmsLimit) {
      await changeIntake(tx, grant.intake, "blocked", "sms_daily_allowance_reached"); return null;
    }
    const [receipt] = await tx.insert(executions).values({ organizationId: org, actionKey: key, kind: "callie_one_call_acknowledgment",
      fingerprint: grant.payloadHash, actorUserId: grant.authority.revision.approvedByUserId, expiresAt: new Date(Date.now() + 15 * 60_000) }).onConflictDoNothing().returning();
    if (!receipt) denyCallie("logical_response_already_owned");
    await tx.insert(events).values({ organizationId: org, executionId: receipt.id, state: "processing", detail: "One-call signed SMS acknowledgment ownership acquired under the approved CALLIE policy.", actorUserId: receipt.actorUserId });
    const [created] = await tx.insert(acknowledgments).values({ organizationId: org, intakeId, callId: grant.intake.callId,
      policyRevisionId: grant.intake.policyRevisionId, triggerMessageSid: grant.intake.triggerMessageSid!, receiptId: receipt.id,
      operationKey: key, payloadHash: grant.payloadHash, accountSid: grant.authority.binding.accountSid,
      fromPhone: grant.authority.binding.phoneNumber, toPhone: grant.intake.fromPhone, messagingServiceSid: grant.authority.binding.messagingServiceSid!, bodyHash: callieHash(grant.message) }).returning();
    const owned = await changeIntake(tx, grant.intake, "dispatching", "acknowledgment_provider_handoff_pending", false);
    if (!owned) denyCallie("intake_changed");
    await audit(tx, owned, "acknowledgment_claimed", { acknowledgmentId: created.id, executionId: receipt.id, triggerMessageSid: grant.intake.triggerMessageSid, customerMessageSent: false });
    return { acknowledgment: created, version: owned.version, payloadHash: grant.payloadHash };
  });
}

async function finalGrant(ack: Acknowledgment, version: number, payloadHash: string) {
  const grant = await exactGrant(db, ack.organizationId, ack.intakeId, new Date(), ["dispatching"]);
  const [receipt] = await db.select().from(executions).where(and(eq(executions.organizationId, ack.organizationId), eq(executions.id, ack.receiptId), eq(executions.actionKey, ack.operationKey)));
  const [current] = await db.select().from(acknowledgments).where(and(eq(acknowledgments.organizationId, ack.organizationId), eq(acknowledgments.id, ack.id)));
  if (grant.intake.version !== version || grant.payloadHash !== payloadHash || !receipt || receipt.state !== "processing" || receipt.fingerprint !== payloadHash || receipt.expiresAt <= new Date() ||
      !current || current.status !== "dispatching" || current.providerSid || current.payloadHash !== payloadHash ||
      current.triggerMessageSid !== grant.intake.triggerMessageSid || current.bodyHash !== callieHash(grant.message) ||
      current.intakeId !== grant.intake.id || current.callId !== grant.intake.callId || current.policyRevisionId !== grant.intake.policyRevisionId ||
      current.accountSid !== grant.authority.binding.accountSid || current.fromPhone !== grant.authority.binding.phoneNumber ||
      current.toPhone !== grant.intake.fromPhone || current.messagingServiceSid !== grant.authority.binding.messagingServiceSid ||
      current.receiptId !== receipt.id || current.operationKey !== callieOperationKey(grant.intake.callId)) denyCallie("acknowledgment_ownership_changed");
  if (await timing(db, grant, new Date())) denyCallie("sending_window_changed");
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  if (await countTwilioSmsOperations(db, ack.organizationId, day) > grant.authority.binding.dailySmsLimit) denyCallie("sms_daily_allowance_changed");
  assertOutboundDeliveryAllowed();
  return grant;
}

async function settle(ack: Acknowledgment, version: number, result: { kind: "accepted"; providerSid: string } | { kind: "blocked" | "unknown"; reason: string; status?: string; errorCode?: string }) {
  return db.transaction(async tx => {
    await lockCallie(tx, ack.organizationId);
    const [intake] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, ack.organizationId), eq(intakes.id, ack.intakeId)));
    if (!intake) throw new Error("CALLIE original intake is unavailable; preserve owned effect.");
    const accepted = result.kind === "accepted";
    // Provider evidence is retained even when the execution has already expired,
    // been reconciled, or office work changed. It never grants another dispatch.
    if (accepted) await tx.update(acknowledgments).set({ providerSid: result.providerSid, status: "accepted", updatedAt: new Date() })
      .where(and(eq(acknowledgments.id, ack.id), sql`(${acknowledgments.providerSid} is null or ${acknowledgments.providerSid} = ${result.providerSid})`, inArray(acknowledgments.status, ["dispatching", "uncertain"])));
    else await tx.update(acknowledgments).set({ status: result.status ?? (result.kind === "blocked" ? "cancelled" : "uncertain"), errorCode: result.errorCode ?? null, updatedAt: new Date() })
      .where(and(eq(acknowledgments.id, ack.id), eq(acknowledgments.status, "dispatching")));
    const state = accepted ? "succeeded" : result.kind === "blocked" ? "blocked" : "indeterminate";
    const [receipt] = await tx.update(executions).set({ state, completedAt: new Date(), detail: accepted ? "Twilio accepted the one-call acknowledgment; delivery is separate." : result.kind === "blocked" ? "No provider POST was started. Original response identity remains owned." : "The provider effect is uncertain. Automatic replay is blocked." })
      .where(and(eq(executions.organizationId, ack.organizationId), eq(executions.id, ack.receiptId), eq(executions.actionKey, ack.operationKey), eq(executions.fingerprint, ack.payloadHash), eq(executions.state, "processing"))).returning();
    if (receipt) await tx.insert(events).values({ organizationId: ack.organizationId, executionId: receipt.id, state, detail: receipt.detail!, actorUserId: receipt.actorUserId });
    await audit(tx, intake, accepted ? "provider_accepted" : "provider_result", { acknowledgmentId: ack.id, executionId: ack.receiptId,
      ...(accepted ? { providerMessageId: result.providerSid, acceptance: "accepted", deliveryConfirmed: false } : { result: result.kind, reason: result.reason }), executionUpdated: Boolean(receipt) });
    if (intake.state === "dispatching" && intake.version === version) {
      if (receipt) await changeIntake(tx, intake, accepted ? "accepted" : result.kind === "blocked" ? "blocked" : "indeterminate", accepted ? "acknowledgment_provider_accepted" : result.reason, !accepted);
      else await changeIntake(tx, intake, "indeterminate", "acknowledgment_receipt_requires_review");
    }
  });
}

async function dispatchAcknowledgment(claim: NonNullable<Awaited<ReturnType<typeof claimAcknowledgment>>>) {
  const { acknowledgment: ack, version, payloadHash } = claim;
  let dispatched = false;
  try {
    const response = await postCallieAcknowledgment(async () => {
      const grant = await finalGrant(ack, version, payloadHash), binding = grant.authority.binding;
      return { accountSid: binding.accountSid, apiKeySid: binding.apiKeySid!, apiKeySecret: binding.apiKeySecret, messagingServiceSid: binding.messagingServiceSid!,
        to: ack.toPhone, message: grant.message, callbackUrl: `${binding.origin}/api/v1/public/sms/status?callieOperation=${ack.id}` };
    }, () => { dispatched = true; });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: number };
      const code = Number.isSafeInteger(body.code) ? String(body.code) : String(response.status);
      if (["21610", "21211", "21614"].includes(code)) await addSuppression({ organizationId: ack.organizationId, channel: "sms", value: ack.toPhone,
        reason: code === "21610" ? "stop_keyword" : "invalid", source: "callie_twilio_api" });
      await settle(ack, version, { kind: "unknown", reason: "provider_result_requires_review", status: response.status >= 500 ? "uncertain" : response.status === 429 ? "rate_limited" : "failed", errorCode: code });
      return;
    }
    const body = await response.json() as { sid?: string };
    if (!/^SM[a-f0-9]{32}$/i.test(body.sid ?? "")) throw new Error("Missing provider acceptance identity");
    await settle(ack, version, { kind: "accepted", providerSid: body.sid! });
  } catch (error) {
    // No network retries, including when acceptance arrived but final storage
    // failed. A later signed callback can retain evidence without replaying.
    await settle(ack, version, dispatched ? { kind: "unknown", reason: "provider_outcome_unknown" } : { kind: "blocked", reason: error instanceof CallieError ? error.code : "final_guard_unavailable" });
  }
}

/** Signature-verified original operation only. Status callbacks do not resend. */
export async function acceptCallieStatusCallback(req: Request): Promise<boolean> {
  const id = z.uuid().safeParse(req.query.callieOperation);
  if (!id.success || req.query.operation !== undefined) return false;
  const [ack] = await db.select().from(acknowledgments).where(eq(acknowledgments.id, id.data));
  if (!ack) return false;
  const binding = await twilioForOrganization(ack.organizationId);
  if (!binding || binding.accountSid !== ack.accountSid || binding.phoneNumber !== ack.fromPhone || binding.messagingServiceSid !== ack.messagingServiceSid ||
      !twilioRequestValid(req, binding) || req.body.From !== ack.fromPhone || phoneE164(req.body.To ?? "") !== ack.toPhone ||
      !/^SM[a-f0-9]{32}$/i.test(req.body.MessageSid ?? "") || (ack.providerSid && ack.providerSid !== req.body.MessageSid)) return false;
  const ranks: Record<string, number> = { dispatching: 0, uncertain: 0, accepted: 1, queued: 2, sending: 3, sent: 4, delivered: 5, undelivered: 5, failed: 5 };
  const status = String(req.body.MessageStatus), providerSid = String(req.body.MessageSid);
  if (!(status in ranks)) return false;
  const errorCode = /^\d{4,6}$/.test(req.body.ErrorCode ?? "") ? String(req.body.ErrorCode) : null;
  await db.transaction(async tx => {
    await lockCallie(tx, ack.organizationId);
    const [changed] = await tx.update(acknowledgments).set({ providerSid, status, errorCode, updatedAt: new Date() }).where(and(
      eq(acknowledgments.organizationId, ack.organizationId), eq(acknowledgments.id, ack.id),
      sql`(${acknowledgments.providerSid} is null or ${acknowledgments.providerSid} = ${providerSid})`,
      sql`${acknowledgments.status} not in ('delivered','undelivered','failed','cancelled','rate_limited')`,
      sql`case ${acknowledgments.status} when 'accepted' then 1 when 'queued' then 2 when 'sending' then 3 when 'sent' then 4 else 0 end <= ${ranks[status]}`)).returning();
    if (!changed) return;
    const [intake] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, ack.organizationId), eq(intakes.id, ack.intakeId)));
    if (intake) {
      await audit(tx, intake, "provider_status", { acknowledgmentId: ack.id, providerMessageId: providerSid, status, deliveryConfirmed: status === "delivered" });
      if (["failed", "undelivered"].includes(status) && !TERMINAL.has(intake.state)) await officeAttention(tx, intake, "acknowledgment_not_delivered");
    }
  });
  if (["21610", "21211", "21614"].includes(errorCode ?? "")) await addSuppression({ organizationId: ack.organizationId, channel: "sms", value: ack.toPhone,
    reason: errorCode === "21610" ? "stop_keyword" : "invalid", source: "callie_twilio_status" });
  return true;
}

async function monitorIntake(row: Intake) {
  await db.transaction(async tx => {
    await lockCallie(tx, row.organizationId);
    const [current] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, row.organizationId), eq(intakes.id, row.id)));
    if (!current || current.version !== row.version || TERMINAL.has(current.state)) return;
    const [receipt] = await tx.select().from(executions).where(and(eq(executions.organizationId, row.organizationId), eq(executions.actionKey, callieOperationKey(row.callId))));
    if (current.state === "dispatching" && receipt?.state === "processing" && receipt.expiresAt <= new Date()) {
      const [expired] = await tx.update(executions).set({ state: "indeterminate", completedAt: new Date(), detail: "Interrupted CALLIE acknowledgment. Preserve ownership and reconcile; do not resend." })
        .where(and(eq(executions.id, receipt.id), eq(executions.state, "processing"))).returning();
      if (expired) await tx.insert(events).values({ organizationId: row.organizationId, executionId: receipt.id, state: "indeterminate", detail: expired.detail! });
      await tx.update(acknowledgments).set({ status: "uncertain", updatedAt: new Date() }).where(and(eq(acknowledgments.organizationId, row.organizationId), eq(acknowledgments.intakeId, row.id), eq(acknowledgments.status, "dispatching")));
      await changeIntake(tx, current, "indeterminate", "provider_outcome_unknown"); return;
    }
    if (current.state === "dispatching" && receipt && receipt.state !== "processing") {
      await changeIntake(tx, current, "indeterminate", "acknowledgment_receipt_requires_review"); return;
    }
    const [reply] = await tx.select({ messageSid: twilioInboundEventsTable.messageSid }).from(twilioInboundEventsTable).where(and(
      eq(twilioInboundEventsTable.organizationId, row.organizationId), eq(twilioInboundEventsTable.phone, row.fromPhone),
      row.triggerMessageSid ? ne(twilioInboundEventsTable.messageSid, row.triggerMessageSid) : undefined,
      gte(twilioInboundEventsTable.receivedAt, row.createdAt))).limit(1);
    if (reply && !["dispatching", "indeterminate"].includes(current.state)) {
      if (current.state !== "blocked" || current.reason !== "another_inbound_requires_review") await changeIntake(tx, current, "blocked", "another_inbound_requires_review");
      else await tx.update(intakes).set({ updatedAt: new Date() }).where(eq(intakes.id, current.id));
      return;
    }
    if (current.dueAt <= new Date()) await officeAttention(tx, current, "callback_deadline_reached");
    await tx.update(intakes).set({ updatedAt: new Date() }).where(and(eq(intakes.id, current.id), eq(intakes.version, current.version)));
  });
}

/** Bounded, rotating work. No historical enrollment and no automatic replay. */
export async function processCallieIntakes(organizationId?: string) {
  const pending = await db.select().from(intakes).where(and(organizationId ? eq(intakes.organizationId, organizationId) : undefined,
    inArray(intakes.state, ["confirmed", "deferred"]), lte(intakes.ackDueAt, new Date()), customerWorkAllowedSql(intakes.organizationId))).orderBy(asc(intakes.updatedAt)).limit(20);
  for (const row of pending) {
    try { const claim = await claimAcknowledgment(row.organizationId, row.id); if (claim) await dispatchAcknowledgment(claim); }
    catch (error) { if (!(error instanceof CallieError)) throw error; await blockIntake(row, error.code); }
  }
  const watching = await db.select().from(intakes).where(and(organizationId ? eq(intakes.organizationId, organizationId) : undefined,
    sql`${intakes.state} not in ('resolved','cancelled','booked')`, customerWorkAllowedSql(intakes.organizationId))).orderBy(asc(intakes.updatedAt)).limit(50);
  for (const row of watching) await monitorIntake(row);
}
