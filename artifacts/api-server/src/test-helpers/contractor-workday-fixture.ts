import { randomUUID } from "node:crypto";
import { contactsTable, crmTasksTable, db, organizationsTable, propertiesTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createAppointment, updateTask } from "../services/crm";
import { createWorkdayAsset } from "../services/property-assets";
import { approveWorkdayTemplate, createWorkdayTemplate, previewWorkdayTemplate } from "../services/work-checklists";
import { createAppointmentWorkEntry, getAppointmentWork, previewAppointmentWorkCompletion, saveAppointmentWorkEntry } from "../services/appointment-work";
import { approveServiceRecurrence, createServiceObligation, updateServiceObligation } from "../services/service-obligations";
import type { WorkdayDefinition } from "../services/contractor-workday-contract";

export const workdayTestDefinition: WorkdayDefinition = { name: "Synthetic technician record", trade: "hvac", description: "Fictional workflow verification only", items: [
  { key: "observed", label: "Record work performed", kind: "result", required: true, allowNotApplicable: true, unit: null },
  { key: "reading", label: "Optional observed temperature", kind: "number", required: false, allowNotApplicable: true, unit: "degrees F" },
] };
export const workdayTestAsset = { category: "hvac_equipment" as const, label: "Synthetic heat pump", manufacturer: null, model: null, serial: null, location: null, installedOn: null, notes: "Recorded only; no warranty conclusion.", warrantyStartsOn: null, warrantyEndsOn: null, warrantySource: null, attributes: [] };
export async function contractorWorkdayFixture(options: { definition?: WorkdayDefinition; service?: boolean; asset?: boolean; enroll?: boolean } = {}) {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["127.0.0.1", "localhost"].includes(target.hostname)) throw new Error("Use fresh isolated test database");
  const [company] = await db.insert(organizationsTable).values({ name: "SYNTHETIC Workday Test", slug: randomUUID() }).returning();
  const org = company.id;
  const [owner, tech, office, sales, viewer] = await db.insert(usersTable).values((["owner", "inspector", "office", "sales_manager", "viewer"] as const).map(role => ({ organizationId: org, role, firstName: `Synthetic ${role}`, emailVerifiedAt: new Date() }))).returning();
  const [contact, otherContact] = await db.insert(contactsTable).values([{ organizationId: org, firstName: "Existing", lastName: "Customer", doNotContact: true }, { organizationId: org, firstName: "Other customer", doNotContact: true }]).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org, contactId: contact.id, addressLine1: "100 Fictional Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
  const appointment = await createAppointment(org, { contactId: contact.id, propertyId: property.id, assignedUserId: tech.id, type: "other", scheduledStart: new Date("2035-01-31T15:00:00Z"), scheduledEnd: new Date("2035-01-31T16:00:00Z"), notes: "Original office notes remain unchanged." });
  if (!appointment || typeof appointment === "string") throw new Error("Fixture appointment failed");
  const actor = { userId: tech.id }, manager = { userId: owner.id };
  const draft = await createWorkdayTemplate(org, manager, { requestId: randomUUID(), definition: options.definition ?? workdayTestDefinition });
  const templateId = String((draft.template as { id: string }).id);
  const review = await previewWorkdayTemplate(org, manager, templateId, { expectedVersion: 1, revisionId: (draft.template as { latestRevision: { id: string } }).latestRevision.id });
  const approved = await approveWorkdayTemplate(org, manager, templateId, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true });
  const template = approved.template as { id: string; version: number; approvedRevision: { id: string } };
  let assetId: string | null = null;
  if (options.asset !== false) { const created = await createWorkdayAsset(org, manager, contact.id, { ...workdayTestAsset, requestId: randomUUID(), propertyId: property.id }); assetId = String((created.asset as { id: string }).id); }
  let service: typeof serviceObligationsTable.$inferSelect | null = null;
  if (options.service !== false) {
    const created = await createServiceObligation(org, owner.id, { contactId: contact.id, propertyId: property.id, kind: "maintenance", equipmentLabel: "Historical service label unchanged", dueDate: "2035-01-31", noticeDays: 7, assignedUserId: tech.id });
    if ("error" in created) throw new Error(created.error);
    const recurrence = await approveServiceRecurrence(org, owner.id, created.id, { expectedUpdatedAt: created.updatedAt.toISOString(), intervalMonths: 1, endDate: "2035-03-31", agreementNote: "Synthetic explicit recurrence for test only" });
    if ("error" in recurrence) throw new Error(recurrence.error);
    const linked = await updateServiceObligation(org, owner.id, created.id, { appointmentId: appointment.id, expectedUpdatedAt: recurrence.updatedAt.toISOString() });
    if (linked.error) throw new Error(linked.error);
    await updateTask(org, linked.taskId, { status: "in_progress", description: "Technician and office jointly authored this original task note.", dueAt: new Date("2030-01-01T12:00:00Z"), assignedUserId: tech.id });
    [service] = await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, linked.id));
  }
  if (options.enroll !== false) await createAppointmentWorkEntry(org, actor, appointment.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: appointment.updatedAt.toISOString(), checklistRevisionId: template.approvedRevision.id, assetId, serviceObligationId: service?.id ?? null });
  return { org, owner, tech, office, sales, viewer, actor, manager, contact, otherContact, property, appointment, template, assetId, service };
}
export type WorkdayFixture = Awaited<ReturnType<typeof contractorWorkdayFixture>>;
export async function answerWorkday(f: WorkdayFixture, attention = false) {
  let work = await getAppointmentWork(f.org, f.actor, f.appointment.id);
  for (const entry of work.entries.filter(e => e.state === "draft")) {
    const saved = await saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, entry.id, { requestId: randomUUID(), expectedVersion: entry.version, answers: [{ itemKey: "observed", result: attention ? "needs_attention" : "done", value: null, reason: attention ? "Recorded issue requires office review." : null }], notes: "Actual staff-entered synthetic observations." });
    work = saved.work;
  }
  return work;
}
export async function reviewWorkday(f: WorkdayFixture, attention = false) {
  const work = await getAppointmentWork(f.org, f.actor, f.appointment.id);
  return previewAppointmentWorkCompletion(f.org, f.actor, f.appointment.id, { expectedAppointmentUpdatedAt: work.appointment.updatedAt, entries: work.entries.filter(e => e.state !== "cancelled").map(e => ({ id: e.id, version: e.version })), serviceObligationIds: f.service ? [f.service.id] : [], performedAt: new Date(Date.now() - 1000).toISOString(), summary: "Staff records the work performed; no warranty or customer acceptance is inferred.", outcome: attention ? "needs_followup" : "completed", followup: attention ? { assignedUserId: f.office.id, dueAt: new Date(Date.now() + 86_400_000).toISOString(), note: "Office must review the recorded condition with the technician." } : null });
}
