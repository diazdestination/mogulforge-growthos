import { appointmentsTable, contactsTable, crmTasksTable, db, invoicesTable, leadsTable, projectsTable, propertiesTable, usersTable } from "@workspace/db";
import { and, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { customerWorkRootsTable } from "../../../../lib/db/src/schema/customer-work";

export type ScheduleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class ScheduleError extends Error {
  constructor(public code: "invalid_interval" | "invalid_assignee" | "resource_conflict" | "stale_update" | "estimate_lead_mismatch" | "customer_reference_mismatch", public status = 409) {
    super({ invalid_interval: "Set an end time after the start time.", invalid_assignee: "Choose an active team member who has accepted access and can manage customer work.", resource_conflict: "A team member already has an appointment or job during this window.", stale_update: "This record changed. Refresh it before saving again.", estimate_lead_mismatch: "Choose an estimate belonging to this job's customer opportunity.", customer_reference_mismatch: "The appointment, opportunity, and service must refer to the same customer and property when specified." }[code]);
  }
}

/**
 * Callers hold the company schedule lock first. Retain selected parent SHARE
 * locks through native appointment/reminder insertion so ordinary CRM edits
 * cannot invalidate a previously read relationship before the booking commits.
 * New manual work checks the lead's complete property lineage; unchanged
 * historical edits retain the older lead/property semantics, without relinking.
 */
export async function appointmentCustomer(tx: ScheduleTransaction, org: string, refs: { leadId?: string | null; contactId?: string | null; propertyId?: string | null }, options: { requireCoherentLeadProperty?: boolean } = {}) {
  let contactId = refs.contactId ?? null;
  let leadPropertyId: string | null = null;
  if (refs.leadId) {
    const [lead] = await tx.select({ contactId: leadsTable.contactId, propertyId: leadsTable.propertyId }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, refs.leadId))).for("share");
    if (!lead || (contactId && contactId !== lead.contactId)) throw new ScheduleError("customer_reference_mismatch", 400);
    contactId = lead.contactId;
    if (options.requireCoherentLeadProperty) leadPropertyId = lead.propertyId;
  }
  if (contactId) {
    const [contact] = await tx.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId))).for("share");
    if (!contact) throw new ScheduleError("customer_reference_mismatch", 400);
  }
  if (leadPropertyId && refs.propertyId && leadPropertyId !== refs.propertyId) throw new ScheduleError("customer_reference_mismatch", 400);
  const propertyIds = [...new Set([refs.propertyId, leadPropertyId].filter((id): id is string => !!id))].sort();
  if (propertyIds.length) {
    const properties = await tx.select({ id: propertiesTable.id, contactId: propertiesTable.contactId }).from(propertiesTable)
      .where(and(eq(propertiesTable.organizationId, org), inArray(propertiesTable.id, propertyIds))).orderBy(propertiesTable.id).for("share");
    if (!contactId || properties.length !== propertyIds.length || properties.some(property => property.contactId !== contactId)) throw new ScheduleError("customer_reference_mismatch", 400);
  }
  // Derive only the customer from an explicit lead, never its worksite.
  return contactId;
}

/** Kept identical to concierge inspection locking so every writer serializes. */
export async function lockContractorSchedule(tx: ScheduleTransaction, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${org}:inspection-booking`}))`);
}

export function assertScheduleVersion(current: Date, expected?: string | Date) {
  if (expected !== undefined && new Date(expected).getTime() !== current.getTime()) throw new ScheduleError("stale_update");
}

export function assertScheduleInterval(start?: Date | null, end?: Date | null) {
  if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())) || (end && (!start || end <= start))) throw new ScheduleError("invalid_interval", 400);
}

export async function assertOperationalStaff(tx: ScheduleTransaction, org: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const users = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, org), inArray(usersTable.id, unique))).for("share");
  if (users.length !== unique.length || users.some(user => !user.isActive || user.id.startsWith("invite:") || !user.emailVerifiedAt || !hasPermission(user.role, "crm.write"))) throw new ScheduleError("invalid_assignee", 400);
}

/** Terminal transitions retain same-company history even after access is revoked. */
export async function assertHistoricalStaff(tx: ScheduleTransaction, org: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const users = await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, org), inArray(usersTable.id, unique))).for("share");
  if (users.length !== unique.length) throw new ScheduleError("invalid_assignee", 400);
}

export function formatAppointmentWindow(start: Date, candidate: unknown) {
  let timeZone = typeof candidate === "string" && candidate.length <= 100 ? candidate : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(start); }
  catch { timeZone = "UTC"; }
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(start);
}

export async function assertResourceWindow(tx: ScheduleTransaction, org: string, ids: string[], start: Date, end: Date, exclude: { appointmentId?: string; projectId?: string } = {}) {
  if (!ids.length) return;
  const [appointment] = await tx.select({ id: appointmentsTable.id }).from(appointmentsTable).where(and(
    eq(appointmentsTable.organizationId, org), inArray(appointmentsTable.assignedUserId, ids),
    inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
    exclude.appointmentId ? ne(appointmentsTable.id, exclude.appointmentId) : undefined,
    lt(appointmentsTable.scheduledStart, end), gt(sql`coalesce(${appointmentsTable.scheduledEnd}, ${appointmentsTable.scheduledStart} + interval '2 hours')`, start),
  )).limit(1);
  const [project] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(and(
    eq(projectsTable.organizationId, org), inArray(projectsTable.status, ["scheduled", "in_progress"]),
    exclude.projectId ? ne(projectsTable.id, exclude.projectId) : undefined,
    or(...ids.map(id => sql`${projectsTable.crewUserIds} @> ${JSON.stringify([id])}::jsonb`)),
    lt(projectsTable.scheduledStart, end), gt(sql`coalesce(${projectsTable.scheduledEnd}, ${projectsTable.scheduledStart} + interval '1 day')`, start),
  )).limit(1);
  if (appointment || project) throw new ScheduleError("resource_conflict");
}

export async function ensureInvoicePreparationTask(tx: ScheduleTransaction, project: typeof projectsTable.$inferSelect) {
  let contactId: string | null = null;
  if (project.customerWorkId) {
    const [root] = await tx.select().from(customerWorkRootsTable).where(and(eq(customerWorkRootsTable.organizationId,project.organizationId),eq(customerWorkRootsTable.id,project.customerWorkId))).for("share");
    if (!root || project.leadId !== null) throw new ScheduleError("customer_reference_mismatch",400);
    contactId = root.contactId;
  }
  const sourceEvent = `project.invoice_preparation:${project.id}`;
  const [existing] = await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, project.organizationId), eq(crmTasksTable.sourceEvent, sourceEvent))).limit(1);
  const [invoice] = await tx.select({ id: invoicesTable.id }).from(invoicesTable).where(and(eq(invoicesTable.organizationId, project.organizationId), eq(invoicesTable.projectId, project.id), ne(invoicesTable.status, "void"))).limit(1);
  if (existing) {
    const status = invoice ? "done" : project.status === "completed" ? (existing.status === "in_progress" ? "in_progress" : "open") : "cancelled";
    if (project.customerWorkId && (existing.leadId !== null || existing.contactId !== contactId)) throw new ScheduleError("customer_reference_mismatch",400);
    if (existing.status !== status) await tx.update(crmTasksTable).set({ status, completedAt: status === "done" ? new Date() : null, ...(status === "open" && !project.customerWorkId ? { dueAt: new Date() } : {}) }).where(and(eq(crmTasksTable.organizationId, project.organizationId), eq(crmTasksTable.id, existing.id)));
    return;
  }
  if (invoice || project.status !== "completed") return;
  await tx.insert(crmTasksTable).values({ organizationId: project.organizationId, leadId: project.leadId, contactId, title: `Prepare invoice: ${project.name}`, description: "Review the completed work, agreed estimate, and billing details before preparing an invoice. No invoice has been issued or sent by this task.", sourceEvent, dueAt: new Date(), priority: "normal" });
}
