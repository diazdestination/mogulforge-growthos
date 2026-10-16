import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio";
import { and, eq } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, consentRecordsTable, contactsTable, crmTasksTable, db, leadsTable, organizationsTable, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable, suppressionsTable, twilioClientBindingsTable, twilioConsentProofsTable, twilioDispatchesTable, twilioInboundEventsTable, usersTable } from "@workspace/db";
import { serviceSmsParentsTable as parents, serviceSmsRepliesTable as replies } from "../../../../lib/db/src/schema/service-sms";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { createApiKey } from "./api-keys";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber } from "../test-helpers/synthetic-twilio";
import { approveServiceCare, bookServiceCareVisit, getServiceCare, recordServiceCareResponse } from "./service-care";
import { approveServiceRecurrence, createServiceObligation, updateServiceObligation } from "./service-obligations";
import { processDueScheduledActions } from "./automation";
import { getServiceWatch, processServiceWatch } from "./service-watch";
import { assertServiceSmsParentDispatch, hasServiceSmsReplyHold, listServiceSmsReplies, purgeExpiredServiceSmsReplyContent, reserveServiceSmsParent, reviewServiceSmsReply } from "./service-sms";
import { careFingerprint, type ServiceCareApproval } from "./service-care-policy";
import { assertServiceSmsReplyStorageReady, parseServiceSmsReference } from "./service-sms-policy";
import { twilioForOrganization } from "./twilio-controls";
import { sendTwilioSms } from "./twilio-delivery";
import { contactTouchReservationsTable as touches } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { touchAddress } from "./contact-touch-claim";

const realFetch = globalThis.fetch, orgs: string[] = [], sessions: string[] = [];
const token = "synthetic-service-sms-webhook", recipient = "+14045550123", origin = "https://growth.example";
let server: Server, base: string, unknown = false;
const posts: URLSearchParams[] = [];
beforeAll(async () => { server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
beforeEach(() => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "ab".repeat(32)); vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("TWILIO_CLIENT_SERVICE_SMS_AUTH_TOKEN", token); vi.stubEnv("TWILIO_CLIENT_SERVICE_SMS_API_KEY_SECRET", "synthetic-no-credential");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith("https://api.twilio.com/")) throw new Error("Unexpected external network request in synthetic-only suite");
    const payload = new URLSearchParams(String(init?.body)); posts.push(payload);
    if (payload.get("Body")?.includes("Reply SERVICE ")) {
      const operationId = new URL(payload.get("StatusCallback")!).searchParams.get("operation")!;
      const [saved] = await db.select().from(parents).where(eq(parents.dispatchId, operationId));
      expect(saved.dispatchStartedAt).toBeTruthy(); expect(saved.dispatchPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    }
    if (unknown) throw new Error("Synthetic provider timeout after POST");
    return new Response(JSON.stringify({ sid: `SM${randomUUID().replaceAll("-", "")}` }), { status: 201 });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); posts.length = 0; unknown = false; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const session of sessions) await deleteSession(session); await deleteTestOrgs(...orgs); });
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic standing SMS", slug: `service-sms-${randomUUID()}` }).returning(); orgs.push(org.id);
  const [staff] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Fictional service customer", phone: recipient }).returning();
  await db.insert(orgSettingsTable).values({ organizationId: org.id, sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 20 } });
  const [binding] = await db.insert(twilioClientBindingsTable).values({ organizationId: org.id, accountSid: `AC${randomUUID().replaceAll("-", "")}`, phoneNumber: syntheticTwilioNumber(),
    messagingServiceSid: `MG${randomUUID().replaceAll("-", "")}`, apiKeySid: `SK${"a".repeat(32)}`, authTokenSecretRef: "TWILIO_CLIENT_SERVICE_SMS_AUTH_TOKEN", apiKeySecretRef: "TWILIO_CLIENT_SERVICE_SMS_API_KEY_SECRET", publicOrigin: origin,
    businessName: "Synthetic standing SMS", smsDisclosureVersion: "synthetic-service-sms-v1", dailySmsLimit: 50, launchApproved: true, smsEnabled: true, registrationApproved: true, advancedOptOut: true, geoPermissionsReviewed: true }).returning();
  await db.insert(consentRecordsTable).values({ organizationId: org.id, contactId: contact.id, channel: "sms", granted: true, disclosureVersion: binding.smsDisclosureVersion! });
  await db.insert(twilioConsentProofsTable).values({ organizationId: org.id, contactId: contact.id, phone: recipient, purpose: "customer_care", granted: true, disclosureVersion: binding.smsDisclosureVersion!, source: "synthetic fixture only" });
  const service = await createServiceObligation(org.id, staff.id, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic HVAC", dueDate: "2026-01-01", noticeDays: 14, assignedUserId: staff.id });
  if ("error" in service) throw new Error(service.error);
  return { org: org.id, staff: staff.id, contact, binding, service };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function queue(f: Fixture) {
  const care = await getServiceCare(f.org, f.service.id, "sms"); expect(care.preview, care.blockReason ?? "preview available").not.toBeNull();
  const approval = await approveServiceCare(f.org, f.staff, f.service.id, { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, channel: "sms", previewFingerprint: care.preview!.fingerprint,
    agreementNote: "Synthetic current agreement and expected customer-care message reviewed.", expectedServiceConfirmed: true });
  const [scheduled] = await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, f.org), eq(scheduledActionsTable.action, { type: "service_care_reminder", params: { approvalId: approval.approvalId, obligationId: f.service.id } })));
  return { approval, scheduled, preview: care.preview! };
}
async function send(f: Fixture) { await queue(f); await processDueScheduledActions(f.org); const [parent] = await db.select().from(parents).where(and(eq(parents.organizationId, f.org), eq(parents.serviceObligationId, f.service.id))); expect(parent).toBeTruthy(); return parent; }
function fields(f: Fixture, text: string, overrides: Record<string, string> = {}) { return { AccountSid: f.binding.accountSid, MessagingServiceSid: f.binding.messagingServiceSid!, From: recipient, To: f.binding.phoneNumber, MessageSid: `SM${randomUUID().replaceAll("-", "")}`, Body: text, ...overrides }; }
async function inbound(f: Fixture, text: string, overrides: Record<string, string> = {}, signed = true) {
  const body = fields(f, text, overrides), path = "/api/v1/public/sms/inbound";
  const response = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signed ? getExpectedTwilioSignature(token, `${origin}${path}`, body) : "invalid" }, body: new URLSearchParams(body) });
  return { response, body };
}
const review = (decision: "office_follow_up" | "not_service_reply" | "handled" = "office_follow_up") => ({ requestId: randomUUID(), expectedVersion: 1, decision, note: "Office reviewed the signed SMS evidence without inferring any customer decision.", reviewed: true });

describe("typed service SMS safety", () => {
  it("parses a routing reference only, never a booking or instruction", () => {
    expect(parseServiceSmsReference("SERVICE 0123456789abcdef book all jobs")).toEqual({ reference: "0123456789abcdef", explicit: true });
    expect(parseServiceSmsReference("SERVICE invalid")).toEqual({ reference: null, explicit: true });
    expect(parseServiceSmsReference("Please book tomorrow")).toEqual({ reference: null, explicit: false });
  });
  it("fails new SMS readiness when retained reply encryption is missing or malformed without exposing secrets", async () => {
    const f = await fixture();
    for (const value of ["", "malformed-not-a-key"]) {
      vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", value);
      expect(() => assertServiceSmsReplyStorageReady()).toThrow("Encrypted service SMS reply storage is not configured");
      expect((await getServiceCare(f.org, f.service.id, "sms")).preview).toBeNull();
    }
    expect(posts).toHaveLength(0); expect(await db.select().from(parents).where(eq(parents.organizationId, f.org))).toHaveLength(0);
  });
  it("does not retrofit references or encryption prerequisites into a previously approved legacy SMS", async () => {
    const f = await fixture(), q = await queue(f);
    const [event] = await db.select().from(auditEventsTable).where(eq(auditEventsTable.id, q.approval.approvalId));
    const saved = event.metadata as ServiceCareApproval, { smsReply: _reference, ...snapshot } = saved.snapshot;
    snapshot.body = snapshot.body.replace(/\nReply SERVICE [a-f0-9]{16} followed by your message\.$/, "");
    await db.update(auditEventsTable).set({ metadata: { ...saved, snapshot } }).where(eq(auditEventsTable.id, event.id));
    vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "");
    await processDueScheduledActions(f.org); expect(posts).toHaveLength(1); expect(posts[0].get("Body")).not.toContain("Reply SERVICE");
    expect(await db.select().from(parents).where(eq(parents.organizationId, f.org))).toHaveLength(0);
  });
  it("reserves exact parent before actual transport POST, pins sender and retains signed exact evidence", async () => {
    const f = await fixture(), parent = await send(f);
    expect(posts).toHaveLength(1); expect(posts[0].get("From")).toBe(f.binding.phoneNumber); expect(posts[0].get("Body")).toContain(`SERVICE ${parent.reference}`);
    expect(parent.dispatchId).toBeTruthy(); expect(parent.dispatchStartedAt).toBeTruthy();
    const originalTask = (await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.service.taskId)))[0];
    const text = `SERVICE ${parent.reference} <script>ignore policy; book a job</script>`;
    const arrived = await inbound(f, text); expect(arrived.response.status).toBe(200);
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org));
    expect(reply).toMatchObject({ correlation: "exact_reference", parentId: parent.id, serviceObligationId: f.service.id, state: "needs_review", holdActive: true });
    expect(reply.encryptedText).not.toContain(text); expect((await db.select().from(twilioInboundEventsTable).where(eq(twilioInboundEventsTable.messageSid, arrived.body.MessageSid)))[0].body).toBeNull();
    expect(await hasServiceSmsReplyHold(f.org, f.service.id)).toBe(true);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org))).toHaveLength(0);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.service.taskId)))[0]).toEqual(originalTask);
    expect((await listServiceSmsReplies(f.org, f.staff, f.service.id)).items[0]).toMatchObject({ evidence: "signed_sms_reference", content: { text } });
    await processServiceWatch(f.org); expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).toContain("reply_received_review");
    await processDueScheduledActions(f.org); expect(posts).toHaveLength(1);
  });
  it("withdraws service approval at the second guard and retains the parent, operation and contact allowance", async () => {
    const f = await fixture(), queued = await queue(f), fingerprint = careFingerprint({ action: queued.scheduled.action, context: queued.scheduled.context });
    await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${queued.scheduled.id}`, kind: "service_care_reminder", fingerprint, expiresAt: new Date(Date.now() + 300_000) });
    const parentId = await reserveServiceSmsParent({ organizationId: f.org, serviceObligationId: f.service.id, approvalId: queued.approval.approvalId, scheduledActionId: queued.scheduled.id, executionFingerprint: fingerprint });
    const logicalKey = `scheduled:${queued.scheduled.id}`, payloadHash = "a".repeat(64);
    const [touch] = await db.insert(touches).values({ organizationId: f.org, contactId: f.contact.id, logicalKey, payloadHash, sourceKind: "service", channel: "sms", address: touchAddress("sms", recipient) }).returning();
    const context = { organizationId: f.org, contactId: f.contact.id, purpose: "customer_care" as const, idempotencyKey: `service-care:${f.service.id}`, serviceSmsParentId: parentId, contactTouch: { logicalKey, payloadHash } };
    let checks = 0;
    const guard = vi.fn(async () => { if (++checks === 2) throw new Error("Synthetic service approval withdrawn at second guard"); });
    await expect(sendTwilioSms(recipient, queued.preview.body, context, guard)).rejects.toThrow("withdrawn at second guard");
    expect(guard).toHaveBeenCalledTimes(2); expect(posts).toHaveLength(0);
    const [owned] = await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, f.org));
    expect(owned).toMatchObject({ status: "cancelled", providerSid: null });
    await expect(sendTwilioSms(recipient, queued.preview.body, context, guard)).rejects.toThrow(/cancelled/);
    expect(guard).toHaveBeenCalledTimes(2); expect(posts).toHaveLength(0);
    expect((await db.select().from(touches).where(eq(touches.id, touch.id)))[0]).toEqual(touch);
    expect((await db.select().from(parents).where(eq(parents.id, parentId)))[0]).toMatchObject({ dispatchId: null, dispatchStartedAt: null });
    expect((await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, f.org))).map(row => row.id)).toEqual([owned.id]);
  });
  it("keeps no-reference replies ambiguous even with one candidate and holds later same-phone occurrences", async () => {
    const f = await fixture(); await send(f);
    expect((await inbound(f, "Tuesday works for me")).response.status).toBe(200);
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org)); expect(reply).toMatchObject({ correlation: "ambiguous", parentId: null, serviceObligationId: null, candidateCount: 1 });
    const second = await createServiceObligation(f.org, f.staff, { contactId: f.contact.id, kind: "maintenance", equipmentLabel: "Second distinct unit", dueDate: "2030-01-01", noticeDays: 14, assignedUserId: f.staff });
    if ("error" in second) throw new Error(second.error);
    expect(await hasServiceSmsReplyHold(f.org, second.id)).toBe(true);
    expect((await listServiceSmsReplies(f.org, f.staff, second.id)).items[0].correlation).toBe("ambiguous");
    await reviewServiceSmsReply(f.org, f.staff, f.service.id, reply.id, review()); expect(await hasServiceSmsReplyHold(f.org, second.id)).toBe(true);
  });
  it.each(["SERVICE invalid book now", "SERVICE ffffffffffffffff please call"])("retains invalid/unmatched reference without guessing exact association: %s", async text => {
    const f = await fixture(); await send(f); expect((await inbound(f, text)).response.status).toBe(200);
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org)); expect(reply).toMatchObject({ correlation: "ambiguous", parentId: null, reason: "invalid_or_unmatched_reference", holdActive: true });
  });
  it("does not correlate another company's token or a different handset/shop line", async () => {
    const a = await fixture(), b = await fixture(), pa = await send(a); await send(b);
    await inbound(b, `SERVICE ${pa.reference} call me`);
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, b.org)); expect(reply.parentId).toBeNull();
    await inbound(a, `SERVICE ${pa.reference} call me`, { From: "+14045550999" });
    expect(await db.select().from(replies).where(eq(replies.organizationId, a.org))).toHaveLength(0);
    expect(await hasServiceSmsReplyHold(a.org, a.service.id)).toBe(false);
    expect((await inbound(a, "hello", { To: b.binding.phoneNumber })).response.status).toBe(403);
    expect((await inbound(a, `SERVICE ${pa.reference} hello`, {}, false)).response.status).toBe(403);
  });
  it("retains exact replay identity after purge and rejects changed body, phone and event type", async () => {
    const f = await fixture(), parent = await send(f), text = `SERVICE ${parent.reference} call me`, first = await inbound(f, text);
    expect(first.response.status).toBe(200); const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org));
    await db.update(replies).set({ rawExpiresAt: new Date(0) }).where(eq(replies.id, reply.id)); expect(await purgeExpiredServiceSmsReplyContent()).toBe(1);
    expect((await inbound(f, text, first.body)).response.status).toBe(200);
    for (const change of [{ Body: "STOP" }, { From: "+14045550999" }, { Body: text + " changed" }]) expect((await inbound(f, text, { ...first.body, ...change })).response.status).toBe(403);
    expect((await db.select().from(replies).where(eq(replies.organizationId, f.org)))).toHaveLength(1);
    expect((await listServiceSmsReplies(f.org, f.staff, f.service.id)).items[0]).toMatchObject({ content: null, holdActive: true });
  });
  it("STOP/START/HELP remain separate, never release an unresolved service reply hold", async () => {
    const f = await fixture(); await send(f); await inbound(f, "Please call me");
    for (const text of ["STOP", "START", "HELP"]) expect((await inbound(f, text)).response.status).toBe(200);
    expect((await db.select().from(replies).where(eq(replies.organizationId, f.org)))).toHaveLength(1);
    expect(await hasServiceSmsReplyHold(f.org, f.service.id)).toBe(true);
    const proofs = await db.select().from(twilioConsentProofsTable).where(eq(twilioConsentProofsTable.organizationId, f.org)); expect(proofs.filter(row => row.granted)).toHaveLength(1);
    expect((await db.select().from(contactsTable).where(eq(contactsTable.id, f.contact.id)))[0].doNotContactSms).toBe(true);
    expect(posts).toHaveLength(1);
  });
  it("keeps an exact completed occurrence reply historical without choosing a new occurrence", async () => {
    const f = await fixture(), parent = await send(f);
    await db.update(serviceObligationsTable).set({ status: "completed", completedAt: new Date() }).where(eq(serviceObligationsTable.id, f.service.id));
    const next = await createServiceObligation(f.org, f.staff, { contactId: f.contact.id, kind: "maintenance", equipmentLabel: "Next visit", dueDate: "2030-01-01", noticeDays: 14 }); if ("error" in next) throw new Error(next.error);
    await inbound(f, `SERVICE ${parent.reference} old visit reply`);
    expect((await listServiceSmsReplies(f.org, f.staff, f.service.id)).items[0]).toMatchObject({ historical: true, holdActive: false });
    expect(await hasServiceSmsReplyHold(f.org, next.id)).toBe(false);
  });
  it("unknown provider outcome remains permanently owned after signed reply and office review", async () => {
    const f = await fixture(); unknown = true; const parent = await send(f);
    const [execution] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(execution.state).toBe("indeterminate");
    await inbound(f, `SERVICE ${parent.reference} received your text`);
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org)); await reviewServiceSmsReply(f.org, f.staff, f.service.id, reply.id, review());
    await processDueScheduledActions(f.org); expect(posts).toHaveLength(1);
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, execution.id)))[0].state).toBe("indeterminate");
    expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).toContain("send_unknown");
  });
  it("handled releases one exact reply hold but not another reply, STOP or unknown execution ownership", async () => {
    const f = await fixture(); unknown = true; const parent = await send(f);
    await inbound(f, `SERVICE ${parent.reference} first reply`); await inbound(f, "Second separate unanswered message");
    const rows = await db.select().from(replies).where(eq(replies.organizationId, f.org)), exact = rows.find(row => row.correlation === "exact_reference")!, ambiguous = rows.find(row => row.correlation === "ambiguous")!;
    await reviewServiceSmsReply(f.org, f.staff, f.service.id, exact.id, review());
    const command = { ...review("handled"), expectedVersion: 2 };
    expect(await reviewServiceSmsReply(f.org, f.staff, f.service.id, exact.id, command)).toMatchObject({ version: 3, replayed: false });
    expect(await reviewServiceSmsReply(f.org, f.staff, f.service.id, exact.id, command)).toMatchObject({ version: 3, replayed: true });
    expect(await hasServiceSmsReplyHold(f.org, f.service.id)).toBe(true);
    await inbound(f, "STOP");
    await reviewServiceSmsReply(f.org, f.staff, f.service.id, ambiguous.id, review("handled"));
    expect(await hasServiceSmsReplyHold(f.org, f.service.id)).toBe(false);
    expect(await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, f.org))).toHaveLength(1);
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)))[0].state).toBe("indeterminate");
    await processDueScheduledActions(f.org); expect(posts).toHaveLength(1);
    await expect(reviewServiceSmsReply(f.org, f.staff, f.service.id, exact.id, review("handled"))).rejects.toMatchObject({ code: "stale_review" });
  });
  it("accepts omitted optional service metadata only while the exact bound program is unchanged", async () => {
    const f = await fixture(), parent = await send(f);
    const absent = await inbound(f, `SERVICE ${parent.reference} callback please`, { MessagingServiceSid: "" }); expect(absent.response.status).toBe(200);
    const [reply] = await db.select().from(replies).where(eq(replies.messageSid, absent.body.MessageSid)); expect(reply).toMatchObject({ correlation: "exact_reference", messagingServiceSid: null });
    expect((await inbound(f, `SERVICE ${parent.reference} mismatch`, { MessagingServiceSid: `MG${"e".repeat(32)}` })).response.status).toBe(403);
    await db.update(twilioClientBindingsTable).set({ messagingServiceSid: `MG${"e".repeat(32)}` }).where(eq(twilioClientBindingsTable.id, f.binding.id));
    const changed = await inbound(f, `SERVICE ${parent.reference} changed program`, { MessagingServiceSid: "" }); expect(changed.response.status).toBe(200);
    expect((await db.select().from(replies).where(eq(replies.messageSid, changed.body.MessageSid)))[0]).toMatchObject({ correlation: "ambiguous", parentId: null });
  });
  it("keeps ordinary unknown/no-parent SMS in generic intake, including explicit invalid references", async () => {
    const f = await fixture();
    const received = await inbound(f, "SERVICE ffffffffffffffff untracked"); expect(received.response.status).toBe(200);
    expect(await db.select().from(replies).where(eq(replies.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(twilioInboundEventsTable).where(eq(twilioInboundEventsTable.messageSid, received.body.MessageSid)))[0].body).toBe("SERVICE ffffffffffffffff untracked");
  });
  it("retains multiple phone candidates without picking the last or first service", async () => {
    const f = await fixture(); await send(f);
    const second = await createServiceObligation(f.org, f.staff, { contactId: f.contact.id, kind: "maintenance", equipmentLabel: "Distinct second unit", dueDate: "2026-01-02", noticeDays: 14, assignedUserId: f.staff }); if ("error" in second) throw new Error(second.error);
    await send({ ...f, service: second });
    await inbound(f, "Please arrange that appointment");
    const page = await listServiceSmsReplies(f.org, f.staff, f.service.id); expect(page.items[0]).toMatchObject({ correlation: "ambiguous", serviceObligationId: null, candidateCount: 2 });
    expect(new Set(page.items[0].candidateServiceObligationIds)).toEqual(new Set([f.service.id, second.id]));
    expect(await hasServiceSmsReplyHold(f.org, second.id)).toBe(true); expect(posts).toHaveLength(2);
  });
  it("actual reminder → signed reply → explicit staff response/booking → completion creates only one agreed successor", async () => {
    const f = await fixture();
    const recurring = await approveServiceRecurrence(f.org, f.staff, f.service.id, { expectedUpdatedAt: f.service.updatedAt.toISOString(), intervalMonths: 12, endDate: "2036-01-01", agreementNote: "Synthetic annual maintenance agreement explicitly reviewed." });
    if ("error" in recurring) throw new Error(recurring.error);
    const parent = await send(f); await inbound(f, `SERVICE ${parent.reference} Please call about service`);
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org)); await reviewServiceSmsReply(f.org, f.staff, f.service.id, reply.id, review("handled"));
    const before = await getServiceCare(f.org, f.service.id, "sms");
    const response = await recordServiceCareResponse(f.org, f.staff, f.service.id, { requestId: randomUUID(), expectedUpdatedAt: before.expectedUpdatedAt, channel: "phone", outcome: "ready_to_book", respondedAt: new Date().toISOString(), note: "Office separately called the customer and confirmed the actual future visit window.", staffAttested: true });
    const after = await getServiceCare(f.org, f.service.id, "sms", { actorUserId: f.staff, appointmentType: "other" });
    if (after.scheduling.review.state !== "ready") throw new Error("Expected actual staff-reviewed service scheduling context");
    await bookServiceCareVisit(f.org, f.staff, f.service.id, { requestId: randomUUID(), expectedUpdatedAt: after.expectedUpdatedAt, responseId: response.responseId, assignedUserId: f.staff, scheduledStart: "2030-01-05T15:00:00.000Z", scheduledEnd: "2030-01-05T16:00:00.000Z", type: "other", customerConfirmed: true, schedulingReview: { context: after.scheduling.review.context, duration: { kind: "explicit", preset: null }, startWallTime: null, endWallTime: null } });
    const [booked] = await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, f.service.id));
    const completed = await updateServiceObligation(f.org, f.staff, f.service.id, { status: "completed", expectedUpdatedAt: booked.updatedAt.toISOString(), completionNote: "Synthetic technician explicitly recorded completed maintenance, not warranty eligibility." });
    if ("error" in completed) throw new Error(completed.error);
    await processDueScheduledActions(f.org);
    expect(await db.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, f.org), eq(serviceObligationsTable.predecessorObligationId, f.service.id)))).toHaveLength(1);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1); expect(posts).toHaveLength(1);
  });
  it("reply after reserved parent but before POST blocks the exact dispatch without resetting any execution", async () => {
    const f = await fixture(), queued = await queue(f), fingerprint = careFingerprint({ action: queued.scheduled.action, context: queued.scheduled.context });
    await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${queued.scheduled.id}`, kind: "service_care_reminder", fingerprint, expiresAt: new Date(Date.now() + 300_000) });
    const parentId = await reserveServiceSmsParent({ organizationId: f.org, serviceObligationId: f.service.id, approvalId: queued.approval.approvalId, scheduledActionId: queued.scheduled.id, executionFingerprint: fingerprint });
    await inbound(f, "Please wait, office must call me"); expect(await hasServiceSmsReplyHold(f.org, f.service.id)).toBe(true);
    const [operation] = await db.insert(twilioDispatchesTable).values({ organizationId: f.org, contactId: f.contact.id, idempotencyKey: `service-care:${f.service.id}`, payloadHash: "a".repeat(64), phone: recipient, purpose: "customer_care", accountSid: f.binding.accountSid }).returning();
    await expect(assertServiceSmsParentDispatch({ parentId, organizationId: f.org, operationId: operation.id, body: queued.preview.body, binding: (await twilioForOrganization(f.org))!, consentProofId: randomUUID() })).rejects.toMatchObject({ effectNotAttempted: true });
    expect(posts).toHaveLength(0); expect((await db.select().from(parents).where(eq(parents.id, parentId)))[0].dispatchStartedAt).toBeNull();
  });
  it("explicit unrelated disposition releases only service hold, no consent or booking, and is idempotent", async () => {
    const f = await fixture(); await send(f); await inbound(f, "Wrong subject for this reminder");
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org)); await inbound(f, "STOP");
    const command = review("not_service_reply"), first = await reviewServiceSmsReply(f.org, f.staff, f.service.id, reply.id, command);
    expect(await reviewServiceSmsReply(f.org, f.staff, f.service.id, reply.id, command)).toEqual({ ...first, replayed: true });
    await expect(reviewServiceSmsReply(f.org, f.staff, f.service.id, reply.id, { ...command, note: "Changed synthetic review note is not a replay." })).rejects.toMatchObject({ code: "request_changed" });
    expect(await hasServiceSmsReplyHold(f.org, f.service.id)).toBe(false); expect(await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, f.org))).toHaveLength(1);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org))).some(row => ["service.care_response_recorded", "service.care_visit_booked"].includes(row.action))).toBe(false);
  });
  it("HTTP requires accepted tenant staff; rejects API keys, forged overrides and stale reviews", async () => {
    const f = await fixture(), other = await fixture(); await send(f); await inbound(f, "Office please call");
    const [reply] = await db.select().from(replies).where(eq(replies.organizationId, f.org));
    async function login(org: string, role: "office" | "viewer", verified = true) { const [user] = await db.insert(usersTable).values({ organizationId: org, role, emailVerifiedAt: verified ? new Date() : null }).returning();
      const session = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 }); sessions.push(session); return session; }
    const office = await login(f.org, "office"), viewer = await login(f.org, "viewer"), inactive = await login(f.org, "office", false), foreign = await login(other.org, "office");
    const url = `${base}/api/v1/service-obligations/${f.service.id}/sms-replies`, headers = (session: string) => ({ authorization: `Bearer ${session}`, "content-type": "application/json" });
    expect((await realFetch(url)).status).toBe(401); expect((await realFetch(url, { headers: headers(foreign) })).status).toBe(404); expect((await realFetch(url, { headers: headers(inactive) })).status).toBe(403);
    const valid = await realFetch(url, { headers: headers(viewer) }); expect(valid.status).toBe(200); expect(valid.headers.get("cache-control")).toBe("no-store");
    const key = (await createApiKey({ organizationId: f.org, createdByUserId: f.staff, role: "office", name: "Synthetic SMS reply test" })).key;
    expect((await realFetch(url, { headers: { "x-api-key": key } })).status).toBe(403);
    for (const session of [viewer, inactive, foreign]) expect((await realFetch(`${url}/${reply.id}/review`, { method: "POST", headers: headers(session), body: JSON.stringify(review()) })).status).toBe(session === foreign ? 404 : 403);
    expect((await realFetch(`${url}/${reply.id}/review`, { method: "POST", headers: { ...headers(office), origin: "https://untrusted.invalid" }, body: JSON.stringify(review()) })).status).toBe(403);
    expect((await realFetch(`${url}/${reply.id}/review`, { method: "POST", headers: headers(office), body: JSON.stringify({ ...review(), customerConfirmed: true }) })).status).toBe(400);
    expect((await realFetch(`${url}/${reply.id}/review`, { method: "POST", headers: headers(office), body: JSON.stringify({ ...review(), expectedVersion: 50 }) })).status).toBe(409);
    expect((await realFetch(`${url}/${reply.id}/review`, { method: "POST", headers: headers(office), body: JSON.stringify(review()) })).status).toBe(200);
  });
});
