import { appointmentsTable, appointmentWorkCompletionsTable as completions, appointmentWorkEntriesTable as entries, db } from "@workspace/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { WorkdayError } from "./contractor-workday-contract";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function retainsWorkdayLeadHistory(tx: Tx, org: string, leadId: string) {
  const [row] = await tx.select({ id: entries.id }).from(entries).innerJoin(appointmentsTable, and(eq(appointmentsTable.organizationId, entries.organizationId), eq(appointmentsTable.id, entries.appointmentId))).where(and(eq(entries.organizationId, org), eq(appointmentsTable.leadId, leadId))).limit(1);
  return !!row;
}
const blocked = () => { throw new WorkdayError(409, "workday_completion_required", "This visit has reviewed field work. Finish it through Visit work; sealed work cannot be reopened or reassigned."); };
/** No import of CRM/service executors. Caller already holds the schedule lock. */
export async function guardWorkdayAppointment(tx: Tx, org: string, appointmentId: string, current: Record<string, unknown>, patch: Record<string, unknown>, originalCompletionId?: string) {
  const retained = await tx.select().from(entries).where(and(eq(entries.organizationId, org), eq(entries.appointmentId, appointmentId)));
  // Cancelled entries are retained customer history, not permission to move the
  // same visit and its original evidence to a different customer or worksite.
  if (retained.length) for (const key of ["contactId", "propertyId", "leadId"]) {
    if (patch[key] !== undefined && String(patch[key] ?? "") !== String(current[key] ?? "")) {
      throw new WorkdayError(409, "workday_parent_locked", "This visit retains prepared work for its original customer and property. Create a separate visit for different customer, property or lead links.");
    }
  }
  const rows = retained.filter(row => row.state !== "cancelled");
  const [sealed] = await tx.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.appointmentId, appointmentId), isNull(completions.originalCompletionId)));
  if (!rows.length && !sealed) return;
  if (sealed) {
    // Even an unchanged external PATCH would otherwise re-run native task and
    // reminder reconciliation. Only the first internal atomic finish may pass.
    if (originalCompletionId !== sealed.id || current.status === "completed") blocked();
    for (const key of ["contactId", "propertyId", "leadId", "assignedUserId", "scheduledStart", "scheduledEnd", "type", "notes"]) {
      if (patch[key] !== undefined && String(patch[key] ?? "") !== String(current[key] ?? "")) blocked();
    }
    if (patch.status !== undefined && patch.status !== "completed") blocked();
  }
  if (patch.status === "completed" && (!sealed || originalCompletionId !== sealed.id || current.status === "completed" || rows.some(row => row.state !== "finalized" || row.completionId !== sealed.id))) blocked();
}
export async function guardWorkdayService(tx: Tx, org: string, serviceId: string, current: { status: string; appointmentId: string | null }, patch: { status?: string; appointmentId?: string | null }, originalCompletionId?: string) {
  const rows = await tx.select().from(entries).where(and(eq(entries.organizationId, org), eq(entries.serviceObligationId, serviceId), ne(entries.state, "cancelled")));
  if (!rows.length) return;
  let originallyPerformed = false;
  for (const row of rows) {
    if (!row.completionId) continue;
    const [proof] = await tx.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.id, row.completionId), eq(completions.appointmentId, row.appointmentId), isNull(completions.originalCompletionId)));
    const services = proof?.snapshot.services;
    if (Array.isArray(services) && services.some(v => v && typeof v === "object" && (v as { id?: unknown }).id === serviceId)) {
      originallyPerformed = true;
      if (patch.status === "completed" && (originalCompletionId !== proof!.id || current.status === "completed" || row.appointmentId !== current.appointmentId)) blocked();
    }
  }
  if (originallyPerformed && (patch.status !== "completed" || !originalCompletionId)) blocked();
  const currentRows = rows.filter(row => row.appointmentId === current.appointmentId);
  if (patch.appointmentId !== undefined && patch.appointmentId !== current.appointmentId && currentRows.some(row => row.state !== "finalized")) blocked();
  // Explicitly unperformed services may be coherently rebooked, without changing
  // the old answers. A later visit acquires fresh work and final command evidence.
  if (patch.status !== "completed") return;
  if (!originallyPerformed || currentRows.some(row => row.state !== "finalized" || row.completionId !== originalCompletionId)) blocked();
}
