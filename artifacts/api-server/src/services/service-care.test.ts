import { randomUUID, webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activitiesTable, appointmentsTable, auditEventsTable, consentRecordsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, pool, propertiesTable, DEFAULT_INSPECTION_AVAILABILITY, emailIntelligenceSourcesTable, emailResponseReviewsTable, leadsTable, organizationsTable, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable, twilioClientBindingsTable, twilioConsentProofsTable, usersTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber, syntheticTwilioSid } from "../test-helpers/synthetic-twilio";
import { approveServiceCare, bookServiceCareVisit, executeServiceCareReminder, getServiceCare, preflightServiceCareReminder, recordServiceCareResponse } from "./service-care";
import { careCanonicalJson, careFingerprint, serviceCareMessage, serviceCareBookingSchema, serviceCareBookingOutcomeSchema, serviceCareBookingResultSchema, serviceCareSchedulingReadSchema } from "./service-care-policy";
import { createServiceObligation, updateServiceObligation } from "./service-obligations";
import { resolveCustomerEmailSender, sendCustomerEmail } from "./customer-email";
import { processDueScheduledActions } from "./automation";
import { addSuppression } from "./send-gate";
import { updateAppointment } from "./crm";
import { getSchedulingReviewContext, saveSchedulingPolicy } from "./scheduling-policy";
import { transitionCustomerLifecycle } from "./customer-lifecycle";

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
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Service Company", slug: `service-care-${randomUUID()}`, timezone: "UTC" }).returning(); orgs.push(org.id);
  const [staff] = await db.insert(usersTable).values({ organizationId: org.id, role: "office", emailVerifiedAt: new Date() }).returning();
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic customer", email: "customer@example.invalid", phone: "+14045550123" }).returning();
  await db.insert(orgSettingsTable).values({ organizationId: org.id, sendingHours: { quietHoursEnabled: false } });
  senders.set(org.id, { userId: staff.id, source: "company_default", provider: "gmail", senderEmail: "office@example.invalid" });
  const obligation = await createServiceObligation(org.id, staff.id, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic heat pump", dueDate, noticeDays: 14, assignedUserId: staff.id });
  if ("error" in obligation) throw new Error(obligation.error);
  return { org: org.id, staff: staff.id, owner: owner.id, contact: contact.id, obligation };
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
async function booking(f: Fixture, responseId: string, day = 1, type: "inspection" | "other" = "inspection") {
  const care = await getServiceCare(f.org, f.obligation.id);
  const context = await getSchedulingReviewContext({ organizationId: f.org, userId: f.staff }, { sourceKind: "direct_customer", sourceId: f.contact, ...(care.scheduling?.source.propertyId ? { propertyId: care.scheduling.source.propertyId } : {}), reservationKind: "appointment", appointmentType: type });
  return { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, responseId, assignedUserId: f.staff, type, customerConfirmed: true as const, scheduledStart: `2035-01-${String(day).padStart(2, "0")}T15:00:00.000Z`, scheduledEnd: `2035-01-${String(day).padStart(2, "0")}T16:00:00.000Z`, schedulingReview: { context, duration: { kind: "explicit" as const, preset: null }, startWallTime: null, endWallTime: null } };
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
    expect(await bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).toEqual({ ...first, replayed: true });
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
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "inspection_capacity_conflict" });
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

async function configureScheduling(f: Fixture, gap = 30, cap: number | null = 2) {
  return saveSchedulingPolicy({ organizationId: f.org, userId: f.owner }, { expectedRevision: 0, expectedCompanyTimeZone: "UTC", enabled: true, minimumTravelGapMinutes: gap, maxConcurrentReservations: cap, durationPresets: [] });
}
describe("reviewed service-care scheduling", () => {
  it("provides actual source and selected-type context without a connected reminder sender", async () => {
    const f = await fixture();
    const [property] = await db.insert(propertiesTable).values({ organizationId: f.org, contactId: f.contact, addressLine1: "Synthetic property", city: "Synthetic", state: "CA", postalCode: "00000" }).returning();
    await db.update(serviceObligationsTable).set({ propertyId: property.id }).where(eq(serviceObligationsTable.id, f.obligation.id));
    senders.delete(f.org);
    const read = await getServiceCare(f.org, f.obligation.id, "email", { actorUserId: f.staff, appointmentType: "other" });
    expect(read.preview).toBeNull();
    expect(read.scheduling).toMatchObject({ organizationId: f.org, actorUserId: f.staff, obligationId: f.obligation.id, expectedUpdatedAt: read.expectedUpdatedAt, appointmentType: "other", source: { sourceKind: "direct_customer", contactId: f.contact, propertyId: property.id, leadId: null, estimateId: null }, review: { state: "ready", policy: null, context: { companyTimeZone: "UTC", inspection: null, targetVersion: null, targetFingerprint: null } } });
    const inspection = await getServiceCare(f.org, f.obligation.id, "sms", { actorUserId: f.staff, appointmentType: "inspection" });
    expect(inspection.scheduling.review.state).toBe("ready");
    if (inspection.scheduling.review.state === "ready") expect(inspection.scheduling.review.context.inspection).not.toBeNull();
    expect(effects).toHaveLength(0);
  });
  it("keeps absent property null and holds missing reader or invalid policy without erasing history", async () => {
    const f = await fixture();
    expect((await getServiceCare(f.org, f.obligation.id)).scheduling).toMatchObject({ actorUserId: null, source: { propertyId: null }, review: { state: "held", code: "scheduling_reader_required" } });
    await db.update(organizationsTable).set({ timezone: "Invalid/Zone" }).where(eq(organizationsTable.id, f.org));
    const read = await getServiceCare(f.org, f.obligation.id, "email", { actorUserId: f.staff });
    expect(read).toMatchObject({ active: true, obligationId: f.obligation.id, scheduling: { source: { contactId: f.contact, propertyId: null }, review: { state: "held", code: "invalid_scheduling_policy" } } });
  });
  it("requires review on fresh revision-zero staff bookings without minting a receipt", async () => {
    const f = await fixture(), r = await response(f), { schedulingReview: _review, ...legacy } = await booking(f, r.responseId);
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, legacy)).rejects.toMatchObject({ code: "stale_scheduling_review" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_visit_booked")))).toHaveLength(0);
  });
  it("rejects a stale company-zone review before source side effects", async () => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId);
    await db.update(organizationsTable).set({ timezone: "America/Los_Angeles" }).where(eq(organizationsTable.id, f.org));
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "stale_scheduling_review" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].status).toBe("open");
  });
  it("replays the original audit-bound result before changed policy, lifecycle, service and target", async () => {
    const f = await fixture(), configured = await configureScheduling(f);
    const r = await response(f), input = await booking(f, r.responseId), first = await bookServiceCareVisit(f.org, f.staff, f.obligation.id, input);
    expect(first.bookingOutcome).toMatchObject({ formatVersion: 1, status: "committed", organizationId: f.org, actorUserId: f.staff, obligationId: f.obligation.id, requestId: input.requestId, requestFingerprint: careFingerprint(input), responseId: r.responseId, expectedUpdatedAt: input.expectedUpdatedAt, appointmentId: first.appointmentId });
    await db.update(orgSettingsTable).set({ schedulingPolicy: { ...configured.policy!, digest: "f".repeat(64) } }).where(eq(orgSettingsTable.organizationId, f.org));
    await db.update(organizationsTable).set({ timezone: "Invalid/Zone" }).where(eq(organizationsTable.id, f.org));
    await transitionCustomerLifecycle(f.org, f.owner, { action: "pause", expectedVersion: 0, reason: "Synthetic pause after original booking" });
    await db.update(serviceObligationsTable).set({ status: "cancelled", appointmentId: null }).where(eq(serviceObligationsTable.id, f.obligation.id));
    await db.delete(appointmentsTable).where(eq(appointmentsTable.id, first.appointmentId));
    expect(await bookServiceCareVisit(f.org, f.owner, f.obligation.id, input)).toEqual({ ...first, replayed: true });
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "scheduling.reservation_transition.v1")))).toHaveLength(1);
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  });
  it("preserves historical omitted-review hashes and holds corrupted receipt proof", async () => {
    const f = await fixture(), r = await response(f), { schedulingReview: _review, ...original } = await booking(f, r.responseId);
    const legacy = { ...original, requestId: original.requestId.toUpperCase(), expectedUpdatedAt: original.expectedUpdatedAt.replace("Z", "000Z") }; // Retain the original UUID case and accepted timestamp precision.
    const appointmentId = randomUUID();
    const [audit] = await db.insert(auditEventsTable).values({ organizationId: f.org, actorUserId: f.staff, entityType: "service_obligation", entityId: f.obligation.id, action: "service.care_visit_booked", metadata: { ...legacy, appointmentId, requestFingerprint: careFingerprint(legacy), evidence: "staff_attested_customer_confirmation" } }).returning();
    await db.delete(serviceObligationsTable).where(eq(serviceObligationsTable.id, f.obligation.id));
    const result = await bookServiceCareVisit(f.org, f.owner, f.obligation.id, legacy);
    expect(result).toMatchObject({ appointmentId, replayed: true, bookingOutcome: { bookingId: audit.id, actorUserId: f.staff, requestFingerprint: careFingerprint(legacy), expectedUpdatedAt: legacy.expectedUpdatedAt } });
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...legacy, schedulingReview: _review })).rejects.toMatchObject({ code: "request_changed" });
    await db.update(auditEventsTable).set({ metadata: { ...audit.metadata, appointmentId: "not-a-uuid" } }).where(eq(auditEventsTable.id, audit.id));
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, legacy)).rejects.toMatchObject({ code: "invalid_booking_receipt" });
  });
  it("rejects reviewed source/type changes and a replacement latest response", async () => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId);
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, type: "other" })).rejects.toMatchObject({ code: "stale_scheduling_review" });
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, { ...input, schedulingReview: { ...input.schedulingReview, context: { ...input.schedulingReview.context, source: { ...input.schedulingReview.context.source, contactId: randomUUID() } } } })).rejects.toMatchObject({ code: "stale_scheduling_review" });
    await response(f);
    const fresh = await booking(f, r.responseId);
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, fresh)).rejects.toMatchObject({ code: "response_required" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("rejects incoherent source properties and unaccepted scheduling readers", async () => {
    const f = await fixture(), foreign = await fixture();
    const [property] = await db.insert(propertiesTable).values({ organizationId: foreign.org, contactId: foreign.contact, addressLine1: "Synthetic foreign property", city: "Synthetic", state: "CA", postalCode: "00000" }).returning();
    await db.update(serviceObligationsTable).set({ propertyId: property.id }).where(eq(serviceObligationsTable.id, f.obligation.id));
    await expect(getServiceCare(f.org, f.obligation.id, "email", { actorUserId: f.staff })).rejects.toMatchObject({ code: "customer_reference_mismatch" });
    await expect(getServiceCare(f.org, f.obligation.id, "email", { actorUserId: foreign.staff })).rejects.toMatchObject({ code: "scheduling_access_denied" });
  });
  it("holds changed service worksite even when its timestamp was retained", async () => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId);
    const [property] = await db.insert(propertiesTable).values({ organizationId: f.org, contactId: f.contact, addressLine1: "Synthetic changed worksite", city: "Synthetic", state: "CA", postalCode: "00000" }).returning();
    await db.update(serviceObligationsTable).set({ propertyId: property.id, updatedAt: new Date(input.expectedUpdatedAt) }).where(eq(serviceObligationsTable.id, f.obligation.id));
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "stale_scheduling_review" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("retains the saved neighbor travel gap after policy disable", async () => {
    const f = await fixture(); await configureScheduling(f, 60, null);
    const r = await response(f), original = await booking(f, r.responseId);
    const first = await bookServiceCareVisit(f.org, f.staff, f.obligation.id, original);
    const stored = (await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, first.appointmentId)))[0];
    expect(stored.schedulingReservation).toMatchObject({ minimumTravelGapMinutes: 60, admittedByUserId: f.staff, target: { id: first.appointmentId } });
    await saveSchedulingPolicy({ organizationId: f.org, userId: f.owner }, { expectedRevision: 1, expectedCompanyTimeZone: "UTC", enabled: false, minimumTravelGapMinutes: 0, maxConcurrentReservations: null, durationPresets: [] });
    const obligation = await createServiceObligation(f.org, f.staff, { contactId: f.contact, kind: "maintenance", equipmentLabel: "Synthetic second system", dueDate: "2035-01-01", noticeDays: 14 });
    if ("error" in obligation) throw Error(obligation.error);
    const next = { ...f, obligation }, nextResponse = await response(next), input = await booking(next, nextResponse.responseId);
    const tooClose = { ...input, scheduledStart: "2035-01-01T16:30:00.000Z", scheduledEnd: "2035-01-01T17:30:00.000Z" };
    await expect(bookServiceCareVisit(f.org, f.staff, obligation.id, tooClose)).rejects.toMatchObject({ code: "travel_conflict" });
    expect(await bookServiceCareVisit(f.org, f.staff, obligation.id, { ...input, scheduledStart: "2035-01-01T17:00:00.000Z", scheduledEnd: "2035-01-01T18:00:00.000Z" })).toMatchObject({ replayed: false });
  });
  it("uses true peak for inspection/company capacity without the old intersection-count gate", async () => {
    const f = await fixture();
    await db.update(orgSettingsTable).set({ inspectionAvailability: { ...DEFAULT_INSPECTION_AVAILABILITY, maxBookingsPerWindow: 2 } }).where(eq(orgSettingsTable.organizationId, f.org));
    await configureScheduling(f, 0, 2);
    await db.insert(appointmentsTable).values([15, 16].map(hour => ({ organizationId: f.org, contactId: f.contact, type: "inspection" as const, scheduledStart: new Date(`2035-01-01T${hour}:00:00.000Z`), scheduledEnd: new Date(`2035-01-01T${hour + 1}:00:00.000Z`) })));
    const r = await response(f), input = { ...await booking(f, r.responseId), scheduledEnd: "2035-01-01T17:00:00.000Z" };
    expect(await bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).toMatchObject({ replayed: false });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(3);
  });
  it("enforces the general company ceiling on non-inspection service bookings", async () => {
    const f = await fixture(); await configureScheduling(f, 0, 1);
    await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact, type: "production", scheduledStart: new Date("2035-01-01T15:00:00.000Z"), scheduledEnd: new Date("2035-01-01T16:00:00.000Z") });
    const r = await response(f), input = await booking(f, r.responseId, 1, "other");
    await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toMatchObject({ code: "company_capacity_conflict" });
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("rolls back native row, source link, task, reminder and transition when the original receipt fails", async () => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId), hook = `qa_care_rollback_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid AND NEW.action='service.care_visit_booked' THEN RAISE EXCEPTION 'Synthetic source receipt failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${hook} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
    try { await expect(bookServiceCareVisit(f.org, f.staff, f.obligation.id, input)).rejects.toThrow(); }
    finally { await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON audit_events`); await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`); }
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, f.obligation.id)))[0]).toMatchObject({ appointmentId: null, updatedAt: new Date(input.expectedUpdatedAt) });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].status).toBe("open");
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "scheduling.reservation_transition.v1")))).toHaveLength(0);
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_visit_booked")))).toHaveLength(0);
  });
});

async function waitForBlocker(pid: number, pattern = "%") {
  for (let i = 0; i < 200; i++) {
    const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2", [pid, pattern]);
    if (result.rows[0]) return Number(result.rows[0].pid);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Independent PostgreSQL service-care barrier was not observed");
}
async function careBarrier(table: "appointments" | "customer_lifecycle", org: string) {
  const name = `qa_care_${randomUUID().replaceAll("-", "")}`, keeper = await pool.connect();
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${org}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtext('${name}')); END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  await keeper.query("BEGIN");
  await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
  return {
    pid: Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid),
    release: () => keeper.query("COMMIT"),
    cleanup: async (pending: Promise<unknown>[]) => {
      await keeper.query("ROLLBACK"); keeper.release(); await Promise.allSettled(pending);
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    },
  };
}
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("service-care lifecycle admission races", () => {
  it.each([true, false])("serializes pause and fresh booking with pauseFirst=%s", async pauseFirst => {
    const f = await fixture(), r = await response(f), input = await booking(f, r.responseId), pending: Promise<unknown>[] = [];
    const hold = await careBarrier(pauseFirst ? "customer_lifecycle" : "appointments", f.org);
    const observe = (value: Promise<unknown>) => { pending.push(value); void value.catch(() => {}); return value; };
    const pause = () => transitionCustomerLifecycle(f.org, f.owner, { action: "pause", expectedVersion: 0, reason: "Synthetic lifecycle scheduling contender" });
    const book = () => bookServiceCareVisit(f.org, f.staff, f.obligation.id, input);
    try {
      const first = observe(pauseFirst ? pause() : book()), firstPid = await waitForBlocker(hold.pid, "%insert into%");
      const second = observe(pauseFirst ? book() : pause()), secondPid = await waitForBlocker(firstPid, "%pg_advisory_xact_lock%");
      expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
      await hold.release(); await first;
      if (pauseFirst) await expect(second).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
      else await second;
      expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(pauseFirst ? 0 : 1);
      expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_visit_booked")))).toHaveLength(pauseFirst ? 0 : 1);
    } finally { await hold.cleanup(pending); }
  }, 30000);
  it.each(["actor", "property"] as const)("rechecks committed %s authority after an independent row-lock contender", async kind => {
    const f = await fixture();
    const [other] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Synthetic different customer" }).returning();
    const [property] = await db.insert(propertiesTable).values({ organizationId: f.org, contactId: f.contact, addressLine1: "Synthetic locked property", city: "Synthetic", state: "CA", postalCode: "00000" }).returning();
    await db.update(serviceObligationsTable).set({ propertyId: property.id }).where(eq(serviceObligationsTable.id, f.obligation.id));
    const r = await response(f), input = await booking(f, r.responseId), keeper = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await keeper.query("BEGIN");
      if (kind === "actor") await keeper.query("UPDATE users SET is_active=false WHERE id=$1", [f.staff]);
      else await keeper.query("UPDATE properties SET contact_id=$1 WHERE id=$2", [other.id, property.id]);
      const pid = Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending = bookServiceCareVisit(f.org, f.staff, f.obligation.id, input); void pending.catch(() => {});
      expect(await waitForBlocker(pid, "%for share%")).not.toBe(pid);
      await keeper.query("COMMIT");
      await expect(pending).rejects.toMatchObject({ code: kind === "actor" ? "invalid_assignee" : "customer_reference_mismatch" });
      expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    } finally { await keeper.query("ROLLBACK"); keeper.release(); if (pending) await Promise.allSettled([pending]); }
  }, 30000);
});

describe("closed service-care wire contract and browser hash vectors", () => {
  const legacy = { requestId: "11111111-1111-4111-8111-111111111111", expectedUpdatedAt: "2035-01-01T00:00:00.000Z", responseId: "22222222-2222-4222-8222-222222222222", assignedUserId: "staff_original", scheduledStart: "2035-01-02T15:00:00.000Z", scheduledEnd: "2035-01-02T16:00:00.000Z", type: "other" as const, customerConfirmed: true as const };
  const context = { organizationId: "33333333-3333-4333-8333-333333333333", policyRevision: 0, policyDigest: null, companyTimeZone: "UTC", inspection: null, applicableRules: { newTravelGapMinutes: 0, companyCeiling: null, inspectionCeiling: null }, source: { sourceKind: "direct_customer" as const, leadId: null, contactId: "44444444-4444-4444-8444-444444444444", propertyId: null, estimateId: null }, targetVersion: null, targetFingerprint: null };
  const reviewed = { ...legacy, schedulingReview: { context, duration: { kind: "explicit" as const, preset: null }, startWallTime: null, endWallTime: null } };
  it.each([
    { name: "omitted historical review", input: legacy, hash: "e29febeb749f7845406e3a06ec0b41c79d0f77fb77849f88efb408ad9efd0785" },
    { name: "exact reviewed booking", input: reviewed, hash: "1fc0cef9f16c12614302654ed91035d324378851f42dffff4ce58e2928306a2a" },
  ])("pins the $name vector against browser-compatible Web Crypto", async ({ input, hash }) => {
    expect(serviceCareBookingSchema.parse(input)).toEqual(input);
    const canonical = careCanonicalJson(input);
    const browserDigest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    expect(Array.from(new Uint8Array(browserDigest), value => value.toString(16).padStart(2, "0")).join("")).toBe(hash);
    expect(careFingerprint(input)).toBe(hash);
    expect(careFingerprint(Object.fromEntries(Object.entries(input).reverse()))).toBe(hash);
  });
  it("closes every new object without accepting authority or normalizing omitted review", () => {
    expect(Object.hasOwn(serviceCareBookingSchema.parse(legacy), "schedulingReview")).toBe(false);
    expect(serviceCareBookingSchema.safeParse({ ...legacy, schedulingReview: null }).success).toBe(false);
    expect(serviceCareBookingSchema.safeParse({ ...reviewed, schedulingReview: { ...reviewed.schedulingReview, context: { ...context, actorUserId: "forged" } } }).success).toBe(false);
    const read = { organizationId: context.organizationId, actorUserId: "staff_original", obligationId: legacy.requestId, expectedUpdatedAt: legacy.expectedUpdatedAt, appointmentType: "other", source: context.source, review: { state: "ready", policy: null, context } };
    expect(serviceCareSchedulingReadSchema.safeParse(read).success).toBe(true);
    for (const altered of [{ ...read, actor: "forged" }, { ...read, actorUserId: null }, { ...read, source: { ...read.source, contactId: legacy.requestId } }, { ...read, source: { ...read.source, customerWorkId: legacy.requestId } }, { ...read, review: { ...read.review, snapshot: {} } }]) expect(serviceCareSchedulingReadSchema.safeParse(altered).success).toBe(false);
    const outcome = { formatVersion: 1, status: "committed", organizationId: context.organizationId, actorUserId: "staff_original", obligationId: legacy.requestId, bookingId: legacy.responseId, requestId: legacy.requestId, requestFingerprint: careFingerprint(legacy), responseId: legacy.responseId, expectedUpdatedAt: legacy.expectedUpdatedAt, appointmentId: context.source.contactId };
    expect(serviceCareBookingOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(serviceCareBookingOutcomeSchema.safeParse({ ...outcome, available: true }).success).toBe(false);
    expect(serviceCareBookingResultSchema.safeParse({ appointmentId: legacy.requestId, replayed: true, bookingOutcome: outcome }).success).toBe(false);
  });
});
