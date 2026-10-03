import {
  db, activitiesTable, auditEventsTable, contactsTable, leadsTable, usersTable,
  emailResponseReviewsTable as replies, emailIntelligenceMessagesTable as messages,
  playbookEnrollmentsTable as enrollments, scheduledActionsTable as scheduled,
  bieActionProposalsTable as proposals, revenueExecutionsTable as executions,
  crmTasksTable,
  type EmailResponseReview,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { verifyOutboundReplyEvidence } from "./reply-evidence";
import { mailboxCommunicationParentsTable as mailboxParents } from "../../../../lib/db/src/schema/mailbox-communication";
import { sourceNurtureItemsTable as nurtureItems } from "../../../../lib/db/src/schema/source-nurture";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type VerifiedReplyParent = { provider: "gmail" | "microsoft"; outboundMessageId: string; senderEmail: string };
const OUTBOUND_TYPES = ["lead_email_sent", "email_sent", "bie_email_sent", "playbook_touch_sent", "automation_message_sent", "appointment_reminder_sent", "confirmation_sent"];
const FOLLOWUP_ACTIONS = ["send_email", "send_sms", "schedule_followup", "playbook_step"];

export class ReplyReviewError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "invalid_reply_review") { super(message); }
}

/** Same namespace is used by durable claims; no external calls occur under this lock. */
export async function lockReplyLead(tx: Transaction, organizationId: string, leadId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-reply:${organizationId}:${leadId}`}, 0))`);
}
/** Caller holds the company prefix; acquire every affected lead before rows. */
export async function lockReplyContact(tx: Transaction, organizationId: string, contactId: string, leadIds: string[] = []) {
  const items = await tx.select({ leadId: nurtureItems.leadId }).from(nurtureItems).where(and(eq(nurtureItems.organizationId, organizationId), eq(nurtureItems.contactId, contactId), sql`${nurtureItems.admittedAt} is not null`));
  for (const id of [...new Set([...leadIds, ...items.map(row => row.leadId)])].sort()) await lockReplyLead(tx, organizationId, id);
}

async function audit(tx: Transaction, row: EmailResponseReview, action: string, actorUserId: string | null, metadata: Record<string, unknown>) {
  await tx.insert(auditEventsTable).values({ organizationId: row.organizationId, actorUserId, action,
    entityType: "email_response_review", entityId: row.id, metadata });
}

/** No sender/subject fuzzy matching. The signed normalizer must resolve the parent
 * message in the original sending mailbox; raw In-Reply-To headers alone are not
 * this identity. Request/client correlation IDs are never message IDs. */
export async function registerEmailResponse(tx: Transaction, input: {
  organizationId: string; sourceId: string; messageId: string; externalMessageId: string;
  payloadSha256: string; from: string; to: string[]; sentAt: Date | null;
  replyTo?: VerifiedReplyParent | null; synthetic?: boolean; legacy?: boolean;
}) {
  await (await import("./source-outreach-ownership")).acquireNurtureLocks(tx, input.organizationId);
  const [row] = await tx.insert(replies).values({ organizationId: input.organizationId, sourceId: input.sourceId,
    messageId: input.messageId, externalMessageId: input.externalMessageId, payloadSha256: input.payloadSha256,
    replyAt: input.sentAt, state: input.synthetic ? "dismissed" : "needs_review", reason: input.synthetic ? "synthetic_fixture" : input.legacy ? "legacy_message_requires_review" : "no_verified_parent",
  }).returning();
  if (input.synthetic || input.legacy || !input.replyTo) return row;
  const identity = input.replyTo;
  const evidence = await tx.select({ activity: activitiesTable, lead: leadsTable, contact: contactsTable })
    .from(activitiesTable)
    .innerJoin(leadsTable, and(eq(leadsTable.id, activitiesTable.leadId), eq(leadsTable.organizationId, input.organizationId)))
    .innerJoin(contactsTable, and(eq(contactsTable.id, leadsTable.contactId), eq(contactsTable.organizationId, input.organizationId)))
    .where(and(eq(activitiesTable.organizationId, input.organizationId), inArray(activitiesTable.type, OUTBOUND_TYPES),
      sql`${activitiesTable.metadata}->>'provider' = ${identity.provider}`,
      sql`${activitiesTable.metadata}->>'providerMessageId' = ${identity.outboundMessageId}`,
      sql`lower(${activitiesTable.metadata}->>'senderEmail') = ${identity.senderEmail}`,
      sql`${activitiesTable.metadata}->>'acceptance' = 'accepted'`)).limit(3);
  let reason = "parent_not_found";
  if (evidence.length > 1) reason = "ambiguous_parent";
  if (evidence.length === 1) {
    const candidate = evidence[0]!;
    const acceptedAt = verifyOutboundReplyEvidence(candidate.activity.metadata, { organizationId: input.organizationId, leadId: candidate.lead.id });
    if (!acceptedAt) reason = "unverified_outbound_evidence";
    else if (candidate.contact.email?.trim().toLowerCase() !== input.from || candidate.activity.metadata.replyEvidenceRecipient !== input.from || !input.to.includes(identity.senderEmail)) reason = "participant_mismatch";
    else if (!input.sentAt) reason = "missing_sent_time";
    else if (input.sentAt.getTime() > Date.now() + 60_000) reason = "future_sent_time";
    else if (input.sentAt < acceptedAt) reason = "reply_predates_parent";
    else {
      await tx.update(replies).set({ outboundActivityId: candidate.activity.id }).where(eq(replies.id, row.id));
      return confirmReply(tx, { ...row, outboundActivityId: candidate.activity.id }, candidate.lead.id, input.sentAt, null, "Exact original mailbox and provider message identity; inbound participants match.");
    }
  }
  const [updated] = await tx.update(replies).set({ reason }).where(eq(replies.id, row.id)).returning();
  return updated!;
}

type NurtureReplyContext = { planId: string; itemId: string; stepId: string };
async function confirmReply(tx: Transaction, row: EmailResponseReview, leadId: string, replyAt: Date, actor: string | null, note: string, typed?: { historical: boolean; contactId: string; nurture?: NurtureReplyContext }) {
  await (await import("./source-outreach-ownership")).acquireNurtureLocks(tx, row.organizationId);
  const [before] = await tx.select({ contactId: leadsTable.contactId }).from(leadsTable).where(and(eq(leadsTable.organizationId, row.organizationId), eq(leadsTable.id, leadId)));
  if (before) await lockReplyContact(tx, row.organizationId, before.contactId, [leadId]);
  const [lead] = await tx.select().from(leadsTable).where(and(eq(leadsTable.organizationId, row.organizationId), eq(leadsTable.id, leadId)));
  if (!lead) throw new ReplyReviewError("Opportunity not found in this company.", 404, "not_found");
  const [contact] = await tx.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.organizationId, row.organizationId), eq(contactsTable.id, lead.contactId)));
  if (!contact) throw new ReplyReviewError("Opportunity contact is unavailable.", 409);
  // A delayed historical reply must not hold a newer conversation or workflow.
  const outboundRows = await tx.select({ metadata: activitiesTable.metadata }).from(activitiesTable).where(and(
    eq(activitiesTable.organizationId, row.organizationId), eq(activitiesTable.leadId, lead.id),
    inArray(activitiesTable.type, OUTBOUND_TYPES)));
  const samePlanParents = typed?.nurture ? await tx.select().from(mailboxParents).where(and(eq(mailboxParents.organizationId, row.organizationId), eq(mailboxParents.leadId, lead.id),
    sql`${mailboxParents.sourceNurtureStepId} is not null`, sql`${mailboxParents.contextSnapshot}->>'planId' = ${typed.nurture.planId}`)) : [];
  const newerOutbound = outboundRows.some(activity => {
    const acceptedAt = verifyOutboundReplyEvidence(activity.metadata, { organizationId: row.organizationId, leadId: lead.id });
    // Only an exact observed original parent can establish a sibling. Arbitrary
    // metadata plan tags never exempt an unrelated newer conversation.
    if (samePlanParents.some(parent => parent.observedAt && parent.providerMessageId && parent.providerMessageId === activity.metadata.providerMessageId &&
      activity.metadata.provider === parent.provider && activity.metadata.senderEmail === parent.mailboxEmail && activity.metadata.replyEvidenceRecipient === parent.recipient)) return false;
    return acceptedAt !== null && acceptedAt > replyAt;
  });
  const [newerEnrollment] = await tx.select({ id: enrollments.id }).from(enrollments).where(and(
    eq(enrollments.organizationId, row.organizationId), eq(enrollments.leadId, lead.id),
    inArray(enrollments.status, ["active", "paused"]), gt(enrollments.createdAt, replyAt))).limit(1);
  const [newerTypedOutbound] = await tx.select({ id: mailboxParents.id }).from(mailboxParents).where(and(
    eq(mailboxParents.organizationId, row.organizationId), eq(mailboxParents.leadId, lead.id), gt(mailboxParents.providerSentAt, replyAt), sql`${mailboxParents.observedAt} is not null`,
    typed?.nurture ? sql`not (${mailboxParents.sourceNurtureStepId} is not null and coalesce(${mailboxParents.contextSnapshot}->>'planId' = ${typed.nurture.planId}, false))` : undefined)).limit(1);
  const historical = Boolean(typed?.historical) || replyAt < lead.createdAt || Boolean(newerOutbound) || Boolean(newerEnrollment) || Boolean(newerTypedOutbound);
  const summary = { pausedEnrollments: 0, cancelledActions: 0, blockedProposals: 0, reconciliationRequired: 0 };
  if (historical && typed?.nurture) {
    const { stopSourceNurtureForReply } = await import("./source-nurture-authority");
    const stopped = await stopSourceNurtureForReply(tx, row.organizationId, { ...typed.nurture, replyId: row.id, replyAt });
    summary.cancelledActions += stopped.cancelledActions;
    summary.reconciliationRequired += stopped.reconciliationRequired;
  }
  if (!historical) {
    const { stopSourceNurtureForContact } = await import("./source-nurture-authority");
    const stopped = await stopSourceNurtureForContact(tx, row.organizationId, typed?.contactId ?? contact.id, "customer_reply_requires_office");
    summary.cancelledActions += stopped.cancelledActions;
    summary.reconciliationRequired += stopped.reconciliationRequired;
    const paused = await tx.update(enrollments).set({ status: "paused", nextRunAt: null,
      pauseReason: "Customer replied; staff review required before more outreach",
      history: sql`${enrollments.history} || ${JSON.stringify([{ at: new Date().toISOString(), kind: "paused", detail: `Customer reply review ${row.id}` }])}::jsonb`,
    }).where(and(eq(enrollments.organizationId, row.organizationId), eq(enrollments.leadId, lead.id),
      eq(enrollments.status, "active"), lte(enrollments.createdAt, replyAt))).returning({ id: enrollments.id });
    summary.pausedEnrollments = paused.length;
    // Lock pending rows before receipt lookup. The scheduler's guarded attempt
    // update then sees either the cancellation or its already-existing receipt.
    const work = await tx.select().from(scheduled).where(and(eq(scheduled.organizationId, row.organizationId),
      sql`${scheduled.context}->>'leadId' = ${lead.id}`, eq(scheduled.status, "pending"), lte(scheduled.createdAt, replyAt))).for("update");
    for (const action of work.filter(action => FOLLOWUP_ACTIONS.includes(action.action.type))) {
      const [receipt] = await tx.select({ state: executions.state }).from(executions).where(and(
        eq(executions.organizationId, row.organizationId), eq(executions.actionKey, `scheduled:${action.id}`)));
      if (receipt) { if (["processing", "indeterminate"].includes(receipt.state)) summary.reconciliationRequired++; continue; }
      await tx.update(scheduled).set({ status: "cancelled", lastError: "Customer replied; review before creating new follow-up." }).where(eq(scheduled.id, action.id));
      summary.cancelledActions++;
    }
    const pending = await tx.select().from(proposals).where(and(eq(proposals.organizationId, row.organizationId),
      eq(proposals.leadId, lead.id), inArray(proposals.status, ["proposed", "approved", "processing", "indeterminate"]), lte(proposals.createdAt, replyAt))).for("update");
    for (const proposal of pending) {
      const [receipt] = await tx.select({ state: executions.state }).from(executions).where(and(
        eq(executions.organizationId, row.organizationId), eq(executions.actionKey, `bie:${proposal.id}`)));
      if (receipt || ["processing", "indeterminate"].includes(proposal.status)) {
        if (!receipt || ["processing", "indeterminate"].includes(receipt.state)) summary.reconciliationRequired++;
        continue;
      }
      await tx.update(proposals).set({ status: "blocked", executionDetail: "Customer replied; review before creating a new action." }).where(eq(proposals.id, proposal.id));
      summary.blockedProposals++;
    }
  }
  const [confirmed] = await tx.update(replies).set({ state: "confirmed", reason: historical ? "historical_reply" : typed ? "original_mailbox_observation" : actor ? "staff_confirmed" : "verified_parent",
    leadId: lead.id, contactId: typed?.contactId ?? contact.id, replyAt, holdActive: !historical, reviewedByUserId: actor, reviewedAt: typed ? null : new Date(), reviewNote: typed ? null : note, effectSummary: summary,
  }).where(eq(replies.id, row.id)).returning();
  await tx.insert(activitiesTable).values({ organizationId: row.organizationId, leadId: lead.id, contactId: typed?.contactId ?? contact.id, actorUserId: actor,
    type: "customer_reply", title: historical ? "Historical customer reply linked" : "Customer replied — review follow-up",
    occurredAt: replyAt, metadata: { responseReviewId: row.id, correlation: typed ? "original_mailbox_observation" : actor ? "staff_confirmed" : "verified_parent", historical, ...summary } });
  await audit(tx, confirmed!, "customer_reply.confirmed", actor, { leadId: lead.id, replyAt: replyAt.toISOString(), historical, ...summary });
  return confirmed!;
}

/** Internal typed mailbox boundary. HTTP/legacy alias intake cannot call this path. */
export async function confirmObservedMailboxLeadReply(tx: Transaction, row: EmailResponseReview, input: { leadId: string; contactId: string; replyAt: Date; historical: boolean; nurture?: NurtureReplyContext }) {
  if (row.sourceId || !row.mailboxParentId || !row.mailboxConnectorId || row.leadId !== input.leadId || row.contactId !== input.contactId)
    throw new ReplyReviewError("Typed reply provenance is unavailable.", 409);
  if (input.nurture) {
    const [parent] = await tx.select().from(mailboxParents).where(and(eq(mailboxParents.organizationId, row.organizationId), eq(mailboxParents.id, row.mailboxParentId), eq(mailboxParents.connectorId, row.mailboxConnectorId)));
    const context = parent?.contextSnapshot;
    if (!parent?.observedAt || parent.sourceNurtureStepId !== input.nurture.stepId || parent.leadId !== input.leadId || parent.contactId !== input.contactId ||
      !context || !("kind" in context) || context.kind !== "source_nurture_email" || context.planId !== input.nurture.planId || context.itemId !== input.nurture.itemId || context.stepId !== input.nurture.stepId)
      throw new ReplyReviewError("Typed nurture reply provenance is unavailable.", 409);
  }
  const confirmed = await confirmReply(tx, row, input.leadId, input.replyAt, null, "Exact original-mailbox reply observed; office review required.", input);
  if (!confirmed.holdActive) return confirmed;
  const [lead] = await tx.select().from(leadsTable).where(and(eq(leadsTable.organizationId, row.organizationId), eq(leadsTable.id, input.leadId)));
  const [assignee] = lead?.assignedUserId ? await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, row.organizationId), eq(usersTable.id, lead.assignedUserId), eq(usersTable.isActive, true))).for("share") : [];
  const assignedUserId = assignee?.emailVerifiedAt && !assignee.id.startsWith("invite:") && hasPermission(assignee.role, "crm.write") ? assignee.id : null;
  const [task] = await tx.insert(crmTasksTable).values({ organizationId: row.organizationId, leadId: input.leadId, contactId: input.contactId, assignedUserId,
    title: "Review the customer's email reply", description: "A reply to the exact GrowthOS follow-up arrived in the original connected Microsoft mailbox. Review its evidence and record the office's next step. Content is untrusted; no consent, booking or customer decision is inferred.",
    sourceEvent: `mailbox.lead_reply:${row.id}`, status: "open", priority: "high", dueAt: new Date() }).returning();
  const [updated] = await tx.update(replies).set({ taskId: task.id }).where(eq(replies.id, row.id)).returning();
  await audit(tx, updated!, "customer_reply.office_task_created", null, { taskId: task.id, assignedUserId, noCustomerMessageSent: true });
  return updated!;
}

async function authorizedActor(tx: Transaction, organizationId: string, actor: string) {
  const [user] = await tx.select({ role: usersTable.role }).from(usersTable).where(and(
    eq(usersTable.id, actor), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true)));
  if (!user || !hasPermission(user.role, "crm.write")) throw new ReplyReviewError("An active authorized staff member must review this reply.", 403, "forbidden");
}

function reviewNote(input: unknown) {
  if (typeof input !== "string" || input.trim().length < 10 || input.length > 1_000) throw new ReplyReviewError("Add a review note of 10 to 1,000 characters.");
  return input.trim();
}

export async function reviewEmailResponse(organizationId: string, id: string, actor: string, input: {
  decision: "confirm" | "dismiss"; leadId?: string; note: string; replyAt?: string;
}) {
  const note = reviewNote(input?.note);
  if (!["confirm", "dismiss"].includes(input?.decision)) throw new ReplyReviewError("Choose confirm or dismiss.");
  return db.transaction(async tx => {
    await (await import("./source-outreach-ownership")).acquireNurtureLocks(tx, organizationId);
    await authorizedActor(tx, organizationId, actor);
    if (input.decision === "confirm" && typeof input.leadId === "string" && /^[\da-f-]{36}$/i.test(input.leadId)) {
      const [lead] = await tx.select({ contactId: leadsTable.contactId }).from(leadsTable).where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, input.leadId)));
      if (lead) await lockReplyContact(tx, organizationId, lead.contactId, [input.leadId]);
    }
    const [row] = await tx.select().from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.id, id))).for("update");
    if (!row) throw new ReplyReviewError("Reply not found.", 404, "not_found");
    if (row.mailboxParentId) throw new ReplyReviewError("Use the versioned original-mailbox reply review on this opportunity.", 409, "typed_reply_review_required");
    if (row.state !== "needs_review") {
      if ((input.decision === "confirm" && row.state === "confirmed" && row.leadId === input.leadId) || (input.decision === "dismiss" && row.state === "dismissed")) return row;
      throw new ReplyReviewError("This reply already has a different review decision.", 409, "review_conflict");
    }
    if (row.reason === "synthetic_fixture") throw new ReplyReviewError("A synthetic inbox demonstration cannot change customer work.", 409, "synthetic_fixture");
    if (input.decision === "dismiss") {
      const [dismissed] = await tx.update(replies).set({ state: "dismissed", reviewedByUserId: actor, reviewedAt: new Date(), reviewNote: note }).where(eq(replies.id, row.id)).returning();
      await audit(tx, dismissed!, "customer_reply.dismissed", actor, {});
      return dismissed!;
    }
    if (typeof input.leadId !== "string" || !/^[\da-f-]{36}$/i.test(input.leadId)) throw new ReplyReviewError("Select one opportunity in this company.");
    const at = row.replyAt ?? (typeof input.replyAt === "string" ? new Date(input.replyAt) : null);
    if (!at || !Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 60_000) throw new ReplyReviewError("Confirm the original reply time; it cannot be in the future.");
    if (row.replyAt && input.replyAt && row.replyAt.getTime() !== new Date(input.replyAt).getTime()) throw new ReplyReviewError("The original source reply time cannot be changed.");
    return confirmReply(tx, row, input.leadId, at, actor, note);
  });
}

export async function releaseEmailResponseHold(organizationId: string, id: string, actor: string, noteInput: unknown) {
  const note = reviewNote(noteInput);
  return db.transaction(async tx => {
    await (await import("./source-outreach-ownership")).acquireNurtureLocks(tx, organizationId);
    await authorizedActor(tx, organizationId, actor);
    const [before] = await tx.select({ leadId: replies.leadId, contactId: replies.contactId }).from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.id, id)));
    if (before?.leadId && before.contactId) await lockReplyContact(tx, organizationId, before.contactId, [before.leadId]);
    const [row] = await tx.select().from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.id, id))).for("update");
    if (!row) throw new ReplyReviewError("Reply not found.", 404, "not_found");
    if (row.mailboxParentId) throw new ReplyReviewError("Use the versioned original-mailbox reply review on this opportunity.", 409, "typed_reply_review_required");
    if (row.state !== "confirmed" || !row.leadId) throw new ReplyReviewError("Only a confirmed reply hold can be resolved.", 409);
    if (row.releasedAt) return row;
    await lockReplyLead(tx, organizationId, row.leadId);
    const [released] = await tx.update(replies).set({ holdActive: false, releasedAt: new Date(), releasedByUserId: actor, releaseNote: note }).where(eq(replies.id, id)).returning();
    await audit(tx, released!, "customer_reply.hold_resolved", actor, { leadId: row.leadId, rescheduledActions: 0 });
    // Never resurrect cancelled work or resume source/company holds.
    return released!;
  });
}

export async function hasCustomerReplyHold(organizationId: string, leadId: string, reader: Pick<typeof db, "select"> = db) {
  const [row] = await reader.select({ id: replies.id }).from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.leadId, leadId), eq(replies.holdActive, true))).limit(1);
  return Boolean(row);
}

export async function hasContactReplyHold(organizationId: string, contactId: string, reader: Pick<typeof db, "select"> = db) {
  const [row] = await reader.select({ id: replies.id }).from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.contactId, contactId), eq(replies.holdActive, true))).limit(1);
  return Boolean(row);
}

export async function listEmailResponses(organizationId: string, page = 0, scope = "attention") {
  const where = and(eq(replies.organizationId, organizationId), scope === "all" ? undefined : or(eq(replies.state, "needs_review"), eq(replies.holdActive, true)));
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(replies).where(where);
  const items = await db.select({ id: replies.id, messageId: replies.messageId, state: replies.state, reason: replies.reason,
    leadId: replies.leadId, replyAt: replies.replyAt, receivedAt: replies.receivedAt, holdActive: replies.holdActive,
    reviewedAt: replies.reviewedAt, releasedAt: replies.releasedAt, effectSummary: replies.effectSummary,
    mailboxParentId: replies.mailboxParentId,
    subject: messages.redactedSubject, fromEmail: messages.fromEmail, leadSummary: leadsTable.summary,
  }).from(replies)
    .leftJoin(messages, and(eq(messages.id, replies.messageId), eq(messages.organizationId, organizationId)))
    .leftJoin(leadsTable, and(eq(leadsTable.id, replies.leadId), eq(leadsTable.organizationId, organizationId)))
    .where(where).orderBy(desc(replies.receivedAt), replies.id).limit(20).offset(page * 20);
  return { items, total: count!, page, pageSize: 20 };
}
