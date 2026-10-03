import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { auditEventsTable } from "./audit";
import { twilioCallsTable, twilioClientBindingsTable, twilioInboundEventsTable } from "./twilio";
import { revenueExecutionsTable } from "./revenue-workspace";
import { appointmentsTable } from "./appointments";

export interface CalliePolicySettings {
  enabled: boolean;
  timezone: string;
  days: number[];
  opensAt: string;
  closesAt: string;
  businessHoursOwnerId: string | null;
  afterHoursOwnerId: string | null;
  responseMinutes: number;
}
export interface CalliePolicySnapshot extends CalliePolicySettings {
  templateVersion: "callie-intake.v1";
  prompts: { service: string; request: string; window: string; disclosure: string; consent: string; instructions: string };
  acknowledgmentBody: string;
  binding: { id: string; accountSid: string; sender: string; messagingServiceSid: string; disclosureVersion: string; origin: string; businessName: string } | null;
}
export const CALLIE_STAGES = ["admitted", "service", "request", "window", "consent", "complete"] as const;
export type CallieStage = typeof CALLIE_STAGES[number];
export const CALLIE_STATES = ["admitted", "collecting", "awaiting_sms", "confirmed", "deferred", "dispatching", "accepted", "blocked", "indeterminate", "resolved", "cancelled", "booked"] as const;
export type CallieState = typeof CALLIE_STATES[number];
export type CallieServiceIntent = "repair" | "replacement" | "maintenance" | "other";
export type CallieRequestIntent = "callback" | "visit";
export type CallieCallbackWindow = "morning" | "afternoon" | "any";
/** Bounded stage evidence. Every response is encrypted, including challenge replay. Never expose through staff APIs. */
export interface CallieStepReceipt { stage: CallieStage; version: number; digit: string; at: string; responseEncrypted: string }

/** Append-only owner-approved snapshots; highest version is the current head, including disable revisions. */
export const calliePolicyRevisionsTable = pgTable("callie_policy_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  version: integer("version").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  snapshot: jsonb("snapshot").$type<CalliePolicySnapshot>().notNull(),
  reviewId: uuid("review_id").notNull(),
  reviewPayloadHash: text("review_payload_hash").notNull(),
  approvedByUserId: varchar("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("callie_policy_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("callie_policy_org_version_uq").on(t.organizationId, t.version),
  uniqueIndex("callie_policy_review_uq").on(t.organizationId, t.reviewId),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "callie_policy_actor_fk" }),
  foreignKey({ columns: [t.organizationId, t.reviewId, t.approvedByUserId], foreignColumns: [auditEventsTable.organizationId, auditEventsTable.id, auditEventsTable.actorUserId], name: "callie_policy_review_fk" }),
  check("callie_policy_version_ck", sql`${t.version} > 0`),
  check("callie_policy_hash_ck", sql`${t.reviewPayloadHash} ~ '^[a-f0-9]{64}$'`),
  check("callie_policy_enabled_ck", sql`coalesce(jsonb_typeof(${t.snapshot}->'enabled') = 'boolean' and (${t.snapshot}->>'enabled')::boolean = ${t.enabled}, false)`),
]);

/** Contact-free, forward-only admission. A CALLIE request never creates identity or general consent. */
export const callieIntakesTable = pgTable("callie_intakes", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  callId: uuid("call_id").notNull(),
  policyRevisionId: uuid("policy_revision_id").notNull(),
  version: integer("version").notNull().default(1),
  state: text("state").$type<CallieState>().notNull().default("admitted"),
  stage: text("stage").$type<CallieStage>().notNull().default("admitted"),
  bindingId: uuid("binding_id").notNull(),
  accountSid: text("account_sid").notNull(),
  providerCallSid: text("provider_call_sid").notNull(),
  fromPhone: text("from_phone").notNull(),
  calledNumber: text("called_number").notNull(),
  ownerUserId: varchar("owner_user_id").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  ackDueAt: timestamp("ack_due_at", { withTimezone: true }),
  serviceIntent: text("service_intent").$type<CallieServiceIntent>(),
  requestIntent: text("request_intent").$type<CallieRequestIntent>(),
  callbackWindow: text("callback_window").$type<CallieCallbackWindow>(),
  stepReceipts: jsonb("step_receipts").$type<CallieStepReceipt[]>().notNull().default([]),
  challengeHash: text("challenge_hash"),
  challengeEncrypted: text("challenge_encrypted"),
  challengeExpiresAt: timestamp("challenge_expires_at", { withTimezone: true }),
  triggerMessageSid: text("trigger_message_sid"),
  triggerAccountSid: text("trigger_account_sid"),
  triggerFrom: text("trigger_from"),
  triggerTo: text("trigger_to"),
  triggerPayloadHash: text("trigger_payload_hash"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
  reason: text("reason").notNull().default("awaiting_dial_outcome"),
  appointmentId: uuid("appointment_id"),
  officeRequestId: uuid("office_request_id"),
  officePayloadHash: text("office_payload_hash"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("callie_intake_org_id_uq").on(t.organizationId, t.id),
  unique("callie_intake_grant_uq").on(t.organizationId, t.id, t.callId, t.policyRevisionId, t.triggerMessageSid),
  uniqueIndex("callie_intake_call_uq").on(t.callId),
  uniqueIndex("callie_intake_trigger_uq").on(t.triggerMessageSid),
  uniqueIndex("callie_intake_challenge_uq").on(t.organizationId, t.fromPhone, t.challengeHash),
  index("callie_intake_worklist_idx").on(t.organizationId, t.state, t.dueAt),
  foreignKey({ columns: [t.organizationId, t.callId], foreignColumns: [twilioCallsTable.organizationId, twilioCallsTable.id], name: "callie_intake_call_fk" }),
  foreignKey({ columns: [t.organizationId, t.policyRevisionId], foreignColumns: [calliePolicyRevisionsTable.organizationId, calliePolicyRevisionsTable.id], name: "callie_intake_policy_fk" }),
  foreignKey({ columns: [t.organizationId, t.bindingId], foreignColumns: [twilioClientBindingsTable.organizationId, twilioClientBindingsTable.id], name: "callie_intake_binding_fk" }),
  foreignKey({ columns: [t.organizationId, t.ownerUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "callie_intake_owner_fk" }),
  foreignKey({ columns: [t.organizationId, t.triggerMessageSid], foreignColumns: [twilioInboundEventsTable.organizationId, twilioInboundEventsTable.messageSid], name: "callie_intake_trigger_fk" }),
  foreignKey({ columns: [t.organizationId, t.appointmentId], foreignColumns: [appointmentsTable.organizationId, appointmentsTable.id], name: "callie_intake_appointment_fk" }),
  check("callie_intake_version_ck", sql`${t.version} > 0`),
  check("callie_intake_state_ck", sql`${t.state} in ('admitted','collecting','awaiting_sms','confirmed','deferred','dispatching','accepted','blocked','indeterminate','resolved','cancelled','booked') and ${t.stage} in ('admitted','service','request','window','consent','complete')`),
  check("callie_intake_choice_ck", sql`(${t.serviceIntent} is null or ${t.serviceIntent} in ('repair','replacement','maintenance','other')) and (${t.requestIntent} is null or ${t.requestIntent} in ('callback','visit')) and (${t.callbackWindow} is null or ${t.callbackWindow} in ('morning','afternoon','any'))`),
  check("callie_intake_steps_ck", sql`jsonb_typeof(${t.stepReceipts}) = 'array' and jsonb_array_length(${t.stepReceipts}) <= 5`),
  check("callie_intake_trigger_ck", sql`(${t.triggerMessageSid} is null and ${t.triggerAccountSid} is null and ${t.triggerFrom} is null and ${t.triggerTo} is null and ${t.triggerPayloadHash} is null and ${t.confirmedAt} is null and ${t.grantExpiresAt} is null) or (${t.triggerMessageSid} is not null and ${t.triggerAccountSid} is not null and ${t.triggerFrom} is not null and ${t.triggerTo} is not null and ${t.triggerPayloadHash} is not null and ${t.confirmedAt} is not null and ${t.grantExpiresAt} is not null and ${t.triggerAccountSid} = ${t.accountSid} and ${t.triggerFrom} = ${t.fromPhone} and ${t.triggerTo} = ${t.calledNumber} and ${t.triggerPayloadHash} ~ '^[a-f0-9]{64}$' and ${t.grantExpiresAt} > ${t.confirmedAt})`),
  check("callie_intake_challenge_ck", sql`(${t.challengeHash} is null and ${t.challengeEncrypted} is null and ${t.challengeExpiresAt} is null) or (${t.challengeHash} is not null and ${t.challengeEncrypted} is not null and ${t.challengeExpiresAt} is not null and ${t.challengeHash} ~ '^[a-f0-9]{64}$')`),
  check("callie_intake_grant_state_ck", sql`${t.state} not in ('confirmed','deferred','dispatching','accepted','indeterminate') or (${t.triggerMessageSid} is not null and ${t.stage} = 'complete')`),
  check("callie_intake_booking_ck", sql`((${t.officeRequestId} is null and ${t.officePayloadHash} is null and ${t.appointmentId} is null) or (${t.officeRequestId} is not null and ${t.officePayloadHash} is not null and ${t.officePayloadHash} ~ '^[a-f0-9]{64}$')) and ((${t.state} = 'booked' and ${t.appointmentId} is not null and ${t.officeRequestId} is not null) or (${t.state} <> 'booked' and ${t.appointmentId} is null))`),
]);

export const callieAckDispatchesTable = pgTable("callie_ack_dispatches", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  intakeId: uuid("intake_id").notNull(),
  callId: uuid("call_id").notNull(),
  policyRevisionId: uuid("policy_revision_id").notNull(),
  triggerMessageSid: text("trigger_message_sid").notNull(),
  receiptId: uuid("receipt_id").notNull(),
  operationKey: text("operation_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  accountSid: text("account_sid").notNull(),
  fromPhone: text("from_phone").notNull(),
  toPhone: text("to_phone").notNull(),
  messagingServiceSid: text("messaging_service_sid").notNull(),
  bodyHash: text("body_hash").notNull(),
  status: text("status").notNull().default("dispatching"),
  providerSid: text("provider_sid"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("callie_ack_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("callie_ack_intake_uq").on(t.organizationId, t.intakeId),
  uniqueIndex("callie_ack_operation_uq").on(t.organizationId, t.operationKey),
  uniqueIndex("callie_ack_sid_uq").on(t.providerSid),
  foreignKey({ columns: [t.organizationId, t.intakeId, t.callId, t.policyRevisionId, t.triggerMessageSid], foreignColumns: [callieIntakesTable.organizationId, callieIntakesTable.id, callieIntakesTable.callId, callieIntakesTable.policyRevisionId, callieIntakesTable.triggerMessageSid], name: "callie_ack_grant_fk" }),
  foreignKey({ columns: [t.organizationId, t.receiptId, t.operationKey], foreignColumns: [revenueExecutionsTable.organizationId, revenueExecutionsTable.id, revenueExecutionsTable.actionKey], name: "callie_ack_receipt_fk" }),
  check("callie_ack_key_ck", sql`${t.operationKey} = 'missed-call-care:' || ${t.callId}::text || ':sms:v1'`),
  check("callie_ack_hash_ck", sql`${t.payloadHash} ~ '^[a-f0-9]{64}$' and ${t.bodyHash} ~ '^[a-f0-9]{64}$'`),
  check("callie_ack_status_ck", sql`${t.status} in ('dispatching','accepted','queued','sending','sent','delivered','undelivered','failed','cancelled','rate_limited','uncertain')`),
]);
