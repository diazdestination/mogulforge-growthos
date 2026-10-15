import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ReservationSnapshot } from "@workspace/scheduling-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { contactsTable } from "./contacts";
import { appointmentStatusEnum, appointmentTypeEnum } from "./enums";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

export const appointmentsTable = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    propertyId: uuid("property_id").references(() => propertiesTable.id),
    assignedUserId: varchar("assigned_user_id").references(() => usersTable.id),
    type: appointmentTypeEnum("type").notNull().default("inspection"),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    scheduledStart: timestamp("scheduled_start", {
      withTimezone: true,
    }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    schedulingReservation: jsonb("scheduling_reservation").$type<ReservationSnapshot>(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("appointments_scheduling_reservation_ck", sql`${table.schedulingReservation} is null or coalesce((
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
    unique("appointments_org_id_uq").on(table.organizationId, table.id),
    index("appointments_org_start_idx").on(
      table.organizationId,
      table.scheduledStart,
    ),
    index("appointments_org_assigned_idx").on(
      table.organizationId,
      table.assignedUserId,
    ),
  ],
);

export const insertAppointmentSchema = createInsertSchema(
  appointmentsTable,
).omit({ id: true, createdAt: true, updatedAt: true, schedulingReservation: true });
export type InsertAppointment = z.infer<typeof insertAppointmentSchema>;
export type Appointment = typeof appointmentsTable.$inferSelect;
