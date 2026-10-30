import {
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

import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";

/**
 * Zapier Connected Apps give each GrowthOS specialist (SCOUT, APPT, INVO,
 * CALLIE, SCHED, ...) bounded, contractor-authorized hands in the apps the
 * contractor already uses. The contractor connects their own Zapier account
 * through the Zapier MCP Embed; Zapier returns a per-organization MCP server
 * URL that GrowthOS stores application-encrypted. Task usage is billed to the
 * contractor's own Zapier account, never to a platform credential.
 *
 * No table in this file stores provider credentials or raw provider
 * responses in ordinary JSON fields; digests and bounded summaries only.
 */

export const ZAPIER_SPECIALIST_IDS = [
  "esti",
  "bill",
  "invo",
  "sched",
  "appt",
  "callie",
  "maintain",
  "scout",
] as const;
export type ZapierSpecialistId = (typeof ZAPIER_SPECIALIST_IDS)[number];

export const ZAPIER_POLICY_MODES = ["off", "approve", "auto"] as const;
export type ZapierPolicyMode = (typeof ZAPIER_POLICY_MODES)[number];

export const ZAPIER_EXECUTION_STATES = [
  "pending_approval",
  "rejected",
  "executing",
  "succeeded",
  "failed",
  "blocked",
  "indeterminate",
] as const;
export type ZapierExecutionState = (typeof ZAPIER_EXECUTION_STATES)[number];

export type ZapierCapabilityDirection = "read" | "write";

/** Non-secret contractor choices for a bound capability (calendar id, default class, ...). */
export type ZapierBindingConfig = Record<string, string | number | boolean | null>;

export const zapierMcpConnectionsTable = pgTable(
  "zapier_mcp_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    connectedByUserId: varchar("connected_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** AES-256-GCM, AAD `${organizationId}:zapier-mcp`. The URL is the tenant credential. */
    encryptedServerUrl: text("encrypted_server_url").notNull(),
    /** SHA-256 of the server URL for duplicate detection and safe logging. */
    serverUrlFingerprint: text("server_url_fingerprint").notNull(),
    /** Lower-cased Zapier MCP host the URL was validated against at connect time. */
    serverHost: text("server_host").notNull(),
    serverMode: text("server_mode").$type<"agentic" | "managed" | "unknown">().notNull().default("unknown"),
    toolCount: integer("tool_count"),
    lastToolsRefreshedAt: timestamp("last_tools_refreshed_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("zapier_mcp_connections_org_uniq").on(table.organizationId),
    index("zapier_mcp_connections_fingerprint_idx").on(table.serverUrlFingerprint),
  ],
);

/**
 * A capability binding is the contractor's explicit choice of which Zapier
 * action (app + action key + connected account) a specialist capability runs.
 * Specialists never pick actions themselves; an unbound capability is inert.
 */
export const zapierCapabilityBindingsTable = pgTable(
  "zapier_capability_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    specialistId: text("specialist_id").$type<ZapierSpecialistId>().notNull(),
    direction: text("direction").$type<ZapierCapabilityDirection>().notNull(),
    /** Zapier app identifier (selected_api), e.g. GoogleCalendarCLIAPI. */
    zapierApp: text("zapier_app").notNull(),
    zapierAppName: text("zapier_app_name").notNull(),
    /** Zapier action key, e.g. detailed_event. */
    zapierAction: text("zapier_action").notNull(),
    zapierActionName: text("zapier_action_name").notNull(),
    /** Zapier connected-account id for that app; null uses the server default. */
    zapierConnectionId: text("zapier_connection_id"),
    bindingConfig: jsonb("binding_config").$type<ZapierBindingConfig>().notNull().default({}),
    boundByUserId: varchar("bound_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("zapier_capability_bindings_org_capability_uniq").on(
      table.organizationId,
      table.capability,
    ),
  ],
);

/**
 * Per-capability authority for a specialist: off (inert), approve (a human
 * approves every write), or auto (bounded by the daily budget). Reads are
 * budgeted too so a runaway sync cannot exhaust the contractor's Zapier tasks.
 */
export const zapierSpecialistPoliciesTable = pgTable(
  "zapier_specialist_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    specialistId: text("specialist_id").$type<ZapierSpecialistId>().notNull(),
    mode: text("mode").$type<ZapierPolicyMode>().notNull().default("approve"),
    dailyBudget: integer("daily_budget").notNull().default(25),
    updatedByUserId: varchar("updated_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("zapier_specialist_policies_org_capability_uniq").on(
      table.organizationId,
      table.capability,
    ),
  ],
);

/**
 * Immutable ledger of every Zapier action a specialist requested. Request and
 * response bytes are retained only as SHA-256 digests plus a bounded,
 * field-allowlisted summary. Writes are linked to the durable execution
 * receipt that owns the external effect.
 */
export const zapierActionExecutionsTable = pgTable(
  "zapier_action_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    specialistId: text("specialist_id").$type<ZapierSpecialistId>().notNull(),
    capability: text("capability").notNull(),
    direction: text("direction").$type<ZapierCapabilityDirection>().notNull(),
    zapierApp: text("zapier_app").notNull(),
    zapierAction: text("zapier_action").notNull(),
    /** Caller-stable key; a replay with a different request digest is rejected. */
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestSummary: jsonb("request_summary").$type<Record<string, unknown>>().notNull().default({}),
    responseDigest: text("response_digest"),
    resultSummary: jsonb("result_summary").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").$type<ZapierExecutionState>().notNull(),
    detail: text("detail").notNull().default(""),
    errorCode: text("error_code"),
    estimatedTasks: integer("estimated_tasks").notNull().default(2),
    linkedEntityType: text("linked_entity_type"),
    linkedEntityId: uuid("linked_entity_id"),
    requestedByUserId: varchar("requested_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    approvedByUserId: varchar("approved_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    durableExecutionId: uuid("durable_execution_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("zapier_action_executions_org_idempotency_uniq").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("zapier_action_executions_org_state_idx").on(table.organizationId, table.state),
    index("zapier_action_executions_org_capability_created_idx").on(
      table.organizationId,
      table.capability,
      table.createdAt,
    ),
  ],
);

export type ZapierMcpConnection = typeof zapierMcpConnectionsTable.$inferSelect;
export type ZapierCapabilityBinding = typeof zapierCapabilityBindingsTable.$inferSelect;
export type ZapierSpecialistPolicy = typeof zapierSpecialistPoliciesTable.$inferSelect;
export type ZapierActionExecution = typeof zapierActionExecutionsTable.$inferSelect;
