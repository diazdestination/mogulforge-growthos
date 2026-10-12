import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activitiesTable, appointmentsTable, auditEventsTable, consentRecordsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, emailIntelligenceSourcesTable, emailResponseReviewsTable, leadsTable, organizationsTable, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable, twilioClientBindingsTable, twilioConsentProofsTable, usersTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber, syntheticTwilioSid } from "../test-helpers/synthetic-twilio";
import { approveServiceCare, bookServiceCareVisit, executeServiceCareReminder, getServiceCare, preflightServiceCareReminder, recordServiceCareResponse } from "./service-care";
import { careFingerprint, serviceCareMessage } from "./service-care-policy";
import { createServiceObligation, updateServiceObligation } from "./service-obligations";
import { resolveCustomerEmailSender, sendCustomerEmail } from "./customer-email";
import { processDueScheduledActions } from "./automation";
import { addSuppression } from "./send-gate";
import { updateAppointment } from "./crm";

vi.mock("./customer-email", () => ({ resolveCustomerEmailSender: vi.fn(), sendCustomerEmail: vi.fn() }));
const orgs: string[] = [], effects: string[] = [];
const senders = new Map<string, Awaited<ReturnType<typeof resolveCustomerEmailSender>>>();
let lateChange: (() => Promise<void>) | null = null, unknownEffect = false;
beforeEach(() => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.mocked(resolveCustomerEmailSender).mockImplementation(async ({ organizationId }) => {
    const value = senders.get(organizationId); if (!value) throw new Error("Synthetic disconnected sender"); return { ...value };
  });
  vi.mocked(sendCustomerEmail).mockImplementation(async input => {
    await lateChange?.(); await input.beforeDispatch?.();
    expect(input.expectedSender).toEqual(senders.get(input.organizationId));
    effects.push(input.organizationId);
    if (unknownEffect) throw new Error("Synthetic unknown provider outcome");
    return { id: "synthetic-message", provider: "gmail", acceptance: "accepted", senderEmail: "office@example.invalid", senderUserId: senders.get(input.organizationId)!.userId };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); effects.length = 0; lateChange = null; unknownEffect = false; });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture(dueDate = "2026-01-01") {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Service Company", slug: `service-care-${randomUUID()}` }).returning(); orgs.push(org.id);
  const [staff] = await db.insert(usersTable).values({ organizationId: org.id, role: "office", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic customer", email: "customer@example.invalid", phone: "+14045550123" }).returning();
  await db.insert(orgSettingsTable).values({ organizationId: org.id, sendingHours: { quietHoursEnabled: false } });
  senders.set(org.id, { userId: staff.id, source: "company_default", provider: "gmail", senderEmail: "office@example.invalid" });
  const obligation = await createServiceObligation(org.id, staff.id, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic heat pump", dueDate, noticeDays: 14, assignedUserId: staff.id });
  if ("error" in obligation) throw new Error(obligation.error);
  return { org: org.id, staff: staff.id, contact: contact.id, obligation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function approvalInput(f: Fixture, channel: "email" | "sms" = "email") {
  const care = await getServiceCare(f.org, f.obligation.id, channel);
  expect(care.preview).not.toBeNull();
  return { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, channel, previewFingerprint: care.preview!.fingerprint, agreementNote: "Reviewed current synthetic service agreement and recipient expectation.", expectedServiceConfirmed: true as const };
}
async function queue(f: Fixture, channel: "email" | "sms" = "email") {
  const input = await approvalInput(f, channel);
  const result = await approveServiceCare(f.org, f.staff, f.obligation.id, input);
  const [scheduled] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org));
  return { ...result, input, scheduled };
}
async function response(f: Fixture, outcome: "ready_to_book" | "follow_up" | "declined" = "ready_to_book") {
  const care = await getServiceCare(f.org, f.obligation.id);
  const input = { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, channel: "phone", outcome, respondedAt: new Date(Date.now() - 1000).toISOString(), note: "Synthetic customer explicitly agreed to office scheduling.", staffAttested: true };
  return { ...await recordServiceCareResponse(f.org, f.staff, f.obligation.id, input), input };
}
async function booking(f: Fixture, responseId: string, day = 1) {
  const care = await getServiceCare(f.org, f.obligation.id);
  return { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, responseId, assignedUserId: f.staff, type: "inspection", customerConfirmed: true, scheduledStart: `2035-01-${String(day).padStart(2, "0")}T15:00:00.000Z`, scheduledEnd: `2035-01-${String(day).padStart(2, "0")}T16:00:00.000Z` };
}
describe("one reviewed service reminder", () => {
  it("has fixed non-promotional copy without invented warranty terms and stable JSONB hashes", () => {
    const message = serviceCareMessage({ businessName: "Synthetic", equipmentLabel: "Unit 2", kind: "warranty_check", dueDate: "2035-01-31" });
    expect(message.body).toContain("No appointment is booked yet"); expect(message.body).toContain("does not determine warranty coverage");
    expect(message.body).not.toMatch(/guarantee|discount|offer expires/i);
    expect(careFingerprint({ b: [2, 1], a: true })).toBe(careFingerprint({ a: true, b: [2, 1] }));
  });
  it("previews without effects, saves exact approval, and returns a lost-ack receipt without duplicate actions", async () => {
    const f = await fixture(); const q = await queue(f);
    expect(effects).toHaveLength(0);
    expect(await approveServiceCare(f.org, f.staff, f.obligation.id, q.input)).toEqual({ approvalId: q.approvalId, replayed: true });
    await expect(approveServiceCare(f.org, f.staff, f.obligation.id, { ...q.input, requestId: randomUUID() })).rejects.toMatchObject({ code: "reminder_exists" });
    await expect(approveServiceCare(f.org, f.staff, f.obligation.id, { ...q.input, agreementNote: "Different synthetic service approval." })).rejects.toMatchObject({ code: "request_changed" });
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
    const [audit] = await db.select().from(auditEventsTable).where(eq(auditEventsTable.id, q.approvalId));
    expect(audit.metadata).toMatchObject({ snapshot: { recipient: "customer@example.invalid", sender: senders.get(f.org) } });
  });
  it("scheduler sends once, retains acceptance-not-delivery evidence and office follow-up", async () => {
    const f = await fixture(); await queue(f);
    await processDueScheduledActions(f.org); await processDueScheduledActions(f.org);
    expect(effects).toEqual([f.org]);
    const care = await getServiceCare(f.org, f.obligation.id);
    expect(care.reminder).toMatchObject({ state: "succeeded", deliveryConfirmed: false, providerEvidence: { acceptance: "accepted", deliveryConfirmed: false } });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].description).toContain("delivery and response are unconfirmed");
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect(await db.select().from(activitiesTable).where(eq(activitiesTable.organizationId, f.org))).toHaveLength(1);
  });
  it("uses the actual SMS adapter with purpose consent and a mocked network, once per obligation", async () => {
    const f = await fixture();
    vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", Buffer.alloc(32, 19).toString("base64"));
    vi.stubEnv("TWILIO_CLIENT_SERVICE_CARE_AUTH_TOKEN", "synthetic-webhook");
    vi.stubEnv("TWILIO_CLIENT_SERVICE_CARE_API_KEY_SECRET", "synthetic-secret");
    const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ sid: syntheticTwilioSid("SM") }), { status: 201 }));
    vi.stubGlobal("fetch", provider);
    await db.insert(twilioClientBindingsTable).values({ organizationId: f.org, accountSid: `AC${randomUUID().replaceAll("-", "")}`, phoneNumber: syntheticTwilioNumber(), messagingServiceSid: `MG${"2".repeat(32)}`, apiKeySid: `SK${"3".repeat(32)}`, authTokenSecretRef: "TWILIO_CLIENT_SERVICE_CARE_AUTH_TOKEN", apiKeySecretRef: "TWILIO_CLIENT_SERVICE_CARE_API_KEY_SECRET", publicOrigin: "https://synthetic.example.invalid", businessName: "Synthetic Service Company", smsDisclosureVersion: "synthetic-care-v1", dailySmsLimit: 20, launchApproved: true, smsEnabled: true, registrationApproved: true, advancedOptOut: true, geoPermissionsReviewed: true });
    await db.insert(consentRecordsTable).values({ organizationId: f.org, contactId: f.contact, channel: "sms", granted: true, disclosureVersion: "synthetic-care-v1" });
    await db.insert(twilioConsentProofsTable).values({ organizationId: f.org, contactId: f.contact, phone: "+14045550123", purpose: "customer_care", granted: true, disclosureVersion: "synthetic-care-v1", source: "synthetic fixture only" });
    await queue(f, "sms"); await processDueScheduledActions(f.org); await processDueScheduledActions(f.org);
    expect(provider).toHaveBeenCalledOnce();
    expect(String(provider.mock.calls[0][1]?.body)).toContain("Reply+STOP");
    expect((await getServiceCare(f.org, f.obligation.id)).reminder).toMatchObject({ channel: "sms", state: "succeeded", providerEvidence: { provider: "twilio", deliveryConfirmed: false } });
    expect(effects).toHaveLength(0);
  });
  it("preserves the staff plan changed during provider handoff, adding acceptance evidence without erasing it", async () => {
    const f = await fixture(); await queue(f);
    const [other] = await db.insert(usersTable).values({ organizationId: f.org, role: "office", emailVerifiedAt: new Date() }).returning();
    const deadline = new Date(Date.now() + 10 * 60_000);
    vi.mocked(sendCustomerEmail).mockImplementationOnce(async input => {
      await input.beforeDispatch?.();
      // The provider has the payload; a simultaneous staff edit cannot be recalled.
      await db.update(crmTasksTable).set({ status: "in_progress", assignedUserId: other.id, dueAt: deadline, description: "Office promised a callback in ten minutes. Keep this plan." }).where(eq(crmTasksTable.id, f.obligation.taskId));
      return { provider: "gmail", id: "synthetic-accepted", acceptance: "accepted", senderEmail: "office@example.invalid", senderUserId: f.staff };
    });
    await processDueScheduledActions(f.org);
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId));
    expect(task).toMatchObject({ status: "in_progress", assignedUserId: other.id, dueAt: deadline });
    expect(task.description).toContain("Office promised a callback in ten minutes. Keep this plan.");
    expect(task.description).toContain("delivery and response are unconfirmed");
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("succeeded");
  });
  it("defers the global hold before permanent execution claim, then resumes the same action", async () => {
    const f = await fixture(); const q = await queue(f);
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await processDueScheduledActions(f.org);
    expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).toHaveLength(0);
    expect(effects).toHaveLength(0);
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    await db.update(scheduledActionsTable).set({ runAt: new Date(Date.now() - 1000) }).where(eq(scheduledActionsTable.id, q.scheduled.id));
    await processDueScheduledActions(f.org); expect(effects).toEqual([f.org]);
  });
  it("defers quiet hours and future notice dates without burning a key", async () => {
    const f = await fixture(); const q = await queue(f);
    const closedDay = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(new Date().getUTCDay() + 1) % 7];
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: true, timezone: "UTC", days: [closedDay], startHour: 9, endHour: 18 } }).where(eq(orgSettingsTable.organizationId, f.org));
    await processDueScheduledActions(f.org);
    expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, q.scheduled.id)))[0].runAt.getTime()).toBeGreaterThan(Date.now());
    const later = await fixture("2035-05-01"), queued = await queue(later);
    expect((await preflightServiceCareReminder(later.org, queued.scheduled.action.params, queued.scheduled.context, queued.scheduled.id)).resumeAt!.toISOString().slice(0, 10)).toBe("2035-04-17");
  });
  it("frequency caps defer a second due obligation for the same customer without claiming it", async () => {
    const f = await fixture();
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.org));
    const other = await createServiceObligation(f.org, f.staff, { contactId: f.contact, kind: "maintenance", equipmentLabel: "Synthetic second unit", dueDate: "2026-01-01", noticeDays: 14 });
    if ("error" in other) throw new Error(other.error);
    await queue(f); await queue({ ...f, obligation: other }); await processDueScheduledActions(f.org);
    expect(effects).toHaveLength(1);
    const receipts = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(receipts).toHaveLength(1);
    const [remaining] = await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, f.org), eq(scheduledActionsTable.status, "pending"))); expect(remaining.runAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("a current customer reply hold blocks service automation and is not released by office service notes", async () => {
    const f = await fixture();
    const [source] = await db.insert(emailIntelligenceSourcesTable).values({ organizationId: f.org, intakeAlias: `synthetic-${randomUUID()}@example.invalid` }).returning();
    const [hold] = await db.insert(emailResponseReviewsTable).values({ organizationId: f.org, sourceId: source.id, externalMessageId: randomUUID(), payloadSha256: "synthetic-hash", contactId: f.contact, state: "confirmed", reason: "staff_confirmed", holdActive: true }).returning();
    expect((await getServiceCare(f.org, f.obligation.id)).blockReason).toContain("reply_requires_opportunity_context");
    await response(f);
    expect((await db.select().from(emailResponseReviewsTable).where(eq(emailResponseReviewsTable.id, hold.id)))[0].holdActive).toBe(true);
    expect(effects).toHaveLength(0);
  });
  it.each(["dnc", "suppression", "imported_source", "lifecycle", "unconfigured_sms"])("holds %s instead of manufacturing source permission or consent", async kind => {
    const f = await fixture();
    if (kind === "dnc") await db.update(contactsTable).set({ doNotContact: true }).where(eq(contactsTable.id, f.contact));
    if (kind === "suppression") await addSuppression({ organizationId: f.org, channel: "email", value: "customer@example.invalid", reason: "unsubscribed" });
    if (kind === "imported_source") await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contact, creationMethod: "import" });
    if (kind === "lifecycle") await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic hold" });
    const care = await getServiceCare(f.org, f.obligation.id, kind === "unconfigured_sms" ? "sms" : "email");
    expect(care.preview).toBeNull(); expect(care.blockReason).toBeTruthy(); expect(effects).toHaveLength(0);
  });
  it.each(["service", "recipient", "sender", "actor", "dnc"])("rechecks late %s changes at actual dispatch", async kind => {
    const f = await fixture(); await queue(f);
    lateChange = async () => {
      if (kind === "service") await updateServiceObligation(f.org, f.staff, f.obligation.id, { status: "cancelled" });
      if (kind === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact));
      if (kind === "sender") senders.get(f.org)!.provider = "microsoft";
      if (kind === "actor") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.staff));
      if (kind === "dnc") await db.update(contactsTable).set({ doNotContactEmail: true }).where(eq(contactsTable.id, f.contact));
    };
    await processDueScheduledActions(f.org);
    expect(effects).toHaveLength(0);
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("blocked");
  });
  it("does not permit cloned scheduled actions, forged durable payloads, or foreign approval IDs", async () => {
    const f = await fixture(), foreign = await fixture(); const q = await queue(f);
    const [clone] = await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: q.scheduled.action, context: q.scheduled.context, runAt: new Date() }).returning();
    await expect(preflightServiceCareReminder(f.org, clone.action.params, clone.context, clone.id)).rejects.toMatchObject({ code: "invalid_claim" });
    await expect(preflightServiceCareReminder(foreign.org, q.scheduled.action.params, q.scheduled.context, q.scheduled.id)).rejects.toMatchObject({ code: "invalid_approval" });
    await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${q.scheduled.id}`, kind: "service_care_reminder", fingerprint: "forged", expiresAt: new Date(Date.now() + 100_000) });
    await expect(executeServiceCareReminder(f.org, q.scheduled.action.params, q.scheduled.context, q.scheduled.id)).rejects.toMatchObject({ code: "invalid_execution" }); expect(effects).toHaveLength(0);
  });
  it("unknown effects stay non-retryable across queue retries and alternate approval keys", async () => {
    const f = await fixture(); const q = await queue(f); unknownEffect = true;
    await processDueScheduledActions(f.org); await processDueScheduledActions(f.org);
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("indeterminate");
    await expect(approveServiceCare(f.org, f.staff, f.obligation.id, { ...q.input, requestId: randomUUID() })).rejects.toMatchObject({ code: "reminder_exists" });
    await db.update(revenueExecutionsTable).set({ state: "confirmed_not_performed" }).where(eq(revenueExecutionsTable.organizationId, f.org));
    await expect(approveServiceCare(f.org, f.staff, f.obligation.id, { ...q.input, requestId: randomUUID() })).rejects.toMatchObject({ code: "reminder_exists" });
    expect(effects).toEqual([f.org]);
  });
  it("expired processing is shown as unknown and passes to durable reconciliation, even during a global hold", async () => {
    const f = await fixture(); const q = await queue(f);
    await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${q.scheduled.id}`, kind: "service_care_reminder", fingerprint: careFingerprint({ action: q.scheduled.action, context: q.scheduled.context }), expiresAt: new Date(Date.now() - 1000) });
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("indeterminate");
    expect(await preflightServiceCareReminder(f.org, q.scheduled.action.params, q.scheduled.context, q.scheduled.id)).toEqual({ resumeAt: null });
    await processDueScheduledActions(f.org);
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)))[0].state).toBe("indeterminate"); expect(effects).toHaveLength(0);
  });
});
describe("staff response to confirmed office booking", () => {
  it("records a staff attestation once and cancels an unclaimed reminder without claiming a verified inbox response", async () => {
    const f = await fixture(); const q = await queue(f), r = await response(f);
    expect(await recordServiceCareResponse(f.org, f.staff, f.obligation.id, r.input)).toEqual({ responseId: r.responseId, replayed: true });
    await processDueScheduledActions(f.org); expect(effects).toHaveLength(0);
    expect((await getServiceCare(f.org, f.obligation.id)).response).toMatchObject({ evidence: "staff_attested_not_provider_verified", outcome: "ready_to_book" });
    expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, q.scheduled.id)))[0].status).toBe("cancelled");
    expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("preserves an uncertain send when staff records the actual customer response", async () => {
    const f = await fixture(); await queue(f); unknownEffect = true; await processDueScheduledActions(f.org);
    await response(f); expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("indeterminate"); expect(effects).toEqual([f.org]);
  });
  it("books exactly one linked appointment, returning the original receipt after a lost acknowledgment", async () => {
    const f = await fixture(); const r = await response(f), input = await booking(f, r.responseId);
    const first = await bookServiceCareVisit(f.org, f.staff, f.obligation.id, input);
    expect(await bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).toEqual({ appointmentId: first.appointmentId, replayed: true });
    const care = await getServiceCare(f.org, f.obligation.id); expect(care.appointment).toMatchObject({ id: first.appointmentId, status: "confirmed" }); expect(care.active).toBe(true);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].status).toBe("done");
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1); expect(effects).toHaveLength(0);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
  });
  it("requires current explicit customer confirmation and safe future intervals", async () => {
    const f = await fixture(), r = await response(f, "declined"); let input = await booking(f, r.responseId);
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "response_required" });
    const ready = await response(f); input = await booking(f, ready.responseId);
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, customerConfirmed: false })).rejects.toBeDefined();
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, scheduledEnd: "2035-01-01T14:00:00.000Z" })).rejects.toMatchObject({ code: "invalid_interval" });
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, scheduledStart: "2020-01-01T14:00:00.000Z" })).rejects.toMatchObject({ code: "invalid_window" });
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, expectedUpdatedAt: "2020-01-01T14:00:00.000Z" })).rejects.toMatchObject({ code: "stale_update" });
  });
  it("blocks overlapping crew or inspection capacity and cross-tenant/ineligible staff", async () => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId, 2), foreign = await fixture();
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, assignedUserId: foreign.staff })).rejects.toMatchObject({ code: "invalid_assignee" });
    await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact, assignedUserId: f.staff, type: "production", scheduledStart: new Date(input.scheduledStart), scheduledEnd: new Date(input.scheduledEnd) });
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "resource_conflict" });
    await db.delete(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org));
    await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact, type: "inspection", scheduledStart: new Date(input.scheduledStart), scheduledEnd: new Date(input.scheduledEnd) });
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "capacity_conflict" });
  });
  it("reopens follow-up on cancellation and requires a fresh response before rebooking", async () => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId, 3);
    const first = await bookServiceCareVisit(f.org, f.staff, f.obligation.id, input);
    await updateAppointment(f.org, first.appointmentId, { status: "cancelled" });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].status).toBe("open");
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, await booking(f, r.responseId, 4))).rejects.toMatchObject({ code: "fresh_response_required" });
    const next = await response(f); expect(await bookServiceCareVisit(f.org, f.staff, f.obligation.id, await booking(f, next.responseId, 4))).toMatchObject({ replayed: false });
  });
  it("rejects foreign reads and inactive/reader approval identities", async () => {
    const f = await fixture(), other = await fixture(); const input = await approvalInput(f);
    await expect(getServiceCare(other.org, f.obligation.id)).rejects.toMatchObject({ status: 404 });
    await expect(approveServiceCare(f.org, other.staff, f.obligation.id, input)).rejects.toMatchObject({ status: 403 });
    await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, f.staff));
    await expect(approveServiceCare(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ status: 403 });
  });
});
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("independent PostgreSQL service-care ownership", () => {
  it("serializes competing approval request IDs into one scheduled reminder", async () => {
    const f = await fixture(), input = await approvalInput(f);
    const results = await Promise.allSettled([approveServiceCare(f.org, f.staff, f.obligation.id, input), approveServiceCare(f.org, f.staff, f.obligation.id, { ...input, requestId: randomUUID() })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
  });
});
