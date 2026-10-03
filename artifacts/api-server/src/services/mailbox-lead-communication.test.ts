import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activitiesTable, appointmentsTable, bieActionProposalsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, emailResponseReviewsTable as replies, leadsTable, revenueExecutionsTable, scheduledActionsTable, usersTable } from "@workspace/db";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { mailboxConnectorsTable as connectors } from "../../../../lib/db/src/schema/mailbox-connectors";
import { deleteLeadMailboxFixtures, dispatchLeadFixture, leadArrival, leadMailboxFixture, observeLeadFixture, receiveLeadFixture, reserveLeadFixture } from "../test-helpers/mailbox-lead-fixture";
import { assertMailboxOutboundParentDispatch, bindMailboxSentParent, ingestMailboxReply, isMailboxReplyCandidate, listLeadMailboxReplies, purgeExpiredLeadReplyContent, reviewLeadMailboxReply } from "./mailbox-communication";
import { hasCustomerReplyHold, releaseEmailResponseHold, reviewEmailResponse } from "./response-correlation";
import { checkSendEligibility } from "./send-gate";

const orgs: string[] = [];
beforeEach(() => { vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a1".repeat(32)); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "b1".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"); });
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => deleteLeadMailboxFixtures(orgs));
async function fixture() { const f = await leadMailboxFixture(); orgs.push(f.org); return f; }
const review = () => ({ requestId: randomUUID(), expectedVersion: 1, decision: "handled", note: "Office inspected the exact reply and recorded its next action separately.", reviewed: true });

it("exact typed reply atomically holds native lead follow-up and creates one accepted-assignee office task without a new lead or booking", async () => {
  const f = await fixture();
  const [pending] = await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: { type: "send_email", params: {} }, context: { leadId: f.lead.id }, runAt: new Date() }).returning();
  const [unclaimed] = await db.insert(bieActionProposalsTable).values({ organizationId: f.org, leadId: f.lead.id, actionType: "send_email", title: "Later old draft", rationale: "Synthetic", status: "proposed" }).returning();
  const { result, arrival } = await receiveLeadFixture(f);
  const page = await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id), row = page.items[0];
  expect(row).toMatchObject({ id: result.replyId, state: "confirmed", historical: false, holdActive: true, assignedUserId: f.staff.id, monitoringCurrent: true, content: { text: arrival.text } });
  expect(await hasCustomerReplyHold(f.org, f.lead.id)).toBe(true);
  expect((await checkSendEligibility({ organizationId: f.org, leadId: f.lead.id, contact: f.contact, channel: "email", kind: "outreach" }))).toMatchObject({ ok: false, reason: "customer_reply_requires_review" });
  expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, pending.id)))[0].status).toBe("cancelled");
  expect((await db.select().from(bieActionProposalsTable).where(eq(bieActionProposalsTable.id, unclaimed.id)))[0].status).toBe("blocked");
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, f.execution.id)))[0].state).toBe("processing");
  expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org))).toHaveLength(1);
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
  expect((await db.select().from(replies).where(eq(replies.id, result.replyId!)))[0]).toMatchObject({ sourceId: null, messageId: null, reviewedAt: null });
  expect((await db.select().from(replies).where(eq(replies.id, result.replyId!)))[0].encryptedText).not.toContain(arrival.text);
  expect((await ingestMailboxReply(f.identity, arrival)).state).toBe("duplicate");
  expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, f.org))).toHaveLength(1);
});
it("metadata prefilter and pending-parent recovery stay exact and do not read unrelated bodies", async () => {
  const f = await fixture(), { id, header } = await dispatchLeadFixture(f), arrival = leadArrival(f, `<sent-${id}@example.invalid>`);
  expect(await isMailboxReplyCandidate(f.identity, arrival)).toBe(true);
  expect(await ingestMailboxReply(f.identity, arrival)).toMatchObject({ state: "unmatched" });
  expect(await isMailboxReplyCandidate(f.identity, { ...arrival, from: "unrelated@example.invalid" })).toBe(false);
  expect(await isMailboxReplyCandidate(f.identity, { ...arrival, internetMessageId: "<bad>" })).toBe(false);
  await bindMailboxSentParent(f.identity, { correlationHeader: header.value, providerMessageId: `sent-${id}`, internetMessageId: arrival.inReplyTo[0], from: f.identity.mailboxEmail, to: [f.message.to], subject: f.message.subject, sentAt: new Date(arrival.sentAt.getTime() - 1) });
  expect((await ingestMailboxReply(f.identity, arrival)).state).toBe("needs_review");
});
it.each(["recipient", "body", "sender", "unreviewed", "expired", "hold", "ack"])("fails closed before dispatch for changed %s", async kind => {
  const f = await fixture();
  if (kind === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
  if (kind === "body") f.message.body = "Not approved";
  if (kind === "sender") f.identity = { ...f.identity, mailboxEmail: "different@example.invalid" };
  if (kind === "unreviewed") await db.update(bieActionProposalsTable).set({ status: "proposed" }).where(eq(bieActionProposalsTable.id, f.proposal.id));
  if (kind === "expired") await db.update(revenueExecutionsTable).set({ expiresAt: new Date(0) }).where(eq(revenueExecutionsTable.id, f.execution.id));
  if (kind === "ack") await db.update(connectors).set({ leadMonitoringEnabled: false, leadMonitoringVersion: 2 }).where(eq(connectors.id, f.connector.id));
  if (kind === "hold") { await receiveLeadFixture(f); }
  await expect(reserveLeadFixture(f)).rejects.toThrow();
});
it("late lead acknowledgement revocation blocks final claim and body-read candidacy without changing service connector identity", async () => {
  const f = await fixture(), id = await reserveLeadFixture(f);
  await db.update(connectors).set({ leadMonitoringEnabled: false, leadMonitoringVersion: 2 }).where(eq(connectors.id, f.connector.id));
  await expect(assertMailboxOutboundParentDispatch(id, f.identity, f.message)).rejects.toMatchObject({ effectNotAttempted: true });
  expect((await db.select().from(parents).where(eq(parents.id, id)))[0].dispatchStartedAt).toBeNull();
  expect(await isMailboxReplyCandidate(f.identity, leadArrival(f, `<sent-${id}@example.invalid>`))).toBe(false);
  expect((await db.select().from(connectors).where(eq(connectors.id, f.connector.id)))[0].version).toBe(f.identity.connectorVersion);
});
it("duplicates after raw purge retain one hold/task and changed immutable observations conflict", async () => {
  const f = await fixture(), { result, arrival } = await receiveLeadFixture(f);
  await db.update(replies).set({ rawExpiresAt: new Date(0) }).where(eq(replies.id, result.replyId!));
  expect((await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id)).items[0].content).toBeNull();
  expect(await purgeExpiredLeadReplyContent()).toBe(1);
  expect((await ingestMailboxReply(f.identity, arrival)).state).toBe("duplicate");
  await expect(ingestMailboxReply(f.identity, { ...arrival, text: "Changed" })).rejects.toMatchObject({ code: "reply_payload_conflict" });
  expect(await hasCustomerReplyHold(f.org, f.lead.id)).toBe(true);
  expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, f.org))).toHaveLength(1);
});
it("newer observed Microsoft send makes a delayed old reply historical even when provider acceptance was unknown", async () => {
  const f = await fixture(), { id, sent } = await observeLeadFixture(f), arrival = leadArrival(f, sent.internetMessageId);
  const [old] = await db.select().from(parents).where(eq(parents.id, id));
  await db.insert(parents).values({ ...old, id: randomUUID(), actionKey: `bie:${randomUUID()}`, correlationHeader: randomBytes(32).toString("hex"), providerMessageId: "later-immutable", internetMessageId: "<later@example.invalid>", acceptedAt: null, providerSentAt: new Date(arrival.sentAt.getTime() + 1), observedAt: new Date() });
  await ingestMailboxReply(f.identity, arrival);
  expect((await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id)).items[0]).toMatchObject({ historical: true, holdActive: false, taskId: null });
  expect(await hasCustomerReplyHold(f.org, f.lead.id)).toBe(false);
});
it("changed canonical customer yields historical evidence, not a task or hold on the new customer", async () => {
  const f = await fixture(), { sent } = await observeLeadFixture(f);
  await db.update(contactsTable).set({ email: "new-address@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
  await ingestMailboxReply(f.identity, leadArrival(f, sent.internetMessageId));
  expect((await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id)).items[0]).toMatchObject({ historical: true, holdActive: false, taskId: null });
});
it("retains the original customer on a historical timeline event after the lead is reassociated", async () => {
  const f = await fixture(), { sent } = await observeLeadFixture(f);
  const [replacement] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Different customer", email: "different@example.invalid" }).returning();
  await db.update(leadsTable).set({ contactId: replacement.id }).where(eq(leadsTable.id, f.lead.id));
  await ingestMailboxReply(f.identity, leadArrival(f, sent.internetMessageId));
  const [activity] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, f.org), eq(activitiesTable.type, "customer_reply")));
  expect(activity.contactId).toBe(f.contact.id); expect(activity.metadata.historical).toBe(true);
  expect(await hasCustomerReplyHold(f.org, f.lead.id)).toBe(false);
});
it.each(["snapshot", "leadVersion", "proposal"])("rejects a changed %s at the last parent claim", async kind => {
  const f = await fixture(), id = await reserveLeadFixture(f);
  if (kind === "snapshot") await db.update(bieActionProposalsTable).set({ payload: { ...f.proposal.payload, emailReview: { ...(f.proposal.payload.emailReview as Record<string, unknown>), recipient: "undisplayed@example.invalid" } } }).where(eq(bieActionProposalsTable.id, f.proposal.id));
  if (kind === "leadVersion") await db.update(leadsTable).set({ updatedAt: new Date() }).where(eq(leadsTable.id, f.lead.id));
  if (kind === "proposal") await db.update(bieActionProposalsTable).set({ status: "rejected" }).where(eq(bieActionProposalsTable.id, f.proposal.id));
  await expect(assertMailboxOutboundParentDispatch(id, f.identity, f.message)).rejects.toMatchObject({ effectNotAttempted: true });
  expect((await db.select().from(parents).where(eq(parents.id, id)))[0].dispatchStartedAt).toBeNull();
});
it("office handling is exact/versioned/idempotent after reader revocation and never resumes cancelled or unknown work", async () => {
  const f = await fixture(), first = await receiveLeadFixture(f), second = await ingestMailboxReply(f.identity, { ...first.arrival, providerMessageId: randomUUID(), internetMessageId: `<${randomUUID()}@example.invalid>` });
  await db.update(revenueExecutionsTable).set({ state: "indeterminate" }).where(eq(revenueExecutionsTable.id, f.execution.id));
  await db.update(connectors).set({ state: "disabled", encryptedRefreshToken: null, version: 2 }).where(eq(connectors.id, f.connector.id));
  const input = review(), saved = await reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, first.result.replyId!, input);
  expect(saved).toMatchObject({ version: 2, replayed: false });
  expect(await reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, first.result.replyId!, input)).toEqual({ ...saved, replayed: true });
  await expect(reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, first.result.replyId!, { ...input, note: "Changed same request content" })).rejects.toMatchObject({ code: "request_changed" });
  await expect(reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, first.result.replyId!, review())).rejects.toMatchObject({ code: "stale_review" });
  expect((await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id)).items.find(row => row.id === first.result.replyId)).toMatchObject({ holdActive: false, taskStatus: "done", monitoringCurrent: false });
  expect(await hasCustomerReplyHold(f.org, f.lead.id)).toBe(true);
  expect((await db.select().from(replies).where(eq(replies.id, second.replyId!)))[0].holdActive).toBe(true);
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, f.execution.id)))[0].state).toBe("indeterminate");
});
it("legacy review/resolve cannot bypass typed version/current-authority checks", async () => {
  const f = await fixture(), { result } = await receiveLeadFixture(f);
  await expect(releaseEmailResponseHold(f.org, result.replyId!, f.staff.id, "Legacy release may not handle typed evidence")).rejects.toMatchObject({ code: "typed_reply_review_required" });
  await expect(reviewEmailResponse(f.org, result.replyId!, f.staff.id, { decision: "confirm", leadId: f.lead.id, note: "Legacy route may not confirm typed evidence" })).rejects.toMatchObject({ code: "typed_reply_review_required" });
  await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic pause" });
  await expect(reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, result.replyId!, review())).rejects.toMatchObject({ code: "company_held" });
});
it("inactive assignee becomes visible unassigned office work and tenant/parent/task FKs cannot be transplanted", async () => {
  const f = await fixture(), other = await fixture(), { sent } = await observeLeadFixture(f);
  const [inactive] = await db.insert(usersTable).values({ organizationId: f.org, role: "office", isActive: false, emailVerifiedAt: new Date() }).returning();
  await db.update(leadsTable).set({ assignedUserId: inactive.id }).where(eq(leadsTable.id, f.lead.id));
  const result = await ingestMailboxReply(f.identity, leadArrival(f, sent.internetMessageId));
  const [row] = await db.select().from(replies).where(eq(replies.id, result.replyId!));
  expect((await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id)).items[0].assignedUserId).toBeNull();
  await expect(listLeadMailboxReplies(other.org, other.staff.id, f.lead.id)).rejects.toMatchObject({ status: 404 });
  await expect(db.insert(replies).values({ ...row, id: randomUUID(), externalMessageId: randomUUID(), mailboxConnectorId: other.connector.id })).rejects.toThrow();
  await expect(db.insert(replies).values({ ...row, id: randomUUID(), externalMessageId: randomUUID(), leadId: other.lead.id })).rejects.toThrow();
  const [foreignTask] = await db.insert(crmTasksTable).values({ organizationId: other.org, title: "Different company task" }).returning();
  await expect(db.update(replies).set({ taskId: foreignTask.id }).where(eq(replies.id, row.id))).rejects.toThrow();
});
it("rejects a changed same-company task context without releasing the reply hold", async () => {
  const f = await fixture(), { result } = await receiveLeadFixture(f);
  const [reply] = await db.select().from(replies).where(eq(replies.id, result.replyId!));
  await db.update(crmTasksTable).set({ sourceEvent: "unrelated.office_work" }).where(eq(crmTasksTable.id, reply.taskId!));
  await expect(reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, reply.id, review())).rejects.toMatchObject({ code: "task_context_changed" });
  expect(await hasCustomerReplyHold(f.org, f.lead.id)).toBe(true);
  expect((await db.select().from(replies).where(eq(replies.id, reply.id)))[0].version).toBe(1);
});
it("bounds retained lead reply pages without hiding older evidence", async () => {
  const f = await fixture(), { sent } = await observeLeadFixture(f);
  for (let i = 0; i < 26; i++) await ingestMailboxReply(f.identity, leadArrival(f, sent.internetMessageId));
  const first = await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id), second = await listLeadMailboxReplies(f.org, f.staff.id, f.lead.id, { offset: 25 });
  expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true); expect(second.items).toHaveLength(1); expect(second.hasMore).toBe(false);
  expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(26);
});
it("a changed explicit acknowledgement never adopts an older lead parent", async () => {
  const f = await fixture(), { id, sent } = await observeLeadFixture(f), arrival = leadArrival(f, sent.internetMessageId);
  await db.update(connectors).set({ leadMonitoringEnabled: true, leadMonitoringVersion: 3, leadMonitoringApprovedAt: new Date() }).where(eq(connectors.id, f.connector.id));
  expect(await isMailboxReplyCandidate(f.identity, arrival)).toBe(false);
  expect(await ingestMailboxReply(f.identity, arrival)).toMatchObject({ state: "ignored", reason: "lead_monitoring_changed" });
  expect(await db.select().from(replies).where(eq(replies.organizationId, f.org))).toHaveLength(0);
  expect((await db.select().from(parents).where(eq(parents.id, id)))[0].dispatchStartedAt).not.toBeNull();
});
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("independent PostgreSQL typed lead reply races", () => {
  it("concurrent same arrival commits one receipt, one task and one hold", async () => {
    const f = await fixture(), { sent } = await observeLeadFixture(f), arrival = leadArrival(f, sent.internetMessageId);
    const results = await Promise.all([ingestMailboxReply(f.identity, arrival), ingestMailboxReply(f.identity, arrival)]);
    expect(results.map(row => row.state).sort()).toEqual(["duplicate", "needs_review"]);
    expect(await db.select().from(replies).where(eq(replies.organizationId, f.org))).toHaveLength(1);
    expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, f.org))).toHaveLength(1);
    expect(await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, f.org), eq(activitiesTable.type, "customer_reply")))).toHaveLength(1);
  });
  it("concurrent stale staff reviews have only one versioned effect", async () => {
    const f = await fixture(), { result } = await receiveLeadFixture(f);
    const results = await Promise.allSettled([reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, result.replyId!, review()), reviewLeadMailboxReply(f.org, f.staff.id, f.lead.id, result.replyId!, review())]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(item => item.status === "rejected")).toHaveLength(1);
    expect((await db.select().from(replies).where(eq(replies.id, result.replyId!)))[0]).toMatchObject({ version: 2, holdActive: false });
    expect(await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.status, "done")))).toHaveLength(1);
  });
});
