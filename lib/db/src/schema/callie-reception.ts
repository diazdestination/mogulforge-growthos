import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { callieIntakesTable, calliePolicyRevisionsTable } from "./callie";
import { revenueExecutionsTable } from "./revenue-workspace";

/** Non-secret company-owned provider configuration; changing it holds old authority. */
export const callieReceptionBindingsTable = pgTable("callie_reception_bindings", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  version: integer("version").notNull().default(1), enabled: boolean("enabled").notNull().default(false),
  agentId: text("agent_id").notNull(), agentVersionId: text("agent_version_id").notNull(),
  branchId: text("branch_id"),
  environment: text("environment").$type<"production" | "staging">().notNull(),
  credentialKey: text("credential_key").notNull(), configurationSha256: text("configuration_sha256").notNull(),
  updatedByUserId: varchar("updated_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("callie_reception_binding_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("callie_reception_binding_org_uq").on(t.organizationId),
  uniqueIndex("callie_reception_binding_agent_uq").on(t.agentId, t.environment),
  foreignKey({ columns: [t.organizationId, t.updatedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "callie_reception_binding_actor_fk" }),
  check("callie_reception_binding_version_ck", sql`${t.version} > 0`),
  check("callie_reception_binding_identity_ck", sql`${t.agentId} ~ '^[A-Za-z0-9_-]{1,128}$' and ${t.agentVersionId} ~ '^[A-Za-z0-9_-]{1,128}$' and (${t.branchId} is null or ${t.branchId} ~ '^[A-Za-z0-9_-]{1,128}$') and ${t.environment} in ('production','staging') and ${t.credentialKey} ~ '^[A-Z][A-Z0-9_]{0,59}$' and ${t.configurationSha256} ~ '^[a-f0-9]{64}$'`),
]);

export const callieReceptionSessionsTable = pgTable("callie_reception_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  intakeId: uuid("intake_id").notNull(), callId: uuid("call_id").notNull(), policyRevisionId: uuid("policy_revision_id").notNull(),
  intakeMode: text("intake_mode").notNull().default("conversation"),
  receptionBindingId: uuid("reception_binding_id").notNull(),
  state: text("state").$type<"admitted" | "registering" | "registered" | "active" | "completed" | "interrupted" | "blocked" | "indeterminate" | "expired">().notNull().default("admitted"),
  reason: text("reason").notNull().default("awaiting_dial_outcome"),
  agentId: text("agent_id").notNull(), agentVersionId: text("agent_version_id").notNull(), environment: text("environment").notNull(),
  conversationId: text("conversation_id"), conversationBoundAt: timestamp("conversation_bound_at", { withTimezone: true }),
  capabilityHash: text("capability_hash"), capabilityExpiresAt: timestamp("capability_expires_at", { withTimezone: true }),
  registrationReceiptId: uuid("registration_receipt_id"), registrationKey: text("registration_key"),
  registrationAcceptedAt: timestamp("registration_accepted_at", { withTimezone: true }),
  dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
  toolsUsed: integer("tools_used").notNull().default(0),
  factsEncrypted: text("facts_encrypted"), summaryEncrypted: text("summary_encrypted"),
  contentExpiresAt: timestamp("content_expires_at", { withTimezone: true }).notNull(),
  contentPurgedAt: timestamp("content_purged_at", { withTimezone: true }),
  conversationOutcome: text("conversation_outcome").$type<"pending" | "completed" | "interrupted" | "empty" | "unknown">().notNull().default("pending"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  transferReceiptId: uuid("transfer_receipt_id"), transferKey: text("transfer_key"),
  transferState: text("transfer_state").$type<"not_requested" | "claiming" | "redirect_accepted" | "ringing" | "phone_answered" | "not_answered" | "failed" | "indeterminate" | "blocked">().notNull().default("not_requested"),
  transferTarget: text("transfer_target"), transferRequestedAt: timestamp("transfer_requested_at", { withTimezone: true }),
  transferDispatchStartedAt: timestamp("transfer_dispatch_started_at", { withTimezone: true }),
  transferAcceptedAt: timestamp("transfer_accepted_at", { withTimezone: true }),
  transferChildCallSid: text("transfer_child_call_sid"), transferCompletedAt: timestamp("transfer_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("callie_reception_session_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("callie_reception_session_intake_uq").on(t.organizationId, t.intakeId),
  uniqueIndex("callie_reception_session_call_uq").on(t.callId),
  uniqueIndex("callie_reception_session_conversation_uq").on(t.conversationId),
  uniqueIndex("callie_reception_session_child_uq").on(t.transferChildCallSid),
  index("callie_reception_session_retention_idx").on(t.contentExpiresAt),
  foreignKey({ columns: [t.organizationId, t.intakeId, t.callId, t.policyRevisionId, t.intakeMode], foreignColumns: [callieIntakesTable.organizationId, callieIntakesTable.id, callieIntakesTable.callId, callieIntakesTable.policyRevisionId, callieIntakesTable.mode], name: "callie_reception_session_intake_fk" }),
  foreignKey({ columns: [t.organizationId, t.policyRevisionId], foreignColumns: [calliePolicyRevisionsTable.organizationId, calliePolicyRevisionsTable.id], name: "callie_reception_session_policy_fk" }),
  foreignKey({ columns: [t.organizationId, t.receptionBindingId], foreignColumns: [callieReceptionBindingsTable.organizationId, callieReceptionBindingsTable.id], name: "callie_reception_session_binding_fk" }),
  foreignKey({ columns: [t.organizationId, t.registrationReceiptId, t.registrationKey], foreignColumns: [revenueExecutionsTable.organizationId, revenueExecutionsTable.id, revenueExecutionsTable.actionKey], name: "callie_reception_session_registration_fk" }),
  foreignKey({ columns: [t.organizationId, t.transferReceiptId, t.transferKey], foreignColumns: [revenueExecutionsTable.organizationId, revenueExecutionsTable.id, revenueExecutionsTable.actionKey], name: "callie_reception_session_transfer_fk" }),
  check("callie_reception_session_state_ck", sql`${t.intakeMode} = 'conversation' and ${t.state} in ('admitted','registering','registered','active','completed','interrupted','blocked','indeterminate','expired') and ${t.conversationOutcome} in ('pending','completed','interrupted','empty','unknown') and ${t.transferState} in ('not_requested','claiming','redirect_accepted','ringing','phone_answered','not_answered','failed','indeterminate','blocked')`),
  check("callie_reception_session_identity_ck", sql`${t.agentId} ~ '^[A-Za-z0-9_-]{1,128}$' and ${t.agentVersionId} ~ '^[A-Za-z0-9_-]{1,128}$' and ${t.environment} in ('production','staging') and (${t.conversationId} is null or ${t.conversationId} ~ '^[A-Za-z0-9_-]{1,128}$') and ((${t.conversationId} is null) = (${t.conversationBoundAt} is null))`),
  check("callie_reception_session_capability_ck", sql`(${t.capabilityHash} is null and ${t.capabilityExpiresAt} is null) or (${t.capabilityHash} is not null and ${t.capabilityHash} ~ '^[a-f0-9]{64}$' and ${t.capabilityExpiresAt} is not null)`),
  check("callie_reception_session_key_ck", sql`((${t.registrationReceiptId} is null and ${t.registrationKey} is null) or (${t.registrationReceiptId} is not null and ${t.registrationKey} is not null and ${t.registrationKey} = 'callie:' || ${t.callId}::text || ':conversation:v1')) and ((${t.transferReceiptId} is null and ${t.transferKey} is null) or (${t.transferReceiptId} is not null and ${t.transferKey} is not null and ${t.transferKey} = 'callie:' || ${t.callId}::text || ':human-transfer:v1'))`),
  check("callie_reception_session_bounded_ck", sql`${t.toolsUsed} between 0 and 12 and (${t.factsEncrypted} is null or length(${t.factsEncrypted}) <= 12000) and (${t.summaryEncrypted} is null or length(${t.summaryEncrypted}) <= 10000)`),
  check("callie_reception_session_transfer_ck", sql`(${t.transferTarget} is null or ${t.transferTarget} ~ '^[+]1[2-9][0-9]{9}$') and (${t.transferChildCallSid} is null or ${t.transferChildCallSid} ~ '^CA[a-fA-F0-9]{32}$') and (${t.transferState} = 'not_requested' or (${t.transferReceiptId} is not null and ${t.transferTarget} is not null and ${t.transferRequestedAt} is not null))`),
]);

/** Append-only event identity/hash; only bounded encrypted extracted text may expire. */
export const callieReceptionEventsTable = pgTable("callie_reception_events", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  sessionId: uuid("session_id").notNull(), eventKey: text("event_key").notNull(),
  kind: text("kind").$type<"initialize" | "save_facts" | "request_handoff" | "post_call" | "transfer_status">().notNull(),
  payloadHash: text("payload_hash").notNull(), contentEncrypted: text("content_encrypted"),
  contentExpiresAt: timestamp("content_expires_at", { withTimezone: true }).notNull(), contentPurgedAt: timestamp("content_purged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("callie_reception_event_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("callie_reception_event_original_uq").on(t.organizationId, t.sessionId, t.eventKey),
  index("callie_reception_event_retention_idx").on(t.contentExpiresAt),
  foreignKey({ columns: [t.organizationId, t.sessionId], foreignColumns: [callieReceptionSessionsTable.organizationId, callieReceptionSessionsTable.id], name: "callie_reception_event_session_fk" }),
  check("callie_reception_event_key_ck", sql`length(${t.eventKey}) between 1 and 200 and ${t.payloadHash} ~ '^[a-f0-9]{64}$' and ${t.kind} in ('initialize','save_facts','request_handoff','post_call','transfer_status')`),
  check("callie_reception_event_content_ck", sql`${t.contentEncrypted} is null or length(${t.contentEncrypted}) <= 16000`),
]);
