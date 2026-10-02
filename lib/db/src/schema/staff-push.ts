import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable, sessionsTable } from "./auth";
import { leadsTable } from "./leads";
import { serviceObligationsTable } from "./service-obligations";
import { serviceWatchCasesTable } from "./service-watch";

/** Explicit owner-approved policy. Missing days or recipients never imply coverage. */
export interface StaffPushPolicy {
  enabled: boolean;
  /** Separate opt-in for accountable service owners; legacy policies stay off. */
  serviceAlertsEnabled?: boolean;
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
  unique("staff_push_subscription_org_id_uq").on(t.organizationId, t.id),
  index("staff_push_member_idx").on(t.organizationId, t.userId),
]);

export type StaffPushDeliveryState = "pending" | "dispatching" | "accepted" | "rejected" | "expired" | "cancelled" | "indeterminate";

/** Durable per-device receipt: acceptance is never called delivery/read. */
export const staffPushDeliveriesTable = pgTable("staff_push_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => leadsTable.id, { onDelete: "cascade" }),
  serviceObligationId: uuid("service_obligation_id"),
  serviceWatchCaseId: uuid("service_watch_case_id"),
  serviceNoticeRevision: integer("service_notice_revision"),
  serviceOwnerId: varchar("service_owner_id"),
  eventKey: text("event_key"),
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
  uniqueIndex("staff_push_event_device_uq").on(t.organizationId, t.eventKey, t.subscriptionId),
  foreignKey({ columns: [t.organizationId, t.leadId], foreignColumns: [leadsTable.organizationId, leadsTable.id], name: "staff_push_lead_tenant_fk" }),
  foreignKey({ columns: [t.organizationId, t.subscriptionId], foreignColumns: [staffPushSubscriptionsTable.organizationId, staffPushSubscriptionsTable.id], name: "staff_push_device_tenant_fk" }),
  foreignKey({ columns: [t.organizationId, t.serviceObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "staff_push_service_tenant_fk" }),
  foreignKey({ columns: [t.organizationId, t.serviceWatchCaseId], foreignColumns: [serviceWatchCasesTable.organizationId, serviceWatchCasesTable.id], name: "staff_push_watch_tenant_fk" }),
  foreignKey({ columns: [t.organizationId, t.serviceOwnerId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "staff_push_service_owner_fk" }),
  check("staff_push_target_valid", sql`(${t.leadId} is not null and ${t.serviceObligationId} is null and ${t.serviceWatchCaseId} is null and ${t.serviceNoticeRevision} is null and ${t.serviceOwnerId} is null and ${t.eventKey} is null) or (${t.leadId} is null and ${t.serviceObligationId} is not null and ${t.serviceWatchCaseId} is not null and ${t.serviceNoticeRevision} > 0 and ${t.serviceNoticeRevision} is not null and ${t.serviceOwnerId} is not null and ${t.eventKey} = 'service-watch:' || ${t.serviceWatchCaseId}::text || ':' || ${t.serviceNoticeRevision}::text and ${t.eventKey} is not null)`),
  index("staff_push_due_idx").on(t.state, t.createdAt),
]);
