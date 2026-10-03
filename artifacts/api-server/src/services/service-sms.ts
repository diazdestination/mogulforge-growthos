import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { auditEventsTable, contactsTable, db, revenueExecutionsTable, serviceObligationsTable, twilioConsentProofsTable, twilioDispatchesTable, twilioInboundEventsTable, usersTable } from "@workspace/db";
import { serviceSmsParentsTable as parents, serviceSmsRepliesTable as replies } from "../../../../lib/db/src/schema/service-sms";
import { decryptEmailContent, encryptEmailContent } from "../lib/email-content-encryption";
import { hasPermission } from "../lib/permissions";
import { assertOperationalStaff, lockContractorSchedule, type ScheduleTransaction } from "./contractor-scheduling";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { careFingerprint } from "./service-care-policy";
import { assertServiceCareAuthorizationCurrent } from "./service-care-authorization";
import { digest, phoneE164, twilioForOrganization, type TwilioClientBinding } from "./twilio-controls";
import { assertServiceSmsReplyStorageReady, parseServiceSmsReference, serviceSmsReplyQuery, serviceSmsReplyReference, serviceSmsReplyReviewInput, serviceSmsReplySuffix } from "./service-sms-policy";
import { checkSendEligibility } from "./send-gate";

type Reader = typeof db | ScheduleTransaction;
type Parent = typeof parents.$inferSelect;
const parentWhere = (org: string, id: string) => and(eq(parents.organizationId, org), eq(parents.id, id));
const serviceWhere = (org: string, id: string) => and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id));
const MAX_CANDIDATES = 100;
export class ServiceSmsError extends Error {
  constructor(readonly code: string, readonly status = 409) { super("Service SMS evidence needs office review. No customer message, consent change or booking was created."); }
}
function fail(code: string, status = 409): never { throw new ServiceSmsError(code, status); }
/** Also used before the inbound phone dedupe lock; no reverse lock order. */
export async function lockServiceSms(tx: ScheduleTransaction, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx, org);
}
export const serviceSmsBindingFingerprint = (binding: TwilioClientBinding) => careFingerprint({ id: binding.id, accountSid: binding.accountSid,
  phone: binding.phoneNumber, service: binding.messagingServiceSid, disclosure: binding.smsDisclosureVersion, businessName: binding.businessName, origin: binding.origin });
const authorizationFingerprint = (approval: { authorization?: unknown }) => careFingerprint(approval.authorization ?? { origin: "individual" });
async function readerAllowed(reader: Reader, org: string, actor: string) {
  const [user] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  if (!user?.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, "crm.read")) fail("staff_required", 403);
}
async function occurrence(reader: Reader, parent: Parent) {
  const [service] = await reader.select().from(serviceObligationsTable).where(serviceWhere(parent.organizationId, parent.serviceObligationId));
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, parent.organizationId), eq(contactsTable.id, parent.contactId)));
  if (!service || !contact) fail("source_missing");
  const saved = parent.contextSnapshot;
  const historical = service.status !== "active" || service.contactId !== parent.contactId || phoneE164(contact.phone ?? "") !== parent.recipient ||
    service.dueAt.toISOString() !== saved.dueAt || service.occurrenceIndex !== saved.occurrenceIndex || service.createdAt.toISOString() !== saved.createdAt;
  return { service, contact, historical };
}
async function assertParentCurrent(reader: Reader, parent: Parent, options: { lockTask?: boolean } = {}) {
  assertServiceSmsReplyStorageReady();
  const claim = await assertServiceCareAuthorizationCurrent(reader, parent.organizationId, parent.approvalId, parent.scheduledActionId, options);
  const saved = claim.approval.snapshot;
  const current = await occurrence(reader, parent);
  if (current.historical || current.service.updatedAt.toISOString() !== parent.contextSnapshot.updatedAt || claim.obligation.id !== parent.serviceObligationId ||
      saved.contactId !== parent.contactId || saved.channel !== "sms" || saved.recipient !== parent.recipient || digest(saved.body) !== parent.bodySha256 ||
      saved.smsReply?.version !== 1 || saved.smsReply.reference !== parent.reference || authorizationFingerprint(claim.approval) !== parent.authorizationFingerprint) fail("parent_changed");
  if (await hasServiceSmsReplyHold(parent.organizationId, parent.serviceObligationId, reader)) fail("reply_hold");
  const [receipt] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, parent.organizationId), eq(revenueExecutionsTable.id, parent.executionId)));
  if (!receipt || receipt.actionKey !== parent.actionKey || receipt.fingerprint !== parent.executionFingerprint || receipt.state !== "processing" || receipt.expiresAt <= new Date()) fail("execution_not_owned");
  const binding = await twilioForOrganization(parent.organizationId, reader);
  if (!binding?.smsEnabled || binding.id !== parent.bindingId || binding.accountSid !== parent.accountSid || binding.phoneNumber !== parent.sender ||
      binding.messagingServiceSid !== parent.messagingServiceSid || binding.smsDisclosureVersion !== parent.disclosureVersion ||
      serviceSmsBindingFingerprint(binding) !== parent.bindingFingerprint || saved.smsBinding !== parent.bindingFingerprint) fail("sender_changed");
  if (!(await getCustomerLifecycleStatus(parent.organizationId, reader)).automationAllowed) fail("company_held");
  return { claim, binding };
}

export async function reserveServiceSmsParent(input: { organizationId: string; serviceObligationId: string; approvalId: string; scheduledActionId: string; executionFingerprint: string }): Promise<string> {
  assertServiceSmsReplyStorageReady();
  return db.transaction(async tx => {
    await lockServiceSms(tx, input.organizationId);
    const claim = await assertServiceCareAuthorizationCurrent(tx, input.organizationId, input.approvalId, input.scheduledActionId);
    const saved = claim.approval.snapshot, service = claim.obligation;
    const binding = await twilioForOrganization(input.organizationId, tx);
    const actionKey = `scheduled:${input.scheduledActionId}`;
    const [execution] = await tx.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, input.organizationId), eq(revenueExecutionsTable.actionKey, actionKey)));
    if (service.id !== input.serviceObligationId || saved.channel !== "sms" || !binding?.smsEnabled || !binding.messagingServiceSid || !binding.smsDisclosureVersion ||
        saved.smsReply?.version !== 1 || saved.smsReply.reference !== serviceSmsReplyReference(input.organizationId, service.id) ||
        !saved.body.endsWith(serviceSmsReplySuffix(input.organizationId, service.id)) || !execution || execution.fingerprint !== input.executionFingerprint) fail("invalid_parent_claim");
    const [existing] = await tx.select().from(parents).where(and(eq(parents.organizationId, input.organizationId), eq(parents.serviceObligationId, service.id)));
    if (existing) {
      if (existing.approvalId !== input.approvalId || existing.scheduledActionId !== input.scheduledActionId || existing.executionFingerprint !== input.executionFingerprint || existing.dispatchStartedAt) fail("parent_owned");
      await assertParentCurrent(tx, existing); return existing.id;
    }
    const [parent] = await tx.insert(parents).values({ organizationId: input.organizationId, serviceObligationId: service.id, contactId: service.contactId, bindingId: binding.id,
      approvalId: input.approvalId, scheduledActionId: input.scheduledActionId, actionKey, executionId: execution.id, executionFingerprint: input.executionFingerprint,
      authorizationFingerprint: authorizationFingerprint(claim.approval), contextSnapshot: { version: 1, dueAt: service.dueAt.toISOString(), occurrenceIndex: service.occurrenceIndex,
        createdAt: service.createdAt.toISOString(), updatedAt: service.updatedAt.toISOString(), authorizationOrigin: claim.approval.authorization?.origin ?? "individual" },
      reference: saved.smsReply.reference, accountSid: binding.accountSid, sender: binding.phoneNumber, recipient: saved.recipient, messagingServiceSid: binding.messagingServiceSid,
      disclosureVersion: binding.smsDisclosureVersion, bindingFingerprint: serviceSmsBindingFingerprint(binding), bodySha256: digest(saved.body), operationKey: `service-care:${service.id}` }).returning();
    await assertParentCurrent(tx, parent); return parent.id;
  });
}

/** Last transport hook. It claims the exact generic SMS operation before POST. */
export async function assertServiceSmsParentDispatch(input: { parentId: string; organizationId: string; operationId: string; body: string; binding: TwilioClientBinding; consentProofId: string }) {
  try {
    await db.transaction(async tx => {
      await lockServiceSms(tx, input.organizationId);
      const [parent] = await tx.select().from(parents).where(parentWhere(input.organizationId, input.parentId)).for("update");
      if (!parent || parent.dispatchStartedAt || digest(input.body) !== parent.bodySha256 || serviceSmsBindingFingerprint(input.binding) !== parent.bindingFingerprint) fail("parent_dispatch_changed");
      await assertParentCurrent(tx, parent, { lockTask: true });
      const [contact] = await tx.select().from(contactsTable).where(and(eq(contactsTable.organizationId, input.organizationId), eq(contactsTable.id, parent.contactId))).for("share");
      const [proof] = await tx.select().from(twilioConsentProofsTable).where(and(eq(twilioConsentProofsTable.organizationId, input.organizationId), eq(twilioConsentProofsTable.contactId, parent.contactId),
        eq(twilioConsentProofsTable.phone, parent.recipient), eq(twilioConsentProofsTable.purpose, "customer_care"))).orderBy(desc(twilioConsentProofsTable.recordedAt), asc(twilioConsentProofsTable.granted)).limit(1);
      if (!contact || phoneE164(contact.phone ?? "") !== parent.recipient || !proof?.granted || proof.id !== input.consentProofId || proof.disclosureVersion !== parent.disclosureVersion ||
          !(await checkSendEligibility({ organizationId: input.organizationId, contact, channel: "sms", kind: "transactional" }, tx)).ok) fail("consent_changed");
      const [operation] = await tx.select().from(twilioDispatchesTable).where(and(eq(twilioDispatchesTable.organizationId, input.organizationId), eq(twilioDispatchesTable.id, input.operationId))).for("update");
      const message = `${input.binding.businessName}: ${input.body.trim()}\nReply STOP to opt out. HELP for help.`;
      const expectedPayloadHash = digest(JSON.stringify({ phone: parent.recipient, message, purpose: "customer_care", contactId: parent.contactId, accountSid: parent.accountSid, sender: parent.sender }));
      if (!operation || operation.idempotencyKey !== parent.operationKey || operation.contactId !== parent.contactId || operation.phone !== parent.recipient ||
          operation.accountSid !== parent.accountSid || operation.purpose !== "customer_care" || operation.status !== "dispatching" || operation.providerSid || operation.payloadHash !== expectedPayloadHash) fail("operation_mismatch");
      await tx.update(parents).set({ dispatchId: operation.id, dispatchPayloadHash: operation.payloadHash, dispatchStartedAt: new Date() }).where(eq(parents.id, parent.id));
    });
  } catch { throw new EmailDispatchBlockedError(); }
}

const inboundHash = (fields: Record<string, string>) => careFingerprint(fields);
/** Called only AFTER Twilio signature validation; same transaction as the inbound receipt. */
export async function ingestServiceSmsReply(tx: ScheduleTransaction, binding: TwilioClientBinding, fields: Record<string, string>): Promise<boolean> {
  const org = binding.organizationId, phone = phoneE164(fields.From ?? "");
  if (!phone || fields.From !== phone || fields.To !== binding.phoneNumber || fields.AccountSid !== binding.accountSid) fail("signed_envelope_changed", 403);
  const [event] = await tx.select().from(twilioInboundEventsTable).where(and(eq(twilioInboundEventsTable.organizationId, org), eq(twilioInboundEventsTable.messageSid, fields.MessageSid)));
  if (!event || event.eventType !== "message" || event.phone !== phone) fail("inbound_not_owned", 403);
  const [previous] = await tx.select().from(replies).where(and(eq(replies.organizationId, org), eq(replies.messageSid, fields.MessageSid)));
  if (previous) {
    if (previous.payloadSha256 !== inboundHash(fields)) fail("reply_payload_conflict", 403);
    return true;
  }
  const reference = parseServiceSmsReference(fields.Body ?? "");
  const candidates = await tx.select().from(parents).where(and(eq(parents.organizationId, org), eq(parents.bindingId, binding.id), eq(parents.accountSid, binding.accountSid),
    eq(parents.sender, fields.To), eq(parents.recipient, phone), sql`${parents.reservedAt} <= ${event.receivedAt.toISOString()}::timestamptz`))
    .orderBy(desc(parents.reservedAt), desc(parents.id)).limit(MAX_CANDIDATES + 1);
  // No retained service context: leave this in ordinary signed SMS intake.
  // Do not hide unknown handsets in an unreachable service-only inbox.
  if (!candidates.length) return false;
  // An explicit invalid reference NEVER falls back to the newest/only phone match.
  const exact = reference.reference ? await tx.select().from(parents).where(and(eq(parents.organizationId, org), eq(parents.reference, reference.reference),
    eq(parents.bindingId, binding.id), eq(parents.accountSid, binding.accountSid), eq(parents.sender, fields.To), eq(parents.recipient, phone),
    // Number-level inbound hooks may omit this associated-service metadata.
    // Keep its actual absence in the receipt; the retained parent must still
    // match the current exact company binding's program. Supplied mismatches
    // have already failed signature-envelope validation at the route boundary.
    eq(parents.messagingServiceSid, fields.MessagingServiceSid || binding.messagingServiceSid || ""),
    isNotNull(parents.dispatchStartedAt), sql`${parents.dispatchStartedAt} <= ${event.receivedAt.toISOString()}::timestamptz`)).limit(2) : [];
  const parent = exact.length === 1 ? exact[0] : null;
  const current = parent ? await occurrence(tx, parent) : null;
  const id = randomUUID(), historical = current?.historical ?? false;
  const reason = parent ? historical ? "historical_reference" : "exact_reference_review_required" : reference.explicit ? "invalid_or_unmatched_reference" : "missing_reference";
  const visibleCandidates = candidates.slice(0, MAX_CANDIDATES);
  await tx.insert(replies).values({ id, organizationId: org, bindingId: binding.id, messageSid: fields.MessageSid, accountSid: fields.AccountSid, fromNumber: phone,
    toNumber: fields.To, messagingServiceSid: fields.MessagingServiceSid || null, payloadSha256: inboundHash(fields), bodySha256: digest(fields.Body ?? ""),
    parentId: parent?.id ?? null, serviceObligationId: parent?.serviceObligationId ?? null, contactId: parent?.contactId ?? null,
    correlation: parent ? "exact_reference" : "ambiguous", reason, candidateParentIds: parent ? [parent.id] : visibleCandidates.map(row => row.id),
    candidateCount: parent ? 1 : candidates.length, candidatesTruncated: !parent && candidates.length > MAX_CANDIDATES, historical, holdActive: !historical,
    receivedAt: event.receivedAt, encryptedText: encryptEmailContent(JSON.stringify({ text: (fields.Body ?? "").slice(0, 1600) }), `${org}:${id}:service-sms-reply`),
    rawExpiresAt: new Date(Date.now() + 7 * 86_400_000) });
  // Remove the duplicate raw inbox copy; the bounded encrypted evidence is the
  // only new storage of service-message content. The generic receipt remains.
  await tx.update(twilioInboundEventsTable).set({ body: null }).where(and(eq(twilioInboundEventsTable.organizationId, org), eq(twilioInboundEventsTable.messageSid, fields.MessageSid)));
  await tx.insert(auditEventsTable).values({ organizationId: org, action: "service.sms_reply_received", entityType: parent ? "service_obligation" : "service_sms_reply", entityId: parent?.serviceObligationId ?? id,
    metadata: { replyId: id, parentId: parent?.id ?? null, correlation: parent ? "exact_reference" : "ambiguous", historical, noBookingCreated: true, noConsentGranted: true, uncertainExecutionPreserved: true } });
  // MAINTAIN reconciles a typed exception against the existing office task.
  // Never reopen completed work, overwrite its assignee or erase a staff plan.
  return true;
}

/** Duplicate validation is read-only, including after raw evidence is purged. */
export async function assertServiceSmsReplay(reader: Reader, org: string, fields: Record<string, string>) {
  const [reply] = await reader.select().from(replies).where(and(eq(replies.organizationId, org), eq(replies.messageSid, fields.MessageSid)));
  if (reply && reply.payloadSha256 !== inboundHash(fields)) fail("reply_payload_conflict", 403);
}
function visibleReply(org: string, id: string, phone: string | null) {
  return and(eq(replies.organizationId, org), or(eq(replies.serviceObligationId, id), phone ? and(eq(replies.correlation, "ambiguous"), eq(replies.fromNumber, phone)) : undefined));
}
export async function serviceSmsReplyFacts(org: string, id: string, reader: Reader = db) {
  const [service] = await reader.select().from(serviceObligationsTable).where(serviceWhere(org, id));
  if (!service || service.status !== "active") return null;
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, service.contactId)));
  const phone = phoneE164(contact?.phone ?? "");
  const [row] = await reader.select({ id: replies.id, version: replies.version, state: replies.state, holdActive: replies.holdActive,
    recordedAt: replies.recordedAt, correlation: replies.correlation }).from(replies)
    .leftJoin(parents, and(eq(parents.organizationId, org), eq(parents.id, replies.parentId)))
    .where(and(eq(replies.organizationId, org), eq(replies.holdActive, true), eq(replies.historical, false), phone ? or(
      and(eq(replies.correlation, "ambiguous"), eq(replies.fromNumber, phone)),
      and(eq(replies.correlation, "exact_reference"), eq(replies.serviceObligationId, id), eq(parents.contactId, service.contactId), eq(parents.recipient, phone),
        sql`${parents.contextSnapshot}->>'dueAt' = ${service.dueAt.toISOString()}`,
        sql`(${parents.contextSnapshot}->>'occurrenceIndex')::int = ${service.occurrenceIndex}`,
        sql`${parents.contextSnapshot}->>'createdAt' = ${service.createdAt.toISOString()}`),
    ) : sql`false`))
    .orderBy(sql`case when ${replies.state} = 'needs_review' then 0 else 1 end`, desc(replies.recordedAt), desc(replies.id)).limit(1);
  return row ?? null;
}
export async function hasServiceSmsReplyHold(org: string, id: string, reader: Reader = db) { return !!await serviceSmsReplyFacts(org, id, reader); }

async function servicePhone(reader: Reader, org: string, id: string) {
  const [service] = await reader.select().from(serviceObligationsTable).where(serviceWhere(org, id));
  if (!service) fail("not_found", 404);
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, service.contactId)));
  return { service, phone: phoneE164(contact?.phone ?? "") };
}
export async function listServiceSmsReplies(org: string, actor: string, id: string, raw: unknown = {}) {
  await readerAllowed(db, org, actor); const query = serviceSmsReplyQuery.parse(raw);
  const { phone } = await servicePhone(db, org, id);
  const rows = await db.select().from(replies).where(visibleReply(org, id, phone)).orderBy(desc(replies.recordedAt), desc(replies.id)).limit(26).offset(query.offset);
  const items = await Promise.all(rows.slice(0, 25).map(async row => {
    let content: { text: string } | null = null;
    if (row.encryptedText && row.rawExpiresAt > new Date()) { try { const parsed = JSON.parse(decryptEmailContent(row.encryptedText, `${org}:${row.id}:service-sms-reply`)); if (typeof parsed.text === "string") content = { text: parsed.text }; } catch { /* Identity and hold outlive unavailable content. */ } }
    const [parent] = row.parentId ? await db.select().from(parents).where(parentWhere(org, row.parentId)) : [];
    const historical = row.historical || (!!parent && (await occurrence(db, parent)).historical);
    const candidates = row.candidateParentIds.length ? await db.select({ serviceId: parents.serviceObligationId }).from(parents).where(and(eq(parents.organizationId, org), inArray(parents.id, row.candidateParentIds))) : [];
    return { id: row.id, serviceObligationId: row.serviceObligationId, version: row.version, state: row.state, correlation: row.correlation, reason: row.reason,
      historical, holdActive: row.holdActive && !historical, receivedAt: row.receivedAt.toISOString(), recordedAt: row.recordedAt.toISOString(), rawExpiresAt: row.rawExpiresAt.toISOString(), content,
      reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewNote: row.reviewNote, evidence: row.correlation === "exact_reference" ? "signed_sms_reference" as const : "signed_sms_phone_scope" as const,
      candidateServiceObligationIds: candidates.map(value => value.serviceId), candidateCount: row.candidateCount, candidatesTruncated: row.candidatesTruncated };
  }));
  return { items, hasMore: rows.length > 25, offset: query.offset, limit: 25, held: !(await getCustomerLifecycleStatus(org)).automationAllowed };
}
export async function reviewServiceSmsReply(org: string, actor: string, serviceId: string, replyId: string, raw: unknown) {
  const command = serviceSmsReplyReviewInput.parse(raw), fingerprint = careFingerprint({ actor, serviceId, replyId, ...command });
  return db.transaction(async tx => {
    await lockServiceSms(tx, org); await readerAllowed(tx, org, actor); await assertOperationalStaff(tx, org, [actor]);
    if (!(await getCustomerLifecycleStatus(org, tx)).automationAllowed) fail("company_held");
    const { phone } = await servicePhone(tx, org, serviceId);
    const [reply] = await tx.select().from(replies).where(and(visibleReply(org, serviceId, phone), eq(replies.id, replyId))).for("update");
    if (!reply) fail("not_found", 404);
    if (reply.reviewRequestId === command.requestId) { if (reply.reviewFingerprint !== fingerprint) fail("request_changed"); return { replyId, version: reply.version, replayed: true }; }
    if (reply.version !== command.expectedVersion || reply.state === "dismissed" ||
        (reply.state === "reviewed" && (!reply.holdActive || command.decision === "office_follow_up"))) fail("stale_review");
    const dismissed = command.decision === "not_service_reply";
    const released = dismissed || command.decision === "handled";
    await tx.update(replies).set({ state: dismissed ? "dismissed" : "reviewed", holdActive: !released && reply.holdActive, version: reply.version + 1,
      reviewedByUserId: actor, reviewedAt: new Date(), reviewNote: command.note, reviewRequestId: command.requestId, reviewFingerprint: fingerprint }).where(eq(replies.id, reply.id));
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "service.sms_reply_reviewed", entityType: "service_obligation", entityId: serviceId,
      metadata: { replyId, requestId: command.requestId, requestFingerprint: fingerprint, decision: command.decision, version: reply.version + 1, correlation: reply.correlation, note: command.note,
        serviceSmsHoldReleased: released, futureSeparatelyApprovedRemindersMayResume: released && reply.correlation === "ambiguous", noBookingCreated: true, noConsentChanged: true, noSendRearmed: true } });
    return { replyId, version: reply.version + 1, replayed: false };
  });
}
export async function purgeExpiredServiceSmsReplyContent(now = new Date()) {
  const expired = await db.select({ id: replies.id }).from(replies).where(and(lt(replies.rawExpiresAt, now), isNotNull(replies.encryptedText))).orderBy(asc(replies.rawExpiresAt), asc(replies.id)).limit(100);
  if (!expired.length) return 0;
  return (await db.update(replies).set({ encryptedText: null, rawPurgedAt: now }).where(and(inArray(replies.id, expired.map(row => row.id)), lt(replies.rawExpiresAt, now), isNotNull(replies.encryptedText))).returning({ id: replies.id })).length;
}
