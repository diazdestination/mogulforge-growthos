import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, leadsTable, missedCallHandoffsTable, propertiesTable, revenueExecutionsTable, twilioCallsTable, twilioInboundEventsTable, usersTable } from "@workspace/db";
import { callieIntakesTable } from "../../../../lib/db/src/schema/callie";
import { callieOfficeFixture } from "../test-helpers/callie-office-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { bookCallieVisit, getCallieOfficeDetail, listCallieOffice, reviewCallieCaller, updateCallieOffice } from "./callie-office";
import { reviewMissedCall } from "./missed-call-handoff";
import { careOperationKey } from "./missed-call-care-policy";

const orgs: string[] = [];
async function fixture(reviewed = false) { const f = await callieOfficeFixture(reviewed); orgs.push(f.org); return f; }
afterAll(async () => { await deleteTestOrgs(...orgs); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(f: Fixture) { const read = await getCallieOfficeDetail(f.org, f.owner.id, f.intake.id); return { requestId: randomUUID(), expectedVersion: read.version, expectedFingerprint: read.expectedFingerprint }; }
async function booking(f: Fixture) { return { ...await command(f), contactId: f.contact.id, leadId: null, propertyId: f.property.id, assignedUserId: f.office.id, type: "other" as const, scheduledStart: "2035-01-02T15:00:00.000Z", scheduledEnd: "2035-01-02T16:00:00.000Z", confirmationNote: "Fictional customer agreed to this exact technician and window in a real office conversation.", customerConfirmed: true as const }; }
describe("CALLIE bounded office work", () => {
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
    expect(repeated.replayed).toBe(true); expect(repeated.detail.appointment?.id).toBe(first.detail.appointment?.id);
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
    expect(a.detail.appointment?.id).toBe(b.detail.appointment?.id); expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1);
  });
});
