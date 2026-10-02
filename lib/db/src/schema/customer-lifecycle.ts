import { check, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";

export type CustomerLifecycleState = "active" | "paused" | "offboarding_requested";

/** Reversible operating hold only. No billing, credential revocation or deletion. */
export const customerLifecycleTable = pgTable("customer_lifecycle", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id),
  state: text("state").$type<CustomerLifecycleState>().notNull(),
  version: integer("version").notNull().default(1),
  reason: text("reason").notNull(),
  requestId: uuid("request_id"),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  updatedByUserId: varchar("updated_by_user_id").references(() => usersTable.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("customer_lifecycle_state_valid", sql`${table.state} IN ('active', 'paused', 'offboarding_requested')`),
  check("customer_lifecycle_version_positive", sql`${table.version} > 0`),
]);
