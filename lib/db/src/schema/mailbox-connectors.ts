import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";

/** Separate opt-in read credential. Never reused to send or edit a mailbox. */
export const mailboxConnectorsTable = pgTable(
  "mailbox_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull(),
    provider: text("provider").notNull().default("microsoft"),
    connectionId: uuid("connection_id").notNull(),
    connectionRevision: text("connection_revision").notNull(),
    mailboxAccountId: text("mailbox_account_id").notNull(),
    mailboxEmail: text("mailbox_email").notNull(),
    policyVersion: integer("policy_version").notNull().default(1),
    version: integer("version").notNull().default(1),
    state: text("state")
      .$type<"pending" | "active" | "disabled" | "gap" | "revoked">()
      .notNull()
      .default("pending"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    // Folder IDs and opaque continuations are encrypted; no body is retained here.
    encryptedCursors: text("encrypted_cursors"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    // Separate local context permission; changing it preserves service identity.
    leadMonitoringEnabled: boolean("lead_monitoring_enabled")
      .notNull()
      .default(false),
    leadMonitoringVersion: integer("lead_monitoring_version")
      .notNull()
      .default(0),
    leadMonitoringApprovedAt: timestamp("lead_monitoring_approved_at", {
      withTimezone: true,
    }),
    leadMonitoringChangedAt: timestamp("lead_monitoring_changed_at", {
      withTimezone: true,
    }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("mailbox_connectors_org_id_uq").on(t.organizationId, t.id),
    unique("mailbox_connectors_org_user_uq").on(t.organizationId, t.userId),
    foreignKey({
      columns: [t.organizationId, t.userId],
      foreignColumns: [usersTable.organizationId, usersTable.id],
      name: "mailbox_connector_actor_fk",
    }).onDelete("cascade"),
    check(
      "mailbox_connector_state_ck",
      sql`${t.state} in ('pending','active','disabled','gap','revoked') and ${t.provider} = 'microsoft' and ${t.version} > 0 and ${t.policyVersion} = 1`,
    ),
    check(
      "mailbox_connector_active_ck",
      sql`${t.state} <> 'active' or (${t.encryptedRefreshToken} is not null and ${t.encryptedCursors} is not null and ${t.startedAt} is not null)`,
    ),
    index("mailbox_connector_poll_idx").on(t.state, t.lastSuccessAt),
    check(
      "mailbox_connector_lead_monitoring_ck",
      sql`${t.leadMonitoringVersion} >= 0 and (not ${t.leadMonitoringEnabled} or (${t.leadMonitoringVersion} > 0 and ${t.leadMonitoringApprovedAt} is not null and ${t.leadMonitoringChangedAt} is not null))`,
    ),
  ],
);

/** Permanent content digests survive raw-body purge; changed redelivery is held. */
export const mailboxReceiptsTable = pgTable(
  "mailbox_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id").notNull(),
    connectorVersion: integer("connector_version").notNull(),
    folder: text("folder").$type<"inbox" | "sentitems">().notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    state: text("state")
      .$type<"processed" | "ignored" | "review" | "pending">()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("mailbox_receipt_identity_uq").on(
      t.organizationId,
      t.connectorId,
      t.folder,
      t.providerMessageId,
    ),
    foreignKey({
      columns: [t.organizationId, t.connectorId],
      foreignColumns: [
        mailboxConnectorsTable.organizationId,
        mailboxConnectorsTable.id,
      ],
      name: "mailbox_receipt_connector_fk",
    }).onDelete("cascade"),
    check(
      "mailbox_receipt_state_ck",
      sql`${t.state} in ('processed','ignored','review','pending') and ${t.folder} in ('inbox','sentitems') and ${t.connectorVersion} > 0 and ${t.attempts} >= 0 and ${t.contentSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export type MailboxConnector = typeof mailboxConnectorsTable.$inferSelect;
