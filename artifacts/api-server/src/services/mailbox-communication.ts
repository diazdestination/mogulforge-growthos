import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { auditEventsTable, bieActionProposalsTable, contactsTable, crmTasksTable, db, emailResponseReviewsTable as leadReplies, leadsTable, revenueExecutionsTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { mailboxCommunicationParentsTable as parents, mailboxServiceRepliesTable as replies, type SourceNurtureMailboxContext } from "../../../../lib/db/src/schema/mailbox-communication";
import { sourceNurturePlansTable, sourceNurtureItemsTable, sourceNurtureStepsTable } from "../../../../lib/db/src/schema/source-nurture";
import { decryptEmailContent, encryptEmailContent } from "../lib/email-content-encryption";
import { hasPermission } from "../lib/permissions";
import { assertOperationalStaff, type ScheduleTransaction } from "./contractor-scheduling";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { MAILBOX_HEADER, MAILBOX_MAX_BODY, mailboxDigest, type MailboxIdentity } from "./mailbox-contract";
import { confirmObservedMailboxLeadReply, hasCustomerReplyHold, lockReplyLead, lockReplyContact } from "./response-correlation";
import { assertServiceCareAuthorizationCurrent } from "./service-care-authorization";
import { careFingerprint } from "./service-care-policy";
import { hasServiceSmsReplyHold } from "./service-sms";

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
const identitySchema = z.object({ organizationId: z.uuid(), senderUserId: z.string().min(1), provider: z.literal("microsoft"), connectionId: z.uuid(), connectionRevision: z.iso.datetime(),
  mailboxAccountId: z.string().min(1), mailboxEmail: email, connectorId: z.uuid(), connectorVersion: z.number().int().positive(), policyVersion: z.literal(1), startedAt: z.iso.datetime() }).strict();
const leadContextFields = { version: z.literal(1), kind: z.literal("bie_lead_email"), leadId: z.uuid(), contactId: z.uuid(), leadCreatedAt: z.iso.datetime(), leadUpdatedAt: z.iso.datetime(),
  leadMonitoringApproval: z.object({ version: z.number().int().positive(), approvedAt: z.iso.datetime() }).strict() };
const leadContextSchema = z.object({ ...leadContextFields, proposalId: z.uuid() }).strict();
const nurtureContextSchema = z.object({ kind: z.literal("source_nurture_email"), version: z.literal(1), planId: z.uuid(), itemId: z.uuid(), stepId: z.uuid(), stepIndex: z.union([z.literal(1), z.literal(2)]),
  leadId: z.uuid(), contactId: z.uuid(), scheduledActionId: z.uuid(), planReviewId: z.uuid(), planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nurtureMonitoringApproval: z.object({ version: z.number().int().positive(), approvedAt: z.iso.datetime() }).strict() }).strict();
export const leadReplySendSnapshotSchema = z.object({ ...leadContextFields, recipient: email, mailboxIdentity: identitySchema }).strict();
export type LeadReplySendSnapshot = Omit<z.infer<typeof leadReplySendSnapshotSchema>, "mailboxIdentity"> & { mailboxIdentity: MailboxIdentity };
export const leadReplyReviewInput = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().positive(), decision: z.literal("handled"), note: z.string().trim().min(10).max(1000), reviewed: z.literal(true) }).strict();

export class MailboxCommunicationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super("The reply evidence needs review. Refresh the saved record; no customer message or booking was created."); }
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
  const { acquireNurtureLocks } = await import("./source-outreach-ownership");
  await acquireNurtureLocks(tx, org);
}
async function activeCompany(reader: Reader, org: string) { if (!(await getCustomerLifecycleStatus(org, reader)).automationAllowed) fail("company_held"); }
async function readerAllowed(reader: Reader, org: string, actor: string) {
  const [user] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  if (!user?.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, "crm.read")) fail("staff_required", 403);
}
async function executionCurrent(reader: Reader, parent: Parent) {
  const [receipt] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, parent.organizationId), eq(revenueExecutionsTable.actionKey, parent.actionKey)));
  if (!receipt || receipt.state !== "processing" || receipt.expiresAt <= new Date() || receipt.fingerprint !== parent.executionFingerprint) fail("execution_not_owned");
  if (parent.leadId && !parent.sourceNurtureStepId && receipt.actorUserId !== parent.senderUserId) fail("execution_not_owned");
}
async function exactService(reader: Reader, parent: Parent, dispatch = false, options: { lockTask?: boolean } = {}) {
  if (!parent.serviceObligationId) fail("unsupported_context");
  const [service] = await reader.select().from(serviceObligationsTable).where(serviceWhere(parent.organizationId, parent.serviceObligationId));
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, parent.organizationId), eq(contactsTable.id, parent.contactId)));
  if (!service || !contact) fail("context_missing");
  const snapshot = parent.contextSnapshot;
  if ("kind" in snapshot) fail("unsupported_context");
  const historical = service.status !== "active" || service.contactId !== parent.contactId || contact.email?.trim().toLowerCase() !== parent.recipient ||
    service.dueAt.toISOString() !== snapshot.dueAt || service.occurrenceIndex !== snapshot.occurrenceIndex || service.createdAt.toISOString() !== snapshot.createdAt;
  if (dispatch && (historical || service.updatedAt.toISOString() !== snapshot.updatedAt || await hasServiceMailboxReplyHold(parent.organizationId, service.id, reader))) fail("service_changed_or_reply_held");
  if (dispatch) {
    const claim = await assertServiceCareAuthorizationCurrent(reader, parent.organizationId, snapshot.approvalId, snapshot.scheduledActionId, options);
    const proof = { origin: claim.approval.authorization?.origin ?? "individual", fingerprint: careFingerprint(claim.approval.authorization ?? { origin: "individual" }) };
    if ((snapshot.authorization ? careFingerprint(snapshot.authorization) !== careFingerprint(proof) : proof.origin !== "individual") ||
        await hasServiceSmsReplyHold(parent.organizationId, service.id, reader)) fail("service_authorization_changed");
  }
  return { service, contact, historical };
}

async function leadMonitoringCurrent(parent: Parent, reader: Reader) {
  if (parent.sourceNurtureStepId) {
    const snapshot = nurtureContextSchema.parse(parent.contextSnapshot);
    const { getNurtureMonitoringApproval } = await import("./mailbox-connector");
    const approval = await getNurtureMonitoringApproval(identityFor(parent), reader);
    return snapshot.stepId === parent.sourceNurtureStepId && !!approval && mailboxDigest(approval) === mailboxDigest(snapshot.nurtureMonitoringApproval);
  }
  const snapshot = leadContextSchema.parse(parent.contextSnapshot);
  const { getLeadMonitoringApproval } = await import("./mailbox-connector");
  const approval = await getLeadMonitoringApproval(identityFor(parent), reader);
  return !!approval && mailboxDigest(approval) === mailboxDigest(snapshot.leadMonitoringApproval);
}
async function exactLead(reader: Reader, parent: Parent, dispatch = false) {
  if (parent.sourceNurtureStepId) return exactNurtureLead(reader, parent, dispatch);
  const snapshot = leadContextSchema.parse(parent.contextSnapshot);
  if (!parent.leadId || snapshot.leadId !== parent.leadId || snapshot.contactId !== parent.contactId) fail("unsupported_context");
  const [lead] = await reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, parent.organizationId), eq(leadsTable.id, parent.leadId)));
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, parent.organizationId), eq(contactsTable.id, parent.contactId)));
  if (!lead || !contact) fail("context_missing");
  const historical = lead.contactId !== parent.contactId || contact.email?.trim().toLowerCase() !== parent.recipient || lead.createdAt.toISOString() !== snapshot.leadCreatedAt || ["won", "lost", "completed"].includes(lead.status);
  if (dispatch) {
    if (historical || lead.updatedAt.toISOString() !== snapshot.leadUpdatedAt || await hasCustomerReplyHold(parent.organizationId, lead.id, reader)) fail("lead_changed_or_reply_held");
    if (!await leadMonitoringCurrent(parent, reader)) fail("lead_monitoring_changed");
    const [proposal] = await reader.select().from(bieActionProposalsTable).where(and(eq(bieActionProposalsTable.organizationId, parent.organizationId), eq(bieActionProposalsTable.id, snapshot.proposalId)));
    if (!proposal || proposal.status !== "approved" || proposal.leadId !== parent.leadId || proposal.actionType !== "send_email" || proposal.reviewedByUserId !== parent.senderUserId ||
      parent.actionKey !== `bie:${proposal.id}` || mailboxDigest(proposal.payload) !== parent.executionFingerprint) fail("approval_mismatch");
  }
  return { lead, contact, historical };
}

/** Read exact retained authority for correlation; stopping/expiry does not erase history. */
async function exactNurtureLead(reader: Reader, parent: Parent, dispatch = false) {
  const snapshot = nurtureContextSchema.parse(parent.contextSnapshot);
  if (parent.sourceNurtureStepId !== snapshot.stepId || parent.leadId !== snapshot.leadId || parent.contactId !== snapshot.contactId) fail("unsupported_context");
  const [saved] = await reader.select({ step: sourceNurtureStepsTable, item: sourceNurtureItemsTable, plan: sourceNurturePlansTable }).from(sourceNurtureStepsTable)
    .innerJoin(sourceNurtureItemsTable, and(eq(sourceNurtureItemsTable.organizationId, parent.organizationId), eq(sourceNurtureItemsTable.id, sourceNurtureStepsTable.itemId)))
    .innerJoin(sourceNurturePlansTable, and(eq(sourceNurturePlansTable.organizationId, parent.organizationId), eq(sourceNurturePlansTable.id, sourceNurtureStepsTable.planId)))
    .where(and(eq(sourceNurtureStepsTable.organizationId, parent.organizationId), eq(sourceNurtureStepsTable.id, snapshot.stepId)));
  if (!saved || saved.plan.id !== snapshot.planId || saved.item.id !== snapshot.itemId || saved.step.stepIndex !== snapshot.stepIndex ||
    saved.step.leadId !== parent.leadId || saved.step.contactId !== parent.contactId || saved.step.scheduledActionId !== snapshot.scheduledActionId ||
    parent.actionKey !== `scheduled:${snapshot.scheduledActionId}` || saved.plan.payloadSha256 !== snapshot.planFingerprint || saved.plan.reviewId !== snapshot.planReviewId ||
    mailboxDigest(saved.item.snapshot.mailboxIdentity) !== mailboxDigest(identityFor(parent)) || mailboxDigest(saved.item.snapshot.nurtureMonitoringApproval) !== mailboxDigest(snapshot.nurtureMonitoringApproval) ||
    saved.item.recipient !== parent.recipient || mailboxContentHash({ to: saved.item.recipient, subject: saved.step.subject, body: saved.step.body }) !== parent.contentSha256) fail("nurture_parent_changed");
  const [lead] = await reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, parent.organizationId), eq(leadsTable.id, snapshot.leadId)));
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, parent.organizationId), eq(contactsTable.id, parent.contactId)));
  if (!lead || !contact) fail("context_missing");
  const historical = lead.contactId !== parent.contactId || contact.email?.trim().toLowerCase() !== parent.recipient || lead.createdAt.toISOString() !== saved.item.snapshot.leadCreatedAt || ["won", "lost", "completed"].includes(lead.status);
  if (dispatch) {
    if (historical) fail("lead_changed_or_reply_held");
    const { assertNurtureStepCurrent } = await import("./source-nurture-authority");
    const current = await assertNurtureStepCurrent(reader, parent.organizationId, snapshot.stepId, { phase: "dispatch" });
    if (current.executionFingerprint !== parent.executionFingerprint) fail("execution_not_owned");
  }
  return { lead, contact, historical };
}

/** Internal typed authority only; no caller-provided policy/source snapshots. */
export async function reserveSourceNurtureMailboxParent(input: { identity: MailboxIdentity; stepId: string; executionFingerprint: string; message: Message }) {
  const { identity, message } = input;
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId);
    const { readNurtureStep, assertNurtureStepCurrent } = await import("./source-nurture-authority");
    const saved = await readNurtureStep(tx, identity.organizationId, input.stepId);
    await lockReplyLead(tx, identity.organizationId, saved.step.leadId);
    await currentIdentity(identity, tx);
    const authority = await assertNurtureStepCurrent(tx, identity.organizationId, input.stepId, { phase: "dispatch" });
    if (!authority.step.scheduledActionId || authority.executionFingerprint !== input.executionFingerprint || mailboxDigest(authority.mailboxIdentity) !== mailboxDigest(identity) || mailboxContentHash(authority.message) !== mailboxContentHash(message)) fail("approval_mismatch");
    const context: SourceNurtureMailboxContext = { kind: "source_nurture_email", version: 1, planId: authority.plan.id, itemId: authority.item.id, stepId: authority.step.id, stepIndex: authority.step.stepIndex,
      leadId: authority.step.leadId, contactId: authority.step.contactId, scheduledActionId: authority.step.scheduledActionId, planReviewId: authority.plan.reviewId, planFingerprint: authority.plan.payloadSha256,
      nurtureMonitoringApproval: authority.nurtureMonitoringApproval };
    const actionKey = `scheduled:${authority.step.scheduledActionId}`;
    const [prior] = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.actionKey, actionKey)));
    if (prior) {
      if (prior.sourceNurtureStepId !== input.stepId || !sameIdentity(prior, identity) || prior.contentSha256 !== mailboxContentHash(message) || prior.executionFingerprint !== input.executionFingerprint || mailboxDigest(prior.contextSnapshot) !== mailboxDigest(context)) fail("parent_conflict");
      if (prior.dispatchStartedAt) fail("dispatch_already_claimed");
      await executionCurrent(tx, prior); return prior.id;
    }
    const [parent] = await tx.insert(parents).values({ organizationId: identity.organizationId, leadId: authority.step.leadId, contactId: authority.step.contactId, sourceNurtureStepId: input.stepId, contextSnapshot: context,
      provider: "microsoft", senderUserId: identity.senderUserId, connectionId: identity.connectionId, connectionRevision: identity.connectionRevision, mailboxAccountId: identity.mailboxAccountId, mailboxEmail: identity.mailboxEmail,
      connectorId: identity.connectorId, connectorVersion: identity.connectorVersion, policyVersion: identity.policyVersion, connectorStartedAt: identity.startedAt, recipient: message.to.trim().toLowerCase(),
      contentSha256: mailboxContentHash(message), subjectSha256: hash(message.subject), bodySha256: hash(message.body), correlationHeader: randomBytes(32).toString("hex"), actionKey, executionFingerprint: input.executionFingerprint }).returning();
    await executionCurrent(tx, parent); return parent.id;
  });
}

/** Called only by the BIE executor; the saved approved payload supplies authority. */
export async function reserveLeadMailboxParent(input: { identity: MailboxIdentity; leadId: string; contactId: string; proposalId: string; executionFingerprint: string; message: Message }) {
  const { identity, message } = input;
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId); await lockReplyLead(tx, identity.organizationId, input.leadId); await currentIdentity(identity, tx);
    const [proposal] = await tx.select().from(bieActionProposalsTable).where(and(eq(bieActionProposalsTable.organizationId, identity.organizationId), eq(bieActionProposalsTable.id, input.proposalId)));
    const parsed = leadReplySendSnapshotSchema.safeParse(proposal?.payload.deliverySnapshot);
    if (!proposal || !parsed.success || proposal.status !== "approved" || proposal.actionType !== "send_email" || proposal.leadId !== input.leadId || proposal.reviewedByUserId !== identity.senderUserId) fail("approval_mismatch");
    const snapshot = parsed.data;
    const review = proposal.payload.emailReview as { version?: unknown; preparedByUserId?: unknown; recipient?: unknown; leadId?: unknown; contactId?: unknown; leadCreatedAt?: unknown; leadUpdatedAt?: unknown; sender?: { provider?: unknown; senderEmail?: unknown } } | undefined;
    if (!review || review.version !== 1 || review.preparedByUserId !== identity.senderUserId || review.recipient !== snapshot.recipient || review.leadId !== snapshot.leadId || review.contactId !== snapshot.contactId ||
      review.leadCreatedAt !== snapshot.leadCreatedAt || review.leadUpdatedAt !== snapshot.leadUpdatedAt || review.sender?.provider !== "microsoft" || review.sender.senderEmail !== identity.mailboxEmail) fail("approval_mismatch");
    if (snapshot.leadId !== input.leadId || snapshot.contactId !== input.contactId || snapshot.recipient !== message.to || proposal.payload.subject !== message.subject || proposal.payload.body !== message.body ||
      mailboxDigest(snapshot.mailboxIdentity) !== mailboxDigest(identity) || mailboxDigest(proposal.payload) !== input.executionFingerprint) fail("approval_mismatch");
    const actionKey = `bie:${proposal.id}`;
    const [previous] = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.actionKey, actionKey)));
    if (previous) {
      if (!sameIdentity(previous, identity) || previous.leadId !== input.leadId || previous.contactId !== input.contactId || previous.contentSha256 !== mailboxContentHash(message) || previous.executionFingerprint !== input.executionFingerprint) fail("parent_conflict");
      if (previous.dispatchStartedAt) fail("dispatch_already_claimed");
      await executionCurrent(tx, previous); await exactLead(tx, previous, true); return previous.id;
    }
    const [parent] = await tx.insert(parents).values({ organizationId: identity.organizationId, leadId: input.leadId, contactId: input.contactId,
      contextSnapshot: { version: 1, kind: "bie_lead_email", leadId: input.leadId, contactId: input.contactId, leadCreatedAt: snapshot.leadCreatedAt, leadUpdatedAt: snapshot.leadUpdatedAt, proposalId: proposal.id, leadMonitoringApproval: snapshot.leadMonitoringApproval },
      provider: identity.provider, senderUserId: identity.senderUserId, connectionId: identity.connectionId, connectionRevision: identity.connectionRevision,
      mailboxAccountId: identity.mailboxAccountId, mailboxEmail: identity.mailboxEmail, connectorId: identity.connectorId, connectorVersion: identity.connectorVersion, policyVersion: identity.policyVersion, connectorStartedAt: identity.startedAt,
      recipient: snapshot.recipient, contentSha256: mailboxContentHash(message), subjectSha256: hash(message.subject), bodySha256: hash(message.body), correlationHeader: randomBytes(32).toString("hex"), actionKey, executionFingerprint: input.executionFingerprint }).returning();
    await executionCurrent(tx, parent); await exactLead(tx, parent, true); return parent.id;
  });
}

/** Internal only: caller supplies the exact already-approved scheduled receipt, never HTTP context. */
export async function reserveServiceMailboxParent(input: { identity: MailboxIdentity; serviceObligationId: string; contactId: string; approvalId: string; scheduledActionId: string; expectedUpdatedAt: string; executionFingerprint: string; message: Message }) {
  const { identity, message } = input;
  email.parse(message.to);
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId); await currentIdentity(identity, tx);
    const authority = await assertServiceCareAuthorizationCurrent(tx, identity.organizationId, input.approvalId, input.scheduledActionId);
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
      await executionCurrent(tx, previous); await exactService(tx, previous, true); return previous.id;
    }
    const [parent] = await tx.insert(parents).values({ organizationId: identity.organizationId, contactId: input.contactId, serviceObligationId: service.id,
      contextSnapshot: { dueAt: service.dueAt.toISOString(), occurrenceIndex: service.occurrenceIndex, createdAt: service.createdAt.toISOString(), updatedAt: input.expectedUpdatedAt, approvalId: input.approvalId, scheduledActionId: input.scheduledActionId,
        authorization: { origin: authority.approval.authorization?.origin ?? "individual", fingerprint: careFingerprint(authority.approval.authorization ?? { origin: "individual" }) } },
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
      await lock(tx, identity.organizationId);
      const [context] = await tx.select({ leadId: parents.leadId }).from(parents).where(parentWhere(identity.organizationId, parentId));
      if (context?.leadId) await lockReplyLead(tx, identity.organizationId, context.leadId);
      await currentIdentity(identity, tx);
      const [parent] = await tx.select().from(parents).where(parentWhere(identity.organizationId, parentId)).for("update");
      if (!parent || !sameIdentity(parent, identity) || parent.dispatchStartedAt || parent.contentSha256 !== mailboxContentHash(message)) fail("parent_dispatch_mismatch");
      await executionCurrent(tx, parent);
      if (parent.leadId) await exactLead(tx, parent, true);
      else await exactService(tx, parent, true, { lockTask: true });
      await tx.update(parents).set({ dispatchStartedAt: new Date() }).where(eq(parents.id, parent.id));
      return { name: MAILBOX_HEADER, value: parent.correlationHeader };
    });
  } catch { throw new EmailDispatchBlockedError(); }
}
export async function recordMailboxParentAcceptance(parentId: string, org: string) {
  await db.update(parents).set({ acceptedAt: new Date() }).where(and(parentWhere(org, parentId), isNotNull(parents.dispatchStartedAt), isNull(parents.acceptedAt)));
}

/** Only the fixed authenticated original-mailbox adapter calls this; header text alone is not authority. */
export async function bindMailboxSentParent(identity: MailboxIdentity, raw: z.input<typeof sentSchema>): Promise<{ matched: boolean; parentId?: string; reason: string }> {
  const parsed = sentSchema.safeParse(raw);
  if (!parsed.success) return { matched: false, reason: "invalid_sent_observation" };
  const input = parsed.data;
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId);
    const [before] = await tx.select({ leadId: parents.leadId }).from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.correlationHeader, input.correlationHeader)));
    if (before?.leadId) await lockReplyLead(tx, identity.organizationId, before.leadId);
    await currentIdentity(identity, tx);
    const [parent] = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.correlationHeader, input.correlationHeader))).for("update");
    if (!parent || !sameIdentity(parent, identity)) return { matched: false, reason: "parent_not_reserved" };
    if (parent.leadId && !await leadMonitoringCurrent(parent, tx)) return { matched: false, reason: "lead_monitoring_changed" };
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
  if (exact.length) {
    const parent = exact[0];
    return exact.length === 1 && sameIdentity(parent, identity) && !!parent.observedAt && !!parent.providerSentAt &&
      parent.recipient === input.from && input.sentAt >= parent.providerSentAt && input.receivedAt >= parent.providerSentAt &&
      (!parent.leadId || await leadMonitoringCurrent(parent, db));
  }
  const pending = await db.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId), eq(parents.recipient, input.from),
    isNull(parents.internetMessageId), isNotNull(parents.dispatchStartedAt))).orderBy(desc(parents.reservedAt)).limit(2);
  for (const parent of pending) if (sameIdentity(parent, identity) && parent.dispatchStartedAt && input.sentAt >= parent.dispatchStartedAt && input.receivedAt >= parent.dispatchStartedAt &&
    (!parent.leadId || await leadMonitoringCurrent(parent, db))) return true;
  return false;
}

export async function ingestMailboxReply(identity: MailboxIdentity, raw: z.input<typeof replySchema>): Promise<{ state: string; replyId?: string; reason: string }> {
  const input = replySchema.parse(raw), payloadSha256 = mailboxDigest({ ...input, sentAt: input.sentAt?.toISOString() ?? null, receivedAt: input.receivedAt.toISOString() });
  return db.transaction(async tx => {
    await lock(tx, identity.organizationId);
    const [previous] = await tx.select().from(replies).where(and(eq(replies.organizationId, identity.organizationId), eq(replies.connectorId, identity.connectorId), eq(replies.providerMessageId, input.providerMessageId)));
    if (previous) {
      await currentIdentity(identity, tx);
      if (previous.payloadSha256 !== payloadSha256) fail("reply_payload_conflict");
      return { state: "duplicate", replyId: previous.id, reason: "previous_receipt_retained" };
    }
    const [priorLead] = await tx.select().from(leadReplies).where(and(eq(leadReplies.organizationId, identity.organizationId), eq(leadReplies.mailboxConnectorId, identity.connectorId), eq(leadReplies.externalMessageId, input.providerMessageId)));
    if (priorLead) {
      await currentIdentity(identity, tx);
      if (priorLead.payloadSha256 !== payloadSha256) fail("reply_payload_conflict");
      return { state: "duplicate", replyId: priorLead.id, reason: "previous_receipt_retained" };
    }
    const candidates = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId), inArray(parents.internetMessageId, input.inReplyTo))).limit(2);
    if (!candidates.length) {
      await currentIdentity(identity, tx);
      // Retry only a narrowly eligible dispatch awaiting observation. This is
      // NOT a fuzzy match: an eventual exact original RFC parent is still mandatory.
      const pending = await tx.select().from(parents).where(and(eq(parents.organizationId, identity.organizationId), eq(parents.connectorId, identity.connectorId),
        eq(parents.recipient, input.from), isNull(parents.internetMessageId), isNotNull(parents.dispatchStartedAt))).orderBy(desc(parents.reservedAt)).limit(2);
      let eligible = false;
      for (const parent of pending) if (sameIdentity(parent, identity) && parent.dispatchStartedAt && input.sentAt &&
        input.to.includes(parent.mailboxEmail) && input.sentAt >= parent.dispatchStartedAt && input.receivedAt >= parent.dispatchStartedAt && input.receivedAt >= new Date(identity.startedAt) &&
        (!parent.leadId || await leadMonitoringCurrent(parent, tx))) eligible = true;
      return eligible ? { state: "unmatched", reason: "parent_not_observed" } : { state: "ignored", reason: "no_tracked_parent" };
    }
    if (candidates.length !== 1) return { state: "ignored", reason: "ambiguous_parent" };
    const parent = candidates[0];
    if (parent.leadId) await lockReplyContact(tx, identity.organizationId, parent.contactId, [parent.leadId]);
    await currentIdentity(identity, tx);
    if (!sameIdentity(parent, identity) || !parent.observedAt || !parent.providerSentAt || !input.sentAt || input.from !== parent.recipient || !input.to.includes(parent.mailboxEmail) || input.sentAt < parent.providerSentAt || input.receivedAt < parent.providerSentAt || input.receivedAt < new Date(identity.startedAt)) return { state: "ignored", reason: "reply_evidence_mismatch" };
    if (parent.leadId) {
      if (!await leadMonitoringCurrent(parent, tx)) return { state: "ignored", reason: "lead_monitoring_changed" };
      const { lead, historical } = await exactLead(tx, parent);
      const id = randomUUID();
      const [row] = await tx.insert(leadReplies).values({ id, organizationId: identity.organizationId, leadId: parent.leadId, contactId: parent.contactId,
        mailboxParentId: parent.id, mailboxConnectorId: identity.connectorId, externalMessageId: input.providerMessageId, internetMessageId: input.internetMessageId,
        payloadSha256, state: "confirmed", reason: "original_mailbox_observation", replyAt: input.sentAt, receivedAt: input.receivedAt,
        encryptedText: encryptEmailContent(JSON.stringify({ subject: input.subject, text: input.text }), `${identity.organizationId}:${id}:lead-reply`), rawExpiresAt: new Date(Date.now() + 7 * 86_400_000) }).returning();
      const nurture = parent.sourceNurtureStepId ? nurtureContextSchema.parse(parent.contextSnapshot) : null;
      const confirmed = await confirmObservedMailboxLeadReply(tx, row, { leadId: lead.id, contactId: parent.contactId, replyAt: input.sentAt, historical,
        ...(nurture ? { nurture: { planId: nurture.planId, itemId: nurture.itemId, stepId: nurture.stepId } } : {}) });
      return { state: "needs_review", replyId: row.id, reason: confirmed.reason };
    }
    const { service, historical } = await exactService(tx, parent);
    const id = randomUUID(), expires = new Date(Date.now() + 7 * 86_400_000);
    const [reply] = await tx.insert(replies).values({ id, organizationId: identity.organizationId, parentId: parent.id, serviceObligationId: service.id, contactId: parent.contactId,
      connectorId: identity.connectorId, providerMessageId: input.providerMessageId, internetMessageId: input.internetMessageId, payloadSha256,
      replyAt: input.sentAt, receivedAt: input.receivedAt, historical, holdActive: !historical,
      encryptedText: encryptEmailContent(JSON.stringify({ subject: input.subject, text: input.text }), `${identity.organizationId}:${id}:service-reply`), rawExpiresAt: expires }).returning();
    await tx.insert(auditEventsTable).values({ organizationId: identity.organizationId, action: "service.mailbox_reply_received", entityType: "service_obligation", entityId: service.id,
      metadata: { replyId: id, parentId: parent.id, historical, evidence: "original_mailbox_observation_requires_office_review", noBookingCreated: true, uncertainExecutionPreserved: true } });
    // The retained reply and MAINTAIN hold are the office-review work. An inbound
    // message is not authority to reopen a task or replace its staff-owned plan.
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
    const snapshot = parent.contextSnapshot;
    const historical = row.historical || "kind" in snapshot || service.status !== "active" || service.contactId !== row.contactId || contact?.email?.trim().toLowerCase() !== parent.recipient ||
      service.dueAt.toISOString() !== snapshot.dueAt || service.occurrenceIndex !== snapshot.occurrenceIndex;
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

/** SELECT-only projection: expired/unreadable content stays hidden before purge. */
export async function listLeadMailboxReplies(org: string, actor: string, leadId: string, raw: unknown = {}) {
  await readerAllowed(db, org, actor);
  const query = serviceReplyQuery.parse(raw);
  const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, leadId)));
  if (!lead) fail("not_found", 404);
  const rows = await db.select({ reply: leadReplies, parent: parents, task: crmTasksTable, owner: usersTable }).from(leadReplies)
    .innerJoin(parents, and(eq(parents.organizationId, org), eq(parents.id, leadReplies.mailboxParentId)))
    .leftJoin(crmTasksTable, and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, leadReplies.taskId)))
    .leftJoin(usersTable, and(eq(usersTable.organizationId, org), eq(usersTable.id, crmTasksTable.assignedUserId)))
    .where(and(eq(leadReplies.organizationId, org), eq(leadReplies.leadId, leadId), isNotNull(leadReplies.mailboxParentId)))
    .orderBy(desc(leadReplies.receivedAt), desc(leadReplies.id)).limit(26).offset(query.offset);
  const continuity = new Map<string, Promise<boolean>>();
  const items = await Promise.all(rows.slice(0, 25).map(async ({ reply, parent, task, owner }) => {
    let content: { subject: string; text: string } | null = null;
    if (reply.encryptedText && reply.rawExpiresAt && reply.rawExpiresAt > new Date()) {
      try { content = z.object({ subject: z.string(), text: z.string() }).strict().parse(JSON.parse(decryptEmailContent(reply.encryptedText, `${org}:${reply.id}:lead-reply`))); } catch { /* Encrypted evidence unavailable; retain hold and identity. */ }
    }
    const assigned = owner?.isActive && owner.emailVerifiedAt && !owner.id.startsWith("invite:") && hasPermission(owner.role, "crm.write");
    const continuityKey = mailboxDigest({ identity: identityFor(parent), context: parent.contextSnapshot });
    if (!continuity.has(continuityKey)) continuity.set(continuityKey, leadMonitoringCurrent(parent, db).catch(() => false));
    const monitoringCurrent = await continuity.get(continuityKey)!;
    const nurture = parent.sourceNurtureStepId ? nurtureContextSchema.parse(parent.contextSnapshot) : null;
    return { id: reply.id, leadId, version: reply.version, state: reply.state, reason: reply.reason, replyAt: reply.replyAt?.toISOString() ?? null,
      receivedAt: reply.receivedAt.toISOString(), historical: reply.reason === "historical_reply", holdActive: reply.holdActive,
      taskId: task?.id ?? null, taskTitle: task?.title ?? null, taskStatus: task?.status ?? null, assignedUserId: assigned ? owner.id : null,
      assignedUserName: assigned ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || null : null,
      content, rawExpiresAt: reply.rawExpiresAt?.toISOString() ?? null, releasedAt: reply.releasedAt?.toISOString() ?? null,
      releaseNote: reply.releaseNote, effectSummary: reply.effectSummary, monitoringCurrent, evidence: "original_mailbox_observation" as const,
      context: nurture ? { kind: "source_nurture_email" as const, planId: nurture.planId, itemId: nurture.itemId, stepId: nurture.stepId, stepIndex: nurture.stepIndex } : { kind: "bie_lead_email" as const } };
  }));
  return { items, hasMore: rows.length > 25, offset: query.offset, limit: 25 };
}

export async function reviewLeadMailboxReply(org: string, actor: string, leadId: string, replyId: string, raw: unknown) {
  const input = leadReplyReviewInput.parse(raw), fingerprint = mailboxDigest({ ...input, actor, leadId, replyId });
  return db.transaction(async tx => {
    await lock(tx, org); await lockReplyLead(tx, org, leadId);
    await readerAllowed(tx, org, actor); await assertOperationalStaff(tx, org, [actor]); await activeCompany(tx, org);
    const [reply] = await tx.select().from(leadReplies).where(and(eq(leadReplies.organizationId, org), eq(leadReplies.leadId, leadId), eq(leadReplies.id, replyId), isNotNull(leadReplies.mailboxParentId))).for("update");
    if (!reply) fail("not_found", 404);
    const [parent] = await tx.select().from(parents).where(parentWhere(org, reply.mailboxParentId!));
    if (!parent || !parent.observedAt || !parent.providerSentAt || parent.leadId !== leadId || parent.contactId !== reply.contactId || parent.connectorId !== reply.mailboxConnectorId) fail("context_missing");
    // Handling already-observed evidence reads no mailbox and grants no future
    // authority. A revoked reader must not orphan a company-owned office task.
    const [lead] = await tx.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, leadId)));
    if (!lead) fail("not_found", 404);
    if (reply.taskId) {
      const [task] = await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, reply.taskId))).for("update");
      if (!task || task.leadId !== leadId || task.contactId !== reply.contactId || task.sourceEvent !== `mailbox.lead_reply:${reply.id}`) fail("task_context_changed");
    }
    if (reply.reviewRequestId === input.requestId) {
      if (reply.reviewFingerprint !== fingerprint) fail("request_changed");
      return { replyId, version: reply.version, replayed: true };
    }
    if (reply.version !== input.expectedVersion || reply.releasedAt || reply.state !== "confirmed") fail("stale_review");
    await tx.update(leadReplies).set({ holdActive: false, releasedAt: new Date(), releasedByUserId: actor, releaseNote: input.note,
      reviewedAt: new Date(), reviewedByUserId: actor, reviewNote: input.note, version: reply.version + 1, reviewRequestId: input.requestId, reviewFingerprint: fingerprint }).where(eq(leadReplies.id, reply.id));
    if (reply.taskId) await tx.update(crmTasksTable).set({ status: "done", completedAt: new Date() }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, reply.taskId),
      eq(crmTasksTable.leadId, leadId), eq(crmTasksTable.contactId, reply.contactId!), eq(crmTasksTable.sourceEvent, `mailbox.lead_reply:${reply.id}`)));
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "customer_reply.mailbox_handled", entityType: "email_response_review", entityId: reply.id,
      metadata: { leadId, taskId: reply.taskId, version: reply.version + 1, requestId: input.requestId, noCustomerMessageSent: true, rescheduledActions: 0, preservedOtherHolds: true } });
    return { replyId, version: reply.version + 1, replayed: false };
  });
}

/** Explicit bounded housekeeping, never a write performed by a read API. */
export async function purgeExpiredLeadReplyContent(now = new Date()) {
  const rows = await db.select({ id: leadReplies.id }).from(leadReplies).where(and(isNotNull(leadReplies.mailboxParentId), isNotNull(leadReplies.encryptedText), lt(leadReplies.rawExpiresAt, now)))
    .orderBy(asc(leadReplies.rawExpiresAt), asc(leadReplies.id)).limit(100);
  if (!rows.length) return 0;
  const purged = await db.update(leadReplies).set({ encryptedText: null, rawPurgedAt: now }).where(and(inArray(leadReplies.id, rows.map(row => row.id)), lt(leadReplies.rawExpiresAt, now), isNotNull(leadReplies.encryptedText))).returning({ id: leadReplies.id });
  return purged.length;
}
