import { isNotNull, sql } from "drizzle-orm";
import type { ReservationSnapshot } from "@workspace/scheduling-core";
import {
  check,
  foreignKey,
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectStatusEnum } from "./enums";
import { estimatesTable } from "./estimates";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";
import { customerWorkRootsTable } from "./customer-work";

export const projectsTable = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .references(() => leadsTable.id),
    customerWorkId: uuid("customer_work_id"),
    workVersion: integer("work_version"),
    estimateId: uuid("estimate_id").references(() => estimatesTable.id),
    name: text("name").notNull(),
    status: projectStatusEnum("status").notNull().default("scheduled"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    schedulingReservation: jsonb("scheduling_reservation").$type<ReservationSnapshot>(),
    crewUserIds: jsonb("crew_user_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    crewNotes: text("crew_notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("projects_scheduling_reservation_ck", sql`${table.schedulingReservation} is null or coalesce((
      jsonb_typeof(${table.schedulingReservation}) = 'object'
      and ${table.schedulingReservation}->'formatVersion' = '1'::jsonb
      and case when jsonb_typeof(${table.schedulingReservation}->'reservationRevision') = 'number' then
        (${table.schedulingReservation}->>'reservationRevision')::numeric between 1 and 9007199254740991
        and trunc((${table.schedulingReservation}->>'reservationRevision')::numeric) = (${table.schedulingReservation}->>'reservationRevision')::numeric else false end
      and case when jsonb_typeof(${table.schedulingReservation}->'sourcePolicyRevision') = 'number' then
        (${table.schedulingReservation}->>'sourcePolicyRevision')::numeric between 1 and 9007199254740991
        and trunc((${table.schedulingReservation}->>'sourcePolicyRevision')::numeric) = (${table.schedulingReservation}->>'sourcePolicyRevision')::numeric else false end
      and jsonb_typeof(${table.schedulingReservation}->'sourcePolicyDigest') = 'string'
      and jsonb_typeof(${table.schedulingReservation}->'approvedTimeZone') = 'string'
      and jsonb_typeof(${table.schedulingReservation}->'inspection') in ('null', 'object')
      and jsonb_typeof(${table.schedulingReservation}->'startAt') = 'string'
      and jsonb_typeof(${table.schedulingReservation}->'endAt') = 'string'
      and jsonb_typeof(${table.schedulingReservation}->'resourceUserIds') = 'array'
      and case when jsonb_typeof(${table.schedulingReservation}->'minimumTravelGapMinutes') = 'number' then
        (${table.schedulingReservation}->>'minimumTravelGapMinutes')::numeric between 0 and 1440
        and trunc((${table.schedulingReservation}->>'minimumTravelGapMinutes')::numeric) = (${table.schedulingReservation}->>'minimumTravelGapMinutes')::numeric else false end
      and jsonb_typeof(${table.schedulingReservation}->'duration') = 'object'
      and jsonb_typeof(${table.schedulingReservation}->'admittedAt') = 'string'
      and jsonb_typeof(${table.schedulingReservation}->'admittedByUserId') in ('null', 'string')
      and jsonb_typeof(${table.schedulingReservation}->'target') = 'object'
      and jsonb_typeof(${table.schedulingReservation}->'lastTransition') = 'object'
    ), false)`),
    unique("projects_org_work_id_uq").on(table.organizationId, table.id, table.customerWorkId),
    uniqueIndex("projects_work_root_uq").on(table.customerWorkId).where(sql`${table.customerWorkId} is not null`),
    foreignKey({ columns: [table.organizationId, table.customerWorkId], foreignColumns: [customerWorkRootsTable.organizationId, customerWorkRootsTable.id], name: "projects_customer_work_fk" }),
    foreignKey({ columns: [table.organizationId, table.estimateId, table.customerWorkId], foreignColumns: [estimatesTable.organizationId, estimatesTable.id, estimatesTable.customerWorkId], name: "projects_work_estimate_fk" }),
    check("projects_work_scope_ck", sql`(${table.leadId} is not null and ${table.customerWorkId} is null and ${table.workVersion} is null) or (${table.leadId} is null and ${table.customerWorkId} is not null and ${table.workVersion} is not null and ${table.workVersion} > 0)`),
    index("projects_org_status_idx").on(table.organizationId, table.status),
    index("projects_org_lead_idx").on(table.organizationId, table.leadId),
    // A given estimate can back at most one project; the API re-checks this
    // for a friendly error, the index guarantees it under concurrency.
    uniqueIndex("projects_estimate_unique_idx")
      .on(table.estimateId)
      .where(isNotNull(table.estimateId)),
  ],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  schedulingReservation: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
