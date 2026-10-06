import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { estimateStatusEnum } from "./enums";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";
import { customerWorkRootsTable } from "./customer-work";

export interface EstimateLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export const estimatesTable = pgTable(
  "estimates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .references(() => leadsTable.id),
    customerWorkId: uuid("customer_work_id"),
    workVersion: integer("work_version"),
    title: text("title").notNull(),
    status: estimateStatusEnum("status").notNull().default("draft"),
    lineItems: jsonb("line_items")
      .$type<EstimateLineItem[]>()
      .notNull()
      .default([]),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("estimates_org_work_id_uq").on(table.organizationId, table.id, table.customerWorkId),
    uniqueIndex("estimates_work_root_uq").on(table.customerWorkId).where(sql`${table.customerWorkId} is not null`),
    foreignKey({ columns: [table.organizationId, table.customerWorkId], foreignColumns: [customerWorkRootsTable.organizationId, customerWorkRootsTable.id], name: "estimates_customer_work_fk" }),
    check("estimates_work_scope_ck", sql`(${table.leadId} is not null and ${table.customerWorkId} is null and ${table.workVersion} is null) or (${table.leadId} is null and ${table.customerWorkId} is not null and ${table.workVersion} is not null and ${table.workVersion} > 0)`),
    index("estimates_org_status_idx").on(table.organizationId, table.status),
    index("estimates_org_lead_idx").on(table.organizationId, table.leadId),
  ],
);

export const insertEstimateSchema = createInsertSchema(estimatesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;
export type Estimate = typeof estimatesTable.$inferSelect;
