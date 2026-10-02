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

import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { contactsTable } from "./contacts";
import { activitiesTable } from "./activities";

export type EmailIntelligenceSourceStatus = "pending" | "active" | "paused" | "error";
export type EmailIntelligenceMessageStatus = "processed" | "raw_purged";
export type EmailIntelligenceFactKind =
  | "estimate_request"
  | "follow_up_commitment"
  | "price_objection"
  | "buying_signal"
  | "complaint"
  | "appointment_risk";
export type EmailIntelligenceFactStatus = "needs_review" | "verified" | "rejected";

/** Organization-owned intake configuration. No provider credential is stored here. */
export const emailIntelligenceSourcesTable = pgTable(
  "email_intelligence_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    intakeAlias: text("intake_alias").notNull(),
    displayName: text("display_name").notNull().default("Email Intelligence Inbox"),
    status: text("status").$type<EmailIntelligenceSourceStatus>().notNull().default("pending"),
    allowedForwarders: text("allowed_forwarders").array().notNull().default([]),
    retentionDays: integer("retention_days").notNull().default(7),
    attachmentsEnabled: boolean("attachments_enabled").notNull().default(false),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
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
    uniqueIndex("email_intelligence_sources_org_uniq").on(table.organizationId),
    uniqueIndex("email_intelligence_sources_alias_uniq").on(table.intakeAlias),
  ],
);

/**
 * Raw message text is encrypted by the application before insert. Redacted
 * evidence is stored separately in facts and remains reviewable after purge.
 */
export const emailIntelligenceMessagesTable = pgTable(
  "email_intelligence_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => emailIntelligenceSourcesTable.id, { onDelete: "cascade" }),
    externalMessageId: text("external_message_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    forwardedBy: text("forwarded_by").notNull(),
    fromEmail: text("from_email").notNull(),
    toEmails: text("to_emails").array().notNull().default([]),
    redactedSubject: text("redacted_subject").notNull(),
    encryptedRawText: text("encrypted_raw_text"),
    status: text("status").$type<EmailIntelligenceMessageStatus>().notNull().default("processed"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    rawExpiresAt: timestamp("raw_expires_at", { withTimezone: true }).notNull(),
    rawPurgedAt: timestamp("raw_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("email_intelligence_messages_source_external_uniq").on(
      table.sourceId,
      table.externalMessageId,
    ),
    index("email_intelligence_messages_org_received_idx").on(
      table.organizationId,
      table.receivedAt,
    ),
    index("email_intelligence_messages_raw_expiry_idx").on(table.rawExpiresAt),
  ],
);

/** Deterministic beta facts. Every fact requires human disposition. */
export const emailIntelligenceFactsTable = pgTable(
  "email_intelligence_facts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => emailIntelligenceSourcesTable.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => emailIntelligenceMessagesTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<EmailIntelligenceFactKind>().notNull(),
    status: text("status").$type<EmailIntelligenceFactStatus>().notNull().default("needs_review"),
    statement: text("statement").notNull(),
    evidenceExcerpt: text("evidence_excerpt").notNull(),
    confidence: integer("confidence").notNull(),
    extractorVersion: text("extractor_version").notNull().default("deterministic-v1"),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("email_intelligence_facts_org_status_idx").on(table.organizationId, table.status),
    index("email_intelligence_facts_org_message_idx").on(table.organizationId, table.messageId),
  ],
);

export type EmailIntelligenceSource = typeof emailIntelligenceSourcesTable.$inferSelect;
export type EmailIntelligenceMessage = typeof emailIntelligenceMessagesTable.$inferSelect;
export type EmailIntelligenceFact = typeof emailIntelligenceFactsTable.$inferSelect;

/** Minimal durable reply evidence. Raw-content deletion must not release a hold. */
export const emailResponseReviewsTable = pgTable("email_response_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  sourceId: uuid("source_id").notNull().references(() => emailIntelligenceSourcesTable.id),
  messageId: uuid("message_id").references(() => emailIntelligenceMessagesTable.id, { onDelete: "set null" }),
  externalMessageId: text("external_message_id").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  state: text("state").$type<"needs_review" | "confirmed" | "dismissed">().notNull().default("needs_review"),
  reason: text("reason").notNull(),
  leadId: uuid("lead_id").references(() => leadsTable.id),
  contactId: uuid("contact_id").references(() => contactsTable.id),
  outboundActivityId: uuid("outbound_activity_id").references(() => activitiesTable.id, { onDelete: "set null" }),
  replyAt: timestamp("reply_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  holdActive: boolean("hold_active").notNull().default(false),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => usersTable.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
  effectSummary: jsonb("effect_summary").$type<{ pausedEnrollments: number; cancelledActions: number; blockedProposals: number; reconciliationRequired: number }>(),
  releasedByUserId: varchar("released_by_user_id").references(() => usersTable.id),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releaseNote: text("release_note"),
}, (table) => [
  uniqueIndex("email_response_source_external_uniq").on(table.sourceId, table.externalMessageId),
  index("email_response_org_review_idx").on(table.organizationId, table.state, table.receivedAt),
  index("email_response_org_lead_hold_idx").on(table.organizationId, table.leadId, table.holdActive),
]);
export type EmailResponseReview = typeof emailResponseReviewsTable.$inferSelect;
