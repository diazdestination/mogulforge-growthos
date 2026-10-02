import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, DEFAULT_INSPECTION_AVAILABILITY, organizationsTable, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { serviceWatchCasesTable as cases } from "../../../../lib/db/src/schema/service-watch";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createServiceObligation, updateServiceObligation } from "./service-obligations";
import { enqueueStaffServiceNotice } from "./staff-push";
import { getServiceWatch, listServiceWatch, processServiceWatch, serviceWatchNoticeCurrent, updateServiceWatch } from "./service-watch";
import { serviceWatchReasons, WATCH_BATCH_SIZE, type WatchFacts } from "./service-watch-policy";

vi.mock("./staff-push", async original => ({ ...await original<typeof import("./staff-push")>(), enqueueStaffServiceNotice: vi.fn() }));
const orgs: string[] = [];
const now = () => new Date();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture(dueDate = day(5), assigned = true) {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic watch company", slug: `service-watch-${randomUUID()}` }).returning(); orgs.push(org.id);
  const [staff] = await db.insert(usersTable).values({ organizationId: org.id, role: "office", emailVerifiedAt: now() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic service customer", email: "watch@example.invalid" }).returning();
  await db.insert(orgSettingsTable).values({ organizationId: org.id, inspectionAvailability: { ...DEFAULT_INSPECTION_AVAILABILITY, timezone: "America/New_York" } });
  const service = await createServiceObligation(org.id, staff.id, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic heat pump", dueDate, noticeDays: 14, assignedUserId: assigned ? staff.id : undefined });
  if ("error" in service) throw new Error(service.error);
  return { org: org.id, staff: staff.id, contact: contact.id, service };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(f: Fixture, action: "assign" | "acknowledge" = "acknowledge") {
  const detail = await getServiceWatch(f.org, f.staff, f.service.id);
  return { action, requestId: randomUUID(), expectedVersion: detail.expectedVersion, expectedFingerprint: detail.expectedFingerprint, assignedUserId: f.staff,
    note: "Office will call the customer and review the actual reply.", ...(action === "acknowledge" ? { nextActionAt: new Date(Date.now() + 86_400_000).toISOString(), reviewed: true } : {}) };
}
async function auditCare(f: Fixture, action: string, metadata: Record<string, unknown> = {}, at = now()) {
  const [row] = await db.insert(auditEventsTable).values({ organizationId: f.org, actorUserId: f.staff, action: `service.care_${action}`, entityType: "service_obligation", entityId: f.service.id, createdAt: at, metadata }).returning(); return row;
}
async function approval(f: Fixture, receiptState?: "blocked" | "indeterminate" | "processing" | "succeeded") {
  const [scheduled] = await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: { type: "service_care_reminder", params: {} }, context: {}, runAt: now() }).returning();
  await auditCare(f, "reminder_approved", { scheduledActionId: scheduled.id, snapshot: { updatedAt: f.service.updatedAt.toISOString() } });
  if (receiptState) await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${scheduled.id}`, kind: "service_care_reminder", state: receiptState, fingerprint: "synthetic", expiresAt: new Date(Date.now() - 1000) });
  return scheduled;
}

describe("service watch deterministic policy", () => {
  const base: WatchFacts = { active: true, dueDate: "2035-01-05", today: "2035-01-01", noticeAt: new Date("2034-12-22Z"), booked: false, appointmentStatus: null,
    approval: false, approvalChanged: false, scheduledState: null, receiptState: null, receiptExpiresAt: null, acceptedAt: null, responseRecorded: false, ownerValid: true, nextActionAt: null };
  it("distinguishes review, recorded silence, response and booking without fabricating them", () => {
    const at = new Date("2035-01-01T12:00:00Z");
    expect(serviceWatchReasons(base, at)).toEqual(["reminder_needs_review"]);
    expect(serviceWatchReasons({ ...base, approval: true, scheduledState: "completed", acceptedAt: new Date("2034-12-28Z") }, at)).toEqual(["no_response_recorded"]);
    expect(serviceWatchReasons({ ...base, responseRecorded: true }, at)).toEqual(["response_needs_action"]);
    expect(serviceWatchReasons({ ...base, booked: true }, at)).toEqual([]);
    expect(serviceWatchReasons({ ...base, booked: true, dueDate: "2034-12-31" }, at)).toEqual(["service_overdue"]);
  });
  it("keeps unknown sends even after completion and preserves declined/no-show follow-up", () => {
    const at = new Date("2035-01-01Z");
    expect(serviceWatchReasons({ ...base, active: false, receiptState: "indeterminate" }, at)).toEqual(["send_unknown"]);
    expect(serviceWatchReasons({ ...base, appointmentStatus: "no_show", ownerValid: false }, at)).toEqual(["visit_no_show", "reminder_needs_review", "owner_required"]);
  });
});

it("GET is readonly; a due service opens exactly one retained watch and notification event", async () => {
  const f = await fixture();
  expect(await getServiceWatch(f.org, f.staff, f.service.id)).toMatchObject({ expectedVersion: 0, reasons: ["reminder_needs_review"], monitorPending: true });
  expect(await db.select().from(cases).where(eq(cases.organizationId, f.org))).toHaveLength(0);
  await processServiceWatch(f.org);
  const [first] = await db.select().from(cases).where(eq(cases.organizationId, f.org));
  expect(first).toMatchObject({ state: "open", episode: 1, assignedUserId: f.staff });
  await processServiceWatch(f.org);
  expect(await db.select().from(cases).where(eq(cases.organizationId, f.org))).toHaveLength(1);
  expect(enqueueStaffServiceNotice).toHaveBeenCalledTimes(1);
  expect(vi.mocked(enqueueStaffServiceNotice).mock.calls[0][0]).toMatchObject({ organizationId: f.org, serviceObligationId: f.service.id, assignedUserId: f.staff, eventKey: `service-watch:${first.id}:${first.noticeRevision}` });
  expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
});

it("acknowledges the actual task owner/deadline once; no invented response, then reopens at deadline", async () => {
  const f = await fixture(); await processServiceWatch(f.org);
  const input = await command(f);
  const result = await updateServiceWatch(f.org, f.staff, f.service.id, input);
  expect(await updateServiceWatch(f.org, f.staff, f.service.id, input)).toEqual({ ...result, replayed: true });
  expect(await updateServiceWatch(f.org, f.staff, f.service.id, input, new Date(Date.now() + 3 * 86_400_000))).toEqual({ ...result, replayed: true });
  const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.service.taskId));
  expect(task.assignedUserId).toBe(f.staff); expect(task.dueAt!.toISOString()).toBe(input.nextActionAt);
  expect(await getServiceWatch(f.org, f.staff, f.service.id)).toMatchObject({ state: "acknowledged", nextAction: input.note });
  await processServiceWatch(f.org); expect(enqueueStaffServiceNotice).toHaveBeenCalledTimes(1);
  await processServiceWatch(f.org, new Date(Date.now() + 2 * 86_400_000));
  const [row] = await db.select().from(cases).where(eq(cases.organizationId, f.org)); expect(row.state).toBe("open"); expect(row.reasons).toContain("next_action_overdue");
  expect((await getServiceWatch(f.org, f.staff, f.service.id)).history.some(event => event.action === "service.watch_reopened")).toBe(true);
  expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_response_recorded")))).toHaveLength(0);
});

it("rejects stale source and stale plan revisions without changing task/plan", async () => {
  const f = await fixture(); await processServiceWatch(f.org); const input = await command(f);
  await db.update(serviceObligationsTable).set({ notes: "Changed source agreement requires fresh review" }).where(eq(serviceObligationsTable.id, f.service.id));
  await expect(updateServiceWatch(f.org, f.staff, f.service.id, input)).rejects.toMatchObject({ code: "stale_watch" });
  const fresh = await command(f); await updateServiceWatch(f.org, f.staff, f.service.id, fresh);
  await expect(updateServiceWatch(f.org, f.staff, f.service.id, { ...fresh, requestId: randomUUID() })).rejects.toMatchObject({ code: "stale_watch" });
  await expect(updateServiceWatch(f.org, f.staff, f.service.id, { ...fresh, note: "Different office note on same request." })).rejects.toMatchObject({ code: "request_changed" });
});

it("assigns unowned canonical work, rejects foreign/inactive/invited staff and never broadcasts", async () => {
  const f = await fixture(day(5), false); await processServiceWatch(f.org);
  expect(enqueueStaffServiceNotice).not.toHaveBeenCalled();
  const foreign = await fixture(); const input = await command(f, "assign");
  await expect(updateServiceWatch(f.org, f.staff, f.service.id, { ...input, assignedUserId: foreign.staff })).rejects.toMatchObject({ code: "invalid_assignee" });
  const [disabled] = await db.insert(usersTable).values({ organizationId: f.org, role: "office", isActive: false, emailVerifiedAt: now() }).returning();
  await expect(updateServiceWatch(f.org, f.staff, f.service.id, { ...input, assignedUserId: disabled.id })).rejects.toMatchObject({ code: "invalid_assignee" });
  await updateServiceWatch(f.org, f.staff, f.service.id, input);
  expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).not.toContain("owner_required");
  expect(enqueueStaffServiceNotice).toHaveBeenCalledTimes(1);
});

it("shows paused history, prevents staff changes and notices, and reopens after approved resume", async () => {
  const f = await fixture(); await processServiceWatch(f.org); const input = await command(f);
  await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", version: 1, reason: "Synthetic pause" });
  await processServiceWatch(f.org);
  expect(await getServiceWatch(f.org, f.staff, f.service.id)).toMatchObject({ held: true, state: "held" });
  await expect(updateServiceWatch(f.org, f.staff, f.service.id, input)).rejects.toMatchObject({ status: 423 });
  expect(enqueueStaffServiceNotice).toHaveBeenCalledTimes(1);
  await db.update(customerLifecycleTable).set({ state: "active", version: 2 }).where(eq(customerLifecycleTable.organizationId, f.org));
  await processServiceWatch(f.org);
  const history = (await getServiceWatch(f.org, f.staff, f.service.id)).history.map(event => event.action);
  expect(history).toContain("service.watch_held"); expect(history).toContain("service.watch_reopened");
});

it("uses recorded acceptance not delivery and keeps blocked/expired effects visible without rearming", async () => {
  const f = await fixture(); const scheduled = await approval(f, "processing"); await processServiceWatch(f.org);
  expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).toContain("send_unknown");
  await db.update(revenueExecutionsTable).set({ state: "succeeded" }).where(eq(revenueExecutionsTable.organizationId, f.org));
  await auditCare(f, "reminder_accepted", { scheduledActionId: scheduled.id, deliveryConfirmed: false }, new Date(Date.now() - 4 * 86_400_000));
  await processServiceWatch(f.org); expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).toContain("no_response_recorded");
  await db.update(revenueExecutionsTable).set({ state: "blocked" }).where(eq(revenueExecutionsTable.organizationId, f.org));
  await processServiceWatch(f.org); expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).toContain("reminder_blocked");
  expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
});

it("resolves from a linked accepted visit and reopens on cancellation without inventing a new one", async () => {
  const f = await fixture(); await processServiceWatch(f.org);
  const [appointment] = await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact, assignedUserId: f.staff, status: "confirmed", scheduledStart: new Date(Date.now() + 86_400_000) }).returning();
  await db.update(serviceObligationsTable).set({ appointmentId: appointment.id }).where(eq(serviceObligationsTable.id, f.service.id));
  await processServiceWatch(f.org);
  expect((await getServiceWatch(f.org, f.staff, f.service.id)).state).toBe("resolved");
  await db.update(appointmentsTable).set({ status: "cancelled" }).where(eq(appointmentsTable.id, appointment.id));
  await processServiceWatch(f.org);
  const detail = await getServiceWatch(f.org, f.staff, f.service.id); expect(detail.reasons).toContain("visit_cancelled"); expect(detail.state).toBe("open");
  expect(detail.history.map(event => event.action)).toContain("service.watch_resolved");
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1);
});

it("keeps unknown ownership after service completion and uses configured calendar dates", async () => {
  const f = await fixture("2026-10-02"); await approval(f, "indeterminate");
  const detail = await getServiceWatch(f.org, f.staff, f.service.id, new Date("2026-10-03T02:00:00Z"));
  expect(detail.today).toBe("2026-10-02"); expect(detail.reasons).not.toContain("service_overdue");
  await updateServiceObligation(f.org, f.staff, f.service.id, { status: "completed", completionNote: "Synthetic technician recorded service completion." });
  await processServiceWatch(f.org); expect((await getServiceWatch(f.org, f.staff, f.service.id)).reasons).toEqual(["send_unknown"]);
});

it("guards notice dispatch against ack, service changes, reassignment and current holds", async () => {
  const f = await fixture(); await processServiceWatch(f.org);
  const [row] = await db.select().from(cases).where(eq(cases.organizationId, f.org));
  expect(await serviceWatchNoticeCurrent(f.org, row.id, row.noticeRevision, f.staff)).toBe(true);
  expect(await serviceWatchNoticeCurrent(f.org, row.id, row.noticeRevision + 1, f.staff)).toBe(false);
  await db.update(contactsTable).set({ firstName: "Changed synthetic identity" }).where(eq(contactsTable.id, f.contact));
  expect(await serviceWatchNoticeCurrent(f.org, row.id, row.noticeRevision, f.staff)).toBe(false);
  await processServiceWatch(f.org); await updateServiceWatch(f.org, f.staff, f.service.id, await command(f));
  expect(await serviceWatchNoticeCurrent(f.org, row.id, row.noticeRevision, f.staff)).toBe(false);
});

it("rotates older held rows so later cases are evaluated and reports unmonitored work truthfully", async () => {
  const f = await fixture();
  for (let i = 0; i < WATCH_BATCH_SIZE + 2; i++) {
    const service = await createServiceObligation(f.org, f.staff, { contactId: f.contact, kind: "maintenance", equipmentLabel: `Synthetic unit ${i}`, dueDate: day(5), noticeDays: 14, assignedUserId: f.staff });
    if ("error" in service) throw new Error(service.error);
  }
  await processServiceWatch(f.org, new Date(Date.now() - 2000));
  expect((await listServiceWatch(f.org, f.staff)).unmonitoredCount).toBe(3);
  await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", version: 1, reason: "Synthetic hold" });
  await processServiceWatch(f.org, new Date(Date.now() - 1000)); await processServiceWatch(f.org);
  expect((await listServiceWatch(f.org, f.staff)).unmonitoredCount).toBe(0);
  const all = await db.select().from(cases).where(eq(cases.organizationId, f.org)); expect(all).toHaveLength(WATCH_BATCH_SIZE + 3); expect(all.every(row => row.state === "held")).toBe(true);
});

it("isolates foreign service/history and denies unverified or viewer writes", async () => {
  const f = await fixture(), foreign = await fixture();
  await expect(getServiceWatch(foreign.org, foreign.staff, f.service.id)).rejects.toMatchObject({ status: 404 });
  const [viewer] = await db.insert(usersTable).values({ organizationId: f.org, role: "viewer", emailVerifiedAt: now() }).returning();
  const [unverified] = await db.insert(usersTable).values({ organizationId: f.org, role: "office", emailVerifiedAt: null }).returning();
  const input = await command(f);
  await expect(updateServiceWatch(f.org, viewer.id, f.service.id, input)).rejects.toMatchObject({ status: 403 });
  await expect(getServiceWatch(f.org, unverified.id, f.service.id)).rejects.toMatchObject({ status: 403 });
});

it("rolls back a failed atomic enqueue, retains a held review record and safely resumes internal work", async () => {
  const f = await fixture();
  vi.mocked(enqueueStaffServiceNotice).mockRejectedValueOnce(new Error("Synthetic enqueue transaction failure"));
  await expect(processServiceWatch(f.org)).rejects.toMatchObject({ code: "monitor_review_required" });
  const [held] = await db.select().from(cases).where(eq(cases.organizationId, f.org));
  expect(held.state).toBe("held"); expect(held.reasons).toContain("source_review_required");
  expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.watch_opened")))).toHaveLength(0);
  await processServiceWatch(f.org);
  const [open] = await db.select().from(cases).where(eq(cases.organizationId, f.org));
  expect(open.id).toBe(held.id); expect(open.state).toBe("open"); expect(open.reasons).not.toContain("source_review_required");
  expect((await getServiceWatch(f.org, f.staff, f.service.id)).history.map(event => event.action)).toContain("service.watch_reopened");
});

it("retains bad bootstrap sources so a full old batch cannot hide a later valid service", async () => {
  const f = await fixture(), foreign = await fixture();
  const ids = [f.service.id];
  for (let i = 1; i <= WATCH_BATCH_SIZE; i++) {
    const service = await createServiceObligation(f.org, f.staff, { contactId: f.contact, kind: "maintenance", equipmentLabel: `Synthetic fairness unit ${i}`, dueDate: day(5), noticeDays: 14, assignedUserId: f.staff });
    if ("error" in service) throw new Error(service.error); ids.push(service.id);
  }
  // Legacy schema allows a contact FK without a tenant composite. The reader
  // must reject it and preserve an operator exception, never cross the boundary.
  for (const id of ids.slice(0, WATCH_BATCH_SIZE)) await db.update(serviceObligationsTable).set({ contactId: foreign.contact }).where(eq(serviceObligationsTable.id, id));
  await expect(processServiceWatch(f.org, new Date(Date.now() - 1000))).rejects.toMatchObject({ code: "monitor_review_required" });
  await expect(processServiceWatch(f.org)).rejects.toMatchObject({ code: "monitor_review_required" });
  const [valid] = await db.select().from(cases).where(eq(cases.serviceObligationId, ids[WATCH_BATCH_SIZE]));
  expect(valid.state).toBe("open"); expect(valid.reasons).toContain("reminder_needs_review");
  const records = await db.select().from(cases).where(eq(cases.organizationId, f.org));
  expect(records).toHaveLength(WATCH_BATCH_SIZE + 1); expect(records.filter(row => row.state === "held")).toHaveLength(WATCH_BATCH_SIZE);
  const visible = await listServiceWatch(f.org, f.staff);
  expect(visible.items).toHaveLength(WATCH_BATCH_SIZE + 1);
  expect(visible.items.filter(row => row.state === "held").every(row => row.customerLabel === "Customer record unavailable — operator review")).toBe(true);
});

it("does not let old resolved history consume the attention-page bound", async () => {
  const f = await fixture();
  const extra: string[] = [];
  for (let i = 0; i < 51; i++) {
    const service = await createServiceObligation(f.org, f.staff, { contactId: f.contact, kind: "maintenance", equipmentLabel: `Synthetic paging unit ${i}`, dueDate: day(5), noticeDays: 14, assignedUserId: f.staff });
    if ("error" in service) throw new Error(service.error); extra.push(service.id);
  }
  for (let i = 0; i < 3; i++) await processServiceWatch(f.org, new Date(Date.now() + i));
  const first = await listServiceWatch(f.org, f.staff); expect(first.items).toHaveLength(50); expect(first.hasMore).toBe(true);
  expect((await listServiceWatch(f.org, f.staff, { offset: 50 })).items).toHaveLength(2);
  for (const id of extra) await db.update(serviceObligationsTable).set({ status: "completed", completionNote: "Synthetic completed work" }).where(eq(serviceObligationsTable.id, id));
  for (let i = 0; i < 3; i++) await processServiceWatch(f.org, new Date(Date.now() + 100 + i));
  const attention = await listServiceWatch(f.org, f.staff); expect(attention.items).toHaveLength(1); expect(attention.items[0].serviceObligationId).toBe(f.service.id);
  const history = await listServiceWatch(f.org, f.staff, { scope: "history" }); expect(history.items).toHaveLength(50); expect(history.hasMore).toBe(true);
});

describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("independent PostgreSQL office ownership", () => {
  it("serializes competing office plans and permits only one current-version acknowledgement", async () => {
    const f = await fixture(); await processServiceWatch(f.org); const input = await command(f);
    const result = await Promise.allSettled([updateServiceWatch(f.org, f.staff, f.service.id, input), updateServiceWatch(f.org, f.staff, f.service.id, { ...input, requestId: randomUUID() })]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1); expect(result.filter(value => value.status === "rejected")).toHaveLength(1);
  });
});
