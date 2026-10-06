import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { twiml } from "twilio";
import { z } from "zod/v4";
import { db, auditEventsTable, callieIntakesTable as intakes, callieReceptionSessionsTable as sessions, callieReceptionEventsTable as events,
  calliePolicyRevisionsTable, crmTasksTable, missedCallHandoffsTable, revenueExecutionsTable as executions, revenueExecutionEventsTable,
  twilioCallsTable, twilioClientBindingsTable, type CallieReceptionPolicySnapshot } from "@workspace/db";
import { decryptSecret, encryptSecret } from "../lib/token-encryption";
import { callieHash, callieOwnerAt } from "./callie-contract";
import { currentCallieRevision, type CallieReader } from "./callie-policy";
import { assertReceptionAuthority, lockCallieReception, receptionCredentials, receptionDeny } from "./callie-reception-policy";
import { CallieReceptionError, callieReceptionEvidenceSchema, callieReceptionFactsSchema, callieReceptionSnapshotSchema, callieReceptionToolInputSchema } from "./callie-reception-contract";
import { assertReceptionDeadline, boundedProviderText, preflightReception, receptionConversationMatches, registerReception, verifyReceptionConversation } from "./callie-reception-provider";
import { twilioForOrganization, type TwilioClientBinding } from "./twilio-controls";
import type { Request } from "express";
import { twilioRequestValid } from "./twilio-controls";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Session = typeof sessions.$inferSelect;
type Call = typeof twilioCallsTable.$inferSelect;
const ended = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const terminalOffice = new Set(["resolved", "cancelled", "booked"]);
const sessionWhere = (org: string, id: string) => and(eq(sessions.organizationId, org), eq(sessions.id, id));
const context = (row: Session, field: string) => `callie-reception:${row.organizationId}:${row.id}:${field}`;
export const receptionRegistrationKey = (callId: string) => `callie:${callId}:conversation:v1`;
export const receptionTransferKey = (callId: string) => `callie:${callId}:human-transfer:v1`;
function fallback() { const xml = new twiml.VoiceResponse(); xml.say("The office has your missed call for review. No appointment or emergency dispatch is confirmed. Goodbye."); xml.hangup(); return xml.toString(); }
function empty() { const xml = new twiml.VoiceResponse(); xml.hangup(); return xml.toString(); }
const reasonOf = (error: unknown, unknown = "provider_result_uncertain") => error instanceof CallieReceptionError ? error.code : unknown;

async function audit(tx: Tx, row: Session, action: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEventsTable).values({ organizationId: row.organizationId, action: `callie.reception.${action}`, entityType: "callie_intake", entityId: row.intakeId,
    metadata: { sessionId: row.id, callId: row.callId, ...metadata } });
}
/** Called only by the fresh signed original-call insertion transaction. */
export async function admitCallieReception(tx: Tx, call: Call, signed: TwilioClientBinding) {
  await lockCallieReception(tx, call.organizationId);
  let authority: Awaited<ReturnType<typeof assertReceptionAuthority>>;
  try { authority = await assertReceptionAuthority(call.organizationId, undefined, { reader: tx, at: call.createdAt, lockRows: true }); }
  catch (error) { if (error instanceof CallieReceptionError) return null; throw error; }
  if (call.direction !== "inbound" || call.providerSid === null || call.accountSid !== signed.accountSid || signed.id !== authority.voice.id ||
      authority.voice.accountSid !== call.accountSid || call.createdAt < authority.revision.approvedAt) return null;
  const [intake] = await tx.insert(intakes).values({ organizationId: call.organizationId, callId: call.id, policyRevisionId: authority.revision.id,
    mode: "conversation", bindingId: authority.voice.id, accountSid: call.accountSid, providerCallSid: call.providerSid, fromPhone: call.phone,
    calledNumber: authority.voice.phoneNumber, ownerUserId: authority.ownerUserId, dueAt: new Date(call.createdAt.getTime() + authority.settings.responseMinutes * 60_000) }).onConflictDoNothing().returning();
  if (!intake) return null;
  const [session] = await tx.insert(sessions).values({ organizationId: call.organizationId, intakeId: intake.id, callId: call.id, policyRevisionId: authority.revision.id,
    receptionBindingId: authority.binding.id, agentId: authority.binding.agentId, agentVersionId: authority.binding.agentVersionId, environment: authority.binding.environment,
    contentExpiresAt: new Date(call.createdAt.getTime() + authority.settings.retentionDays * 86400_000) }).returning();
  await audit(tx, session!, "admitted", { policyRevisionId: authority.revision.id, mode: "conversation", messagingPermissionGranted: false, forwardOnly: true });
  return intake;
}

/** Authority rows stay locked until the caller commits its original effect claim. */
export async function assertReceptionSessionCurrent(tx: Tx, org: string, sessionId: string) {
  const [session] = await tx.select().from(sessions).where(sessionWhere(org, sessionId)).for("update");
  if (!session) receptionDeny("session_unavailable", 404);
  const authority = await assertReceptionAuthority(org, session.policyRevisionId, { reader: tx, lockRows: true });
  const [intake] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, org), eq(intakes.id, session.intakeId))).for("update");
  const [call] = await tx.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, session.callId))).for("share");
  if (!intake || intake.mode !== "conversation" || terminalOffice.has(intake.state) || !call || call.direction !== "inbound" ||
      !["busy", "no-answer", "failed", "canceled"].includes(call.dialStatus ?? "") || ended.has(call.status) || call.createdAt < authority.revision.approvedAt ||
      call.providerSid !== intake.providerCallSid || call.accountSid !== intake.accountSid || call.phone !== intake.fromPhone || intake.calledNumber !== authority.voice.phoneNumber ||
      intake.bindingId !== authority.voice.id || intake.accountSid !== authority.voice.accountSid || intake.policyRevisionId !== session.policyRevisionId ||
      authority.binding.id !== session.receptionBindingId || authority.binding.agentId !== session.agentId || authority.binding.agentVersionId !== session.agentVersionId || authority.binding.environment !== session.environment) receptionDeny("original_reception_authority_changed");
  const [handoff] = await tx.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, org), eq(missedCallHandoffsTable.callId, call.id))).for("share");
  const [task] = handoff ? await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, handoff.taskId))).for("share") : [];
  if (!task || !["open", "in_progress"].includes(task.status) || task.assignedUserId !== intake.ownerUserId ||
      intake.ownerUserId !== callieOwnerAt(authority.settings, call.createdAt)) receptionDeny("office_callback_changed");
  // Final claim freezes original staff work. Notes/assignment/progress/deadline
  // are never rewritten by provider or model callbacks.
  return { session, authority, intake, call, task, handoff: handoff!, fingerprint: callieHash({ intakeId: intake.id, intakeVersion: intake.version, taskId: task.id,
    taskUpdatedAt: task.updatedAt.toISOString(), taskStatus: task.status, owner: task.assignedUserId, dueAt: task.dueAt?.toISOString() ?? null,
    policyId: authority.revision.id, binding: authority.snapshot.receptionBinding, voice: authority.snapshot.voiceBinding }) };
}
async function receipt(tx: Tx, row: Session, kind: "registration" | "transfer", fingerprint: string) {
  const actionKey = kind === "registration" ? receptionRegistrationKey(row.callId) : receptionTransferKey(row.callId);
  const [prior] = await tx.select().from(executions).where(and(eq(executions.organizationId, row.organizationId), eq(executions.actionKey, actionKey)));
  if (prior) return null; // Even expired/blocked/attested receipts never grant another effect.
  const [claim] = await tx.insert(executions).values({ organizationId: row.organizationId, actionKey, fingerprint, kind: `callie_reception_${kind}`, state: "processing",
    expiresAt: new Date(Date.now() + 60_000), detail: "Original effect reserved; dispatch not yet started." }).onConflictDoNothing().returning();
  if (!claim) return null;
  await tx.insert(revenueExecutionEventsTable).values({ organizationId: row.organizationId, executionId: claim.id, state: "processing", detail: "Original call-scoped effect reserved." });
  return claim;
}
async function settle(row: Session, kind: "registration" | "transfer", state: "succeeded" | "blocked" | "indeterminate", code: string, extra: Partial<typeof sessions.$inferInsert> = {}) {
  await db.transaction(async tx => {
    await lockCallieReception(tx, row.organizationId);
    const [current] = await tx.select().from(sessions).where(sessionWhere(row.organizationId, row.id)).for("update");
    if (!current) return;
    const receiptId = kind === "registration" ? current.registrationReceiptId : current.transferReceiptId;
    if (!receiptId) return;
    const [changed] = await tx.update(executions).set({ state, detail: code, completedAt: new Date() }).where(and(eq(executions.organizationId, row.organizationId), eq(executions.id, receiptId), eq(executions.state, "processing"))).returning();
    if (!changed) return;
    const fields = kind === "registration" ? { state: state === "succeeded" ? "registered" as const : state, reason: code } : { transferState: state === "succeeded" ? "redirect_accepted" as const : state };
    // Signed provider outcome may beat the REST response. Never move it backward.
    const transferFinal = ["phone_answered", "not_answered", "failed"].includes(current.transferState);
    await tx.update(sessions).set({ ...(kind === "transfer" && transferFinal ? {} : fields), ...extra, updatedAt: new Date() }).where(sessionWhere(row.organizationId, row.id));
    await tx.insert(revenueExecutionEventsTable).values({ organizationId: row.organizationId, executionId: receiptId, state, detail: code });
    await audit(tx, current, `${kind}_${state}`, { code });
  });
}

export async function beginCallieReception(org: string, callId: string): Promise<string | null> {
  // Shared absolute provider budget leaves room for the signed voice response.
  // Slow preparation never starts a fresh five-second POST after this expires.
  const deadlineAt = Date.now() + 12_000;
  const [row] = await db.select().from(sessions).where(and(eq(sessions.organizationId, org), eq(sessions.callId, callId)));
  if (!row) return null;
  const [call] = await db.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, callId)));
  if (call?.dialStatus === "completed") return empty();
  let prepared: { current: Awaited<ReturnType<typeof assertReceptionSessionCurrent>>; claim: typeof executions.$inferSelect; capability: string } | null = null;
  try {
    prepared = await db.transaction(async tx => {
      await lockCallieReception(tx, org);
      const current = await assertReceptionSessionCurrent(tx, org, row.id);
      assertReceptionDeadline(deadlineAt);
      if (current.session.state !== "admitted" || Date.now() - current.call.createdAt.getTime() > 120_000) return null;
      const claim = await receipt(tx, row, "registration", current.fingerprint);
      if (!claim) return null;
      const capability = randomBytes(32).toString("base64url"), now = new Date();
      await tx.update(sessions).set({ state: "registering", reason: "registration_reserved", registrationReceiptId: claim.id, registrationKey: claim.actionKey,
        capabilityHash: callieHash(capability), capabilityExpiresAt: new Date(now.getTime() + current.authority.settings.maxConversationSeconds * 1000), updatedAt: now }).where(sessionWhere(org, row.id));
      await tx.update(intakes).set({ state: "office_pending", stage: "complete", reason: "conversational_reception_started", updatedAt: now }).where(and(eq(intakes.id, current.intake.id), eq(intakes.organizationId, org)));
      return { current, claim, capability };
    });
  } catch (error) {
    if (!(error instanceof CallieReceptionError)) throw error;
    await db.transaction(async tx => { await lockCallieReception(tx, org); await tx.update(sessions).set({ state: "blocked", reason: error.code, updatedAt: new Date() }).where(and(sessionWhere(org, row.id), eq(sessions.state, "admitted"))); });
    return fallback();
  }
  if (!prepared) {
    // Only the invocation that created the original receipt may emit Connect.
    // A signed retry does not authorize another media connection; a lost first
    // response remains office work, never cached TwiML replay.
    return fallback();
  }
  const { current, claim, capability } = prepared;
  let dispatched = false;
  try {
    await preflightReception(org, current.authority.snapshot, deadlineAt);
    await db.transaction(async tx => {
      await lockCallieReception(tx, org);
      const final = await assertReceptionSessionCurrent(tx, org, row.id);
      assertReceptionDeadline(deadlineAt);
      const [owned] = await tx.select().from(executions).where(and(eq(executions.id, claim.id), eq(executions.organizationId, org))).for("update");
      if (final.fingerprint !== current.fingerprint || !owned || owned.state !== "processing" || owned.fingerprint !== current.fingerprint ||
          final.session.registrationReceiptId !== claim.id || final.session.registrationKey !== claim.actionKey || final.session.dispatchStartedAt ||
          final.session.capabilityHash !== callieHash(capability) || !final.session.capabilityExpiresAt || final.session.capabilityExpiresAt <= new Date()) receptionDeny("registration_claim_changed");
      await tx.update(sessions).set({ dispatchStartedAt: new Date(), updatedAt: new Date() }).where(sessionWhere(org, row.id));
    });
    assertReceptionDeadline(deadlineAt);
    dispatched = true;
    const xml = await registerReception(org, current.authority.snapshot, { sessionId: row.id, callSid: current.intake.providerCallSid, from: current.intake.fromPhone, to: current.intake.calledNumber, capability }, deadlineAt);
    await settle(row, "registration", "succeeded", "provider_registration_accepted", { registrationAcceptedAt: new Date() });
    // A revocation committed during provider I/O cannot undo that request, but
    // it can prevent handing its returned media instructions to the caller.
    await db.transaction(async tx => { await lockCallieReception(tx, org); await assertReceptionSessionCurrent(tx, org, row.id); });
    return xml;
  } catch (error) {
    try { await settle(row, "registration", dispatched ? "indeterminate" : "blocked", reasonOf(error, dispatched ? "registration_result_uncertain" : "provider_preflight_failed")); } catch { /* Original processing receipt remains permanently owned. */ }
    return fallback();
  }
}

async function loadCapability(sessionId: string, token: string) {
  if (!z.uuid().safeParse(sessionId).success || !/^[A-Za-z0-9_-]{43}$/.test(token)) receptionDeny("invalid_call_capability", 403);
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session?.capabilityHash || !session.capabilityExpiresAt || session.capabilityExpiresAt <= new Date() ||
      !timingSafeEqual(Buffer.from(session.capabilityHash, "hex"), Buffer.from(callieHash(token), "hex"))) receptionDeny("invalid_call_capability", 403);
  return session;
}
async function writeEvent(tx: Tx, row: Session, eventKey: string, kind: typeof events.$inferInsert.kind, payload: unknown, content: unknown = null) {
  const hash = callieHash(payload), [prior] = await tx.select().from(events).where(and(eq(events.organizationId, row.organizationId), eq(events.sessionId, row.id), eq(events.eventKey, eventKey)));
  if (prior) { if (prior.payloadHash !== hash || prior.kind !== kind) receptionDeny("event_payload_changed"); return false; }
  await tx.insert(events).values({ organizationId: row.organizationId, sessionId: row.id, eventKey, kind, payloadHash: hash,
    contentExpiresAt: row.contentExpiresAt, contentEncrypted: content !== null && row.contentExpiresAt > new Date() ? encryptSecret(JSON.stringify(content), context(row, `event:${eventKey}`)) : null });
  return true;
}
function approvedContext(snapshot: CallieReceptionPolicySnapshot, transferAvailable: boolean) {
  return { businessName: snapshot.voiceBinding!.businessName, businessFacts: snapshot.businessFacts, callerDisclosure: snapshot.callerDisclosure,
    transferAvailable, maxConversationSeconds: snapshot.maxConversationSeconds,
    boundary: "Collect unverified requests only. No identity, warranty, arrival, message or appointment is confirmed." };
}
function targetFor(snapshot: CallieReceptionPolicySnapshot, at: Date) {
  return callieOwnerAt({ ...snapshot, businessHoursOwnerId: "day", afterHoursOwnerId: "night" }, at) === "day" ? snapshot.businessHoursTransferPhone : snapshot.afterHoursTransferPhone;
}
export async function runCallieReceptionTool(sessionId: string, token: string, raw: unknown) {
  const input = callieReceptionToolInputSchema.parse(raw), initial = await loadCapability(sessionId, token);
  if (input.agentId !== initial.agentId || initial.conversationId && initial.conversationId !== input.conversationId) receptionDeny("conversation_identity_changed", 403);
  // Corroboration uses the provider's original Twilio tuple, not caller/model arguments.
  if (!initial.conversationId) {
    if (input.action !== "initialize") receptionDeny("initialize_required");
    await db.transaction(async tx => { await lockCallieReception(tx, initial.organizationId); await assertReceptionSessionCurrent(tx, initial.organizationId, initial.id); });
    const [policy] = await db.select().from(calliePolicyRevisionsTable).where(and(eq(calliePolicyRevisionsTable.organizationId, initial.organizationId), eq(calliePolicyRevisionsTable.id, initial.policyRevisionId)));
    const [intake] = await db.select().from(intakes).where(and(eq(intakes.organizationId, initial.organizationId), eq(intakes.id, initial.intakeId)));
    const snapshot = callieReceptionSnapshotSchema.parse(policy?.snapshot);
    if (!intake) receptionDeny("session_unavailable");
    await verifyReceptionConversation(initial.organizationId, snapshot, { conversationId: input.conversationId, callSid: intake.providerCallSid, from: intake.fromPhone, to: intake.calledNumber });
  }
  const result = await db.transaction(async tx => {
    await lockCallieReception(tx, initial.organizationId);
    const current = await assertReceptionSessionCurrent(tx, initial.organizationId, initial.id), { session, authority } = current;
    if (!session.capabilityExpiresAt || session.capabilityExpiresAt <= new Date() || session.capabilityHash !== callieHash(token) ||
        !["registered", "active"].includes(session.state) || session.conversationId && session.conversationId !== input.conversationId) receptionDeny("call_tool_authority_ended");
    const eventKey = `tool:${input.requestId}`;
    const [prior] = await tx.select().from(events).where(and(eq(events.organizationId, initial.organizationId), eq(events.sessionId, session.id), eq(events.eventKey, eventKey)));
    if (prior) { if (prior.payloadHash !== callieHash(input) || prior.kind !== input.action) receptionDeny("event_payload_changed");
      return { replayed: true, current, handoff: false }; }
    if (session.transferState !== "not_requested") receptionDeny("handoff_already_requested");
    if (session.toolsUsed >= authority.settings.maxToolCalls) receptionDeny("call_tool_limit");
    if (!session.conversationId && input.action !== "initialize") receptionDeny("initialize_required");
    await writeEvent(tx, session, eventKey, input.action, input, input.action === "save_facts" ? input.facts : null);
    const update: Partial<typeof sessions.$inferInsert> = { toolsUsed: session.toolsUsed + 1, updatedAt: new Date() };
    if (!session.conversationId) Object.assign(update, { conversationId: input.conversationId, conversationBoundAt: new Date(), state: "active", reason: "caller_conversation_active" });
    if (input.action === "save_facts") {
      update.factsEncrypted = encryptSecret(JSON.stringify(input.facts), context(session, "facts"));
      // These are requested choices, not staff-verified customer facts. Once staff
      // reviewed the caller, provider text cannot change their booking context.
      if (!current.handoff.reviewedAt) await tx.update(intakes).set({ serviceIntent: input.facts.serviceIntent, requestIntent: input.facts.requestIntent,
        reason: "caller_facts_saved", version: current.intake.version + 1, updatedAt: new Date() }).where(and(eq(intakes.id, current.intake.id), eq(intakes.organizationId, initial.organizationId)));
    }
    await tx.update(sessions).set(update).where(sessionWhere(initial.organizationId, initial.id));
    return { replayed: false, current, handoff: input.action === "request_handoff" };
  });
  if (result.handoff) return { ok: true, action: input.action, replayed: false, transfer: await requestReceptionHandoff(initial.organizationId, initial.id) };
  if (input.action === "request_handoff") return { ok: true, action: input.action, replayed: true, transfer: result.current.session.transferState };
  return { ok: true, action: input.action, replayed: result.replayed,
    ...(input.action === "initialize" ? { context: approvedContext(result.current.authority.snapshot, !!targetFor(result.current.authority.snapshot, result.current.call.createdAt)) } : { saved: true, identityVerified: false, appointmentBooked: false }) };
}

export async function requestReceptionHandoff(org: string, sessionId: string) {
  const prepared = await db.transaction(async tx => {
    await lockCallieReception(tx, org);
    const current = await assertReceptionSessionCurrent(tx, org, sessionId);
    if (current.session.state !== "active" || !current.session.conversationId || !current.session.capabilityExpiresAt || current.session.capabilityExpiresAt <= new Date()) receptionDeny("call_tool_authority_ended");
    if (current.session.transferState !== "not_requested") return null;
    const [request] = await tx.select({ id: events.id }).from(events).where(and(eq(events.organizationId, org), eq(events.sessionId, sessionId), eq(events.kind, "request_handoff"))).limit(1);
    if (!request) receptionDeny("caller_handoff_request_required");
    const target = targetFor(current.authority.snapshot, current.call.createdAt);
    if (!target) receptionDeny("human_handoff_not_configured");
    // A company number or the caller cannot be a staff target. Also refuse any
    // managed inbound number, which is a known forwarding/routing loop.
    const [loop] = await tx.select({ id: twilioClientBindingsTable.id }).from(twilioClientBindingsTable).where(eq(twilioClientBindingsTable.phoneNumber, target)).limit(1);
    if (target === current.intake.fromPhone || target === current.intake.calledNumber || loop) receptionDeny("transfer_loop");
    const fingerprint = callieHash({ authority: current.fingerprint, target, sessionId });
    const claim = await receipt(tx, current.session, "transfer", fingerprint);
    if (!claim) return null;
    await tx.update(sessions).set({ transferState: "claiming", transferReceiptId: claim.id, transferKey: claim.actionKey, transferTarget: target, transferRequestedAt: new Date(), updatedAt: new Date() }).where(sessionWhere(org, sessionId));
    return { current, claim, target, fingerprint };
  });
  if (!prepared) return "original_transfer_retained";
  const { current, claim, target, fingerprint } = prepared; let dispatched = false;
  try {
    await db.transaction(async tx => {
      await lockCallieReception(tx, org);
      const final = await assertReceptionSessionCurrent(tx, org, sessionId);
      const [owned] = await tx.select().from(executions).where(and(eq(executions.organizationId, org), eq(executions.id, claim.id))).for("update");
      if (!owned || owned.state !== "processing" || owned.fingerprint !== fingerprint || callieHash({ authority: final.fingerprint, target: targetFor(final.authority.snapshot, final.call.createdAt), sessionId }) !== fingerprint ||
          final.session.transferReceiptId !== claim.id || final.session.transferKey !== claim.actionKey || final.session.transferTarget !== target || final.session.transferDispatchStartedAt ||
          !final.session.capabilityExpiresAt || final.session.capabilityExpiresAt <= new Date() || final.session.state !== "active") receptionDeny("transfer_claim_changed");
      await tx.update(sessions).set({ transferDispatchStartedAt: new Date(), updatedAt: new Date() }).where(sessionWhere(org, sessionId));
    });
    const xml = new twiml.VoiceResponse(), voice = current.authority.voice;
    xml.say("I will try the office now. If nobody answers, the office still needs to review your request.");
    xml.dial({ answerOnBridge: true, timeout: 20, timeLimit: 300, record: "do-not-record", callerId: voice.phoneNumber,
      action: `${voice.origin}/api/v1/public/voice/reception-transfer?operation=${current.call.id}&session=${sessionId}`, method: "POST" }).number(target);
    xml.hangup();
    dispatched = true;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${voice.accountSid}/Calls/${current.intake.providerCallSid}.json`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${voice.apiKeySid}:${voice.apiKeySecret}`).toString("base64")}` },
      body: new URLSearchParams({ Twiml: xml.toString() }),
    });
    if (!response.ok) throw new Error("transfer_result_uncertain");
    const body = JSON.parse(await boundedProviderText(response, 16_000));
    if (body.sid !== current.intake.providerCallSid || body.account_sid !== voice.accountSid) throw new Error("transfer_identity_uncertain");
    await settle(current.session, "transfer", "succeeded", "twilio_redirect_accepted_not_human_answer", { transferAcceptedAt: new Date() });
    return "redirect_accepted";
  } catch (error) {
    try { await settle(current.session, "transfer", dispatched ? "indeterminate" : "blocked", reasonOf(error)); } catch { /* Never release/rearm the original claim. */ }
    return dispatched ? "indeterminate" : "blocked";
  }
}

/** The original Dial callback is never reused for the distinct handoff Dial. */
export async function acceptReceptionTransferStatus(req: Request) {
  const id = z.uuid().safeParse(req.query.session), callId = z.uuid().safeParse(req.query.operation);
  if (!id.success || !callId.success || Object.keys(req.query).some(key => !["session", "operation"].includes(key))) return false;
  const [session] = await db.select().from(sessions).where(and(eq(sessions.id, id.data), eq(sessions.callId, callId.data)));
  if (!session?.transferDispatchStartedAt || !session.transferTarget || !session.transferReceiptId) return false;
  const [intake] = await db.select().from(intakes).where(and(eq(intakes.organizationId, session.organizationId), eq(intakes.id, session.intakeId)));
  const binding = await twilioForOrganization(session.organizationId);
  if (!intake || !binding || !twilioRequestValid(req, binding, "voice") || req.body.CallSid !== intake.providerCallSid || req.body.AccountSid !== intake.accountSid ||
      req.body.From !== intake.fromPhone || req.body.To !== intake.calledNumber || !/^CA[a-f0-9]{32}$/i.test(req.body.DialCallSid ?? "") || req.body.DialCallSid === intake.providerCallSid ||
      !["completed", "busy", "no-answer", "failed", "canceled"].includes(req.body.DialCallStatus)) return false;
  await db.transaction(async tx => {
    await lockCallieReception(tx, session.organizationId);
    const [current] = await tx.select().from(sessions).where(sessionWhere(session.organizationId, session.id)).for("update");
    if (!current || current.transferChildCallSid && current.transferChildCallSid !== req.body.DialCallSid) receptionDeny("transfer_child_changed");
    if (!await writeEvent(tx, current, "transfer:final", "transfer_status", req.body)) return;
    const state = req.body.DialCallStatus === "completed" ? "phone_answered" : req.body.DialCallStatus === "failed" ? "failed" : "not_answered";
    await tx.update(sessions).set({ transferState: state, transferChildCallSid: req.body.DialCallSid, transferCompletedAt: new Date(), updatedAt: new Date() }).where(sessionWhere(session.organizationId, session.id));
    await audit(tx, current, "transfer_outcome", { state, humanAcceptanceProven: false });
  });
  return true;
}

export async function acceptReceptionPostCall(sessionId: string, raw: Buffer, signature: string) {
  if (!z.uuid().safeParse(sessionId).success || raw.length > 96_000) receptionDeny("invalid_provider_event", 400);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row?.conversationId) receptionDeny("unbound_conversation", 403);
  const [policy] = await db.select().from(calliePolicyRevisionsTable).where(and(eq(calliePolicyRevisionsTable.organizationId, row.organizationId), eq(calliePolicyRevisionsTable.id, row.policyRevisionId)));
  const snapshot = callieReceptionSnapshotSchema.parse(policy?.snapshot), secret = receptionCredentials(row.organizationId, snapshot.receptionBinding!).webhookSecret;
  const parts = /^t=(\d{10}),v0=([a-f0-9]{64})$/.exec(signature);
  if (!secret || !parts || Math.abs(Date.now() / 1000 - Number(parts[1])) > 300) receptionDeny("invalid_provider_signature", 403);
  const expected = createHmac("sha256", secret).update(`${parts[1]}.`).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[2]!, "hex"))) receptionDeny("invalid_provider_signature", 403);
  let payload: any; try { payload = JSON.parse(raw.toString("utf8")); } catch { receptionDeny("invalid_provider_event", 400); }
  if (payload?.type !== "post_call_transcription" || !payload.data) receptionDeny("unsupported_provider_event", 400);
  const [intake] = await db.select().from(intakes).where(and(eq(intakes.organizationId, row.organizationId), eq(intakes.id, row.intakeId)));
  if (!intake || !receptionConversationMatches(payload.data, { ...snapshot.receptionBinding!, conversationId: row.conversationId, callSid: intake.providerCallSid, from: intake.fromPhone, to: intake.calledNumber })) receptionDeny("provider_event_identity_changed", 403);
  const summary = typeof payload.data.analysis?.transcript_summary === "string" ? payload.data.analysis.transcript_summary.slice(0, 1600) : null;
  await db.transaction(async tx => {
    await lockCallieReception(tx, row.organizationId);
    const [current] = await tx.select().from(sessions).where(sessionWhere(row.organizationId, row.id)).for("update");
    if (!current || current.conversationId !== row.conversationId) receptionDeny("provider_event_identity_changed", 403);
    if (!await writeEvent(tx, current, `post_call:${row.conversationId}`, "post_call", raw.toString("utf8"), summary)) return;
    const outcome = !current.factsEncrypted && !summary ? "empty" : payload.data.status === "done" ? "completed" : "interrupted";
    await tx.update(sessions).set({ state: outcome === "completed" ? "completed" : "interrupted", reason: `conversation_${outcome}`, conversationOutcome: outcome,
      summaryEncrypted: summary && current.contentExpiresAt > new Date() ? encryptSecret(summary, context(current, "summary")) : null, endedAt: new Date(), updatedAt: new Date() }).where(sessionWhere(row.organizationId, row.id));
    await audit(tx, current, "conversation_outcome", { outcome, officeWorkCompleted: false });
    // In particular: no UPDATE to intake, task, handoff, contact, lead or appointment.
  });
  return { received: true };
}

/** Provider configuration has one fixed URL; only an already bound conversation selects a secret. */
export async function receiveReceptionPostCall(raw: Buffer, signature: string) {
  if (raw.length > 96_000) receptionDeny("invalid_provider_event", 400);
  let candidate: any; try { candidate = JSON.parse(raw.toString("utf8")); } catch { receptionDeny("invalid_provider_event", 400); }
  const conversation = candidate?.data?.conversation_id, agent = candidate?.data?.agent_id;
  if (typeof conversation !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(conversation) || typeof agent !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(agent)) receptionDeny("unbound_conversation", 403);
  const [session] = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.conversationId, conversation), eq(sessions.agentId, agent)));
  if (!session) receptionDeny("unbound_conversation", 403);
  return acceptReceptionPostCall(session.id, raw, signature);
}

export async function readCallieReceptionEvidence(reader: CallieReader, org: string, intakeId: string) {
  const [row] = await reader.select().from(sessions).where(and(eq(sessions.organizationId, org), eq(sessions.intakeId, intakeId)));
  if (!row) return null;
  const [policy] = await reader.select().from(calliePolicyRevisionsTable).where(and(eq(calliePolicyRevisionsTable.organizationId, org), eq(calliePolicyRevisionsTable.id, row.policyRevisionId)));
  const [receipt] = row.registrationReceiptId ? await reader.select().from(executions).where(and(eq(executions.organizationId, org), eq(executions.id, row.registrationReceiptId))) : [];
  const expired = row.contentExpiresAt <= new Date() || row.contentPurgedAt !== null;
  let facts = null, summary = null;
  if (!expired) {
    try { facts = row.factsEncrypted ? callieReceptionFactsSchema.parse(JSON.parse(decryptSecret(row.factsEncrypted, context(row, "facts")))) : null; } catch { /* Corrupt/missing key never exposes opaque ciphertext. */ }
    try { summary = row.summaryEncrypted ? decryptSecret(row.summaryEncrypted, context(row, "summary")) : null; } catch { /* Report evidence state without private content. */ }
  }
  return callieReceptionEvidenceSchema.parse({ sessionId: row.id, state: row.state, reason: row.reason, toolsUsed: row.toolsUsed,
    maxToolCalls: policy?.snapshot.templateVersion === "callie-conversation.v2" ? policy.snapshot.maxToolCalls : 3,
    registration: { state: receipt?.state ?? null, acceptedAt: row.registrationAcceptedAt?.toISOString() ?? null },
    conversation: { id: row.conversationId, boundAt: row.conversationBoundAt?.toISOString() ?? null, endedAt: row.endedAt?.toISOString() ?? null, outcome: row.conversationOutcome,
      facts, summary, contentExpiresAt: row.contentExpiresAt.toISOString(), contentExpired: expired },
    transfer: { state: row.transferState, requestedAt: row.transferRequestedAt?.toISOString() ?? null, acceptedAt: row.transferAcceptedAt?.toISOString() ?? null,
      childCallSid: row.transferChildCallSid, completedAt: row.transferCompletedAt?.toISOString() ?? null },
    boundary: "Caller statements are unverified. A phone answer is not proof of human acceptance; only office-saved appointments are confirmed." });
}
/** Monitoring never dispatches/rearms anything and never rewrites staff-owned work. */
export async function processCallieReception(org?: string) {
  const rows = await db.select().from(sessions).where(and(org ? eq(sessions.organizationId, org) : undefined,
    or(inArray(sessions.state, ["admitted", "registering", "registered", "active"]), eq(sessions.transferState, "claiming")), lte(sessions.updatedAt, new Date(Date.now() - 60_000)))).orderBy(asc(sessions.updatedAt)).limit(50);
  for (const row of rows) await db.transaction(async tx => {
    await lockCallieReception(tx, row.organizationId);
    const [current] = await tx.select().from(sessions).where(sessionWhere(row.organizationId, row.id)).for("update");
    if (!current || current.updatedAt.getTime() !== row.updatedAt.getTime()) return;
    if (current.transferState === "claiming" && current.transferReceiptId) {
      const state = current.transferDispatchStartedAt ? "indeterminate" : "blocked";
      await tx.update(executions).set({ state, detail: "Original transfer interrupted; no automatic replay.", completedAt: new Date() }).where(and(eq(executions.id, current.transferReceiptId), eq(executions.organizationId, row.organizationId), eq(executions.state, "processing")));
      await tx.update(sessions).set({ transferState: state, updatedAt: new Date() }).where(sessionWhere(row.organizationId, row.id));
      await audit(tx, current, "transfer_interrupted", { state });
    }
    if (current.state === "registering") {
      if (current.registrationReceiptId) await tx.update(executions).set({ state: current.dispatchStartedAt ? "indeterminate" : "blocked", detail: "Original registration interrupted; no automatic replay.", completedAt: new Date() }).where(and(eq(executions.id, current.registrationReceiptId), eq(executions.organizationId, row.organizationId), eq(executions.state, "processing")));
      await tx.update(sessions).set({ state: current.dispatchStartedAt ? "indeterminate" : "blocked", reason: "registration_interrupted", updatedAt: new Date() }).where(sessionWhere(row.organizationId, row.id));
    } else if (["registered", "active"].includes(current.state) && current.capabilityExpiresAt && current.capabilityExpiresAt <= new Date() || current.state === "admitted" && Date.now() - current.createdAt.getTime() > 120_000) {
      await tx.update(sessions).set({ state: "expired", reason: "conversation_window_ended", conversationOutcome: "unknown", updatedAt: new Date() }).where(sessionWhere(row.organizationId, row.id));
    }
  });
}
export async function purgeExpiredCallieReceptionContent() {
  const rows = await db.select().from(sessions).where(and(lte(sessions.contentExpiresAt, new Date()), isNull(sessions.contentPurgedAt))).orderBy(asc(sessions.contentExpiresAt)).limit(100);
  for (const row of rows) await db.transaction(async tx => {
    await lockCallieReception(tx, row.organizationId);
    await tx.update(sessions).set({ factsEncrypted: null, summaryEncrypted: null, capabilityHash: null, capabilityExpiresAt: null, contentPurgedAt: new Date() }).where(and(sessionWhere(row.organizationId, row.id), lte(sessions.contentExpiresAt, new Date())));
    await tx.update(events).set({ contentEncrypted: null, contentPurgedAt: new Date() }).where(and(eq(events.organizationId, row.organizationId), eq(events.sessionId, row.id), lte(events.contentExpiresAt, new Date())));
  });
  return rows.length;
}
