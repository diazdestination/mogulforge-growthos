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
  uniqueIndex,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { estimatesTable } from "./estimates";
import { projectsTable } from "./projects";
import { customerWorkRootsTable } from "./customer-work";

export type ExecutionState =
  | "processing"
  | "succeeded"
  | "blocked"
  | "indeterminate"
  | "confirmed_succeeded"
  | "confirmed_not_performed";
export const revenueExecutionsTable = pgTable(
  "revenue_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    actionKey: text("action_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind").notNull(),
    state: text("state")
      .$type<ExecutionState>()
      .notNull()
      .default("processing"),
    detail: text("detail"),
    actorUserId: text("actor_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("revenue_execution_exact_uq").on(t.organizationId, t.id, t.actionKey, t.fingerprint),
    unique("revenue_execution_operation_uq").on(t.organizationId, t.id, t.actionKey),
    unique("revenue_execution_exact_actor_uq").on(t.organizationId, t.id, t.actionKey, t.fingerprint, t.actorUserId),
    uniqueIndex("revenue_execution_org_key").on(t.organizationId, t.actionKey),
    index("revenue_execution_org_state").on(t.organizationId, t.state),
  ],
);

export const revenueExecutionEventsTable = pgTable(
  "revenue_execution_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => revenueExecutionsTable.id),
    state: text("state").$type<ExecutionState>().notNull(),
    detail: text("detail").notNull(),
    actorUserId: text("actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("revenue_execution_events_org").on(t.organizationId, t.executionId),
  ],
);

export interface OperatingProfileContent {
  services: string;
  serviceArea: string;
  businessHours: string;
  escalation: string;
  materials: string;
  warranties: string;
  pricingBoundaries: string;
  sourceReference: string;
}
export const operatingProfilesTable = pgTable(
  "operating_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    version: integer("version").notNull(),
    content: jsonb("content").$type<OperatingProfileContent>().notNull(),
    approvedByUserId: text("approved_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("operating_profile_org_version").on(
      t.organizationId,
      t.version,
    ),
  ],
);

export interface DecisionOption {
  name: string;
  description: string;
}
export const decisionRoomsTable = pgTable(
  "decision_rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    estimateId: uuid("estimate_id")
      .notNull()
      .references(() => estimatesTable.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    scope: text("scope").notNull(),
    options: jsonb("options").$type<DecisionOption[]>().notNull().default([]),
    warranty: text("warranty").notNull(),
    sourceReference: text("source_reference").notNull(),
    estimateTotalCents: integer("estimate_total_cents").notNull(),
    estimateUpdatedAt: timestamp("estimate_updated_at", {
      withTimezone: true,
    }).notNull(),
    approvedByUserId: text("approved_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("decision_room_org_lead_version").on(
      t.organizationId,
      t.leadId,
      t.version,
    ),
  ],
);

export type ValueEntryKind =
  "payment" | "refund" | "direct_cost" | "cost_refund";
export const valueEntriesTable = pgTable(
  "value_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .references(() => leadsTable.id),
    customerWorkId: uuid("customer_work_id"),
    refundOfValueEntryId: uuid("refund_of_value_entry_id").references((): AnyPgColumn => valueEntriesTable.id),
    sourceReference: text("source_reference").notNull(),
    kind: text("kind").$type<ValueEntryKind>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedByUserId: text("recorded_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("value_entry_org_reference").on(
      t.organizationId,
      t.sourceReference,
    ),
    index("value_entry_org_lead").on(t.organizationId, t.leadId),
    unique("value_entry_org_id_uq").on(t.organizationId, t.id),
    unique("value_entry_org_work_id_uq").on(t.organizationId, t.id, t.customerWorkId),
    foreignKey({ columns: [t.organizationId, t.customerWorkId], foreignColumns: [customerWorkRootsTable.organizationId, customerWorkRootsTable.id], name: "value_entry_customer_work_fk" }),
    foreignKey({ columns: [t.organizationId, t.refundOfValueEntryId, t.customerWorkId], foreignColumns: [t.organizationId, t.id, t.customerWorkId], name: "value_entry_refund_work_fk" }),
    foreignKey({ columns: [t.organizationId, t.refundOfValueEntryId], foreignColumns: [t.organizationId, t.id], name: "value_entry_refund_tenant_fk" }),
    check("value_entry_work_scope_ck", sql`(${t.leadId} is not null and ${t.customerWorkId} is null) or (${t.leadId} is null and ${t.customerWorkId} is not null)`),
    check("value_entry_work_refund_ck", sql`(${t.customerWorkId} is null and ${t.refundOfValueEntryId} is null) or (${t.customerWorkId} is not null and ((${t.kind} = 'refund' and ${t.refundOfValueEntryId} is not null and ${t.refundOfValueEntryId} <> ${t.id}) or (${t.kind} <> 'refund' and ${t.refundOfValueEntryId} is null)))`),
    index("value_entries_org_work_idx").on(t.organizationId, t.customerWorkId),
  ],
);

export const projectStoriesTable = pgTable(
  "project_stories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projectsTable.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    serviceArea: text("service_area").notNull(),
    body: text("body").notNull(),
    sourceReference: text("source_reference").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
    }).notNull(),
    state: text("state")
      .$type<"draft" | "approved">()
      .notNull()
      .default("draft"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("project_story_org_project_version").on(
      t.organizationId,
      t.projectId,
      t.version,
    ),
  ],
);
