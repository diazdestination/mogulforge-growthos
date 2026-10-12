-- REVIEW ONLY. After 0018; baseline 87adc3eb21599e84aedcf3a9719b9e996f84f8e0. No hosted/schema approval.
-- Requires the pgvector extension. Enabling it on a hosted database is a separate owner/provider approval.
-- Two additive tables: derived retrieval chunks (rebuildable) and staff-authored customer memories. No DML or backfill.
-- All 142 prior table definitions are unchanged. Current source totals 144.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE "customer_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_user_id" varchar,
	CONSTRAINT "customer_memories_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "customer_memories_kind_ck" CHECK ("customer_memories"."kind" in ('fact', 'preference', 'equipment', 'access_note', 'other')),
	CONSTRAINT "customer_memories_source_ck" CHECK (("customer_memories"."source_type" = 'manual' and "customer_memories"."source_id" is null) or ("customer_memories"."source_type" in ('lead', 'activity', 'appointment', 'estimate', 'invoice') and "customer_memories"."source_id" is not null)),
	CONSTRAINT "customer_memories_content_ck" CHECK (char_length(btrim("customer_memories"."content")) between 1 and 1000),
	CONSTRAINT "customer_memories_status_ck" CHECK (("customer_memories"."status" = 'active' and "customer_memories"."retired_at" is null and "customer_memories"."retired_by_user_id" is null) or ("customer_memories"."status" = 'retired' and "customer_memories"."retired_at" is not null and "customer_memories"."retired_by_user_id" is not null))
);
CREATE TABLE "retrieval_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"contact_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_chunks_source_uq" UNIQUE("organization_id","source_type","source_id","embedding_model"),
	CONSTRAINT "retrieval_chunks_scope_ck" CHECK (("retrieval_chunks"."scope" = 'knowledge' and "retrieval_chunks"."contact_id" is null and "retrieval_chunks"."source_type" = 'knowledge_entry') or ("retrieval_chunks"."scope" = 'customer' and "retrieval_chunks"."contact_id" is not null and "retrieval_chunks"."source_type" <> 'knowledge_entry')),
	CONSTRAINT "retrieval_chunks_source_type_ck" CHECK ("retrieval_chunks"."source_type" in ('knowledge_entry', 'customer_memory', 'lead', 'activity', 'appointment', 'estimate', 'invoice')),
	CONSTRAINT "retrieval_chunks_value_ck" CHECK ("retrieval_chunks"."content_sha256" ~ '^[a-f0-9]{64}$' and char_length("retrieval_chunks"."content") between 1 and 8000 and char_length("retrieval_chunks"."embedding_model") between 1 and 100)
);
ALTER TABLE "customer_memories" ADD CONSTRAINT "customer_memories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "customer_memories" ADD CONSTRAINT "customer_memories_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "customer_memories" ADD CONSTRAINT "customer_memories_creator_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_memories" ADD CONSTRAINT "customer_memories_retirer_fk" FOREIGN KEY ("organization_id","retired_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "customer_memories_contact_idx" ON "customer_memories" USING btree ("organization_id","contact_id","status","created_at");
CREATE INDEX "retrieval_chunks_lookup_idx" ON "retrieval_chunks" USING btree ("organization_id","scope","contact_id","embedding_model");
CREATE INDEX "retrieval_chunks_embedding_hnsw_idx" ON "retrieval_chunks" USING hnsw ("embedding" vector_cosine_ops);
