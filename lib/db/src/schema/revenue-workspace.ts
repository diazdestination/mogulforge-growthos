import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { estimatesTable } from "./estimates";
import { projectsTable } from "./projects";

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
      .notNull()
      .references(() => leadsTable.id),
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
