import { sql } from "drizzle-orm";
import { foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { leadsTable, type ImportedOpportunityHistory } from "./leads";
import { contactsTable } from "./contacts";
import { usersTable } from "./auth";

export interface SourceAdoptionSnapshot {
  leadId: string;
  contactId: string;
  importSourceKey: string;
  externalOpportunityId: string;
  importedHistory: ImportedOpportunityHistory;
  sourceSha256: string;
  operationalSha256: string;
  recipient: string;
}

/** Current decision only; every approval/revocation retains its full snapshot in audit_events. */
export const sourceAdoptionsTable = pgTable("source_adoptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  leadId: uuid("lead_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  version: integer("version").notNull(),
  state: text("state").$type<"active" | "revoked">().notNull(),
  snapshot: jsonb("snapshot").$type<SourceAdoptionSnapshot>().notNull(),
  sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
  cutoverAt: timestamp("cutover_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  evidence: text("evidence").notNull(),
  approvedByUserId: varchar("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("source_adoption_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("source_adoption_org_lead_uq").on(t.organizationId, t.leadId),
  foreignKey({ columns: [t.organizationId, t.leadId], foreignColumns: [leadsTable.organizationId, leadsTable.id], name: "source_adoption_lead_fk" }),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "source_adoption_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "source_adoption_actor_fk" }),
]);

export interface SourceOutreachSettings {
  businessName: string;
  mailingAddress: string;
  subject: string;
  body: string;
  timezone: string;
  days: string[];
  startHour: number;
  endHour: number;
  dailyLimit: number;
}
/** Frozen draft -> exact human approval -> optional explicit dispatch, never an auto-enrollment. */
export const sourceOutreachBatchesTable = pgTable("source_outreach_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  version: integer("version").notNull().default(1),
  state: text("state").$type<"draft" | "approved" | "revoked">().notNull().default("draft"),
  settings: jsonb("settings").$type<SourceOutreachSettings>().notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  createdByUserId: varchar("created_by_user_id").notNull(),
  approvedByUserId: varchar("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("source_outreach_batch_org_id_uq").on(t.organizationId, t.id),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "source_outreach_batch_creator_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "source_outreach_batch_approver_fk" }),
]);

export interface SourceOutreachSnapshot {
  version: 1;
  adoptionId: string;
  adoptionVersion: number;
  adoptionSha256: string;
  adoption: SourceAdoptionSnapshot;
  permissionRecordId: string;
  sender: { userId: string; source: "lead_assignee" | "company_default"; provider: "gmail" | "microsoft"; senderEmail: string };
  subject: string;
  body: string;
}
export const sourceOutreachItemsTable = pgTable("source_outreach_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  batchId: uuid("batch_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  adoptionId: uuid("adoption_id").notNull(),
  recipient: text("recipient").notNull(),
  snapshot: jsonb("snapshot").$type<SourceOutreachSnapshot>().notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("source_outreach_item_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("source_outreach_item_batch_lead_uq").on(t.batchId, t.leadId),
  // Reservations survive revoked approval, lost acknowledgement, expiry and reconciliation.
  uniqueIndex("source_outreach_owned_lead_uq").on(t.organizationId, t.leadId).where(sql`${t.claimedAt} is not null`),
  uniqueIndex("source_outreach_owned_recipient_uq").on(t.organizationId, t.recipient).where(sql`${t.claimedAt} is not null`),
  foreignKey({ columns: [t.organizationId, t.batchId], foreignColumns: [sourceOutreachBatchesTable.organizationId, sourceOutreachBatchesTable.id], name: "source_outreach_item_batch_fk" }),
  foreignKey({ columns: [t.organizationId, t.leadId], foreignColumns: [leadsTable.organizationId, leadsTable.id], name: "source_outreach_item_lead_fk" }),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "source_outreach_item_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.adoptionId], foreignColumns: [sourceAdoptionsTable.organizationId, sourceAdoptionsTable.id], name: "source_outreach_item_adoption_fk" }),
]);
