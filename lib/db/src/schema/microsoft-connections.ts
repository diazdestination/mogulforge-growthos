import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";

/** Delegated, per-user mailbox credentials. Tokens are encrypted with org/user AAD. */
export const microsoftConnectionsTable = pgTable(
  "microsoft_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
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
    uniqueIndex("microsoft_connections_org_user_uniq").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

/** A selected provider remains selected on disconnect: never silently fail over. */
export const emailSenderPreferencesTable = pgTable(
  "email_sender_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("email_sender_preferences_org_user_uniq").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export type MicrosoftConnection = typeof microsoftConnectionsTable.$inferSelect;
