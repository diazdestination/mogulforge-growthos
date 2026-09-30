import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appointmentsTable } from "./appointments";
import { contactsTable } from "./contacts";
import { crmTasksTable } from "./crm-tasks";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

export const SERVICE_OBLIGATION_KINDS = ["warranty_check", "maintenance", "service_plan"] as const;
export type ServiceObligationKind = (typeof SERVICE_OBLIGATION_KINDS)[number];
export type ServiceObligationStatus = "active" | "completed" | "cancelled";

/** Contractual customer work, not an acquisition lead or marketing consent. */
export const serviceObligationsTable = pgTable(
  "service_obligations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    contactId: uuid("contact_id").notNull().references(() => contactsTable.id),
    propertyId: uuid("property_id").references(() => propertiesTable.id),
    appointmentId: uuid("appointment_id").references(() => appointmentsTable.id),
    taskId: uuid("task_id").notNull().references(() => crmTasksTable.id),
    kind: text("kind").$type<ServiceObligationKind>().notNull(),
    equipmentLabel: text("equipment_label").notNull(),
    /** UTC timestamp representing a calendar service date at noon UTC. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    noticeDays: integer("notice_days").notNull().default(30),
    status: text("status").$type<ServiceObligationStatus>().notNull().default("active"),
    source: text("source").notNull().default("manual"),
    externalRef: text("external_ref"),
    notes: text("notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index("service_obligations_org_due_idx").on(table.organizationId, table.status, table.dueAt),
    uniqueIndex("service_obligations_org_external_uq")
      .on(table.organizationId, table.source, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
    uniqueIndex("service_obligations_task_uq").on(table.taskId),
  ],
);

export type ServiceObligation = typeof serviceObligationsTable.$inferSelect;
