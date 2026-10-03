import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { serviceObligationsTable } from "./service-obligations";

export type ServiceWatchState = "clear" | "open" | "acknowledged" | "resolved" | "held";
export type ServiceWatchReason = "reminder_needs_review" | "no_response_recorded" | "reminder_blocked" | "send_unknown" | "visit_cancelled" | "visit_no_show" | "service_overdue" | "response_needs_action" | "next_action_overdue" | "owner_required" | "source_review_required";

/** A retained office-work projection, never a second service record or send authority. */
export const serviceWatchCasesTable = pgTable("service_watch_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  serviceObligationId: uuid("service_obligation_id").notNull(),
  version: integer("version").notNull().default(1),
  state: text("state").$type<ServiceWatchState>().notNull().default("clear"),
  reasons: jsonb("reasons").$type<ServiceWatchReason[]>().notNull().default([]),
  observedFingerprint: text("observed_fingerprint").notNull().default(""),
  episode: integer("episode").notNull().default(0),
  assignedUserId: varchar("assigned_user_id"),
  acknowledgedByUserId: varchar("acknowledged_by_user_id"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  nextAction: text("next_action"),
  nextActionAt: timestamp("next_action_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  noticeRevision: integer("notice_revision").notNull().default(0),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("service_watch_org_obligation_uq").on(t.organizationId, t.serviceObligationId),
  unique("service_watch_org_id_uq").on(t.organizationId, t.id),
  index("service_watch_rotation_idx").on(t.lastEvaluatedAt, t.id),
  index("service_watch_org_state_idx").on(t.organizationId, t.state, t.updatedAt),
  foreignKey({ columns: [t.organizationId, t.serviceObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "service_watch_obligation_fk" }),
  foreignKey({ columns: [t.organizationId, t.assignedUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "service_watch_assignee_fk" }),
  foreignKey({ columns: [t.organizationId, t.acknowledgedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "service_watch_acknowledger_fk" }),
]);
