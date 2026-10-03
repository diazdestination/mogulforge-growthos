import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, pool, organizationsTable, usersTable, contactsTable, leadsTable, activitiesTable, emailIntelligenceSourcesTable,
  emailResponseReviewsTable as reviews, scheduledActionsTable as actions, playbooksTable, playbookEnrollmentsTable as enrollments,
  bieActionProposalsTable as proposals, revenueExecutionsTable as executions, auditEventsTable, customerLifecycleTable, orgSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import app from "../../app";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createSession, deleteSession } from "../../lib/auth";
import { checkSendEligibility } from "../../services/send-gate";
import { resumeEnrollment, skipEnrollmentStep } from "../../services/playbooks";
import { reviewEmailResponse, hasCustomerReplyHold, releaseEmailResponseHold } from "../../services/response-correlation";
import { deleteEmailIntelligenceMessage } from "../../services/email-intelligence";
import { processDueScheduledActions } from "../../services/automation";
import { runDurableAction } from "../../services/durable-execution";
import { signOutboundReplyEvidence, verifyOutboundReplyEvidence } from "../../services/reply-evidence";

const originalFetch = globalThis.fetch;
const environment = { key: process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY, webhook: process.env.EMAIL_INGESTION_WEBHOOK_SECRET };
let server: Server, base: string, org: string, alias: string, owner: string;
let externalRequests = 0;
let sid: string, foreignOrg: string, foreignUser: string, viewerSid: string;
const sessions: string[] = [];
async function session(id: string) {
  const value = await createSession({ user: { id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-reply-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(value); return value;
}

beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV !== "test" || !["127.0.0.1", "localhost"].includes(database.hostname)) throw new Error("Reply tests require an isolated local database.");
  process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  process.env.EMAIL_INGESTION_WEBHOOK_SECRET = "synthetic-reply-bridge-secret";
  const [company] = await db.insert(organizationsTable).values({ name: "Synthetic reply company", slug: `reply-${randomUUID()}` }).returning();
  org = company.id;
  const [user] = await db.insert(usersTable).values({ organizationId: org, email: "office@example.test", role: "owner", isActive: true }).returning();
  owner = user.id;
  sid = await session(owner);
  const [foreign] = await db.insert(organizationsTable).values({ name: "Other synthetic reply company", slug: `other-reply-${randomUUID()}` }).returning();
  foreignOrg = foreign.id;
  const [other] = await db.insert(usersTable).values({ organizationId: foreignOrg, role: "owner", isActive: true }).returning();
  foreignUser = other.id;
  const [viewer] = await db.insert(usersTable).values({ organizationId: org, role: "viewer", isActive: true }).returning();
  viewerSid = await session(viewer.id);
  alias = `test-${randomUUID()}`;
  await db.insert(emailIntelligenceSourcesTable).values({ organizationId: org, intakeAlias: alias, status: "active", allowedForwarders: ["office@example.test"] });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(target).origin !== base) { externalRequests++; throw new Error("External provider calls forbidden in reply rehearsal"); }
    return originalFetch(input, init);
  }) satisfies typeof fetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const id of sessions) await deleteSession(id);
  if (org) await deleteTestOrgs(org, foreignOrg);
  if (environment.key === undefined) delete process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY; else process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = environment.key;
  if (environment.webhook === undefined) delete process.env.EMAIL_INGESTION_WEBHOOK_SECRET; else process.env.EMAIL_INGESTION_WEBHOOK_SECRET = environment.webhook;
  expect(externalRequests).toBe(0);
});

async function fixture() {
  const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", email: "prospect@example.test" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org, contactId: contact.id, status: "follow_up", createdAt: new Date(Date.now() - 86_400_000) }).returning();
  const outboundId = randomUUID();
  await db.insert(activitiesTable).values({ organizationId: org, leadId: lead.id, contactId: contact.id, actorUserId: owner, type: "lead_email_sent", title: "Synthetic sent email", occurredAt: new Date(Date.now() - 60_000), metadata: { provider: "gmail", providerMessageId: outboundId, senderEmail: "office@example.test", acceptance: "accepted", deliveryConfirmed: false,
    ...signOutboundReplyEvidence({ provider: "gmail", id: outboundId, senderEmail: "office@example.test" }, { organizationId: org, leadId: lead.id, recipientEmail: contact.email! }, new Date(Date.now() - 60_000).toISOString()),
  } });
  return { lead, contact, outboundId };
}
async function ingest(body: Record<string, unknown>, signatureOverride?: string) {
  const raw = JSON.stringify(body), timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "synthetic-reply-bridge-secret").update(`${timestamp}.`).update(raw).digest("hex");
  return fetch(`${base}/api/v1/public/email-intelligence/intake/${alias}`, { method: "POST", headers: { "content-type": "application/json", "x-mogulforge-signature": signatureOverride ?? `t=${timestamp},v1=${signature}` }, body: raw });
}
function payload(outboundId: string) {
  return { externalMessageId: randomUUID(), forwardedBy: "office@example.test", from: "prospect@example.test", to: ["office@example.test"], subject: "Re: service request", text: "Please call me before following up again.", sentAt: new Date().toISOString(), replyTo: { provider: "gmail", outboundMessageId: outboundId, senderEmail: "office@example.test" } };
}
async function responseReview(messageId: string) {
  const [row] = await db.select().from(reviews).where(and(eq(reviews.organizationId, org), eq(reviews.externalMessageId, messageId)));
  expect(row).toBeDefined(); return row!;
}
const api = (path: string, body?: unknown, cookie = sid) => fetch(`${base}/api/v1${path}`, { method: body ? "POST" : "GET", headers: { cookie: `sid=${cookie}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function pendingWork(leadId: string, createdAt = new Date(Date.now() - 50_000)) {
  const [playbook] = await db.insert(playbooksTable).values({ organizationId: org, name: "Synthetic follow-up", category: "estimate_follow_up", steps: [{ channel: "email", delayMinutes: 10, prompt: "Synthetic, never dispatched" }] }).returning();
  const [enrollment] = await db.insert(enrollments).values({ organizationId: org, leadId, playbookId: playbook.id, category: "estimate_follow_up", status: "active", currentStep: 0, createdAt }).returning();
  const [action] = await db.insert(actions).values({ organizationId: org, action: { type: "send_email", params: { body: "Synthetic" } }, context: { leadId }, createdAt, runAt: new Date(Date.now() + 60_000) }).returning();
  const [proposal] = await db.insert(proposals).values({ organizationId: org, leadId, status: "approved", actionType: "send_email", title: "Synthetic follow-up", rationale: "Local test", createdAt }).returning();
  return { enrollment, action, proposal };
}

it("a signed reply with exact stored mailbox/message evidence records one lead-linked customer reply", async () => {
  const f = await fixture();
  const response = await ingest(payload(f.outboundId));
  expect(response.status).toBe(201);
  const replies = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.leadId, f.lead.id), eq(activitiesTable.type, "customer_reply")));
  expect(replies).toHaveLength(1);
});

it("pauses pending opportunity follow-up without consuming steps or cancelling service reminders", async () => {
  const f = await fixture(), work = await pendingWork(f.lead.id), body = payload(f.outboundId);
  const [reminder] = await db.insert(actions).values({ organizationId: org, action: { type: "appointment_reminder", params: {} }, context: { leadId: f.lead.id }, createdAt: new Date(Date.now() - 50_000), runAt: new Date(Date.now() + 60_000) }).returning();
  expect((await ingest(body)).status).toBe(201);
  const row = await responseReview(body.externalMessageId);
  expect(row).toMatchObject({ state: "confirmed", holdActive: true, effectSummary: { pausedEnrollments: 1, cancelledActions: 1, blockedProposals: 1, reconciliationRequired: 0 } });
  expect((await db.select().from(enrollments).where(eq(enrollments.id, work.enrollment.id)))[0]).toMatchObject({ status: "paused", currentStep: 0 });
  expect((await db.select().from(actions).where(eq(actions.id, work.action.id)))[0].status).toBe("cancelled");
  expect((await db.select().from(actions).where(eq(actions.id, reminder.id)))[0].status).toBe("pending");
  expect(await resumeEnrollment(org, work.enrollment.id)).toMatchObject({ status: "paused", currentStep: 0 });
  expect(await skipEnrollmentStep(org, work.enrollment.id)).toMatchObject({ status: "paused", currentStep: 0 });
  expect(await checkSendEligibility({ organizationId: org, leadId: f.lead.id, contact: f.contact, channel: "email", kind: "outreach" })).toMatchObject({ ok: false, reason: "customer_reply_requires_review" });
  expect(await checkSendEligibility({ organizationId: org, leadId: f.lead.id, contact: f.contact, channel: "email", kind: "transactional" })).toEqual({ ok: true });
});

it("repeated or concurrent identical delivery creates one action and changed content/identity conflicts", async () => {
  const f = await fixture(), body = payload(f.outboundId);
  expect((await Promise.all([ingest(body), ingest(body)])).map(r => r.status).sort()).toEqual([200, 201]);
  expect((await db.select().from(activitiesTable).where(and(eq(activitiesTable.leadId, f.lead.id), eq(activitiesTable.type, "customer_reply"))))).toHaveLength(1);
  expect((await ingest({ ...body, text: "Changed content" })).status).toBe(409);
  expect((await ingest({ ...body, replyTo: { ...body.replyTo, outboundMessageId: randomUUID() } })).status).toBe(409);
});

it("rejects tampering and verified flags instead of accepting client assertions", async () => {
  const f = await fixture(), body = payload(f.outboundId);
  expect((await ingest(body, "t=0,v1=bad")).status).toBe(401);
  expect((await ingest({ ...body, replyTo: { ...body.replyTo, verified: true } })).status).toBe(400);
  expect(await hasCustomerReplyHold(org, f.lead.id)).toBe(false);
});

it.each(["sender", "recipient", "mailbox", "provider", "message"])("%s mismatch stays in review and does not mutate follow-up", async mismatch => {
  const f = await fixture(), body = payload(f.outboundId), work = await pendingWork(f.lead.id);
  if (mismatch === "sender") body.from = "stranger@example.test";
  if (mismatch === "recipient") body.to = ["other@example.test"];
  if (mismatch === "mailbox") body.replyTo.senderEmail = "other@example.test";
  if (mismatch === "provider") body.replyTo.provider = "microsoft";
  if (mismatch === "message") body.replyTo.outboundMessageId = randomUUID();
  expect((await ingest(body)).status).toBe(201);
  expect(await responseReview(body.externalMessageId)).toMatchObject({ state: "needs_review", leadId: null, holdActive: false });
  expect((await db.select().from(enrollments).where(eq(enrollments.id, work.enrollment.id)))[0].status).toBe("active");
});

it("same email on two opportunities never guesses the job; staff must explicitly confirm one", async () => {
  const f = await fixture(), other = await fixture(), body = { ...payload(f.outboundId), replyTo: null };
  await ingest(body);
  const review = await responseReview(body.externalMessageId);
  expect(review.state).toBe("needs_review");
  expect(await hasCustomerReplyHold(org, f.lead.id)).toBe(false);
  const choice = { decision: "confirm", leadId: f.lead.id, note: "Matched the original customer thread to this exact service opportunity." };
  expect((await api(`/email-intelligence/replies/${review.id}/review`, choice)).status).toBe(200);
  expect((await api(`/email-intelligence/replies/${review.id}/review`, choice)).status).toBe(200);
  expect(await hasCustomerReplyHold(org, other.lead.id)).toBe(false);
  expect((await db.select().from(activitiesTable).where(and(eq(activitiesTable.leadId, f.lead.id), eq(activitiesTable.type, "customer_reply"))))).toHaveLength(1);
  expect((await api(`/email-intelligence/replies/${review.id}/review`, { ...choice, leadId: other.lead.id })).status).toBe(409);
});

it("one contact's second opportunity remains eligible while contact-only outreach requires context", async () => {
  const f = await fixture();
  const [second] = await db.insert(leadsTable).values({ organizationId: org, contactId: f.contact.id, status: "follow_up" }).returning();
  await ingest(payload(f.outboundId));
  expect(await hasCustomerReplyHold(org, second.id)).toBe(false);
  expect(await checkSendEligibility({ organizationId: org, contact: f.contact, channel: "email", kind: "outreach" })).toMatchObject({ ok: false, reason: "reply_requires_opportunity_context" });
  expect(await checkSendEligibility({ organizationId: org, leadId: second.id, contact: f.contact, channel: "email", kind: "outreach", sendingHours: { enabled: false, timezone: "UTC", days: [0,1,2,3,4,5,6], startHour: 0, endHour: 24, maxTouchesPerDay: 0 } as never })).toEqual({ ok: true });
});

it("tenant and role checks protect review, resolution, and queue visibility", async () => {
  const f = await fixture(), body = { ...payload(f.outboundId), replyTo: null };
  await ingest(body); const review = await responseReview(body.externalMessageId);
  const choice = { decision: "confirm" as const, leadId: f.lead.id, note: "Explicit original conversation reviewed." };
  await expect(reviewEmailResponse(foreignOrg, review.id, foreignUser, choice)).rejects.toMatchObject({ statusCode: 404 });
  expect((await api(`/email-intelligence/replies/${review.id}/review`, choice, viewerSid)).status).toBe(403);
  const foreignSid = await session(foreignUser);
  expect(await (await api("/email-intelligence/replies?scope=all", undefined, foreignSid)).json()).toMatchObject({ items: [], total: 0 });
});

it.each(["review", "resolve"])("%s rejects sibling/cross-origin and form-encoded browser mutations", async endpoint => {
  const f = await fixture(), body = payload(f.outboundId); await ingest(body);
  const review = await responseReview(body.externalMessageId);
  const url = `${base}/api/v1/email-intelligence/replies/${review.id}/${endpoint}`;
  for (const origin of ['https://malicious.invalid', 'null']) {
    expect((await fetch(url, { method: "POST", headers: { cookie: `sid=${sid}`, origin, "content-type": "application/json" }, body: JSON.stringify({ decision: "dismiss", note: "A synthetic forged mutation." }) })).status).toBe(403);
  }
  expect((await fetch(url, { method: "POST", headers: { cookie: `sid=${sid}`, "content-type": "application/x-www-form-urlencoded" }, body: "decision=dismiss&note=A+synthetic+forged+mutation" })).status).toBe(415);
  expect((await responseReview(body.externalMessageId)).holdActive).toBe(true);
  const oldOrigin = process.env.APP_ORIGIN;
  try {
    process.env.APP_ORIGIN = base;
    const response = await fetch(url, { method: "POST", headers: { cookie: `sid=${sid}`, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(endpoint === "review" ? { decision: "confirm", leadId: f.lead.id, note: "The office confirmed the exact original conversation." } : { note: "The office has handled this exact customer reply." }) });
    expect(response.status).toBe(200);
  } finally { if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin; }
});

it("a generic timeline activity cannot forge accepted outbound identity", async () => {
  const f = await fixture(), forgedMessageId = randomUUID();
  const forged = await api(`/leads/${f.lead.id}/activities`, { type: "email_sent", title: "Staff recorded activity", metadata: { provider: "gmail", providerMessageId: forgedMessageId, senderEmail: "office@example.test", acceptance: "accepted" } });
  expect(forged.status).toBe(201);
  const body = payload(forgedMessageId); await ingest(body);
  expect(await responseReview(body.externalMessageId)).toMatchObject({ state: "needs_review", reason: "unverified_outbound_evidence", holdActive: false });
});

it("unsigned newer timeline activity cannot supersede a genuine reply", async () => {
  const f = await fixture(), body = { ...payload(f.outboundId), sentAt: new Date(Date.now() - 20_000).toISOString() };
  await api(`/leads/${f.lead.id}/activities`, { type: "email_sent", title: "Staff note pretending to be a newer send", metadata: { provider: "gmail", providerMessageId: randomUUID(), senderEmail: "office@example.test", acceptance: "accepted" } });
  await ingest(body);
  expect(await responseReview(body.externalMessageId)).toMatchObject({ state: "confirmed", holdActive: true });
});

it("acceptance proof cannot be transplanted or have its timestamp, recipient, or mailbox changed", async () => {
  const f = await fixture();
  const [activity] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.leadId, f.lead.id), eq(activitiesTable.type, "lead_email_sent")));
  const context = { organizationId: org, leadId: f.lead.id };
  expect(verifyOutboundReplyEvidence(activity.metadata, context)).toBeInstanceOf(Date);
  expect(verifyOutboundReplyEvidence(activity.metadata, { ...context, organizationId: foreignOrg })).toBeNull();
  expect(verifyOutboundReplyEvidence(activity.metadata, { ...context, leadId: randomUUID() })).toBeNull();
  for (const patch of [{ senderEmail: "another@example.test" }, { replyEvidenceAcceptedAt: new Date().toISOString() }, { replyEvidenceRecipient: "another@example.test" }])
    expect(verifyOutboundReplyEvidence({ ...activity.metadata, ...patch }, context)).toBeNull();
});

it("missing evidence key preserves successful send metadata and requires staff review later", async () => {
  const f = await fixture(), originalKey = process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY;
  let proof;
  try {
    delete process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY;
    proof = signOutboundReplyEvidence({ provider: "gmail", id: "accepted-without-key", senderEmail: "office@example.test" }, { organizationId: org, leadId: f.lead.id, recipientEmail: f.contact.email! });
    expect(proof).toEqual({});
    process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = "malformed-key";
    expect(signOutboundReplyEvidence({ provider: "gmail", id: "accepted-without-key", senderEmail: "office@example.test" }, { organizationId: org, leadId: f.lead.id, recipientEmail: f.contact.email! })).toEqual({});
  } finally { process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = originalKey; }
  await db.insert(activitiesTable).values({ organizationId: org, leadId: f.lead.id, type: "lead_email_sent", title: "Synthetic accepted send without inbox key", metadata: { provider: "gmail", providerMessageId: "accepted-without-key", senderEmail: "office@example.test", acceptance: "accepted", ...proof } });
  const body = payload("accepted-without-key"); await ingest(body);
  expect(await responseReview(body.externalMessageId)).toMatchObject({ state: "needs_review", reason: "unverified_outbound_evidence" });
});

it("preserves original reply time and does not cancel a later conversation or workflow", async () => {
  const f = await fixture(), old = new Date(Date.now() - 40_000), work = await pendingWork(f.lead.id, new Date(Date.now() - 20_000));
  const body = { ...payload(f.outboundId), sentAt: old.toISOString() };
  await ingest(body);
  expect(await responseReview(body.externalMessageId)).toMatchObject({ state: "confirmed", reason: "historical_reply", holdActive: false });
  expect((await db.select().from(enrollments).where(eq(enrollments.id, work.enrollment.id)))[0].status).toBe("active");
  expect((await db.select().from(proposals).where(eq(proposals.id, work.proposal.id)))[0].status).toBe("approved");
  const [activity] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.leadId, f.lead.id), eq(activitiesTable.type, "customer_reply")));
  expect(activity.occurredAt.toISOString()).toBe(old.toISOString());
  expect(activity.createdAt.getTime()).toBeGreaterThan(old.getTime());
});

it.each([null, "2099-01-01T00:00:00.000Z"])("unknown or future original time (%s) needs explicit review", async sentAt => {
  const f = await fixture(), body = { ...payload(f.outboundId), sentAt };
  await ingest(body); const review = await responseReview(body.externalMessageId);
  expect(review).toMatchObject({ state: "needs_review", holdActive: false });
  await expect(reviewEmailResponse(org, review.id, owner, { decision: "confirm", leadId: f.lead.id, note: "Confirmed original service thread." })).rejects.toMatchObject({ statusCode: 400 });
});

it("raw/message deletion retains duplicate protection and a confirmed hold", async () => {
  const f = await fixture(), body = payload(f.outboundId);
  await ingest(body); const review = await responseReview(body.externalMessageId);
  await deleteEmailIntelligenceMessage(org, review.messageId!, owner);
  expect((await ingest(body)).status).toBe(200);
  expect(await hasCustomerReplyHold(org, f.lead.id)).toBe(true);
  expect((await ingest({ ...body, text: "Altered after deletion" })).status).toBe(409);
});

it("resolving a reply never resumes cancelled work and imported source holds remain", async () => {
  const f = await fixture(), work = await pendingWork(f.lead.id), body = payload(f.outboundId);
  await db.update(leadsTable).set({ creationMethod: "import" }).where(eq(leadsTable.id, f.lead.id));
  await ingest(body); const review = await responseReview(body.externalMessageId);
  await releaseEmailResponseHold(org, review.id, owner, "Office handled the reply and approved separate new follow-up.");
  expect((await db.select().from(actions).where(eq(actions.id, work.action.id)))[0].status).toBe("cancelled");
  expect((await db.select().from(enrollments).where(eq(enrollments.id, work.enrollment.id)))[0].status).toBe("paused");
  expect(await checkSendEligibility({ organizationId: org, leadId: f.lead.id, contact: f.contact, channel: "email", kind: "outreach" })).toMatchObject({ ok: false, reason: "imported_source_requires_current_review" });
  expect((await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.entityId, review.id), eq(auditEventsTable.action, "customer_reply.hold_resolved"))))).toHaveLength(1);
});

it("claimed or uncertain executions remain available for reconciliation", async () => {
  const f = await fixture(), work = await pendingWork(f.lead.id), body = payload(f.outboundId);
  await db.insert(executions).values([
    { organizationId: org, actionKey: `scheduled:${work.action.id}`, fingerprint: "synthetic", kind: "send_email", state: "processing", expiresAt: new Date(Date.now() + 60_000) },
    { organizationId: org, actionKey: `bie:${work.proposal.id}`, fingerprint: "synthetic", kind: "send_email", state: "indeterminate", expiresAt: new Date(Date.now() - 60_000) },
  ]);
  await ingest(body); const review = await responseReview(body.externalMessageId);
  expect(review.effectSummary).toMatchObject({ cancelledActions: 0, blockedProposals: 0, reconciliationRequired: 2 });
  expect((await db.select().from(actions).where(eq(actions.id, work.action.id)))[0].status).toBe("pending");
  expect((await db.select().from(proposals).where(eq(proposals.id, work.proposal.id)))[0].status).toBe("approved");
  expect((await db.select().from(executions).where(eq(executions.actionKey, `bie:${work.proposal.id}`)))[0].state).toBe("indeterminate");
});

it("reply review and resolution preserve the current company pause", async () => {
  const f = await fixture(), body = payload(f.outboundId);
  await db.insert(customerLifecycleTable).values({ organizationId: org, state: "paused", reason: "Synthetic office pause", updatedByUserId: owner });
  try {
    expect((await ingest(body)).status).toBe(201);
    const review = await responseReview(body.externalMessageId);
    await releaseEmailResponseHold(org, review.id, owner, "Office handled the reply during the company pause.");
    expect((await db.select().from(customerLifecycleTable).where(eq(customerLifecycleTable.organizationId, org)))[0].state).toBe("paused");
    expect(await checkSendEligibility({ organizationId: org, leadId: f.lead.id, contact: f.contact, channel: "email", kind: "outreach" })).toMatchObject({ ok: false, reason: "customer_lifecycle_paused" });
  } finally { await db.delete(customerLifecycleTable).where(eq(customerLifecycleTable.organizationId, org)); }
});

it("fresh scheduled follow-up after a held reply is blocked by the runtime without sending", async () => {
  const f = await fixture(); await ingest(payload(f.outboundId));
  const [action] = await db.insert(actions).values({ organizationId: org, action: { type: "send_email", params: {} }, context: { leadId: f.lead.id }, runAt: new Date(Date.now() - 1000) }).returning();
  await processDueScheduledActions(org);
  expect((await db.select().from(actions).where(eq(actions.id, action.id)))[0].status).toBe("done");
  expect((await db.select().from(executions).where(eq(executions.actionKey, `scheduled:${action.id}`)))[0].state).toBe("blocked");
});

// PGlite emulates a single PostgreSQL session and cannot establish cross-session
// advisory-lock ordering. The normal PostgreSQL CI suite must run this case.
it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("a reply queued before a durable claim cancels before dispatch across PostgreSQL sessions", async () => {
  const f = await fixture(), work = await pendingWork(f.lead.id);
  await db.update(actions).set({ runAt: new Date(Date.now() - 1000) }).where(eq(actions.id, work.action.id));
  const [previousSettings] = await db.select().from(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org));
  // This race must reach the claim boundary at any CI wall-clock time. Quiet
  // hours and contact-budget deferrals have their own separate tests.
  const sendingHours = { quietHoursEnabled: false, timezone: "UTC", startHour: 0, endHour: 24, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], maxTouchesPerDay: 0 };
  await db.insert(orgSettingsTable).values({ organizationId: org, sendingHours }).onConflictDoUpdate({ target: orgSettingsTable.organizationId, set: { sendingHours } });
  const writer = await pool.connect();
  let intake: Promise<Response> | undefined, scheduled: Promise<void> | undefined;
  try {
    await writer.query("BEGIN");
    const { rows: [{ pid }] } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const replyKey = `customer-reply:${org}:${f.lead.id}`;
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [replyKey]);
    const waitingOn = async (blockerPid: number, key: string, boundary: string) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        // Prove the exact exclusive bigint-key advisory lock and its granted
        // owner, not a count of unrelated or transitive database waiters.
        const { rows } = await pool.query<{ pid: number }>(`
          SELECT waiting.pid
          FROM pg_locks waiting
          JOIN pg_locks held ON held.locktype = waiting.locktype
            AND held.database IS NOT DISTINCT FROM waiting.database
            AND held.classid = waiting.classid AND held.objid = waiting.objid
            AND held.objsubid = waiting.objsubid
          JOIN pg_stat_activity activity ON activity.pid = waiting.pid
          WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
            AND waiting.mode = 'ExclusiveLock' AND held.granted
            AND held.mode = 'ExclusiveLock' AND held.pid = $1
            AND $1 = ANY(pg_blocking_pids(waiting.pid))
            AND waiting.classid::bigint = ((hashtextextended($2, 0) >> 32) & 4294967295)
            AND waiting.objid::bigint = (hashtextextended($2, 0) & 4294967295)
            AND waiting.objsubid = 1 AND activity.state = 'active'
            AND activity.wait_event_type = 'Lock' AND activity.wait_event = 'advisory'
        `, [blockerPid, key]);
        if (rows.length) {
          expect(rows).toHaveLength(1);
          return rows[0].pid;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Expected an independent PostgreSQL session waiting on the exact ${boundary} lock held by backend ${blockerPid}.`);
    };
    intake = ingest(payload(f.outboundId));
    const intakePid = await waitingOn(pid, replyKey, "customer-reply");
    scheduled = processDueScheduledActions(org);
    // Intake owns the shared company prefix before it waits for the reply lock.
    // The real scheduler claim therefore waits on intake's first prefix lock,
    // not directly on the test writer: writer -> intake -> scheduler.
    const schedulerPid = await waitingOn(intakePid, `customer-lifecycle:${org}`, "customer-lifecycle");
    expect(new Set([pid, intakePid, schedulerPid]).size).toBe(3);
    const { rows: [{ blockers }] } = await pool.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [schedulerPid]);
    expect(blockers).toContain(intakePid);
    expect(blockers).not.toContain(pid);
    expect(await db.select().from(executions).where(eq(executions.actionKey, `scheduled:${work.action.id}`))).toHaveLength(0);
    expect((await db.select().from(actions).where(eq(actions.id, work.action.id)))[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(externalRequests).toBe(0);
    await writer.query("COMMIT");
    expect((await intake).status).toBe(201);
    await scheduled;
    expect((await db.select().from(actions).where(eq(actions.id, work.action.id)))[0].status).toBe("cancelled");
    expect((await db.select().from(executions).where(eq(executions.actionKey, `scheduled:${work.action.id}`)))[0].state).toBe("blocked");
    expect(externalRequests).toBe(0);
  } finally {
    await writer.query("ROLLBACK"); writer.release();
    await Promise.allSettled([...(intake ? [intake] : []), ...(scheduled ? [scheduled] : [])]);
    if (previousSettings) await db.update(orgSettingsTable).set({ sendingHours: previousSettings.sendingHours }).where(eq(orgSettingsTable.organizationId, org));
    else await db.delete(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org));
  }
});

it("a reply arriving after a durable claim preserves the final accepted receipt", async () => {
  const f = await fixture(), work = await pendingWork(f.lead.id);
  let entered!: () => void, finish!: () => void;
  const claimed = new Promise<void>(resolve => { entered = resolve; }), ack = new Promise<void>(resolve => { finish = resolve; });
  const execution = runDurableAction({ organizationId: org, leadId: f.lead.id, actionKey: `scheduled:${work.action.id}`, kind: "send_email", payload: work.action.action,
    execute: async () => { entered(); await ack; return { state: "succeeded", detail: "Synthetic accepted effect; no provider call." }; } });
  try {
    await claimed;
    const body = payload(f.outboundId); await ingest(body);
    expect((await responseReview(body.externalMessageId)).effectSummary?.reconciliationRequired).toBe(1);
    expect((await db.select().from(actions).where(eq(actions.id, work.action.id)))[0].status).toBe("pending");
  } finally { finish(); }
  expect((await execution).state).toBe("succeeded");
});

it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite").each(["resume", "skip"] as const)("a concurrent %s cannot overwrite a committed reply hold", async operation => {
  const f = await fixture(), work = await pendingWork(f.lead.id);
  if (operation === "resume") await db.update(enrollments).set({ status: "paused" }).where(eq(enrollments.id, work.enrollment.id));
  const writer = await pool.connect();
  let intake: Promise<Response> | undefined, transition: ReturnType<typeof resumeEnrollment> | undefined;
  try {
    await writer.query("BEGIN");
    const { rows: [{ pid }] } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`customer-reply:${org}:${f.lead.id}`]);
    const waiting = async (minimum: number) => {
      await vi.waitFor(async () => {
        const result = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
        expect(result.rows[0].count).toBeGreaterThanOrEqual(minimum);
      }, { timeout: 3000, interval: 20 });
    };
    intake = ingest(payload(f.outboundId)); await waiting(1);
    transition = (operation === "resume" ? resumeEnrollment : skipEnrollmentStep)(org, work.enrollment.id); await waiting(2);
    await writer.query("COMMIT");
    expect((await intake).status).toBe(201);
    expect(await transition).toMatchObject({ status: "paused", currentStep: 0 });
    expect((await db.select().from(enrollments).where(eq(enrollments.id, work.enrollment.id)))[0]).toMatchObject({ status: "paused", currentStep: 0 });
  } finally {
    await writer.query("ROLLBACK"); writer.release();
    await Promise.allSettled([...(intake ? [intake] : []), ...(transition ? [transition] : [])]);
  }
});
