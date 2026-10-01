import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable, sessionsTable } from "./auth";
import { leadsTable } from "./leads";

/** Explicit owner-approved policy. Missing days or recipients never imply coverage. */
export interface StaffPushPolicy {
  enabled: boolean;
  timezone: string;
  days: number[]; // ISO weekdays: 1 Monday ... 7 Sunday
  opensAt: string;
  closesAt: string;
  businessHoursUserIds: string[];
  afterHoursUserIds: string[];
}

export const staffPushPoliciesTable = pgTable("staff_push_policies", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  policy: jsonb("policy").$type<StaffPushPolicy>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const staffPushSubscriptionsTable = pgTable("staff_push_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  // A server-only reference, never returned to the browser or included in push.
  // Session deletion/log-out invalidates this subscription immediately.
  sessionId: varchar("session_id").references(() => sessionsTable.sid, { onDelete: "set null" }),
  endpointHash: text("endpoint_hash").notNull(),
  encryptedSubscription: text("encrypted_subscription"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("staff_push_endpoint_uq").on(t.endpointHash),
  index("staff_push_member_idx").on(t.organizationId, t.userId),
]);

export type StaffPushDeliveryState = "pending" | "dispatching" | "accepted" | "rejected" | "expired" | "cancelled" | "indeterminate";

/** Durable per-device receipt: acceptance is never called delivery/read. */
export const staffPushDeliveriesTable = pgTable("staff_push_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => staffPushSubscriptionsTable.id, { onDelete: "cascade" }),
  state: text("state").$type<StaffPushDeliveryState>().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  providerStatus: integer("provider_status"),
  reason: text("reason"), // allowlisted codes only; never raw provider errors
}, (t) => [
  uniqueIndex("staff_push_lead_device_uq").on(t.organizationId, t.leadId, t.subscriptionId),
  index("staff_push_due_idx").on(t.state, t.createdAt),
]);
