import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { auditEventsTable, contactsTable, crmTasksTable, db, revenueExecutionsTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { mailboxCommunicationParentsTable as parents, mailboxServiceRepliesTable as replies } from "../../../../lib/db/src/schema/mailbox-communication";
import { decryptEmailContent, encryptEmailContent } from "../lib/email-content-encryption";
import { hasPermission } from "../lib/permissions";
import { assertOperationalStaff, lockContractorSchedule, type ScheduleTransaction } from "./contractor-scheduling";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { MAILBOX_HEADER, MAILBOX_MAX_BODY, mailboxDigest, type MailboxIdentity } from "./mailbox-contract";

type Reader = typeof db | ScheduleTransaction;
type Parent = typeof parents.$inferSelect;
type Message = { to: string; subject: string; body: string };
const email = z.email().max(254).transform(value => value.trim().toLowerCase());
const boundedId = z.string().trim().min(1).max(1024).refine(value => !/[\r\n]/.test(value));
const rfcId = boundedId.refine(value => value.length <= 998 && /^<[^<>\s]+@[^<>\s]+>$/.test(value));
const date = z.date().refine(value => Number.isFinite(value.getTime()) && value.getTime() <= Date.now() + 60_000);
const sentSchema = z.object({ correlationHeader: z.string().regex(/^[a-f0-9]{64}$/), providerMessageId: boundedId, internetMessageId: rfcId,
  from: email, to: z.array(email).min(1).max(25), subject: z.string().max(1000), sentAt: date, bodyHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const replySchema = z.object({ providerMessageId: boundedId, internetMessageId: rfcId, inReplyTo: z.array(rfcId).min(1).max(25),
  from: email, to: z.array(email).min(1).max(25), subject: z.string().max(1000), text: z.string().refine(value => Buffer.byteLength(value, "utf8") <= MAILBOX_MAX_BODY), receivedAt: date, sentAt: date.nullable() }).strict();
export const serviceReplyReviewInput = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().positive(), decision: z.enum(["office_follow_up", "not_customer_reply"]), note: z.string().trim().min(10).max(1000), reviewed: z.literal(true) }).strict();
export const serviceReplyQuery = z.object({ offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict();

export class MailboxCommunicationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super("The service reply evidence needs review. Refresh the saved record; no customer message or booking was created."); }
}
function fail(code: string, status = 409): never { throw new MailboxCommunicationError(code, status); }
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const mailboxContentHash = (message: Message) => mailboxDigest({ to: message.to.trim().toLowerCase(), subject: message.subject, body: message.body });
const parentWhere = (org: string, id: string) => and(eq(parents.organizationId, org), eq(parents.id, id));
const serviceWhere = (org: string, id: string) => and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id));
const identityFor = (parent: Parent): MailboxIdentity => ({ organizationId: parent.organizationId, senderUserId: parent.senderUserId, provider: "microsoft", connectionId: parent.connectionId,
  connectionRevision: parent.connectionRevision, mailboxAccountId: parent.mailboxAccountId, mailboxEmail: parent.mailboxEmail,
  connectorId: parent.connectorId, connectorVersion: parent.connectorVersion, policyVersion: parent.policyVersion, startedAt: parent.connectorStartedAt });
function sameIdentity(parent: Parent, identity: MailboxIdentity) { return parent.provider === identity.provider && mailboxDigest(identityFor(parent)) === mailboxDigest(identity); }
async function currentIdentity(identity: MailboxIdentity, reader: Reader = db) {
  const { assertMailboxIdentityCurrent } = await import("./mailbox-connector");
  await assertMailboxIdentityCurrent(identity, reader);
}
async function lock(tx: ScheduleTransaction, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx, org);
}
async function activeCompany(reader: Reader, org: string) { if (!(await getCustomerLifecycleStatus(org, reader)).automationAllowed) fail("company_held"); }
async function readerAllowed(reader: Reader, org: string, actor: string) {
  const [user] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  if (!user?.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, "crm.read")) fail("staff_required", 403);
}
async function executionCurrent(reader: Reader, parent: Parent) {
  const [receipt] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, parent.organizationId), eq(revenueExecutionsTable.actionKey, parent.actionKey)));
  if (!receipt || receipt.state !== "processing" || receipt.expiresAt <= new Date() || receipt.fingerprint !== parent.executionFingerprint) fail("execution_not_owned");
}
async function exactService(reader: Reader, parent: Parent, dispatch = false) {
  if (!parent.serviceObligationId) fail("unsupported_context");
  const [service] = await reader.select().from(serviceObligationsTable).where(serviceWhere(parent.organizationId, parent.serviceObligationId));
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, parent.organizationId), eq(contactsTable.id, parent.contactId)));
  if (!service || !contact) fail("context_missing");
  const snapshot = parent.contextSnapshot;
  const historical = service.status !== "active" || service.contactId !== parent.contactId || contact.email?.trim().toLowerCase() !== parent.recipient ||
    service.dueAt.toISOString() !== snapshot.dueAt || service.occurrenceIndex !== snapshot.occurrenceIndex || service.createdAt.toISOString() !== snapshot.createdAt;
  if (dispatch && (historical || service.updatedAt.toISOString() !== snapshot.updatedAt || await hasServiceMailboxReplyHold(parent.organizationId, service.id, reader))) fail("service_changed_or_reply_held");
  return { service, contact, historical };
}

/** Internal only: caller supplies the exact already-approved scheduled receipt, never HTTP context. */
export async function reserveServiceMailboxParent(input: { identity: MailboxIdentity; serviceObligationId: string; contactId: string; approvalId: string; scheduledActionId: string; expectedUpdatedAt: string; executionFingerprint: string; message: Message }) {
  const { identity, message } = input;
  email.parse(message.to);
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId); await currentIdentity(identity, tx);
    const [service] = await tx.select().from(serviceObligationsTable).where(serviceWhere(identity.organizationId, input.serviceObligationId));
    if (!service || service.contactId !== input.contactId || service.updatedAt.toISOString() !== input.expectedUpdatedAt) fail("service_changed");
    const [approval] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, identity.organizationId), eq(auditEventsTable.id, input.approvalId), eq(auditEventsTable.action, "service.care_reminder_approved"), eq(auditEventsTable.entityId, service.id)));
    const saved = approval?.metadata as { scheduledActionId?: string; snapshot?: { recipient?: string; subject?: string; body?: string; mailboxIdentity?: MailboxIdentity | null } } | undefined;
    if (!saved || saved.scheduledActionId !== input.scheduledActionId || !saved.snapshot || saved.snapshot.recipient !== message.to || saved.snapshot.subject !== message.subject || saved.snapshot.body !== message.body || mailboxDigest(saved.snapshot.mailboxIdentity) !== mailboxDigest(identity)) fail("approval_mismatch");
    const actionKey = `scheduled:${input.scheduledActionId}`;
    const [previous] = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.serviceObligationId, service.id)));
    if (previous) {
      if (!sameIdentity(previous, identity) || previous.actionKey !== actionKey || previous.contentSha256 !== mailboxContentHash(message) || previous.executionFingerprint !== input.executionFingerprint) fail("parent_conflict");
      // A prior dispatch claim can never be reused, even without acceptance.
      if (previous.dispatchStartedAt) fail("dispatch_already_claimed");
      await executionCurrent(tx, previous); return previous.id;
    }
    const [parent] = await tx.insert(parents).values({ organizationId: identity.organizationId, contactId: input.contactId, serviceObligationId: service.id,
      contextSnapshot: { dueAt: service.dueAt.toISOString(), occurrenceIndex: service.occurrenceIndex, createdAt: service.createdAt.toISOString(), updatedAt: input.expectedUpdatedAt, approvalId: input.approvalId, scheduledActionId: input.scheduledActionId },
      provider: identity.provider, senderUserId: identity.senderUserId, connectionId: identity.connectionId, connectionRevision: identity.connectionRevision,
      mailboxAccountId: identity.mailboxAccountId, mailboxEmail: identity.mailboxEmail, connectorId: identity.connectorId, connectorVersion: identity.connectorVersion, policyVersion: identity.policyVersion, connectorStartedAt: identity.startedAt,
      recipient: message.to.trim().toLowerCase(), contentSha256: mailboxContentHash(message), subjectSha256: hash(message.subject), bodySha256: hash(message.body),
      correlationHeader: randomBytes(32).toString("hex"), actionKey, executionFingerprint: input.executionFingerprint }).returning();
    await executionCurrent(tx, parent); await exactService(tx, parent, true); return parent.id;
  });
}

/** Final transport boundary. Claim is permanent; even a lost acceptance cannot reuse it. */
export async function assertMailboxOutboundParentDispatch(parentId: string, identity: MailboxIdentity, message: Message): Promise<{ name: "x-growthos-parent-id"; value: string }> {
  try {
    return await db.transaction(async tx => {
      await lock(tx, identity.organizationId); await currentIdentity(identity, tx);
      const [parent] = await tx.select().from(parents).where(parentWhere(identity.organizationId, parentId)).for("update");
      if (!parent || !sameIdentity(parent, identity) || parent.dispatchStartedAt || parent.contentSha256 !== mailboxContentHash(message)) fail("parent_dispatch_mismatch");
      await executionCurrent(tx, parent); await exactService(tx, parent, true);
      await tx.update(parents).set({ dispatchStartedAt: new Date() }).where(eq(parents.id, parent.id));
      return { name: MAILBOX_HEADER, value: parent.correlationHeader };
    });
  } catch { throw new EmailDispatchBlockedError(); }
}
export async function recordMailboxParentAcceptance(parentId: string, org: string) {
  await db.update(parents).set({ acceptedAt: new Date() }).where(and(parentWhere(org, parentId), isNotNull(parents.dispatchStartedAt)));
}

/** Only the fixed authenticated original-mailbox adapter calls this; header text alone is not authority. */
export async function bindMailboxSentParent(identity: MailboxIdentity, raw: z.input<typeof sentSchema>): Promise<{ matched: boolean; parentId?: string; reason: string }> {
  const parsed = sentSchema.safeParse(raw);
  if (!parsed.success) return { matched: false, reason: "invalid_sent_observation" };
  const input = parsed.data;
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId); await currentIdentity(identity, tx);
    const [parent] = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.correlationHeader, input.correlationHeader))).for("update");
    if (!parent || !sameIdentity(parent, identity)) return { matched: false, reason: "parent_not_reserved" };
    if (!parent.dispatchStartedAt || input.from !== parent.mailboxEmail || input.to.length !== 1 || input.to[0] !== parent.recipient || hash(input.subject) !== parent.subjectSha256 || (input.bodyHash && input.bodyHash !== parent.bodySha256) || input.sentAt.getTime() < parent.dispatchStartedAt.getTime() - 2000 || input.sentAt < new Date(identity.startedAt)) return { matched: false, reason: "sent_observation_mismatch" };
    if (parent.providerMessageId || parent.internetMessageId) {
      if (parent.providerMessageId !== input.providerMessageId || parent.internetMessageId !== input.internetMessageId || parent.providerSentAt?.getTime() !== input.sentAt.getTime()) fail("sent_observation_conflict");
      return { matched: true, parentId: parent.id, reason: "already_observed" };
    }
    const [ambiguous] = await tx.select({ id: parents.id }).from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId), sql`(${parents.providerMessageId} = ${input.providerMessageId} or ${parents.internetMessageId} = ${input.internetMessageId})`)).limit(1);
    if (ambiguous) fail("sent_observation_conflict");
    await tx.update(parents).set({ observedAt: new Date(), providerMessageId: input.providerMessageId, internetMessageId: input.internetMessageId, providerSentAt: input.sentAt }).where(eq(parents.id, parent.id));
    return { matched: true, parentId: parent.id, reason: "observed_in_original_sent_items" };
  });
}

/** Read-only metadata prefilter. It grants no correlation and fetches no content. */
export async function isMailboxReplyCandidate(identity: MailboxIdentity, raw: z.input<typeof replySchema>): Promise<boolean> {
  const parsed = replySchema.safeParse({ ...raw, text: "" });
  if (!parsed.success) return false;
  const input = parsed.data;
  await currentIdentity(identity);
  if (!input.sentAt || !input.to.includes(identity.mailboxEmail) || input.receivedAt < new Date(identity.startedAt)) return false;
  const exact = await db.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId), inArray(parents.internetMessageId, input.inReplyTo))).limit(2);
  if (exact.length) return exact.length === 1 && sameIdentity(exact[0], identity) && !!exact[0].serviceObligationId && !!exact[0].observedAt && !!exact[0].providerSentAt &&
    exact[0].recipient === input.from && input.sentAt >= exact[0].providerSentAt && input.receivedAt >= exact[0].providerSentAt;
  const pending = await db.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId), eq(parents.recipient, input.from),
    isNull(parents.internetMessageId), isNotNull(parents.dispatchStartedAt))).orderBy(desc(parents.reservedAt)).limit(2);
  return pending.some(parent => sameIdentity(parent, identity) && !!parent.serviceObligationId && !!parent.dispatchStartedAt && input.sentAt! >= parent.dispatchStartedAt && input.receivedAt >= parent.dispatchStartedAt);
}

export async function ingestMailboxReply(identity: MailboxIdentity, raw: z.input<typeof replySchema>): Promise<{ state: string; replyId?: string; reason: string }> {
  const input = replySchema.parse(raw), payloadSha256 = mailboxDigest({ ...input, sentAt: input.sentAt?.toISOString() ?? null, receivedAt: input.receivedAt.toISOString() });
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId); await currentIdentity(identity, tx);
    const [previous] = await tx.select().from(replies).where(and(eq(replies.organizationId, identity.organizationId), eq(replies.connectorId, identity.connectorId), eq(replies.providerMessageId, input.providerMessageId)));
    if (previous) {
      if (previous.payloadSha256 !== payloadSha256) fail("reply_payload_conflict");
      return { state: "duplicate", replyId: previous.id, reason: "previous_receipt_retained" };
    }
    const candidates = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId), inArray(parents.internetMessageId, input.inReplyTo))).limit(2);
    if (!candidates.length) {
      // Retry only a narrowly eligible dispatch awaiting observation. This is
      // NOT a fuzzy match: an eventual exact original RFC parent is still mandatory.
      const pending = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId),
        eq(parents.recipient, input.from), isNull(parents.internetMessageId), isNotNull(parents.dispatchStartedAt))).orderBy(desc(parents.reservedAt)).limit(2);
      const eligible = pending.some(parent => sameIdentity(parent, identity) && !!parent.dispatchStartedAt && !!input.sentAt &&
        input.to.includes(parent.mailboxEmail) && input.sentAt >= parent.dispatchStartedAt && input.receivedAt >= parent.dispatchStartedAt && input.receivedAt >= new Date(identity.startedAt));
      return eligible ? { state: "unmatched", reason: "parent_not_observed" } : { state: "ignored", reason: "no_tracked_parent" };
    }
    if (candidates.length !== 1) return { state: "ignored", reason: "ambiguous_parent" };
    const parent = candidates[0];
    if (!sameIdentity(parent, identity) || !parent.serviceObligationId || !parent.observedAt || !parent.providerSentAt || !input.sentAt || input.from !== parent.recipient || !input.to.includes(parent.mailboxEmail) || input.sentAt < parent.providerSentAt || input.receivedAt < parent.providerSentAt || input.receivedAt < new Date(identity.startedAt)) return { state: "ignored", reason: "reply_evidence_mismatch" };
    const { service, historical } = await exactService(tx, parent);
    const id = randomUUID(), expires = new Date(Date.now() + 7 * 86_400_000);
    const [reply] = await tx.insert(replies).values({ id, organizationId: identity.organizationId, parentId: parent.id, serviceObligationId: service.id, contactId: parent.contactId,
      connectorId: identity.connectorId, providerMessageId: input.providerMessageId, internetMessageId: input.internetMessageId, payloadSha256,
      replyAt: input.sentAt, receivedAt: input.receivedAt, historical, holdActive: !historical,
      encryptedText: encryptEmailContent(JSON.stringify({ subject: input.subject, text: input.text }), `${identity.organizationId}:${id}:service-reply`), rawExpiresAt: expires }).returning();
    await tx.insert(auditEventsTable).values({ organizationId: identity.organizationId, action: "service.mailbox_reply_received", entityType: "service_obligation", entityId: service.id,
      metadata: { replyId: id, parentId: parent.id, historical, evidence: "original_mailbox_observation_requires_office_review", noBookingCreated: true, uncertainExecutionPreserved: true } });
    if (!historical) await tx.update(crmTasksTable).set({ status: "open", completedAt: null, dueAt: new Date(), description: "A reply to this exact service reminder arrived in the original connected mailbox. Office review is required. Message content is untrusted; no customer decision, consent, appointment change or completed visit is inferred." }).where(and(eq(crmTasksTable.organizationId, identity.organizationId), eq(crmTasksTable.id, service.taskId)));
    return { state: "needs_review", replyId: reply.id, reason: historical ? "historical_service_reply" : "exact_service_reply_review_required" };
  });
}

export async function hasServiceMailboxReplyHold(org: string, id: string, reader: Reader = db) {
  return !!await serviceMailboxReplyFacts(org, id, reader);
}
export async function serviceMailboxReplyFacts(org: string, id: string, reader: Reader = db) {
  const [latest] = await reader.select({ id: replies.id, version: replies.version, state: replies.state, holdActive: replies.holdActive, recordedAt: replies.recordedAt }).from(replies)
    .innerJoin(parents, and(eq(parents.organizationId, org), eq(parents.id, replies.parentId)))
    .innerJoin(serviceObligationsTable, and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, replies.serviceObligationId)))
    .innerJoin(contactsTable, and(eq(contactsTable.organizationId, org), eq(contactsTable.id, replies.contactId)))
    .where(and(eq(replies.organizationId, org), eq(replies.serviceObligationId, id), eq(replies.historical, false), eq(replies.holdActive, true),
      eq(serviceObligationsTable.contactId, parents.contactId),
      eq(serviceObligationsTable.status, "active"), sql`lower(trim(${contactsTable.email})) = ${parents.recipient}`,
      sql`${parents.contextSnapshot}->>'dueAt' = to_char(${serviceObligationsTable.dueAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      sql`(${parents.contextSnapshot}->>'occurrenceIndex')::int = ${serviceObligationsTable.occurrenceIndex}`))
    .orderBy(sql`case when ${replies.state} = 'needs_review' then 0 else 1 end`, desc(replies.recordedAt), desc(replies.id)).limit(1);
  return latest ?? null;
}
export async function listServiceMailboxReplies(org: string, actor: string, id: string, raw: unknown = {}) {
  await readerAllowed(db, org, actor);
  const query = serviceReplyQuery.parse(raw);
  const [service] = await db.select().from(serviceObligationsTable).where(serviceWhere(org, id));
  if (!service) fail("not_found", 404);
  const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, service.contactId)));
  const rows = await db.select({ reply: replies, parent: parents }).from(replies).innerJoin(parents, and(eq(parents.organizationId, org), eq(parents.id, replies.parentId)))
    .where(and(eq(replies.organizationId, org), eq(replies.serviceObligationId, id))).orderBy(desc(replies.recordedAt), desc(replies.id)).limit(26).offset(query.offset);
  return { items: rows.slice(0, 25).map(({ reply: row, parent }) => {
    let content: { subject: string; text: string } | null = null;
    if (row.encryptedText && row.rawExpiresAt > new Date()) {
      try { content = JSON.parse(decryptEmailContent(row.encryptedText, `${org}:${row.id}:service-reply`)); } catch { /* Receipt remains usable, never invent plaintext. */ }
    }
    const historical = row.historical || service.status !== "active" || service.contactId !== row.contactId || contact?.email?.trim().toLowerCase() !== parent.recipient ||
      service.dueAt.toISOString() !== parent.contextSnapshot.dueAt || service.occurrenceIndex !== parent.contextSnapshot.occurrenceIndex;
    return { id: row.id, serviceObligationId: id, version: row.version, state: row.state, historical, holdActive: row.holdActive && !historical,
      replyAt: row.replyAt.toISOString(), receivedAt: row.receivedAt.toISOString(), rawExpiresAt: row.rawExpiresAt.toISOString(), content,
      reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewNote: row.reviewNote, evidence: "original_mailbox_observation" };
  }), hasMore: rows.length > 25, offset: query.offset, limit: 25, held: !(await getCustomerLifecycleStatus(org)).automationAllowed };
}
export async function reviewServiceMailboxReply(org: string, actor: string, id: string, replyId: string, raw: unknown) {
  const command = serviceReplyReviewInput.parse(raw);
  return db.transaction(async tx => {
    await lock(tx, org); await readerAllowed(tx, org, actor); await activeCompany(tx, org); await assertOperationalStaff(tx, org, [actor]);
    const [reply] = await tx.select().from(replies).where(and(eq(replies.organizationId, org), eq(replies.serviceObligationId, id), eq(replies.id, replyId))).for("update");
    if (!reply) fail("not_found", 404);
    const [parent] = await tx.select().from(parents).where(parentWhere(org, reply.parentId));
    if (!parent) fail("parent_missing");
    await currentIdentity(identityFor(parent), tx);
    if (reply.reviewRequestId === command.requestId) {
      if (reply.reviewFingerprint !== mailboxDigest(command)) fail("request_changed");
      return { replyId, version: reply.version, replayed: true };
    }
    if (reply.version !== command.expectedVersion || reply.state !== "needs_review") fail("stale_review");
    const { historical } = await exactService(tx, parent);
    const dismissed = command.decision === "not_customer_reply";
    await tx.update(replies).set({ state: dismissed ? "dismissed" : "reviewed", holdActive: !dismissed && reply.holdActive && !historical,
      historical: reply.historical || historical, version: reply.version + 1, reviewedByUserId: actor, reviewedAt: new Date(), reviewNote: command.note,
      reviewRequestId: command.requestId, reviewFingerprint: mailboxDigest(command) }).where(eq(replies.id, reply.id));
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "service.mailbox_reply_reviewed", entityType: "service_obligation", entityId: id,
      metadata: { replyId, decision: command.decision, historical: reply.historical || historical, note: command.note, noBookingCreated: true, noSendRearmed: true, staffResponseRequired: !dismissed } });
    return { replyId, version: reply.version + 1, replayed: false };
  });
}

/** Bounded raw retention only; identity/hash/review/unknown receipts are never erased. */
export async function purgeExpiredServiceReplyContent(now = new Date()) {
  const expired = await db.select({ id: replies.id }).from(replies).where(and(lt(replies.rawExpiresAt, now), isNotNull(replies.encryptedText))).orderBy(asc(replies.rawExpiresAt), asc(replies.id)).limit(100);
  if (!expired.length) return 0;
  const changed = await db.update(replies).set({ encryptedText: null, rawPurgedAt: now }).where(and(inArray(replies.id, expired.map(row => row.id)), lt(replies.rawExpiresAt, now), isNotNull(replies.encryptedText))).returning({ id: replies.id });
  return changed.length;
}
