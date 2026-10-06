import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { twiml } from "twilio";
import {
  auditEventsTable, callieIntakesTable as intakes, contactsTable, crmTasksTable, db,
  missedCallCareCasesTable, missedCallHandoffsTable, suppressionsTable, twilioCallsTable,
  type CalliePolicySnapshot, type CallieStage, type CallieStepReceipt,
} from "@workspace/db";
import { decryptSecret, encryptSecret } from "../lib/token-encryption";
import { assertCallieCurrentAuthority, CallieError, currentCallieRevision, lockCallie } from "./callie-policy";
import { CALLIE_CHALLENGE_MS, CALLIE_GRANT_MS, CALLIE_VOICE_MS, callieChallengeCode, callieChallengeHash, callieTriggerHash } from "./callie-contract";
import { isMissedInbound } from "./missed-call-care-policy";
import { normalizePhone } from "./send-gate";
import type { TwilioClientBinding } from "./twilio-controls";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Intake = typeof intakes.$inferSelect;
type Call = typeof twilioCallsTable.$inferSelect;
const finishedStates = new Set(["resolved", "cancelled", "booked"]);
const endedCalls = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const responseContext = (row: Intake, stage: CallieStage, version: number) => `callie:${row.organizationId}:${row.id}:response:${stage}:${version}`;
const challengeContext = (row: Intake) => `callie:${row.organizationId}:${row.id}:challenge`;
const hangup = (message?: string) => {
  const xml = new twiml.VoiceResponse();
  if (message) xml.say(message);
  xml.hangup();
  return xml.toString();
};
const fallback = () => hangup("Your missed call remains with the office for review. No text or appointment is confirmed. Goodbye.");
const safeReason = (error: CallieError) => error.code.slice(0, 100);

async function event(tx: Tx, row: Intake, action: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEventsTable).values({ organizationId: row.organizationId, action: `callie.${action}`, entityType: "twilio_call", entityId: row.callId, metadata: { intakeId: row.id, ...metadata } });
}
async function task(tx: Tx, row: Intake, description: string, claimInitialOwner = false) {
  const [handoff] = await tx.select().from(missedCallHandoffsTable)
    .where(and(eq(missedCallHandoffsTable.organizationId, row.organizationId), eq(missedCallHandoffsTable.callId, row.callId)));
  if (!handoff) return false;
  const originalOpenTask = and(eq(crmTasksTable.organizationId, row.organizationId), eq(crmTasksTable.id, handoff.taskId), sql`${crmTasksTable.status} in ('open','in_progress')`);
  // Only the first qualified handoff may adopt its still-unassigned original
  // task. A human assignment, unassignment or completed task is never undone
  // by a later provider callback, including a callback that fails a guard.
  if (claimInitialOwner && row.state === "admitted" && row.stage === "admitted") {
    await tx.update(crmTasksTable).set({ assignedUserId: row.ownerUserId })
      .where(and(originalOpenTask, isNull(crmTasksTable.assignedUserId)));
  }
  const [updated] = await tx.update(crmTasksTable).set({ dueAt: row.dueAt, priority: "high", description })
    .where(and(originalOpenTask, eq(crmTasksTable.assignedUserId, row.ownerUserId))).returning({ id: crmTasksTable.id });
  return Boolean(updated);
}
async function block(tx: Tx, row: Intake, reason: string) {
  await tx.update(intakes).set({ state: "blocked", stage: "complete", version: row.version + 1, reason, updatedAt: new Date() }).where(and(eq(intakes.id, row.id), eq(intakes.version, row.version)));
  await task(tx, row, `CALLIE needs office review: ${reason}. Caller identity is unverified. No appointment or emergency dispatch is confirmed.`);
  await event(tx, row, "intake_held", { reason });
}

/** Must run ONLY in the transaction that inserted a genuinely new signed inbound call. */
export async function admitCallieIntake(tx: Tx, call: Call, signedBinding: TwilioClientBinding) {
  if (call.direction !== "inbound" || !call.providerSid || call.organizationId !== signedBinding.organizationId || call.accountSid !== signedBinding.accountSid) return null;
  if ((await currentCallieRevision(call.organizationId, tx))?.snapshot.templateVersion === "callie-conversation.v2") {
    const { admitCallieReception } = await import("./callie-reception-runtime");
    return admitCallieReception(tx, call, signedBinding);
  }
  await lockCallie(tx, call.organizationId);
  let authority: Awaited<ReturnType<typeof assertCallieCurrentAuthority>>;
  try {
    authority = await assertCallieCurrentAuthority(call.organizationId, undefined, { reader: tx, at: call.createdAt, requireSms: true });
  } catch (error) {
    if (error instanceof CallieError) return null;
    throw error;
  }
  if (authority.binding.id !== signedBinding.id || authority.binding.accountSid !== call.accountSid || authority.binding.phoneNumber !== signedBinding.phoneNumber || authority.binding.origin !== signedBinding.origin) return null;
  // An absent encryption key means there is no safe replay store. Do not start a flow that cannot finish.
  try { encryptSecret("configuration-check", `callie:${call.organizationId}:admission`); }
  catch { return null; }
  const [row] = await tx.insert(intakes).values({
    organizationId: call.organizationId, callId: call.id, policyRevisionId: authority.revision.id,
    bindingId: authority.binding.id, accountSid: call.accountSid, providerCallSid: call.providerSid,
    fromPhone: call.phone, calledNumber: authority.binding.phoneNumber,
    ownerUserId: authority.ownerUserId, dueAt: new Date(call.createdAt.getTime() + authority.snapshot.responseMinutes * 60_000),
  }).onConflictDoNothing().returning();
  if (row) await event(tx, row, "admitted", { policyRevisionId: row.policyRevisionId, ownerUserId: row.ownerUserId, customerMessageSent: false });
  return row ?? null;
}

function gather(row: Intake, snapshot: CalliePolicySnapshot, stage: Exclude<CallieStage, "admitted" | "complete">, version: number) {
  const xml = new twiml.VoiceResponse();
  // Speak the full optional disclosure before enabling keypad barge-in.
  if (stage === "consent") xml.say(snapshot.prompts.disclosure);
  xml.gather({ input: ["dtmf"], numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: "POST",
    action: `${snapshot.binding!.origin}/api/v1/public/voice/care-gather?operation=${row.callId}&stage=${stage}&version=${version}`,
  }).say(snapshot.prompts[stage]);
  xml.hangup();
  return xml.toString();
}
function receipt(row: Intake, stage: CallieStage, version: number, digit: string, response: string): CallieStepReceipt {
  return { stage, version, digit, at: new Date().toISOString(), responseEncrypted: encryptSecret(response, responseContext(row, stage, version)) };
}
async function current(tx: Tx, row: Intake) {
  const [call] = await tx.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, row.organizationId), eq(twilioCallsTable.id, row.callId)));
  if (!call || call.accountSid !== row.accountSid || call.providerSid !== row.providerCallSid || call.phone !== row.fromPhone || call.direction !== "inbound") throw new CallieError("call_identity_changed");
  const authority = await assertCallieCurrentAuthority(row.organizationId, row.policyRevisionId, { reader: tx, at: call.createdAt, requireSms: true });
  if (authority.binding.id !== row.bindingId || authority.binding.phoneNumber !== row.calledNumber || authority.ownerUserId !== row.ownerUserId) throw new CallieError("call_authority_changed");
  const [care] = await tx.select({ state: missedCallCareCasesTable.state }).from(missedCallCareCasesTable)
    .where(and(eq(missedCallCareCasesTable.organizationId, row.organizationId), eq(missedCallCareCasesTable.callId, row.callId)));
  if (care && ["resolved", "cancelled"].includes(care.state)) throw new CallieError("call_already_handled");
  const [handoff] = await tx.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, row.organizationId), eq(missedCallHandoffsTable.callId, row.callId)));
  // Generic CRM task writers do not hold CALLIE's advisory lock. Freeze the
  // original assignment/status through the stage or SMS-grant transaction.
  const [callback] = handoff ? await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, row.organizationId), eq(crmTasksTable.id, handoff.taskId))).for("update") : [];
  const initialUnassigned = row.state === "admitted" && row.stage === "admitted" && callback?.assignedUserId === null;
  if (!callback || !["open", "in_progress"].includes(callback.status) || (!initialUnassigned && callback.assignedUserId !== row.ownerUserId)) throw new CallieError("office_callback_changed");
  return { call, ...authority };
}

/** Returns null only for a legacy call that was never admitted. Never admits historical calls. */
export async function beginCallieMissedIntake(org: string, callId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await lockCallie(tx, org);
    const [row] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, org), eq(intakes.callId, callId))).for("update");
    if (!row || row.mode !== "keypad") return null;
    if (finishedStates.has(row.state)) return hangup();
    const [call] = await tx.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, org), eq(twilioCallsTable.id, callId)));
    if (!call || !isMissedInbound(call)) {
      if (call?.dialStatus === "completed" && row.state === "admitted") await tx.update(intakes).set({ state: "cancelled", stage: "complete", version: row.version + 1, reason: "staff_connected", resolvedAt: new Date(), updatedAt: new Date() }).where(eq(intakes.id, row.id));
      return hangup();
    }
    let authority: Awaited<ReturnType<typeof current>>;
    try { authority = await current(tx, row); }
    catch (error) {
      if (!(error instanceof CallieError)) throw error;
      if (row.state === "admitted") await block(tx, row, safeReason(error));
      return fallback();
    }
    if (endedCalls.has(call.status) || Date.now() - call.createdAt.getTime() > CALLIE_VOICE_MS) {
      if (row.state === "admitted") await block(tx, row, "voice_intake_expired");
      return fallback();
    }
    const prior = row.stepReceipts.find((item) => item.stage === "admitted" && item.version === 1);
    if (prior) return decryptSecret(prior.responseEncrypted, responseContext(row, prior.stage, prior.version));
    if (row.stage !== "admitted" || row.state !== "admitted") return hangup();
    const xml = gather(row, authority.snapshot, "service", row.version + 1);
    if (!await task(tx, row, "CALLIE is collecting caller-supplied service and callback preferences. Caller identity remains unverified. Review Calls; no appointment or emergency dispatch is confirmed.", true)) {
      await block(tx, row, "office_callback_changed"); return fallback();
    }
    await tx.update(intakes).set({ state: "collecting", stage: "service", version: row.version + 1, stepReceipts: [receipt(row, "admitted", row.version, "", xml)], reason: "caller_qualification_started", updatedAt: new Date() }).where(eq(intakes.id, row.id));
    await event(tx, row, "qualification_started", { customerMessageSent: false });
    return xml;
  });
}

export async function handleCallieGather(org: string, callId: string, stage: CallieStage, version: number, digit: string) {
  return db.transaction(async (tx) => {
    await lockCallie(tx, org);
    const [row] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, org), eq(intakes.callId, callId))).for("update");
    if (!row || row.mode !== "keypad" || finishedStates.has(row.state)) return hangup();
    let authority: Awaited<ReturnType<typeof current>>;
    try { authority = await current(tx, row); }
    catch (error) {
      if (!(error instanceof CallieError)) throw error;
      if (row.state === "collecting") await block(tx, row, safeReason(error));
      return fallback();
    }
    if (!isMissedInbound(authority.call) || endedCalls.has(authority.call.status) || Date.now() - authority.call.createdAt.getTime() > CALLIE_VOICE_MS) return fallback();
    const prior = row.stepReceipts.find((item) => item.stage === stage && item.version === version);
    if (prior) return prior.digit === digit ? decryptSecret(prior.responseEncrypted, responseContext(row, stage, version)) : hangup();
    if (row.state !== "collecting" || row.stage !== stage || row.version !== version) return hangup();
    const nextVersion = row.version + 1;
    const update: Partial<typeof intakes.$inferInsert> = { version: nextVersion, updatedAt: new Date() };
    let response: string;
    if (stage === "service" && /^[1-4]$/.test(digit)) {
      update.serviceIntent = (["repair", "replacement", "maintenance", "other"] as const)[Number(digit) - 1];
      update.stage = "request"; response = gather(row, authority.snapshot, "request", nextVersion);
    } else if (stage === "request" && /^[12]$/.test(digit)) {
      update.requestIntent = digit === "1" ? "callback" : "visit";
      update.stage = "window"; response = gather(row, authority.snapshot, "window", nextVersion);
    } else if (stage === "window" && /^[1-3]$/.test(digit)) {
      update.callbackWindow = (["morning", "afternoon", "any"] as const)[Number(digit) - 1];
      update.stage = "consent"; response = gather(row, authority.snapshot, "consent", nextVersion);
    } else if (stage === "consent" && digit === "1") {
      const code = randomInt(100_000_000).toString().padStart(8, "0");
      update.challengeHash = callieChallengeHash(code); update.challengeEncrypted = encryptSecret(code, challengeContext(row));
      update.challengeExpiresAt = new Date(Date.now() + CALLIE_CHALLENGE_MS);
      update.state = "awaiting_sms"; update.stage = "complete"; update.reason = "caller_sms_request_pending";
      response = hangup(authority.snapshot.prompts.instructions.replace("{{code}}", code.split("").join(" ")).replace("{{sender}}", row.calledNumber.replace(/\D/g, "").split("").join(" ")));
    } else {
      update.state = "blocked"; update.stage = "complete";
      update.reason = stage === "consent" && digit === "0" ? "caller_declined_text" : digit === "" ? "caller_no_input" : "caller_invalid_input";
      response = fallback();
    }
    update.stepReceipts = [...row.stepReceipts, receipt(row, stage, version, digit, response)];
    const [updated] = await tx.update(intakes).set(update).where(and(eq(intakes.id, row.id), eq(intakes.version, version))).returning();
    if (!updated) return hangup();
    await task(tx, updated, `Caller-supplied request: ${updated.serviceIntent ?? "not selected"}; ${updated.requestIntent ?? "not selected"}; callback preference ${updated.callbackWindow ?? "not selected"}. ${updated.reason}. Caller identity is unverified. No appointment or emergency dispatch is confirmed.`);
    await event(tx, row, "qualification_step", { stage, selection: digit || "none", nextStage: updated.stage, nextVersion, customerMessageSent: false });
    return response;
  });
}

export interface CallieSmsInput { binding: TwilioClientBinding; phone: string; messageSid: string; text: string; fields: Record<string, string> }
/** Called inside signed inbound SMS event insertion: proof + exact trigger event commit together. */
export async function consumeCallieSms(tx: Tx, input: CallieSmsInput) {
  const code = callieChallengeCode(input.text);
  if (!code) return false;
  const org = input.binding.organizationId;
  await lockCallie(tx, org);
  const [row] = await tx.select().from(intakes).where(and(eq(intakes.organizationId, org), eq(intakes.fromPhone, input.phone), eq(intakes.challengeHash, callieChallengeHash(code)))).for("update");
  if (!row || row.mode !== "keypad" || row.state !== "awaiting_sms" || row.stage !== "complete" || row.triggerMessageSid || !row.challengeExpiresAt || row.challengeExpiresAt.getTime() <= Date.now()) return false;
  if (input.fields.AccountSid !== row.accountSid || input.fields.From !== row.fromPhone || input.fields.To !== row.calledNumber || input.fields.MessageSid !== input.messageSid || input.binding.id !== row.bindingId) return false;
  try {
    const authority = await current(tx, row);
    // A normal hangup after hearing the code is expected. It is not a new voice admission.
    if (!isMissedInbound(authority.call) || ["failed", "busy", "no-answer", "canceled"].includes(authority.call.status)) return false;
  } catch (error) {
    if (!(error instanceof CallieError)) throw error;
    await block(tx, row, safeReason(error)); return false;
  }
  const [suppressed] = await tx.select({ id: suppressionsTable.id }).from(suppressionsTable).where(and(eq(suppressionsTable.organizationId, org), eq(suppressionsTable.channel, "sms"), eq(suppressionsTable.value, normalizePhone(input.phone))));
  const matches = await tx.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') in (${input.phone.slice(1)}, ${input.phone.slice(2)})`));
  if (suppressed || matches.some((contact) => contact.doNotContact || contact.doNotContactSms)) {
    await block(tx, row, "phone_contact_policy_blocks_text"); return false;
  }
  const now = new Date();
  const [confirmed] = await tx.update(intakes).set({ state: "confirmed", version: row.version + 1,
    triggerMessageSid: input.messageSid, triggerAccountSid: input.fields.AccountSid,
    triggerFrom: input.fields.From, triggerTo: input.fields.To,
    triggerPayloadHash: callieTriggerHash({ accountSid: input.fields.AccountSid, from: input.fields.From, to: input.fields.To, messageSid: input.messageSid, bodyHash: row.challengeHash! }),
    confirmedAt: now, grantExpiresAt: new Date(now.getTime() + CALLIE_GRANT_MS), ackDueAt: now,
    reason: "one_call_acknowledgment_requested", updatedAt: now,
  }).where(and(eq(intakes.id, row.id), eq(intakes.version, row.version), eq(intakes.state, "awaiting_sms"))).returning();
  if (!confirmed) return false;
  await event(tx, confirmed, "one_call_sms_requested", { policyRevisionId: confirmed.policyRevisionId, triggerMessageSid: input.messageSid, proof: "signed_matching_handset_message", reusableConsentGranted: false, identityVerified: false, customerMessageSent: false });
  await task(tx, confirmed, `Caller-supplied ${confirmed.serviceIntent} request: ${confirmed.requestIntent}; callback preference ${confirmed.callbackWindow}. The caller requested one acknowledgment from the calling phone. Identity remains unverified; no appointment is confirmed.`);
  return true;
}
