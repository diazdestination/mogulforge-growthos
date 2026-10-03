import { activitiesTable, auditEventsTable, db, revenueExecutionsTable, scheduledActionsTable } from "@workspace/db";
import { and, eq, gt, inArray, ne, notExists, sql } from "drizzle-orm";
import { contactTouchReservationsTable } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { careFingerprint } from "./service-care-policy";

/** Legacy accepted service activity predates touchLogicalKey. Only its exact
 * retained approval/action/contact tuple may share a newer ledger identity. */
export async function serviceActivityTouchKeys(reader: Pick<typeof db, "select">, org: string,
  activity: Pick<typeof activitiesTable.$inferSelect, "id" | "type" | "metadata">[]) {
  const candidates = activity.filter(row => row.type === "automation_message_sent" && typeof row.metadata?.approvalId === "string" && row.metadata?.touchLogicalKey == null);
  const keys = new Map<string, string>();
  if (!candidates.length) return keys;
  const rows = await reader.select({ activityId: activitiesTable.id, audit: auditEventsTable, scheduled: scheduledActionsTable }).from(activitiesTable)
    .innerJoin(auditEventsTable, and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.action, "service.care_reminder_approved"), eq(auditEventsTable.entityType, "service_obligation"),
      sql`${activitiesTable.metadata}->>'approvalId' = ${auditEventsTable.id}::text`, sql`${auditEventsTable.metadata}->'snapshot'->>'contactId' = ${activitiesTable.contactId}::text`))
    .innerJoin(scheduledActionsTable, and(eq(scheduledActionsTable.organizationId, org), sql`${auditEventsTable.metadata}->>'scheduledActionId' = ${scheduledActionsTable.id}::text`))
    .where(and(eq(activitiesTable.organizationId, org), inArray(activitiesTable.id, candidates.map(row => row.id))));
  for (const { activityId, audit, scheduled } of rows) {
    const snapshot = audit.metadata.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !("obligationId" in snapshot) || snapshot.obligationId !== audit.entityId ||
      scheduled.action.type !== "service_care_reminder" ||
      careFingerprint(scheduled.action.params) !== careFingerprint({ approvalId: audit.id, obligationId: audit.entityId }) ||
      careFingerprint(scheduled.context) !== careFingerprint({ event: "service.care_reminder", serviceObligationId: audit.entityId })) continue;
    keys.set(activityId, `scheduled:${scheduled.id}`);
  }
  return keys;
}

/** Accepted activity and its receipt are one touch; unknown claims remain reserved. */
export async function servicePendingTouchTimes(reader: Pick<typeof db, "select">, org: string, contactId: string, since: Date, excludeActionKey?: string) {
  const rows = await reader.select({ occurredAt: revenueExecutionsTable.createdAt }).from(revenueExecutionsTable)
    .innerJoin(scheduledActionsTable, and(eq(scheduledActionsTable.organizationId, revenueExecutionsTable.organizationId), sql`${revenueExecutionsTable.actionKey} = 'scheduled:' || ${scheduledActionsTable.id}::text`))
    .innerJoin(auditEventsTable, and(eq(auditEventsTable.organizationId, revenueExecutionsTable.organizationId), eq(auditEventsTable.action, "service.care_reminder_approved"),
      sql`${auditEventsTable.id}::text = ${scheduledActionsTable.action}->'params'->>'approvalId'`))
    .where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.kind, "service_care_reminder"),
      sql`${auditEventsTable.metadata}->'snapshot'->>'contactId' = ${contactId}`,
      inArray(revenueExecutionsTable.state, ["processing", "indeterminate", "succeeded", "confirmed_succeeded"]),
      gt(revenueExecutionsTable.createdAt, since), excludeActionKey ? ne(revenueExecutionsTable.actionKey, excludeActionKey) : undefined,
      notExists(reader.select({ id: contactTouchReservationsTable.id }).from(contactTouchReservationsTable).where(and(eq(contactTouchReservationsTable.organizationId, org), eq(contactTouchReservationsTable.logicalKey, revenueExecutionsTable.actionKey)))),
      notExists(reader.select({ id: activitiesTable.id }).from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.contactId, contactId),
        eq(activitiesTable.type, "automation_message_sent"), gt(activitiesTable.occurredAt, since), sql`${activitiesTable.metadata}->>'approvalId' = ${auditEventsTable.id}::text`,
        // Sharing an approval reference does not prove that a different old
        // scheduled receipt is the same effect. Its uncertainty still counts.
        sql`${auditEventsTable.metadata}->>'scheduledActionId' = ${scheduledActionsTable.id}::text`,
        sql`(${activitiesTable.metadata}->>'touchLogicalKey' is null or ${activitiesTable.metadata}->>'touchLogicalKey' = ${revenueExecutionsTable.actionKey})`)))));
  return rows.map(row => row.occurredAt);
}
