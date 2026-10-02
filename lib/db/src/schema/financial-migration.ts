import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { invoicesTable } from "./invoices";
import { valueEntriesTable } from "./revenue-workspace";

/** Private, actor-bound review. No raw file, provider identity or inferred cash. */
export const financialMigrationReviewsTable = pgTable(
  "financial_migration_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    actorUserId: varchar("actor_user_id")
      .notNull()
      .references(() => usersTable.id),
    rawSha256: text("raw_sha256").notNull(),
    digest: text("digest").notNull(),
    contextDigest: text("context_digest").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: text("state")
      .$type<"review" | "committed">()
      .notNull()
      .default("review"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("financial_review_org_id").on(t.organizationId, t.id),
    foreignKey({
      columns: [t.organizationId, t.actorUserId],
      foreignColumns: [usersTable.organizationId, usersTable.id],
      name: "financial_review_actor_tenant",
    }),
    index("financial_review_org_created").on(t.organizationId, t.createdAt),
    check(
      "financial_review_state_valid",
      sql`${t.state} in ('review', 'committed')`,
    ),
    check(
      "financial_review_commit_present",
      sql`(${t.state} = 'review' and ${t.result} is null and ${t.committedAt} is null) or (${t.state} = 'committed' and ${t.result} is not null and ${t.committedAt} is not null)`,
    ),
  ],
);

/** Immutable source identities, independent of files, approvals and request IDs. */
export const financialMigrationItemsTable = pgTable(
  "financial_migration_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => financialMigrationReviewsTable.id),
    sourceSystem: text("source_system").notNull(),
    sourceAccount: text("source_account").notNull(),
    entityType: text("entity_type").$type<"invoice" | "receipt">().notNull(),
    externalId: text("external_id").notNull(),
    digest: text("digest").notNull(),
    invoiceId: uuid("invoice_id").references(() => invoicesTable.id),
    valueEntryId: uuid("value_entry_id").references(() => valueEntriesTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.reviewId],
      foreignColumns: [
        financialMigrationReviewsTable.organizationId,
        financialMigrationReviewsTable.id,
      ],
      name: "financial_item_review_tenant",
    }),
    foreignKey({
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoicesTable.organizationId, invoicesTable.id],
      name: "financial_item_invoice_tenant",
    }),
    foreignKey({
      columns: [t.organizationId, t.valueEntryId],
      foreignColumns: [valueEntriesTable.organizationId, valueEntriesTable.id],
      name: "financial_item_value_tenant",
    }),
    uniqueIndex("financial_item_source_unique").on(
      t.organizationId,
      t.sourceSystem,
      t.sourceAccount,
      t.entityType,
      t.externalId,
    ),
    check(
      "financial_item_target_valid",
      sql`(${t.entityType} = 'invoice' and ${t.invoiceId} is not null and ${t.valueEntryId} is null) or (${t.entityType} = 'receipt' and ${t.invoiceId} is null and ${t.valueEntryId} is not null)`,
    ),
  ],
);
