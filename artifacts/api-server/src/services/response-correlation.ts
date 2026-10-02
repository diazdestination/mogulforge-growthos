import {
  db, activitiesTable, auditEventsTable, contactsTable, leadsTable, usersTable,
  emailResponseReviewsTable as replies, emailIntelligenceMessagesTable as messages,
  playbookEnrollmentsTable as enrollments, scheduledActionsTable as scheduled,
  bieActionProposalsTable as proposals, revenueExecutionsTable as executions,
  type EmailResponseReview,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { verifyOutboundReplyEvidence } from "./reply-evidence";

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

async function confirmReply(tx: Transaction, row: EmailResponseReview, leadId: string, replyAt: Date, actor: string | null, note: string) {
  await lockReplyLead(tx, row.organizationId, leadId);
  const [lead] = await tx.select().from(leadsTable).where(and(eq(leadsTable.organizationId, row.organizationId), eq(leadsTable.id, leadId)));
  if (!lead) throw new ReplyReviewError("Opportunity not found in this company.", 404, "not_found");
  const [contact] = await tx.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.organizationId, row.organizationId), eq(contactsTable.id, lead.contactId)));
  if (!contact) throw new ReplyReviewError("Opportunity contact is unavailable.", 409);
  // A delayed historical reply must not hold a newer conversation or workflow.
  const outboundRows = await tx.select({ metadata: activitiesTable.metadata }).from(activitiesTable).where(and(
    eq(activitiesTable.organizationId, row.organizationId), eq(activitiesTable.leadId, lead.id),
    inArray(activitiesTable.type, OUTBOUND_TYPES)));
  const newerOutbound = outboundRows.some(activity => {
    const acceptedAt = verifyOutboundReplyEvidence(activity.metadata, { organizationId: row.organizationId, leadId: lead.id });
    return acceptedAt !== null && acceptedAt > replyAt;
  });
  const [newerEnrollment] = await tx.select({ id: enrollments.id }).from(enrollments).where(and(
    eq(enrollments.organizationId, row.organizationId), eq(enrollments.leadId, lead.id),
    inArray(enrollments.status, ["active", "paused"]), gt(enrollments.createdAt, replyAt))).limit(1);
  const historical = replyAt < lead.createdAt || Boolean(newerOutbound) || Boolean(newerEnrollment);
  const summary = { pausedEnrollments: 0, cancelledActions: 0, blockedProposals: 0, reconciliationRequired: 0 };
  if (!historical) {
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
  const [confirmed] = await tx.update(replies).set({ state: "confirmed", reason: historical ? "historical_reply" : actor ? "staff_confirmed" : "verified_parent",
    leadId: lead.id, contactId: contact.id, replyAt, holdActive: !historical, reviewedByUserId: actor, reviewedAt: new Date(), reviewNote: note, effectSummary: summary,
  }).where(eq(replies.id, row.id)).returning();
  await tx.insert(activitiesTable).values({ organizationId: row.organizationId, leadId: lead.id, contactId: contact.id, actorUserId: actor,
    type: "customer_reply", title: historical ? "Historical customer reply linked" : "Customer replied — review follow-up",
    occurredAt: replyAt, metadata: { responseReviewId: row.id, correlation: actor ? "staff_confirmed" : "verified_parent", historical, ...summary } });
  await audit(tx, confirmed!, "customer_reply.confirmed", actor, { leadId: lead.id, replyAt: replyAt.toISOString(), historical, ...summary });
  return confirmed!;
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
    await authorizedActor(tx, organizationId, actor);
    const [row] = await tx.select().from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.id, id))).for("update");
    if (!row) throw new ReplyReviewError("Reply not found.", 404, "not_found");
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
    await authorizedActor(tx, organizationId, actor);
    const [row] = await tx.select().from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.id, id))).for("update");
    if (!row) throw new ReplyReviewError("Reply not found.", 404, "not_found");
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

export async function hasContactReplyHold(organizationId: string, contactId: string) {
  const [row] = await db.select({ id: replies.id }).from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.contactId, contactId), eq(replies.holdActive, true))).limit(1);
  return Boolean(row);
}

export async function listEmailResponses(organizationId: string, page = 0, scope = "attention") {
  const where = and(eq(replies.organizationId, organizationId), scope === "all" ? undefined : or(eq(replies.state, "needs_review"), eq(replies.holdActive, true)));
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(replies).where(where);
  const items = await db.select({ id: replies.id, messageId: replies.messageId, state: replies.state, reason: replies.reason,
    leadId: replies.leadId, replyAt: replies.replyAt, receivedAt: replies.receivedAt, holdActive: replies.holdActive,
    reviewedAt: replies.reviewedAt, releasedAt: replies.releasedAt, effectSummary: replies.effectSummary,
    subject: messages.redactedSubject, fromEmail: messages.fromEmail, leadSummary: leadsTable.summary,
  }).from(replies)
    .leftJoin(messages, and(eq(messages.id, replies.messageId), eq(messages.organizationId, organizationId)))
    .leftJoin(leadsTable, and(eq(leadsTable.id, replies.leadId), eq(leadsTable.organizationId, organizationId)))
    .where(where).orderBy(desc(replies.receivedAt), replies.id).limit(20).offset(page * 20);
  return { items, total: count!, page, pageSize: 20 };
}
