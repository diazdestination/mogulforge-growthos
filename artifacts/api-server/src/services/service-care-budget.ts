import { activitiesTable, auditEventsTable, db, revenueExecutionsTable, scheduledActionsTable } from "@workspace/db";
import { and, eq, gt, inArray, ne, notExists, sql } from "drizzle-orm";

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
      notExists(reader.select({ id: activitiesTable.id }).from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.contactId, contactId),
        eq(activitiesTable.type, "automation_message_sent"), gt(activitiesTable.occurredAt, since), sql`${activitiesTable.metadata}->>'approvalId' = ${auditEventsTable.id}::text`)))));
  return rows.map(row => row.occurredAt);
}
