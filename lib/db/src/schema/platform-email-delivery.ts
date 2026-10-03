import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { identityTokensTable } from "./identity-tokens";
import { organizationsTable } from "./organizations";
import { staffInvitationsTable } from "./staff-invitations";

export type PlatformEmailPurpose = "email_verification" | "password_reset" | "staff_invitation";
export type PlatformEmailOutcome = "claimed" | "accepted" | "rejected" | "unknown" | "not_attempted";

/** Retained logical ownership, never an email queue. No token, action URL, body or recipient plaintext. */
export const platformEmailDispatchesTable = pgTable("platform_email_dispatches", {
  id: uuid("id").defaultRandom().primaryKey(),
  logicalKey: text("logical_key").notNull().unique(),
  purpose: text("purpose").$type<PlatformEmailPurpose>().notNull(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  identityTokenId: uuid("identity_token_id").references(() => identityTokensTable.id, { onDelete: "set null" }),
  invitationId: uuid("invitation_id"),
  // Immutable record identity survives deletion of an identity token/user.
  sourceRecordId: uuid("source_record_id").notNull(),
  sourceRevision: text("source_revision").notNull(),
  recipientHash: varchar("recipient_hash", { length: 64 }).notNull(),
  senderMailbox: text("sender_mailbox").notNull(),
  providerContext: varchar("provider_context", { length: 64 }).notNull(),
  fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  outcome: text("outcome").$type<PlatformEmailOutcome>().notNull().default("claimed"),
  outcomeCode: text("outcome_code"),
  providerMessageId: uuid("provider_message_id"),
  httpStatus: integer("http_status"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [
  foreignKey({ name: "platform_email_invitation_org_fk", columns: [table.organizationId, table.invitationId], foreignColumns: [staffInvitationsTable.organizationId, staffInvitationsTable.id] }),
  unique("platform_email_provider_receipt_uq").on(table.providerContext, table.providerMessageId),
  index("platform_email_dispatch_org_idx").on(table.organizationId, table.claimedAt),
  index("platform_email_dispatch_user_idx").on(table.userId, table.claimedAt),
  check("platform_email_purpose_valid", sql`${table.purpose} in ('email_verification','password_reset','staff_invitation')`),
  check("platform_email_outcome_valid", sql`${table.outcome} in ('claimed','accepted','rejected','unknown','not_attempted')`),
  check("platform_email_invitation_bound", sql`${table.purpose} <> 'staff_invitation' or (${table.organizationId} is not null and ${table.invitationId} is not null)`),
  check("platform_email_receipt_valid", sql`(${table.outcome} = 'accepted') = (${table.providerMessageId} is not null)`),
  check("platform_email_http_status_valid", sql`${table.httpStatus} is null or ${table.httpStatus} between 100 and 599`),
]);

/** Authenticated callback evidence is append-only. Changed payloads retain both records and require review. */
export const platformEmailEventsTable = pgTable("platform_email_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerContext: varchar("provider_context", { length: 64 }).notNull(),
  providerMessageId: uuid("provider_message_id").notNull(),
  eventId: varchar("event_id", { length: 200 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  recipientHash: varchar("recipient_hash", { length: 64 }).notNull(),
  senderMailbox: text("sender_mailbox").notNull(),
  signal: text("signal").$type<"sent" | "delivered" | "delayed" | "failed" | "bounced" | "complained">().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("platform_email_event_payload_uq").on(table.providerContext, table.eventId, table.payloadHash),
  index("platform_email_event_parent_idx").on(table.providerContext, table.providerMessageId),
  check("platform_email_signal_valid", sql`${table.signal} in ('sent','delivered','delayed','failed','bounced','complained')`),
]);

export type PlatformEmailDispatch = typeof platformEmailDispatchesTable.$inferSelect;
export type PlatformEmailEvent = typeof platformEmailEventsTable.$inferSelect;
