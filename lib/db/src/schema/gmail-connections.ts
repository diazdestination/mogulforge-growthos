import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  boolean,
} from "drizzle-orm/pg-core";

import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";

/**
 * Per-user Gmail authorization. Token values are application-encrypted before
 * they reach this table; plaintext OAuth credentials must never be persisted.
 */
export const gmailConnectionsTable = pgTable(
  "gmail_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_connections_org_user_uniq").on(
      table.organizationId,
      table.userId,
    ),
    index("gmail_connections_org_email_idx").on(
      table.organizationId,
      table.email,
    ),
  ],
);

/** Short-lived, single-use OAuth transactions prevent login-CSRF and replay. */
export const oauthTransactionsTable = pgTable(
  "oauth_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    module: text("module").notNull().default("gmail_send"),
    requestedScopes: text("requested_scopes").array().notNull().default([]),
    stateHash: text("state_hash").notNull(),
    encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
    returnPath: text("return_path").notNull().default("/settings"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_transactions_state_hash_uniq").on(table.stateHash),
    index("oauth_transactions_expiry_idx").on(table.expiresAt),
  ],
);

export type GmailConnection = typeof gmailConnectionsTable.$inferSelect;

/** User-controlled module switches over one incrementally-authorized account. */
export const googleIntegrationModulesTable = pgTable(
  "google_integration_modules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastCursor: text("last_cursor"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("google_integration_modules_org_user_module_uniq").on(
      table.organizationId,
      table.userId,
      table.module,
    ),
    index("google_integration_modules_org_enabled_idx").on(
      table.organizationId,
      table.enabled,
    ),
  ],
);
