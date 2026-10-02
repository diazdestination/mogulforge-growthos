import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { usersTable } from "./auth";

/**
 * One-time identity actions. Only a SHA-256 digest is stored so a database
 * reader cannot use a reset/verification token. Rows are retained after use
 * for bounded security evidence and are deleted with their user.
 */
export const identityTokensTable = pgTable(
  "identity_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    tokenDigest: varchar("token_digest", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("identity_tokens_user_purpose_idx").on(table.userId, table.purpose),
    index("identity_tokens_expires_idx").on(table.expiresAt),
  ],
);

export type IdentityToken = typeof identityTokensTable.$inferSelect;
