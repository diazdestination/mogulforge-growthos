import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, leadsTable, missedCallHandoffsTable, propertiesTable, revenueExecutionsTable, twilioCallsTable, twilioInboundEventsTable, usersTable, organizationsTable, orgSettingsTable, scheduledActionsTable, pool } from "@workspace/db";
import { callieIntakesTable } from "../../../../lib/db/src/schema/callie";
import { callieOfficeFixture } from "../test-helpers/callie-office-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { bookCallieVisit, getCallieOfficeDetail, listCallieOffice, reviewCallieCaller, updateCallieOffice } from "./callie-office";
import { reviewMissedCall } from "./missed-call-handoff";
import { careOperationKey } from "./missed-call-care-policy";
import * as callieOffice from "./callie-office";
import { canonicalCallieBookingInput, callieBookingSchema, callieBookingOutcomeSchema } from "./callie-office-contract";
import { careFingerprint } from "./service-care-policy";
import { saveSchedulingPolicy, setSchedulingCompanyTimeZone, getSchedulingReviewContext } from "./scheduling-policy";
import { createManualScheduledAppointment } from "./manual-scheduling";
import { transitionCustomerLifecycle } from "./customer-lifecycle";

const orgs: string[] = [];
async function fixture(reviewed = false) { const f = await callieOfficeFixture(reviewed); orgs.push(f.org); return f; }
afterAll(async () => { await deleteTestOrgs(...orgs); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(f: Fixture) { const read = await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id); return { requestId: randomUUID(), expectedVersion: read.version, expectedFingerprint: read.expectedFingerprint }; }
async function booking(f: Fixture, type: "inspection" | "other" = "other") {
  const read = await callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: type, propertyId: f.property.id });
  return { requestId: randomUUID(), expectedVersion: read.expectedVersion, expectedFingerprint: read.expectedFingerprint, contactId: f.contact.id, leadId: read.source?.leadId ?? null, propertyId: f.property.id, assignedUserId: f.office.id, type, scheduledStart: "2035-01-02T15:00:00.000Z", scheduledEnd: "2035-01-02T16:00:00.000Z", confirmationNote: "Fictional customer agreed to this exact technician and window in a real office conversation.", customerConfirmed: true as const,
    ...(read.review.state === "ready" ? { schedulingReview: { context: read.review.context, duration: { kind: "explicit" as const, preset: null }, startWallTime: null, endWallTime: null } } : {}) };
}
async function configure(f: Fixture, gap = 60, cap: number | null = 2) {
  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, f.org));
  return saveSchedulingPolicy({ organizationId: f.org, userId: f.owner.id }, { expectedRevision: 0, expectedCompanyTimeZone: org.timezone, enabled: true, minimumTravelGapMinutes: gap, maxConcurrentReservations: cap, durationPresets: [] });
}
describe("CALLIE bounded office work", () => {
  it.each([false, true])("requires reviewed scheduling context for fresh staff booking configured=%s", async configured => {
    const f = await fixture(true);
    if (configured) await configure(f);
    const { schedulingReview: _review, ...input } = await booking(f);
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).rejects.toMatchObject({ code: "stale_scheduling_review" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect((await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id)).task.status).toBe("open");
  });
  it("reads actual selected-source scheduling context independently of a provider", async () => {
    const f = await fixture(true);
    vi.stubGlobal("fetch", () => { throw new Error("No provider calls allowed"); });
    const read = await callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: "other", propertyId: f.property.id });
    expect(read).toMatchObject({ organizationId: f.org, actorUserId: f.owner.id, intakeId: f.intake.id, appointmentType: "other", source: { contactId: f.contact.id, propertyId: f.property.id }, review: { state: "ready", context: { source: { contactId: f.contact.id, propertyId: f.property.id }, inspection: null, targetVersion: null, targetFingerprint: null } } });
  });
  it("keeps actual explicit customer property and current company zone independent of historical CALLIE and inspection zones", async () => {
    const f = await fixture(true);
    const prior = await callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: "inspection" });
    if (prior.review.state !== "ready") throw Error("Fixture scheduling context held");
    await db.update(organizationsTable).set({ timezone: "America/Los_Angeles" }).where(eq(organizationsTable.id, f.org));
    const [another] = await db.insert(propertiesTable).values({ organizationId: f.org, contactId: f.contact.id, addressLine1: "2 Fictional Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
    const [lead] = await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contact.id, propertyId: another.id }).returning();
    await db.update(missedCallHandoffsTable).set({ leadId: lead.id }).where(eq(missedCallHandoffsTable.id, f.handoff.id));
    const read = await callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: "inspection", propertyId: f.property.id });
    expect(read).toMatchObject({ source: { sourceKind: "lead", leadId: lead.id, propertyId: f.property.id }, review: { state: "ready", context: { companyTimeZone: "America/Los_Angeles", inspection: { ruleTimeZone: prior.review.context.inspection!.ruleTimeZone } } } });
    expect((await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id)).timezone).toBe(f.policy.snapshot.timezone);
    expect((await callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: "other" })).source?.propertyId).toBeNull();
    const booked = await bookCallieVisit(f.org, f.owner.id, f.intake.id, await booking(f));
    expect(booked.detail!.appointmentId).toBe(booked.bookingOutcome.appointmentId);
  });
  it("holds invalid policy while retaining real source, and rejects broken source rather than inventing lineage", async () => {
    const f = await fixture(true), p = await configure(f);
    await db.update(orgSettingsTable).set({ schedulingPolicy: { ...p.policy!, digest: "f".repeat(64) } }).where(eq(orgSettingsTable.organizationId, f.org));
    expect(await callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: "other" })).toMatchObject({ source: { contactId: f.contact.id, propertyId: null }, review: { state: "held", code: "invalid_scheduling_policy" } });
    await db.update(contactsTable).set({ phone: "+12025550124" }).where(eq(contactsTable.id, f.contact.id));
    await expect(callieOffice.getCallieSchedulingContext(f.org, f.owner.id, f.intake.id, { appointmentType: "other" })).rejects.toMatchObject({ code: "caller_source_changed" });
  });
  it("replays original committed evidence before deleted intake, changed policy/zone/lifecycle and assignee reads", async () => {
    const f = await fixture(true); await configure(f);
    const input = await booking(f), first = await bookCallieVisit(f.org, f.owner.id, f.intake.id, input);
    expect(callieBookingOutcomeSchema.safeParse(first.bookingOutcome).success).toBe(true);
    const [saved] = await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, first.bookingOutcome.appointmentId));
    expect(saved.schedulingReservation).toMatchObject({ admittedByUserId: f.owner.id, minimumTravelGapMinutes: 60, target: { id: saved.id } });
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, { ...input, schedulingReview: { ...input.schedulingReview!, context: { ...input.schedulingReview!.context, companyTimeZone: "America/Los_Angeles" } } })).rejects.toMatchObject({ code: "request_changed" });
    await db.update(organizationsTable).set({ timezone: "invalid/synthetic" }).where(eq(organizationsTable.id, f.org));
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.office.id));
    await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic hold", updatedByUserId: f.owner.id });
    await db.delete(callieIntakesTable).where(eq(callieIntakesTable.id, f.intake.id));
    expect(await bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).toEqual({ detail: null, replayed: true, bookingOutcome: first.bookingOutcome });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1);
    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org));
    expect(events.filter(e => e.action === "voice.callie.visit_booked")).toHaveLength(1);
    expect(events.filter(e => e.action === "scheduling.reservation_transition.v1")).toHaveLength(1);
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.owner.id));
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).rejects.toMatchObject({ code: "staff_required" });
  });
  it("preserves historical omitted-review hash and same actor, and refuses malformed original proof", async () => {
    const f = await fixture(true), { schedulingReview: _review, ...input } = await booking(f), appointmentId = randomUUID();
    const [audit] = await db.insert(auditEventsTable).values({ organizationId: f.org, actorUserId: f.owner.id, entityType: "callie_intake", entityId: f.intake.id, action: "voice.callie.visit_booked", metadata: { ...input, requestFingerprint: careFingerprint(input), appointmentId, evidence: "staff_attested_exact_customer_confirmation", noAutomaticResend: true } }).returning();
    await configure(f);
    expect(await bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).toMatchObject({ detail: null, replayed: true, bookingOutcome: { bookingId: audit.id, requestFingerprint: careFingerprint(input), actorUserId: f.owner.id, appointmentId } });
    await expect(bookCallieVisit(f.org, f.office.id, f.intake.id, input)).rejects.toMatchObject({ code: "request_changed" });
    await db.update(auditEventsTable).set({ metadata: { ...audit.metadata, appointmentId: "broken" } }).where(eq(auditEventsTable.id, audit.id));
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).rejects.toMatchObject({ code: "booking_proof_invalid" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("matches actual source hash vectors, preserves original strings/omission and rejects server fields", async () => {
    const f = await fixture(true), current = await booking(f), { schedulingReview: _review, ...legacy } = current;
    for (const body of [current, legacy, { ...legacy, confirmationNote: `  ${legacy.confirmationNote}  ` }, Object.fromEntries(Object.entries(legacy).reverse())]) {
      expect(createHash("sha256").update(canonicalCallieBookingInput(body)).digest("hex")).toBe(careFingerprint(callieBookingSchema.parse(body)));
    }
    expect(canonicalCallieBookingInput(legacy)).not.toContain("schedulingReview");
    expect(canonicalCallieBookingInput({ ...legacy, scheduledStart: legacy.scheduledStart.replace(".000Z", "Z") })).not.toBe(canonicalCallieBookingInput(legacy));
    expect(canonicalCallieBookingInput({ ...legacy, requestId: randomUUID() })).not.toBe(canonicalCallieBookingInput(legacy));
    for (const extra of [{ operationId: randomUUID() }, { actorUserId: f.owner.id }, { schedulingReservation: null }, { schedulingReview: null }]) expect(callieBookingSchema.safeParse({ ...legacy, ...extra }).success).toBe(false);
    const vector = { assignedUserId: "staff-fixture", confirmationNote: "Customer agreed to the exact visit.", contactId: "22222222-2222-4222-8222-222222222222", customerConfirmed: true, expectedFingerprint: "a".repeat(64), expectedVersion: 3, leadId: null, propertyId: null, requestId: "11111111-1111-4111-8111-111111111111", scheduledEnd: "2035-01-02T16:00:00.000Z", scheduledStart: "2035-01-02T15:00:00.000Z", type: "other" };
    expect(careFingerprint(callieBookingSchema.parse(vector))).toBe("91cf8407917bd2d9077b4baba14eb614c17bb908503fca4024892ea6b65ffc22");
  });
  it.each(["policy", "zone", "type", "property"])("refuses a stale reviewed scheduling %s with no partial office writes", async changed => {
    const f = await fixture(true);
    await db.update(usersTable).set({ isPlatformAdmin: true }).where(eq(usersTable.id, f.owner.id));
    const input = await booking(f);
    if (changed === "policy") await configure(f);
    if (changed === "zone") { const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, f.org)); await setSchedulingCompanyTimeZone({ organizationId: f.org, userId: f.owner.id }, f.org, "America/Los_Angeles", org.timezone); }
    if (changed === "type") input.type = "inspection";
    const submitted = changed === "property" ? { ...input, propertyId: null } : input;
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, submitted)).rejects.toMatchObject({ code: "stale_scheduling_review" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect((await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id)).task.status).toBe("open");
  });
  it("reads typed caller requests without returning encrypted replay/challenges or inventing identity/booking", async () => {
    const f = await fixture(); const before = await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org));
    const value = await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id);
    expect(value).toMatchObject({ requestIntent: "visit", identityReviewed: false, appointment: null, smsProof: "not_confirmed", actions: { canBook: false, canReviewCaller: true } });
    expect(JSON.stringify(value)).not.toMatch(/challengeHash|challengeEncrypted|stepReceipts|triggerPayloadHash|triggerMessageSid/);
    expect(await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org))).toHaveLength(before.length);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org))).toHaveLength(0);
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, await booking(f))).rejects.toMatchObject({ code: "caller_review_required" });
  });
  it("requires the current strict caller review and keeps the original accountable owner", async () => {
    const f = await fixture();
    expect(await reviewMissedCall(f.org, f.call.id, f.office.id, { requestId: randomUUID(), action: "link_contact", contactId: f.contact.id })).toEqual({ error: "callie_review_required" });
    const input = { ...await command(f), action: "link_contact", contactId: f.contact.id, staffConfirmed: true };
    const result = await reviewCallieCaller(f.org, f.office.id, f.intake.id, input);
    expect(result.detail).toMatchObject({ identityReviewed: true, contact: { id: f.contact.id }, owner: { id: f.owner.id, eligible: true }, actions: { canBook: true } });
    expect((await reviewCallieCaller(f.org, f.office.id, f.intake.id, input)).replayed).toBe(true);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.task.id)))[0].assignedUserId).toBe(f.owner.id);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("books exactly one native appointment, closes the original task and returns a lost-ack replay", async () => {
    const f = await fixture(true), input = await booking(f);
    vi.stubGlobal("fetch", () => { throw new Error("No provider calls allowed"); });
    const first = await bookCallieVisit(f.org, f.owner.id, f.intake.id, input);
    expect(first.detail).toMatchObject({ state: "booked", appointment: { status: "confirmed", assignedUserId: f.office.id }, task: { status: "done" } });
    const repeated = await bookCallieVisit(f.org, f.owner.id, f.intake.id, input);
    expect(repeated.replayed).toBe(true); expect(repeated.detail).toBeNull(); expect(repeated.bookingOutcome).toEqual(first.bookingOutcome);
    expect(first.bookingOutcome.appointmentId).toBe(first.detail!.appointment?.id);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1);
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, { ...input, confirmationNote: "Changed statement for the same saved identity." })).rejects.toMatchObject({ code: "request_changed" });
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, { ...await booking(f), requestId: randomUUID() })).rejects.toMatchObject({ code: "office_work_closed" });
  });
  it("does not undo another CRM task assignment during identity review and requires explicit ownership repair", async () => {
    const f = await fixture();
    await db.update(crmTasksTable).set({ assignedUserId: f.office.id }).where(eq(crmTasksTable.id, f.task.id));
    const read = await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id);
    expect(read.actions).toMatchObject({ canReviewCaller: false, canBook: false, canClose: false, canAssign: true, blockReason: "owner_review_required" });
    await expect(reviewCallieCaller(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "link_contact", contactId: f.contact.id, staffConfirmed: true })).rejects.toMatchObject({ code: "owner_review_required" });
    await expect(updateCallieOffice(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "resolved", note: "Must not silently take another teammate's callback.", staffConfirmed: true })).rejects.toMatchObject({ code: "owner_review_required" });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.task.id)))[0].assignedUserId).toBe(f.office.id);
    await updateCallieOffice(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "assign", assignedUserId: f.office.id, note: "Explicitly adopt the existing callback task assignee." });
    const reviewed = await reviewCallieCaller(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "link_contact", contactId: f.contact.id, staffConfirmed: true });
    expect(reviewed.detail.owner).toMatchObject({ id: f.office.id, eligible: true });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.task.id)))[0].assignedUserId).toBe(f.office.id);
  });
  it.each(["contact", "property", "technician", "choice", "task"])("rejects a stale exact office agreement after %s changes", async changed => {
    const f = await fixture(true), input = await booking(f);
    if (changed === "contact") await db.update(contactsTable).set({ phone: "+12025550124" }).where(eq(contactsTable.id, f.contact.id));
    if (changed === "property") await db.update(propertiesTable).set({ addressLine1: "2 Changed Lane", updatedAt: f.property.updatedAt }).where(eq(propertiesTable.id, f.property.id));
    if (changed === "technician") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.office.id));
    if (changed === "choice") await db.update(callieIntakesTable).set({ requestIntent: "callback" }).where(eq(callieIntakesTable.id, f.intake.id));
    if (changed === "task") await db.update(crmTasksTable).set({ assignedUserId: f.office.id }).where(eq(crmTasksTable.id, f.task.id));
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).rejects.toMatchObject({ code: "stale_review" });
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("enforces same-customer property, future windows and staff conflicts without partially closing the task", async () => {
    const f = await fixture(true), other = await fixture(true), input = await booking(f);
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, { ...input, propertyId: other.property.id })).rejects.toMatchObject({ code: "property_mismatch" });
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, { ...input, scheduledStart: "2020-01-02T15:00:00.000Z", scheduledEnd: "2020-01-02T16:00:00.000Z" })).rejects.toMatchObject({ code: "invalid_window" });
    await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact.id, assignedUserId: f.office.id, type: "other", scheduledStart: new Date(input.scheduledStart), scheduledEnd: new Date(input.scheduledEnd) });
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).rejects.toMatchObject({ code: "resource_conflict" });
    expect((await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id)).task.status).toBe("open");
  });
  it("blocks in-flight and unreconciled effects, then permits an office decision without changing its receipt", async () => {
    const f = await fixture(true);
    const [receipt] = await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: careOperationKey(f.call.id), fingerprint: "a".repeat(64), kind: "callie", state: "indeterminate", expiresAt: new Date(Date.now() - 1000) }).returning();
    const sid = `SM${randomUUID().replaceAll("-", "")}`;
    await db.insert(twilioInboundEventsTable).values({ organizationId: f.org, messageSid: sid, phone: f.call.phone, eventType: "message", body: null });
    await db.update(callieIntakesTable).set({ state: "indeterminate", triggerMessageSid: sid, triggerAccountSid: f.binding.accountSid, triggerFrom: f.call.phone,
      triggerTo: f.binding.phoneNumber, triggerPayloadHash: "b".repeat(64), confirmedAt: new Date(), grantExpiresAt: new Date(Date.now() + 3600_000) }).where(eq(callieIntakesTable.id, f.intake.id));
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, await booking(f))).rejects.toMatchObject({ code: "provider_reconciliation_required" });
    await db.update(revenueExecutionsTable).set({ state: "processing" }).where(eq(revenueExecutionsTable.id, receipt.id));
    await expect(updateCallieOffice(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "assign", assignedUserId: f.office.id, note: "Explicit reassignment while provider active." })).rejects.toMatchObject({ code: "dispatch_in_progress" });
    await db.update(revenueExecutionsTable).set({ state: "confirmed_not_performed" }).where(eq(revenueExecutionsTable.id, receipt.id));
    await bookCallieVisit(f.org, f.owner.id, f.intake.id, await booking(f));
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, receipt.id)))[0].state).toBe("confirmed_not_performed");
  });
  it("reassigns only accepted staff, holds automation and distinguishes stop from handled", async () => {
    const f = await fixture(), foreign = await fixture();
    await expect(updateCallieOffice(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "assign", assignedUserId: foreign.office.id, note: "No cross-company assignment permitted." })).rejects.toMatchObject({ code: "invalid_assignee" });
    const reassigned = await updateCallieOffice(f.org, f.owner.id, f.intake.id, { ...await command(f), action: "assign", assignedUserId: f.office.id, note: "Office teammate has accepted callback responsibility." });
    expect(reassigned.detail).toMatchObject({ reason: "owner_changed_office_only", owner: { id: f.office.id, eligible: true } });
    const stopped = await updateCallieOffice(f.org, f.office.id, f.intake.id, { ...await command(f), action: "cancelled", note: "Stop automation and keep this callback work open.", staffConfirmed: true });
    expect(stopped.detail).toMatchObject({ state: "cancelled", task: { status: "open" } });
    const resolved = await fixture();
    expect((await updateCallieOffice(resolved.org, resolved.owner.id, resolved.intake.id, { ...await command(resolved), action: "resolved", note: "Office completed the actual customer callback.", staffConfirmed: true })).detail.task.status).toBe("done");
  });
  it("returns oldest unresolved work across bounded pages and separates waiting/history", async () => {
    const f = await fixture();
    for (let index = 0; index < 27; index++) {
      const [call] = await db.insert(twilioCallsTable).values({ organizationId: f.org, requestKey: randomUUID(), direction: "inbound", phone: f.call.phone, staffPhone: f.call.staffPhone, accountSid: f.binding.accountSid, providerSid: `CA${randomUUID().replaceAll("-", "")}`, dialStatus: "no-answer", authorizationSource: "signed-inbound" }).returning();
      const [task] = await db.insert(crmTasksTable).values({ organizationId: f.org, title: "Paged fictional callback", assignedUserId: f.owner.id }).returning();
      await db.insert(missedCallHandoffsTable).values({ organizationId: f.org, callId: call.id, taskId: task.id });
      await db.insert(callieIntakesTable).values({ organizationId: f.org, callId: call.id, policyRevisionId: f.policy.id, bindingId: f.binding.id, accountSid: f.binding.accountSid, providerCallSid: call.providerSid!, fromPhone: call.phone, calledNumber: f.binding.phoneNumber, ownerUserId: f.owner.id, dueAt: new Date(Date.now() - (index + 2) * 60_000), state: "blocked", stage: "complete" });
    }
    const first = await listCallieOffice(f.org, f.owner.id, { scope: "attention", offset: 0 });
    const second = await listCallieOffice(f.org, f.owner.id, { scope: "attention", offset: 25 });
    expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true); expect(second.items).toHaveLength(3); expect(second.hasMore).toBe(false);
    expect(second.items.at(-1)?.id).toBe(f.intake.id);
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(28);
    await db.update(callieIntakesTable).set({ state: "awaiting_sms", dueAt: new Date(Date.now() + 600_000) }).where(eq(callieIntakesTable.id, f.intake.id));
    expect((await listCallieOffice(f.org, f.owner.id, { scope: "waiting", offset: 0 })).items.map(row => row.id)).toEqual([f.intake.id]);
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.owner.id));
    expect((await listCallieOffice(f.org, f.office.id, { scope: "waiting", offset: 0 })).items).toHaveLength(0);
  });
  it("rejects foreign and unaccepted staff, and preserves read access while company work is held", async () => {
    const f = await fixture(true), other = await fixture();
    await expect(getCallieOfficeDetail(other.org, other.owner.id, f.intake.id)).rejects.toMatchObject({ code: "not_found" });
    await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, f.office.id));
    await expect(getCallieOfficeDetail(f.org, f.office.id, f.intake.id)).rejects.toMatchObject({ code: "staff_required" });
    await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic company hold", updatedByUserId: f.owner.id });
    expect((await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id)).companyHeld).toBe(true);
    await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, await booking(f))).rejects.toMatchObject({ code: "company_held" });
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("concurrent same-request office bookings own only one appointment on independent PostgreSQL sessions", async () => {
    const f = await fixture(true), input = await booking(f);
    const [a, b] = await Promise.all([bookCallieVisit(f.org, f.owner.id, f.intake.id, input), bookCallieVisit(f.org, f.owner.id, f.intake.id, input)]);
    expect(a.bookingOutcome).toEqual(b.bookingOutcome); expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1);
  });
});

async function blockedBy(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))", [pid]);
    if (result.rows[0]) return Number(result.rows[0].pid);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Independent CALLIE PostgreSQL contender was not observed");
}
async function barrier(table: string, org: string, timing: string, column = "organization_id") {
  const hook = `qa_callie_${randomUUID().replaceAll("-", "")}`, keeper = await pool.connect();
  await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${column}='${org}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtext('${hook}')); END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${hook} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
  await keeper.query("BEGIN"); await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hook]);
  const pid = Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  return { pid, release: () => keeper.query("COMMIT"), cleanup: async (pending: Promise<unknown>[]) => {
    await keeper.query("ROLLBACK"); keeper.release(); await Promise.allSettled(pending);
    await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`); await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
  } };
}
function pendingResult<T>(operation: Promise<T>, pending: Promise<unknown>[]) {
  const result = operation.then(value => ({ value, error: null }), error => ({ value: null, error })); pending.push(result); return result;
}
const raceCases = (["policy", "zone", "travel", "company", "staff", "property", "lifecycle"] as const).flatMap(kind => [false, true].map(callieFirst => ({ kind, callieFirst })));
it.each(raceCases)("observes independent PG CALLIE/$kind order callieFirst=$callieFirst", async ({ kind, callieFirst }) => {
  const f = await fixture(true);
  await db.update(usersTable).set({ isPlatformAdmin: true }).where(eq(usersTable.id, f.owner.id));
  const saved = await configure(f, kind === "travel" ? 60 : 0, kind === "company" ? 1 : null), input = await booking(f), actor = { organizationId: f.org, userId: f.owner.id };
  const context = await getSchedulingReviewContext(actor, { sourceKind: "direct_customer", sourceId: f.contact.id, propertyId: f.property.id, reservationKind: "appointment", appointmentType: "other" });
  const native = { kind: "appointment_create" as const, operationId: randomUUID(), body: { contactId: f.contact.id, propertyId: f.property.id, type: "other" as const, assignedUserId: kind === "travel" ? f.office.id : f.owner.id,
    scheduledStart: kind === "travel" ? "2035-01-02T16:30:00.000Z" : input.scheduledStart, scheduledEnd: kind === "travel" ? "2035-01-02T17:30:00.000Z" : input.scheduledEnd }, review: { context, duration: { kind: "explicit" as const, preset: null }, startWallTime: null, endWallTime: null } };
  const mutate = async (): Promise<unknown> => {
    if (kind === "policy") return saveSchedulingPolicy(actor, { expectedRevision: saved.policy!.revision, expectedCompanyTimeZone: context.companyTimeZone, enabled: true, minimumTravelGapMinutes: 90, maxConcurrentReservations: null, durationPresets: [] });
    if (kind === "zone") return setSchedulingCompanyTimeZone(actor, f.org, "America/Los_Angeles", context.companyTimeZone);
    if (kind === "travel" || kind === "company") return createManualScheduledAppointment(actor, native);
    if (kind === "staff") return db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.office.id));
    if (kind === "lifecycle") return transitionCustomerLifecycle(f.org, f.owner.id, { action: "pause", expectedVersion: 0, reason: "Synthetic independently ordered pause" });
    return db.update(propertiesTable).set({ addressLine1: "Changed while a visit was reviewed", updatedAt: f.property.updatedAt }).where(eq(propertiesTable.id, f.property.id));
  };
  const table = callieFirst || kind === "travel" || kind === "company" ? "appointments" : kind === "policy" ? "org_settings" : kind === "zone" ? "organizations" : kind === "staff" ? "users" : kind === "lifecycle" ? "customer_lifecycle" : "properties";
  const hold = await barrier(table, f.org, table === "appointments" || table === "customer_lifecycle" ? "BEFORE INSERT" : "BEFORE UPDATE", table === "organizations" ? "id" : "organization_id"), pending: Promise<unknown>[] = [];
  try {
    const first = pendingResult(callieFirst ? bookCallieVisit(f.org, f.owner.id, f.intake.id, input) : mutate(), pending), firstPid = await blockedBy(hold.pid);
    const second = pendingResult(callieFirst ? mutate() : bookCallieVisit(f.org, f.owner.id, f.intake.id, input), pending), secondPid = await blockedBy(firstPid);
    expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
    console.info("CALLIE_PG_BARRIER", JSON.stringify({ kind, callieFirst, keeperPid: hold.pid, firstPid, secondPid }));
    await hold.release();
    const [a, b] = await Promise.all([first, second]), booked = callieFirst ? a : b, mutation = callieFirst ? b : a;
    if (callieFirst) {
      expect(booked.error).toBeNull(); expect(booked.value).toMatchObject({ bookingOutcome: { status: "committed", requestId: input.requestId } });
      if (kind === "travel" || kind === "company") expect(mutation.value).toMatchObject({ ack: { outcome: "no_commit_refused", refusalCode: kind === "travel" ? "travel_conflict" : "company_capacity_conflict" } });
      else expect(mutation.error).toBeNull();
    } else {
      expect(mutation.error).toBeNull();
      expect(booked.error).toMatchObject({ code: kind === "travel" ? "travel_conflict" : kind === "company" ? "company_capacity_conflict" : kind === "staff" || kind === "property" || kind === "lifecycle" ? "stale_review" : "stale_scheduling_review" });
    }
    const reread = await db.select().from(callieIntakesTable).where(eq(callieIntakesTable.id, f.intake.id));
    expect(reread[0].appointmentId !== null).toBe(callieFirst);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.task.id)))[0].status).toBe(callieFirst ? "done" : "open");
  } finally { await hold.cleanup(pending); }
}, 30000);

it("uses inspection true peak and retains the independent rule zone without imposing concierge hours", async () => {
  const f = await fixture(true);
  await db.insert(orgSettingsTable).values({ organizationId: f.org, inspectionAvailability: { timezone: "America/New_York", days: ["Mon"], windows: [{ startHour: 9, endHour: 10 }], blackoutDates: ["2035-01-02"], maxBookingsPerWindow: 2 } });
  await db.update(organizationsTable).set({ timezone: "America/Los_Angeles" }).where(eq(organizationsTable.id, f.org));
  await configure(f, 0, 2);
  for (const hour of [15, 16]) await db.insert(appointmentsTable).values({ organizationId: f.org, type: "inspection", status: "confirmed", scheduledStart: new Date(`2035-01-02T${hour}:00:00.000Z`), scheduledEnd: new Date(`2035-01-02T${hour + 1}:00:00.000Z`) });
  const input = await booking(f, "inspection"); input.scheduledEnd = "2035-01-02T17:00:00.000Z";
  expect(input.schedulingReview!.context).toMatchObject({ companyTimeZone: "America/Los_Angeles", inspection: { ruleTimeZone: "America/New_York" }, applicableRules: { companyCeiling: 2, inspectionCeiling: 2 } });
  expect((await bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).bookingOutcome.status).toBe("committed");
});

it.each(["crm_tasks", "scheduled_actions", "audit_events"])("rolls back CALLIE booking/transition/reminder/task when %s write fails", async table => {
  const f = await fixture(true); await configure(f);
  const input = await booking(f), hook = `qa_callie_fail_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid ${table === "audit_events" ? "AND NEW.action='voice.callie.visit_booked'" : ""} THEN RAISE EXCEPTION 'synthetic atomic booking failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${hook} BEFORE ${table === "crm_tasks" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
  try { await expect(bookCallieVisit(f.org, f.owner.id, f.intake.id, input)).rejects.toThrow(); }
  finally { await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`); await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`); }
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
  expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
  expect((await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id)).task.status).toBe("open");
  expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org))).filter(row => ["voice.callie.visit_booked", "scheduling.reservation_transition.v1"].includes(row.action))).toHaveLength(0);
});
