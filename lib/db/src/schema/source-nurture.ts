import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { leadsTable } from "./leads";
import { contactsTable } from "./contacts";
import { propertiesTable } from "./properties";
import { auditEventsTable } from "./audit";
import { scheduledActionsTable } from "./automations";
import { sourceAdoptionsTable, type SourceAdoptionSnapshot } from "./source-adoption";

export interface NurtureMailboxIdentity {
  organizationId: string; senderUserId: string; provider: "microsoft";
  connectionId: string; connectionRevision: string; mailboxAccountId: string; mailboxEmail: string;
  connectorId: string; connectorVersion: number; policyVersion: 1; startedAt: string;
}
export interface SourceNurtureSettings {
  businessName: string; mailingAddress: string; steps: [{ subject: string; body: string }, { subject: string; body: string }];
  timezone: string; days: string[]; startHour: number; endHour: number; dailyLimit: number;
}
export interface SourceNurtureItemSnapshot {
  version: 1; adoptionId: string; adoptionVersion: number; adoptionSha256: string; adoption: SourceAdoptionSnapshot;
  permissionRecordId: string; ownerUserId: string; propertyId: string | null; leadCreatedAt: string;
  sender: { userId: string; source: "lead_assignee" | "company_default"; provider: "microsoft"; senderEmail: string };
  mailboxIdentity: NurtureMailboxIdentity; nurtureMonitoringApproval: { version: number; approvedAt: string };
}
export const sourceNurturePlansTable = pgTable("source_nurture_plans", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  version: integer("version").notNull().default(1), state: text("state").$type<"draft" | "approved" | "running" | "stopped" | "finished" | "expired">().notNull().default("draft"),
  settings: jsonb("settings").$type<SourceNurtureSettings>().notNull(), payloadSha256: text("payload_sha256").notNull(),
  reviewId: uuid("review_id").notNull(), createdByUserId: varchar("created_by_user_id").notNull(), approvedByUserId: varchar("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }), previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }).notNull(),
  startNotBefore: timestamp("start_not_before", { withTimezone: true }).notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  startRequestId: uuid("start_request_id"), startPayloadHash: text("start_payload_hash"), startedAt: timestamp("started_at", { withTimezone: true }),
  stopRequestId: uuid("stop_request_id"), stopPayloadHash: text("stop_payload_hash"), stoppedAt: timestamp("stopped_at", { withTimezone: true }), stopReason: text("stop_reason"),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(), lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }), lastCode: text("last_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("source_nurture_plan_org_id_uq").on(t.organizationId, t.id),
  unique("source_nurture_plan_review_uq").on(t.organizationId, t.reviewId),
  uniqueIndex("source_nurture_start_request_uq").on(t.organizationId, t.startRequestId), uniqueIndex("source_nurture_stop_request_uq").on(t.organizationId, t.stopRequestId),
  index("source_nurture_plan_check_idx").on(t.state, t.nextCheckAt),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "source_nurture_creator_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "source_nurture_approver_fk" }),
  foreignKey({ columns: [t.organizationId, t.reviewId], foreignColumns: [auditEventsTable.organizationId, auditEventsTable.id], name: "source_nurture_review_fk" }),
  check("source_nurture_plan_state_ck", sql`${t.state} in ('draft','approved','running','stopped','finished','expired') and ${t.version} > 0`),
  check("source_nurture_plan_dates_ck", sql`${t.startNotBefore} < ${t.expiresAt} and ${t.expiresAt} <= ${t.createdAt} + interval '14 days'`),
  check("source_nurture_plan_start_ck", sql`(${t.startedAt} is null and ${t.startRequestId} is null and ${t.startPayloadHash} is null) or (${t.startedAt} is not null and ${t.startRequestId} is not null and ${t.startPayloadHash} is not null)`),
]);
export const sourceNurtureItemsTable = pgTable("source_nurture_items", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id), planId: uuid("plan_id").notNull(),
  leadId: uuid("lead_id").notNull(), contactId: uuid("contact_id").notNull(), propertyId: uuid("property_id"), ownerUserId: varchar("owner_user_id").notNull(),
  adoptionId: uuid("adoption_id").notNull(), recipient: text("recipient").notNull(), snapshot: jsonb("snapshot").$type<SourceNurtureItemSnapshot>().notNull(),
  admittedAt: timestamp("admitted_at", { withTimezone: true }), stoppedAt: timestamp("stopped_at", { withTimezone: true }), stopReason: text("stop_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("source_nurture_item_org_id_uq").on(t.organizationId, t.id), unique("source_nurture_item_context_uq").on(t.organizationId, t.id, t.planId, t.leadId, t.contactId),
  unique("source_nurture_item_plan_lead_uq").on(t.planId, t.leadId), unique("source_nurture_item_plan_address_uq").on(t.planId, t.recipient),
  uniqueIndex("source_nurture_owned_lead_uq").on(t.organizationId, t.leadId).where(sql`${t.admittedAt} is not null`),
  uniqueIndex("source_nurture_owned_address_uq").on(t.organizationId, t.recipient).where(sql`${t.admittedAt} is not null`),
  foreignKey({ columns: [t.organizationId, t.planId], foreignColumns: [sourceNurturePlansTable.organizationId, sourceNurturePlansTable.id], name: "source_nurture_item_plan_fk" }),
  foreignKey({ columns: [t.organizationId, t.leadId], foreignColumns: [leadsTable.organizationId, leadsTable.id], name: "source_nurture_item_lead_fk" }),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "source_nurture_item_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.propertyId], foreignColumns: [propertiesTable.organizationId, propertiesTable.id], name: "source_nurture_item_property_fk" }),
  foreignKey({ columns: [t.organizationId, t.ownerUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "source_nurture_item_owner_fk" }),
  foreignKey({ columns: [t.organizationId, t.adoptionId], foreignColumns: [sourceAdoptionsTable.organizationId, sourceAdoptionsTable.id], name: "source_nurture_item_adoption_fk" }),
  check("source_nurture_address_ck", sql`${t.recipient} = lower(btrim(${t.recipient})) and length(${t.recipient}) > 3`),
]);
export const sourceNurtureStepsTable = pgTable("source_nurture_steps", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id), planId: uuid("plan_id").notNull(), itemId: uuid("item_id").notNull(),
  leadId: uuid("lead_id").notNull(), contactId: uuid("contact_id").notNull(), stepIndex: integer("step_index").$type<1 | 2>().notNull(), predecessorId: uuid("predecessor_id"),
  scheduledActionId: uuid("scheduled_action_id"), subject: text("subject").notNull(), body: text("body").notNull(), messageHash: text("message_hash").notNull(),
  notBefore: timestamp("not_before", { withTimezone: true }), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), claimedAt: timestamp("claimed_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }), acceptanceAuditId: uuid("acceptance_audit_id"), cancelledAt: timestamp("cancelled_at", { withTimezone: true }), reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("source_nurture_step_org_id_uq").on(t.organizationId, t.id), unique("source_nurture_step_parent_context_uq").on(t.organizationId, t.id, t.leadId, t.contactId),
  unique("source_nurture_step_item_context_uq").on(t.organizationId, t.itemId, t.id), unique("source_nurture_step_index_uq").on(t.itemId, t.stepIndex),
  unique("source_nurture_step_action_uq").on(t.organizationId, t.scheduledActionId),
  foreignKey({ columns: [t.organizationId, t.itemId, t.planId, t.leadId, t.contactId], foreignColumns: [sourceNurtureItemsTable.organizationId, sourceNurtureItemsTable.id, sourceNurtureItemsTable.planId, sourceNurtureItemsTable.leadId, sourceNurtureItemsTable.contactId], name: "source_nurture_step_item_fk" }),
  foreignKey({ columns: [t.organizationId, t.itemId, t.predecessorId], foreignColumns: [t.organizationId, t.itemId, t.id], name: "source_nurture_step_previous_fk" }),
  foreignKey({ columns: [t.organizationId, t.scheduledActionId], foreignColumns: [scheduledActionsTable.organizationId, scheduledActionsTable.id], name: "source_nurture_step_action_fk" }),
  foreignKey({ columns: [t.organizationId, t.acceptanceAuditId], foreignColumns: [auditEventsTable.organizationId, auditEventsTable.id], name: "source_nurture_acceptance_fk" }),
  check("source_nurture_step_number_ck", sql`(${t.stepIndex} = 1 and ${t.predecessorId} is null) or (${t.stepIndex} = 2 and ${t.predecessorId} is not null and ${t.predecessorId} <> ${t.id})`),
  check("source_nurture_step_acceptance_ck", sql`(${t.acceptedAt} is null and ${t.acceptanceAuditId} is null) or (${t.acceptedAt} is not null and ${t.acceptanceAuditId} is not null and ${t.claimedAt} is not null)`),
]);
