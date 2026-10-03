import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { contactsTable } from "./contacts";
import { serviceObligationsTable } from "./service-obligations";
import { usersTable } from "./auth";
import { twilioClientBindingsTable, twilioDispatchesTable, twilioInboundEventsTable } from "./twilio";
import { revenueExecutionsTable } from "./revenue-workspace";
import { auditEventsTable } from "./audit";
import { scheduledActionsTable } from "./automations";

export type ServiceSmsContext = { version: 1; dueAt: string; occurrenceIndex: number; createdAt: string; updatedAt: string; authorizationOrigin: "individual" | "standing" };
/** Exact immutable service/sender context exists before an irreversible POST. */
export const serviceSmsParentsTable = pgTable("service_sms_parents", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  serviceObligationId: uuid("service_obligation_id").notNull(), contactId: uuid("contact_id").notNull(), bindingId: uuid("binding_id").notNull(),
  approvalId: uuid("approval_id").notNull(), scheduledActionId: uuid("scheduled_action_id").notNull(),
  actionKey: text("action_key").notNull(), executionId: uuid("execution_id").notNull(), executionFingerprint: text("execution_fingerprint").notNull(),
  authorizationFingerprint: text("authorization_fingerprint").notNull(), contextSnapshot: jsonb("context_snapshot").$type<ServiceSmsContext>().notNull(),
  reference: text("reference").notNull(), templateVersion: integer("template_version").notNull().default(1),
  accountSid: text("account_sid").notNull(), sender: text("sender").notNull(), recipient: text("recipient").notNull(),
  messagingServiceSid: text("messaging_service_sid").notNull(), disclosureVersion: text("disclosure_version").notNull(),
  bindingFingerprint: text("binding_fingerprint").notNull(), bodySha256: text("body_sha256").notNull(),
  operationKey: text("operation_key").notNull(), dispatchId: uuid("dispatch_id"), dispatchPayloadHash: text("dispatch_payload_hash"),
  reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
}, t => [
  unique("service_sms_parent_org_id_uq").on(t.organizationId, t.id),
  unique("service_sms_parent_exact_uq").on(t.organizationId, t.id, t.serviceObligationId, t.contactId, t.bindingId, t.accountSid, t.recipient, t.sender),
  unique("service_sms_parent_occurrence_uq").on(t.organizationId, t.serviceObligationId),
  unique("service_sms_parent_action_uq").on(t.organizationId, t.actionKey),
  unique("service_sms_parent_reference_uq").on(t.organizationId, t.reference),
  uniqueIndex("service_sms_parent_dispatch_uq").on(t.organizationId, t.dispatchId).where(sql`${t.dispatchId} is not null`),
  index("service_sms_parent_phone_idx").on(t.organizationId, t.accountSid, t.sender, t.recipient),
  foreignKey({ columns: [t.organizationId, t.serviceObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "service_sms_parent_service_fk" }),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "service_sms_parent_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.bindingId], foreignColumns: [twilioClientBindingsTable.organizationId, twilioClientBindingsTable.id], name: "service_sms_parent_binding_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvalId], foreignColumns: [auditEventsTable.organizationId, auditEventsTable.id], name: "service_sms_parent_approval_fk" }),
  foreignKey({ columns: [t.organizationId, t.scheduledActionId], foreignColumns: [scheduledActionsTable.organizationId, scheduledActionsTable.id], name: "service_sms_parent_scheduled_fk" }),
  foreignKey({ columns: [t.organizationId, t.executionId, t.actionKey, t.executionFingerprint], foreignColumns: [revenueExecutionsTable.organizationId, revenueExecutionsTable.id, revenueExecutionsTable.actionKey, revenueExecutionsTable.fingerprint], name: "service_sms_parent_execution_fk" }),
  foreignKey({ columns: [t.organizationId, t.dispatchId, t.operationKey, t.accountSid, t.recipient], foreignColumns: [twilioDispatchesTable.organizationId, twilioDispatchesTable.id, twilioDispatchesTable.idempotencyKey, twilioDispatchesTable.accountSid, twilioDispatchesTable.phone], name: "service_sms_parent_dispatch_fk" }),
  check("service_sms_parent_format_ck", sql`${t.templateVersion} = 1 and ${t.reference} ~ '^[a-f0-9]{16}$' and ${t.accountSid} ~ '^AC[a-fA-F0-9]{32}$' and ${t.messagingServiceSid} ~ '^MG[a-fA-F0-9]{32}$' and ${t.sender} ~ '^\\+1[2-9][0-9]{9}$' and ${t.recipient} ~ '^\\+1[2-9][0-9]{9}$' and ${t.executionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.authorizationFingerprint} ~ '^[a-f0-9]{64}$' and ${t.bindingFingerprint} ~ '^[a-f0-9]{64}$' and ${t.bodySha256} ~ '^[a-f0-9]{64}$'`),
  check("service_sms_parent_dispatch_ck", sql`(${t.dispatchStartedAt} is null and ${t.dispatchId} is null and ${t.dispatchPayloadHash} is null) or (${t.dispatchStartedAt} is not null and ${t.dispatchId} is not null and ${t.dispatchPayloadHash} is not null and ${t.dispatchPayloadHash} ~ '^[a-f0-9]{64}$')`),
  check("service_sms_parent_keys_ck", sql`${t.actionKey} = 'scheduled:' || ${t.scheduledActionId}::text and ${t.operationKey} = 'service-care:' || ${t.serviceObligationId}::text`),
]);

/** Signed source evidence; message content never grants authority. */
export const serviceSmsRepliesTable = pgTable("service_sms_replies", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  bindingId: uuid("binding_id").notNull(), messageSid: text("message_sid").notNull(), accountSid: text("account_sid").notNull(),
  fromNumber: text("from_number").notNull(), toNumber: text("to_number").notNull(), messagingServiceSid: text("messaging_service_sid"),
  payloadSha256: text("payload_sha256").notNull(), bodySha256: text("body_sha256").notNull(),
  parentId: uuid("parent_id"), serviceObligationId: uuid("service_obligation_id"), contactId: uuid("contact_id"),
  correlation: text("correlation").$type<"exact_reference" | "ambiguous">().notNull(), reason: text("reason").notNull(),
  candidateParentIds: jsonb("candidate_parent_ids").$type<string[]>().notNull().default([]),
  candidateCount: integer("candidate_count").notNull(), candidatesTruncated: boolean("candidates_truncated").notNull().default(false),
  historical: boolean("historical").notNull().default(false), holdActive: boolean("hold_active").notNull().default(true),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(), recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  state: text("state").$type<"needs_review" | "reviewed" | "dismissed">().notNull().default("needs_review"), version: integer("version").notNull().default(1),
  encryptedText: text("encrypted_text"), rawExpiresAt: timestamp("raw_expires_at", { withTimezone: true }).notNull(), rawPurgedAt: timestamp("raw_purged_at", { withTimezone: true }),
  reviewedByUserId: varchar("reviewed_by_user_id"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }), reviewNote: text("review_note"), reviewRequestId: uuid("review_request_id"), reviewFingerprint: text("review_fingerprint"),
}, t => [
  unique("service_sms_reply_org_id_uq").on(t.organizationId, t.id),
  unique("service_sms_reply_message_uq").on(t.organizationId, t.messageSid),
  index("service_sms_reply_service_idx").on(t.organizationId, t.serviceObligationId, t.state, t.recordedAt),
  index("service_sms_reply_phone_hold_idx").on(t.organizationId, t.fromNumber, t.holdActive),
  index("service_sms_reply_raw_expiry_idx").on(t.rawExpiresAt),
  foreignKey({ columns: [t.organizationId, t.messageSid], foreignColumns: [twilioInboundEventsTable.organizationId, twilioInboundEventsTable.messageSid], name: "service_sms_reply_inbound_fk" }),
  foreignKey({ columns: [t.organizationId, t.bindingId], foreignColumns: [twilioClientBindingsTable.organizationId, twilioClientBindingsTable.id], name: "service_sms_reply_binding_fk" }),
  foreignKey({ columns: [t.organizationId, t.parentId, t.serviceObligationId, t.contactId, t.bindingId, t.accountSid, t.fromNumber, t.toNumber], foreignColumns: [serviceSmsParentsTable.organizationId, serviceSmsParentsTable.id, serviceSmsParentsTable.serviceObligationId, serviceSmsParentsTable.contactId, serviceSmsParentsTable.bindingId, serviceSmsParentsTable.accountSid, serviceSmsParentsTable.recipient, serviceSmsParentsTable.sender], name: "service_sms_reply_exact_parent_fk" }),
  foreignKey({ columns: [t.organizationId, t.reviewedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "service_sms_reply_reviewer_fk" }),
  check("service_sms_reply_correlation_ck", sql`(${t.correlation} = 'exact_reference' and ${t.parentId} is not null and ${t.serviceObligationId} is not null and ${t.contactId} is not null) or (${t.correlation} = 'ambiguous' and ${t.parentId} is null and ${t.serviceObligationId} is null and ${t.contactId} is null and not ${t.historical})`),
  check("service_sms_reply_format_ck", sql`${t.messageSid} ~ '^SM[a-fA-F0-9]{32}$' and ${t.accountSid} ~ '^AC[a-fA-F0-9]{32}$' and ${t.fromNumber} ~ '^\\+1[2-9][0-9]{9}$' and ${t.toNumber} ~ '^\\+1[2-9][0-9]{9}$' and ${t.payloadSha256} ~ '^[a-f0-9]{64}$' and ${t.bodySha256} ~ '^[a-f0-9]{64}$' and ${t.candidateCount} >= 0 and jsonb_typeof(${t.candidateParentIds}) = 'array'`),
  check("service_sms_reply_state_ck", sql`${t.state} in ('needs_review','reviewed','dismissed') and ${t.version} > 0 and (not ${t.historical} or not ${t.holdActive}) and (${t.state} != 'dismissed' or not ${t.holdActive})`),
]);
