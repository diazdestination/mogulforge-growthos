import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { twilioCallsTable } from "./twilio";

/** Configuration is approval-versioned. Missing policy never enables sending. */
export const missedCallCarePoliciesTable = pgTable("missed_call_care_policies", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(false),
  timezone: text("timezone").notNull(),
  days: jsonb("days").$type<number[]>().notNull(),
  opensAt: text("opens_at").notNull(),
  closesAt: text("closes_at").notNull(),
  businessHoursOwnerId: varchar("business_hours_owner_id"),
  afterHoursOwnerId: varchar("after_hours_owner_id"),
  responseMinutes: integer("response_minutes").notNull().default(30),
  approvedByUserId: varchar("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.organizationId, t.businessHoursOwnerId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "missed_care_policy_day_owner_fk" }),
  foreignKey({ columns: [t.organizationId, t.afterHoursOwnerId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "missed_care_policy_after_owner_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "missed_care_policy_approver_fk" }),
]);

export interface MissedCallCareSnapshot {
  templateVersion: "missed-call-care.v1";
  callId: string;
  handoffId: string;
  contactId: string;
  leadId: string | null;
  phone: string;
  dialStatus: string;
  reviewedAt: string;
  policyVersion: number;
  responseMinutes: number;
  ownerUserId: string;
  bindingId: string;
  accountSid: string;
  sender: string;
  messagingServiceSid: string;
  disclosureVersion: string;
  businessName: string;
  publicOrigin: string;
  body: string;
  renderedMessage: string;
}
export type MissedCallCareState = "needs_review" | "approved" | "deferred" | "dispatching" | "awaiting_reply" | "reply_needs_review" | "blocked" | "indeterminate" | "escalated" | "resolved" | "cancelled";
/** One recovery identity for the whole call, not one identity per click or retry. */
export const missedCallCareCasesTable = pgTable("missed_call_care_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  callId: uuid("call_id").notNull(),
  version: integer("version").notNull().default(1),
  state: text("state").$type<MissedCallCareState>().notNull().default("needs_review"),
  approvedSnapshot: jsonb("approved_snapshot").$type<MissedCallCareSnapshot>(),
  approvedByUserId: varchar("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  ownerUserId: varchar("owner_user_id"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  reason: text("reason").notNull().default("staff_review_required"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("missed_care_case_call_uq").on(t.callId),
  uniqueIndex("missed_care_case_org_call_uq").on(t.organizationId, t.callId),
  index("missed_care_case_due_idx").on(t.state, t.dueAt),
  foreignKey({ columns: [t.organizationId, t.callId], foreignColumns: [twilioCallsTable.organizationId, twilioCallsTable.id], name: "missed_care_case_call_fk" }),
  foreignKey({ columns: [t.organizationId, t.ownerUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "missed_care_case_owner_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "missed_care_case_approver_fk" }),
]);
