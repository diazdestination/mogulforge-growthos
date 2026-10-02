import { index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appointmentsTable } from "./appointments";
import { contactsTable } from "./contacts";
import { crmTasksTable } from "./crm-tasks";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

export const SERVICE_OBLIGATION_KINDS = ["warranty_check", "maintenance", "service_plan"] as const;
export type ServiceObligationKind = (typeof SERVICE_OBLIGATION_KINDS)[number];
export type ServiceObligationStatus = "active" | "completed" | "cancelled";
export type ServiceRecurrence = {
  mode: "calendar_months";
  intervalMonths: number;
  anchorDate: string;
  endDate: string | null;
  agreementNote: string;
  approvedByUserId: string;
  approvedAt: string;
};

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
    recurrence: jsonb("recurrence").$type<ServiceRecurrence>(),
    predecessorObligationId: uuid("predecessor_obligation_id").references((): AnyPgColumn => serviceObligationsTable.id),
    occurrenceIndex: integer("occurrence_index").notNull().default(0),
    coverageStartsOn: text("coverage_starts_on"),
    coverageEndsOn: text("coverage_ends_on"),
    coverageEvidence: text("coverage_evidence"),
    completionNote: text("completion_note"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("service_obligations_org_id_uq").on(table.organizationId, table.id),
    index("service_obligations_org_due_idx").on(table.organizationId, table.status, table.dueAt),
    uniqueIndex("service_obligations_org_external_uq")
      .on(table.organizationId, table.source, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
    uniqueIndex("service_obligations_task_uq").on(table.taskId),
    uniqueIndex("service_obligations_predecessor_uq").on(table.predecessorObligationId),
  ],
);

export type ServiceObligation = typeof serviceObligationsTable.$inferSelect;
