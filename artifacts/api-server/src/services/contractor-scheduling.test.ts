import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appointmentsTable, contactsTable, crmTasksTable, db, organizationsTable, propertiesTable, scheduledActionsTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as crm from "./crm";
import { approveServiceRecurrence, createServiceObligation, nextServiceDate, updateServiceObligation } from "./service-obligations";
import { cancelAppointmentReminders, scheduleAppointmentReminder } from "./automation";
import { runDurableAction } from "./durable-execution";
import { formatAppointmentWindow } from "./contractor-scheduling";

let org: string, otherOrg: string, staff: string, otherStaff: string, contact: string, lead: string;
const base = new Date("2035-01-01T15:00:00Z").getTime();
const slot = (day: number) => ({ scheduledStart: new Date(base + day * 86_400_000), scheduledEnd: new Date(base + day * 86_400_000 + 3_600_000) });
beforeAll(async () => {
  const orgs = await db.insert(organizationsTable).values([{ name: "Synthetic contractor A", slug: `contractor-a-${randomUUID()}` }, { name: "Synthetic contractor B", slug: `contractor-b-${randomUUID()}` }]).returning();
  org = orgs[0].id; otherOrg = orgs[1].id;
  const users = await db.insert(usersTable).values([{ organizationId: org, role: "office" }, { organizationId: otherOrg, role: "office" }]).returning();
  staff = users[0].id; otherStaff = users[1].id;
  const c = await crm.createContact(org, { firstName: "Synthetic", email: "contractor@example.test" }); contact = c.id;
  lead = (await crm.createLead(org, { contactId: contact }))!.id;
});
afterAll(async () => { await deleteTestOrgs(org, otherOrg); });
async function appointment(day: number, extra = {}) {
  const value = await crm.createAppointment(org, { type: "production", contactId: contact, leadId: lead, ...slot(day), ...extra });
  if (!value || typeof value === "string") throw new Error(`appointment failed: ${value}`);
  return value;
}
async function service(dueDate = "2035-01-31", extra = {}) {
  const value = await createServiceObligation(org, staff, { contactId: contact, kind: "maintenance", equipmentLabel: "Synthetic heat pump", dueDate, noticeDays: 14, assignedUserId: staff, ...extra });
  if ("error" in value) throw new Error(value.error);
  return value;
}

describe("native schedule resources", () => {
  it("blocks the same staff across appointment types and jobs; allows another staff", async () => {
    await appointment(1, { assignedUserId: staff });
    await expect(appointment(1, { assignedUserId: staff, type: "other" })).rejects.toMatchObject({ code: "resource_conflict" });
    await expect(crm.createProject(org, { leadId: lead, name: "Overlapping job", crewUserIds: [staff], ...slot(1) })).rejects.toMatchObject({ code: "resource_conflict" });
    expect(await appointment(1)).toMatchObject({ assignedUserId: null });
  });
  it("blocks appointments during an existing multi-day crew job", async () => {
    await crm.createProject(org, { leadId: lead, name: "Multi-day job", crewUserIds: [staff], scheduledStart: slot(2).scheduledStart, scheduledEnd: slot(4).scheduledEnd });
    await expect(appointment(3, { assignedUserId: staff })).rejects.toMatchObject({ code: "resource_conflict" });
    expect(await appointment(4, { assignedUserId: staff, scheduledStart: slot(4).scheduledEnd, scheduledEnd: new Date(slot(4).scheduledEnd.getTime() + 3_600_000) })).toBeTruthy();
  });
  it("rejects negative windows and same-org estimates for a different opportunity", async () => {
    await expect(appointment(5, { scheduledEnd: slot(4).scheduledEnd })).rejects.toMatchObject({ code: "invalid_interval" });
    await expect(crm.createProject(org, { leadId: lead, name: "Bad dates", scheduledStart: slot(6).scheduledStart, scheduledEnd: slot(5).scheduledEnd })).rejects.toMatchObject({ code: "invalid_interval" });
    const otherLead = (await crm.createLead(org, { contactId: contact }))!;
    const estimate = (await crm.createEstimate(org, { leadId: otherLead.id, title: "Different job" }))!;
    await expect(crm.createProject(org, { leadId: lead, estimateId: estimate.id, name: "Wrong estimate" })).rejects.toMatchObject({ code: "estimate_lead_mismatch" });
  });
  it("rejects pending invitations, unverified, viewer and foreign assignees", async () => {
    const invalid = await db.insert(usersTable).values([{ id: `invite:${randomUUID()}`, organizationId: org, role: "office" }, { organizationId: org, role: "office", emailVerifiedAt: null }, { organizationId: org, role: "viewer" }]).returning();
    for (const user of invalid) await expect(appointment(7, { assignedUserId: user.id })).rejects.toMatchObject({ code: "invalid_assignee" });
    expect(await crm.createAppointment(org, { ...slot(7), type: "other", assignedUserId: otherStaff })).toBeNull();
  });
  it("prevents stale schedule saves and permits an explicit unassignment", async () => {
    const item = await appointment(8, { assignedUserId: staff });
    const updated = await crm.updateAppointment(org, item.id, { notes: "Office changed this", expectedUpdatedAt: item.updatedAt.toISOString() });
    await expect(crm.updateAppointment(org, item.id, { status: "cancelled", expectedUpdatedAt: item.updatedAt.toISOString() })).rejects.toMatchObject({ code: "stale_update" });
    expect(await crm.updateAppointment(org, item.id, { assignedUserId: null })).toMatchObject({ assignedUserId: null });
    expect(updated).toMatchObject({ notes: "Office changed this" });
  });
  it("closes existing work after a technician is deactivated without assigning new work to them", async () => {
    const [technician] = await db.insert(usersTable).values({ organizationId: org, role: "office" }).returning();
    const visits = await Promise.all([40, 41, 42].map(day => appointment(day, { assignedUserId: technician.id })));
    const jobs = [];
    for (const day of [43, 44]) {
      const job = await crm.createProject(org, { leadId: lead, name: "Historical crew job", crewUserIds: [technician.id], ...slot(day) });
      if (!job || job === crm.DUPLICATE_ESTIMATE) throw new Error("fixture");
      jobs.push(job);
    }
    await db.update(usersTable).set({ isActive: false, emailVerifiedAt: null }).where(eq(usersTable.id, technician.id));
    for (const [index, status] of (["cancelled", "completed", "no_show"] as const).entries()) expect(await crm.updateAppointment(org, visits[index].id, { status, assignedUserId: technician.id })).toMatchObject({ status, assignedUserId: technician.id });
    for (const [index, status] of (["cancelled", "completed"] as const).entries()) expect(await crm.updateProject(org, jobs[index].id, { status, crewUserIds: [technician.id] })).toMatchObject({ status, crewUserIds: [technician.id] });
    await expect(crm.updateAppointment(org, visits[0].id, { status: "scheduled" })).rejects.toMatchObject({ code: "invalid_assignee" });
    await expect(crm.updateProject(org, jobs[0].id, { status: "scheduled" })).rejects.toMatchObject({ code: "invalid_assignee" });
    const unassigned = await appointment(45);
    await expect(crm.updateAppointment(org, unassigned.id, { status: "completed", assignedUserId: technician.id })).rejects.toMatchObject({ code: "invalid_assignee" });
  });
  it("scopes range/assignee selection and includes spanning appointments", async () => {
    const item = await appointment(9, { assignedUserId: staff, scheduledEnd: slot(10).scheduledEnd });
    const rows = await crm.listAppointments(org, undefined, { from: slot(10).scheduledStart, to: slot(11).scheduledStart, assignedUserId: staff });
    expect(rows.map(row => row.id)).toEqual([item.id]);
    expect(await crm.listAppointments(otherOrg, undefined, { from: slot(9).scheduledStart, to: slot(11).scheduledStart })).toHaveLength(0);
  });
  it("creates one invoice preparation task through repeated job completion", async () => {
    const project = await crm.createProject(org, { leadId: lead, name: "Completed synthetic job" });
    if (!project || project === crm.DUPLICATE_ESTIMATE) throw new Error("fixture");
    await crm.updateProject(org, project.id, { status: "completed" });
    await crm.updateProject(org, project.id, { status: "completed" });
    expect(await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.sourceEvent, `project.invoice_preparation:${project.id}`)))).toHaveLength(1);
  });
  it("withdraws invoice preparation while a job is reopened and restores the same task on completion", async () => {
    const project = await crm.createProject(org, { leadId: lead, name: "Reopened synthetic job", status: "completed" });
    if (!project || project === crm.DUPLICATE_ESTIMATE) throw new Error("fixture");
    const tasks = () => db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.sourceEvent, `project.invoice_preparation:${project.id}`)));
    const [original] = await tasks();
    expect(original.status).toBe("open");
    for (const status of ["scheduled", "cancelled"] as const) {
      await crm.updateProject(org, project.id, { status });
      expect(await tasks()).toMatchObject([{ id: original.id, status: "cancelled", completedAt: null }]);
      await crm.updateProject(org, project.id, { status: "completed" });
      expect(await tasks()).toMatchObject([{ id: original.id, status: "open", completedAt: null }]);
    }
    expect(await tasks()).toHaveLength(1);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("serializes concurrent crew appointment versus project writes (real PostgreSQL sessions)", async () => {
    const results = await Promise.allSettled([appointment(12, { assignedUserId: staff }), crm.createProject(org, { leadId: lead, name: "Concurrent job", crewUserIds: [staff], ...slot(12) })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
});

describe("approved service recurrence and appointment reconciliation", () => {
  it("preserves month-end and leap-year anchors", () => {
    expect(nextServiceDate("2035-01-31", 1).toISOString().slice(0, 10)).toBe("2035-02-28");
    expect(nextServiceDate("2035-01-31", 2).toISOString().slice(0, 10)).toBe("2035-03-31");
    expect(nextServiceDate("2036-02-29", 12).toISOString().slice(0, 10)).toBe("2037-02-28");
  });
  it("requires supplied evidence for actual coverage dates; never invents dates", async () => {
    expect(await createServiceObligation(org, staff, { contactId: contact, kind: "warranty_check", equipmentLabel: "Roof", dueDate: "2035-05-01", noticeDays: 14, coverageEndsOn: "2035-12-31" })).toEqual({ error: "invalid_coverage_evidence" });
    const item = await service();
    expect(item.coverageStartsOn).toBeNull(); expect(item.coverageEndsOn).toBeNull();
  });
  it("creates exactly one next task and repeats the same completion receipt", async () => {
    const item = await service();
    const approved = await approveServiceRecurrence(org, staff, item.id, { expectedUpdatedAt: item.updatedAt.toISOString(), intervalMonths: 1, agreementNote: "Synthetic signed monthly agreement", endDate: "2035-03-31" });
    if ("error" in approved) throw new Error(approved.error);
    const complete = { status: "completed" as const, expectedUpdatedAt: approved.updatedAt.toISOString(), completionNote: "Synthetic visit checked by office" };
    const first = await updateServiceObligation(org, staff, item.id, complete);
    const repeat = await updateServiceObligation(org, staff, item.id, complete);
    if ("error" in first || "error" in repeat) throw new Error("completion failed");
    expect(first.nextObligationId).toBeTruthy(); expect(repeat.nextObligationId).toBe(first.nextObligationId);
    const [next] = await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, item.id));
    expect(next.dueAt.toISOString().slice(0, 10)).toBe("2035-02-28"); expect(next.appointmentId).toBeNull();
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, next.taskId)); expect(task.status).toBe("open"); expect(task.assignedUserId).toBe(staff);
    expect(await updateServiceObligation(org, staff, item.id, { status: "active" })).toEqual({ error: "successor_already_created" });
    const second = await updateServiceObligation(org, staff, next.id, { status: "completed" });
    if ("error" in second || !second.nextObligationId) throw new Error("next missing");
    const [last] = await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, second.nextObligationId));
    expect(last.dueAt.toISOString().slice(0, 10)).toBe("2035-03-31");
    expect(await updateServiceObligation(org, staff, last.id, { status: "completed" })).toMatchObject({ nextObligationId: null });
  });
  it("can explicitly stop recurrence, and cancellation cannot create a next visit", async () => {
    const item = await service();
    const approved = await approveServiceRecurrence(org, staff, item.id, { expectedUpdatedAt: item.updatedAt.toISOString(), intervalMonths: 6, agreementNote: "Synthetic agreement" });
    if ("error" in approved) throw new Error(approved.error);
    expect(await updateServiceObligation(org, staff, item.id, { status: "cancelled" })).toMatchObject({ nextObligationId: null });
    expect(await updateServiceObligation(org, staff, item.id, { status: "completed" })).toEqual({ error: "cancelled_service_requires_reopen" });
    expect(await updateServiceObligation(org, staff, item.id, { status: "active" })).toMatchObject({ recurrence: null });
    expect(await updateServiceObligation(org, staff, item.id, { status: "completed" })).toMatchObject({ nextObligationId: null });
    const other = await service();
    await approveServiceRecurrence(org, staff, other.id, { expectedUpdatedAt: other.updatedAt.toISOString(), intervalMonths: null, agreementNote: "Customer requested one visit only" });
    expect(await updateServiceObligation(org, staff, other.id, { status: "completed" })).toMatchObject({ nextObligationId: null });
  });
  it("rejects foreign recurrence IDs and contradictory calendar changes", async () => {
    const item = await service();
    expect(await approveServiceRecurrence(otherOrg, otherStaff, item.id, { expectedUpdatedAt: item.updatedAt.toISOString(), intervalMonths: 1, agreementNote: "Wrong company" })).toEqual({ error: "not_found" });
    await approveServiceRecurrence(org, staff, item.id, { expectedUpdatedAt: item.updatedAt.toISOString(), intervalMonths: 1, agreementNote: "Synthetic agreement" });
    expect(await updateServiceObligation(org, staff, item.id, { dueDate: "2035-03-01" })).toEqual({ error: "recurrence_due_date_conflict" });
  });
  it("reopens office service follow-up for cancelled, no-show and completed appointments", async () => {
    for (const [index, status] of ["cancelled", "no_show", "completed"].entries()) {
      const item = await service(); const appt = await appointment(20 + index);
      expect(await updateServiceObligation(org, staff, item.id, { appointmentId: appt.id })).toMatchObject({ status: "active" });
      await crm.updateAppointment(org, appt.id, { status: status as "cancelled" | "no_show" | "completed" });
      const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, item.taskId)); expect(task.status).toBe("open");
      const [remaining] = await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, item.id)); expect(remaining.status).toBe("active");
    }
  });
  it("rejects linking a canceled appointment to a new obligation", async () => {
    const item = await service(); const appt = await appointment(24, { status: "cancelled" });
    expect(await updateServiceObligation(org, staff, item.id, { appointmentId: appt.id })).toEqual({ error: "appointment_not_active" });
  });
  it("rejects known property contradictions during linking and later appointment edits", async () => {
    const properties = await db.insert(propertiesTable).values(["A", "B"].map(label => ({ organizationId: org, contactId: contact, addressLine1: `Synthetic property ${label}`, city: "Synthetic", state: "CA", postalCode: "00000" }))).returning();
    const item = await service("2035-05-01", { propertyId: properties[0].id });
    const wrong = await appointment(46, { propertyId: properties[1].id });
    expect(await updateServiceObligation(org, staff, item.id, { appointmentId: wrong.id })).toEqual({ error: "appointment_not_for_property" });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, item.taskId)))[0].status).toBe("open");
    const correct = await appointment(47, { propertyId: properties[0].id });
    expect(await updateServiceObligation(org, staff, item.id, { appointmentId: correct.id })).toMatchObject({ appointmentId: correct.id });
    await expect(crm.updateAppointment(org, correct.id, { propertyId: properties[1].id })).rejects.toMatchObject({ code: "customer_reference_mismatch" });
    expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, correct.id)))[0].propertyId).toBe(properties[0].id);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("serializes concurrent service completion to one successor (real PostgreSQL sessions)", async () => {
    const item = await service();
    await approveServiceRecurrence(org, staff, item.id, { expectedUpdatedAt: item.updatedAt.toISOString(), intervalMonths: 3, agreementNote: "Synthetic quarterly agreement" });
    const results = await Promise.all([updateServiceObligation(org, staff, item.id, { status: "completed" }), updateServiceObligation(org, staff, item.id, { status: "completed" })]);
    expect(results[0]).toMatchObject({ nextObligationId: expect.any(String) }); expect(results[1]).toMatchObject({ nextObligationId: (results[0] as { nextObligationId: string }).nextObligationId });
    expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, item.id))).toHaveLength(1);
  });
});

describe("reminder invalidation", () => {
  it("labels minute-accurate appointment times and falls back explicitly to UTC", () => {
    const start = new Date("2035-01-02T16:15:00Z");
    expect(formatAppointmentWindow(start, "America/Los_Angeles")).toContain("8:15 AM PST");
    expect(formatAppointmentWindow(start, "not-a-timezone")).toContain("4:15 PM UTC");
  });
  it("recreates one reminder after status-only reactivation", async () => {
    const item = await appointment(30);
    await crm.updateAppointment(org, item.id, { status: "cancelled" });
    await crm.updateAppointment(org, item.id, { status: "confirmed" });
    await scheduleAppointmentReminder(org, item);
    const rows = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, org));
    expect(rows.filter(row => row.context.appointmentId === item.id && row.status === "pending")).toHaveLength(1);
  });
  it("keeps an in-flight receipt for reconciliation when cancellation arrives", async () => {
    const item = await appointment(31);
    const actions = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, org));
    const action = actions.find(row => row.context.appointmentId === item.id)!;
    let release!: () => void; let signal!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const execution = runDurableAction({ organizationId: org, appointmentId: item.id, actionKey: `scheduled:${action.id}`, kind: "appointment_reminder", payload: {}, execute: async () => { signal(); await waiting; return { state: "succeeded", detail: "Synthetic effect only" }; } });
    await started;
    expect(await cancelAppointmentReminders(org, item.id)).toBe(0);
    release(); expect(await execution).toMatchObject({ state: "succeeded" });
    expect(await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.sourceEvent, `appointment.reminder_reconcile:${action.id}`)))).toHaveLength(1);
  });
});
