/**
 * Retrieval layer (pgvector) and per-customer memory.
 *
 * `retrieval_chunks` is DERIVED data: redacted text plus its embedding for
 * one source record (a knowledge entry, a customer-history record or a
 * customer memory). It can always be rebuilt from the source tables, so it
 * cascades with its company/customer and is never the system of record.
 *
 * `customer_memories` is staff-authored, human-reviewable customer context
 * ("prefers morning visits", "gate code is with the office"). Retiring a
 * memory keeps the row for provenance and removes it from retrieval.
 *
 * Requires the PostgreSQL `vector` extension (pgvector) to exist before the
 * schema is applied: see lib/db/ensure-extensions.mjs.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

import { usersTable } from "./auth";
import { contactsTable } from "./contacts";
import { organizationsTable } from "./organizations";

/** Fixed embedding width: OpenAI text-embedding-3-* requested at 1536 dims and the local hash embedder. */
export const RETRIEVAL_EMBEDDING_DIMENSIONS = 1536;

export const RETRIEVAL_SCOPES = ["knowledge", "customer"] as const;
export type RetrievalScope = (typeof RETRIEVAL_SCOPES)[number];

/** Source records that can be indexed. Knowledge scope only uses `knowledge_entry`. */
export const RETRIEVAL_SOURCE_TYPES = [
  "knowledge_entry",
  "customer_memory",
  "lead",
  "activity",
  "appointment",
  "estimate",
  "invoice",
] as const;
export type RetrievalSourceType = (typeof RETRIEVAL_SOURCE_TYPES)[number];

export const CUSTOMER_MEMORY_KINDS = ["fact", "preference", "equipment", "access_note", "other"] as const;
export type CustomerMemoryKind = (typeof CUSTOMER_MEMORY_KINDS)[number];

/** Where a memory came from: typed by staff, or noted from one history record. */
export const CUSTOMER_MEMORY_SOURCES = ["manual", "lead", "activity", "appointment", "estimate", "invoice"] as const;
export type CustomerMemorySource = (typeof CUSTOMER_MEMORY_SOURCES)[number];

export const CUSTOMER_MEMORY_MAX_LENGTH = 1000;

export const retrievalChunksTable = pgTable(
  "retrieval_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    scope: text("scope").$type<RetrievalScope>().notNull(),
    contactId: uuid("contact_id"),
    sourceType: text("source_type").$type<RetrievalSourceType>().notNull(),
    sourceId: uuid("source_id").notNull(),
    /** Redacted text that was embedded. Never raw email/phone/SSN/policy identifiers. */
    content: text("content").notNull(),
    contentSha256: text("content_sha256").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embedding: vector("embedding", { dimensions: RETRIEVAL_EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("retrieval_chunks_source_uq").on(t.organizationId, t.sourceType, t.sourceId, t.embeddingModel),
    foreignKey({
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contactsTable.organizationId, contactsTable.id],
      name: "retrieval_chunks_contact_fk",
    }).onDelete("cascade"),
    check(
      "retrieval_chunks_scope_ck",
      sql`(${t.scope} = 'knowledge' and ${t.contactId} is null and ${t.sourceType} = 'knowledge_entry') or (${t.scope} = 'customer' and ${t.contactId} is not null and ${t.sourceType} <> 'knowledge_entry')`,
    ),
    check(
      "retrieval_chunks_source_type_ck",
      sql`${t.sourceType} in ('knowledge_entry', 'customer_memory', 'lead', 'activity', 'appointment', 'estimate', 'invoice')`,
    ),
    check(
      "retrieval_chunks_value_ck",
      sql`${t.contentSha256} ~ '^[a-f0-9]{64}$' and char_length(${t.content}) between 1 and 8000 and char_length(${t.embeddingModel}) between 1 and 100`,
    ),
    index("retrieval_chunks_lookup_idx").on(t.organizationId, t.scope, t.contactId, t.embeddingModel),
    index("retrieval_chunks_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const customerMemoriesTable = pgTable(
  "customer_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull(),
    kind: text("kind").$type<CustomerMemoryKind>().notNull(),
    content: text("content").notNull(),
    sourceType: text("source_type").$type<CustomerMemorySource>().notNull().default("manual"),
    sourceId: uuid("source_id"),
    status: text("status").$type<"active" | "retired">().notNull().default("active"),
    createdByUserId: varchar("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByUserId: varchar("retired_by_user_id"),
  },
  (t) => [
    unique("customer_memories_org_id_uq").on(t.organizationId, t.id),
    foreignKey({
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contactsTable.organizationId, contactsTable.id],
      name: "customer_memories_contact_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.createdByUserId],
      foreignColumns: [usersTable.organizationId, usersTable.id],
      name: "customer_memories_creator_fk",
    }),
    foreignKey({
      columns: [t.organizationId, t.retiredByUserId],
      foreignColumns: [usersTable.organizationId, usersTable.id],
      name: "customer_memories_retirer_fk",
    }),
    check("customer_memories_kind_ck", sql`${t.kind} in ('fact', 'preference', 'equipment', 'access_note', 'other')`),
    check(
      "customer_memories_source_ck",
      sql`(${t.sourceType} = 'manual' and ${t.sourceId} is null) or (${t.sourceType} in ('lead', 'activity', 'appointment', 'estimate', 'invoice') and ${t.sourceId} is not null)`,
    ),
    check("customer_memories_content_ck", sql`char_length(btrim(${t.content})) between 1 and 1000`),
    check(
      "customer_memories_status_ck",
      sql`(${t.status} = 'active' and ${t.retiredAt} is null and ${t.retiredByUserId} is null) or (${t.status} = 'retired' and ${t.retiredAt} is not null and ${t.retiredByUserId} is not null)`,
    ),
    index("customer_memories_contact_idx").on(t.organizationId, t.contactId, t.status, t.createdAt),
  ],
);

export type RetrievalChunk = typeof retrievalChunksTable.$inferSelect;
export type CustomerMemory = typeof customerMemoriesTable.$inferSelect;
