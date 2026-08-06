import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { usersTable } from "./auth";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * BIE never stores provider credentials in this table. OAuth credentials stay
 * in the provider-specific secure store; this is the tenant-visible health
 * record used by the Revenue Command Center.
 */
export type BieSource = "google_ads" | "google_analytics" | "search_console" | "business_profile";
export type BieSourceStatus = "not_connected" | "pending" | "connected" | "error";

export const bieConnectedSourcesTable = pgTable(
  "bie_connected_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    source: text("source").$type<BieSource>().notNull(),
    status: text("status").$type<BieSourceStatus>().notNull().default("not_connected"),
    accountLabel: text("account_label"),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("bie_connected_sources_org_source_uniq").on(table.organizationId, table.source),
    index("bie_connected_sources_org_idx").on(table.organizationId),
  ],
);

export type BieAutopilotPolicy = {
  enabled: boolean;
  /** The only action categories BIE can auto-execute. */
  allowedActions: Array<"create_task" | "change_stage" | "send_email">;
  /** Hard daily cap on BIE-originated outreach, in addition to send-gate caps. */
  dailyEmailCap: number;
  /** Explicit operator pause state wins over every other policy flag. */
  pausedAt?: string | null;
  pauseReason?: string | null;
};

export const bieAutopilotPoliciesTable = pgTable(
  "bie_autopilot_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    policy: jsonb("policy")
      .$type<BieAutopilotPolicy>()
      .notNull()
      .default({ enabled: false, allowedActions: [], dailyEmailCap: 20 }),
    updatedByUserId: varchar("updated_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("bie_autopilot_policies_org_uniq").on(table.organizationId)],
);

export type BieAgentRunKind = "revenue_recovery_briefing" | "proposal_generation";
export type BieAgentRunStatus = "running" | "completed" | "failed";

/** Immutable, evidence-backed BIE run snapshots. */
export const bieAgentRunsTable = pgTable(
  "bie_agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    kind: text("kind").$type<BieAgentRunKind>().notNull(),
    status: text("status").$type<BieAgentRunStatus>().notNull().default("running"),
    trigger: text("trigger").notNull().default("manual"),
    initiatedByUserId: varchar("initiated_by_user_id").references(() => usersTable.id),
    summary: text("summary"),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("bie_agent_runs_org_created_idx").on(table.organizationId, table.createdAt)],
);

export type BieActionType = "create_task" | "change_stage" | "send_email";
export type BieActionStatus = "proposed" | "approved" | "executed" | "blocked" | "rejected" | "failed";

/**
 * Every potentially consequential BIE recommendation is durable, reviewable,
 * and tied to one lead. No action can execute without passing its policy and
 * channel-specific safety gate.
 */
export const bieActionProposalsTable = pgTable(
  "bie_action_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    runId: uuid("run_id").references(() => bieAgentRunsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    actionType: text("action_type").$type<BieActionType>().notNull(),
    status: text("status").$type<BieActionStatus>().notNull().default("proposed"),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    estimatedValueCents: integer("estimated_value_cents"),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionDetail: text("execution_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("bie_action_proposals_org_status_idx").on(table.organizationId, table.status),
    index("bie_action_proposals_org_lead_idx").on(table.organizationId, table.leadId),
  ],
);

export type BieConnectedSource = typeof bieConnectedSourcesTable.$inferSelect;
export type BieAutopilotPolicyRow = typeof bieAutopilotPoliciesTable.$inferSelect;
export type BieAgentRun = typeof bieAgentRunsTable.$inferSelect;
export type BieActionProposal = typeof bieActionProposalsTable.$inferSelect;
