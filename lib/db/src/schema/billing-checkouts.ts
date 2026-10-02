import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable, type EntitlementPlanId } from "./organizations";
import { usersTable } from "./auth";

/** Durable provider request identity. Contains no payment URL, key or contact payload. */
export const billingCheckoutsTable = pgTable("billing_checkouts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  intent: text("intent").$type<"initial" | "replacement">().notNull(),
  state: text("state").$type<"pending" | "open" | "reconcile" | "completed" | "expired">().notNull().default("pending"),
  replacesSubscriptionId: text("replaces_subscription_id"),
  completedSubscriptionId: text("completed_subscription_id"),
  priceId: text("price_id").notNull(),
  planId: text("plan_id").$type<EntitlementPlanId>().notNull(),
  successUrl: text("success_url").notNull(),
  cancelUrl: text("cancel_url").notNull(),
  trialDays: integer("trial_days").notNull().default(0),
  // Detect credential/account configuration changes across restart; never store the key.
  providerConfigurationHash: text("provider_configuration_hash").notNull(),
  customerId: text("customer_id"),
  customerAttemptedAt: timestamp("customer_attempted_at", { withTimezone: true }),
  sessionId: text("session_id"),
  sessionAttemptedAt: timestamp("session_attempted_at", { withTimezone: true }),
  sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  recoveryReason: text("recovery_reason"),
  authorizedByUserId: varchar("authorized_by_user_id").references(() => usersTable.id),
  authorizationReason: text("authorization_reason"),
  authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("billing_checkouts_current_org_idx").on(table.organizationId).where(sql`${table.state} in ('pending', 'open', 'reconcile')`),
  uniqueIndex("billing_checkouts_session_idx").on(table.sessionId),
  index("billing_checkouts_org_idx").on(table.organizationId),
  check("billing_checkouts_state_valid", sql`${table.state} in ('pending', 'open', 'reconcile', 'completed', 'expired')`),
  check("billing_checkouts_intent_valid", sql`${table.intent} in ('initial', 'replacement')`),
  check("billing_checkouts_trial_valid", sql`${table.trialDays} >= 0 and ${table.trialDays} <= 730`),
  check("billing_checkouts_replacement_authorized", sql`${table.intent} = 'initial' or (${table.replacesSubscriptionId} is not null and ${table.authorizedByUserId} is not null and ${table.authorizationReason} is not null and ${table.authorizationExpiresAt} is not null)`),
]);

export type BillingCheckout = typeof billingCheckoutsTable.$inferSelect;
