/**
 * Shared request/response contract for per-customer memory and customer
 * context search. Imported by the API routes, the Command Center panel and
 * scripts/customer-memory-api-spec.mjs (OpenAPI projection).
 */
import { z } from "zod/v4";

export const CUSTOMER_MEMORY_KIND_VALUES = ["fact", "preference", "equipment", "access_note", "other"] as const;
export const CUSTOMER_MEMORY_SOURCE_VALUES = ["manual", "lead", "activity", "appointment", "estimate", "invoice"] as const;
export const CUSTOMER_CONTEXT_SOURCE_VALUES = [
  "customer_memory",
  "lead",
  "activity",
  "appointment",
  "estimate",
  "invoice",
] as const;

export const customerMemoryKindLabels: Record<(typeof CUSTOMER_MEMORY_KIND_VALUES)[number], string> = {
  fact: "Fact",
  preference: "Preference",
  equipment: "Equipment",
  access_note: "Access note",
  other: "Other",
};

export const createCustomerMemorySchema = z
  .object({
    kind: z.enum(CUSTOMER_MEMORY_KIND_VALUES),
    content: z.string().trim().min(1).max(1000),
    sourceType: z.enum(CUSTOMER_MEMORY_SOURCE_VALUES).default("manual"),
    sourceId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => (value.sourceType === "manual") === (value.sourceId == null), {
    message: "Manual memories have no source record; noted memories need one.",
  });
export type CreateCustomerMemoryInput = z.input<typeof createCustomerMemorySchema>;

export const customerMemorySchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    contactId: z.uuid(),
    kind: z.enum(CUSTOMER_MEMORY_KIND_VALUES),
    content: z.string(),
    sourceType: z.enum(CUSTOMER_MEMORY_SOURCE_VALUES),
    sourceId: z.uuid().nullable(),
    status: z.enum(["active", "retired"]),
    createdByUserId: z.string(),
    createdAt: z.string(),
    retiredAt: z.string().nullable(),
    retiredByUserId: z.string().nullable(),
  })
  .strict();
export type CustomerMemoryDto = z.infer<typeof customerMemorySchema>;

export const customerMemoryListSchema = z
  .object({
    organizationId: z.uuid(),
    contactId: z.uuid(),
    memories: z.array(customerMemorySchema).max(200),
  })
  .strict();
export type CustomerMemoryList = z.infer<typeof customerMemoryListSchema>;

export const customerContextSearchSchema = z
  .object({
    organizationId: z.uuid(),
    contactId: z.uuid(),
    /** semantic = provider embeddings; lexical_hash = local word hashing; keyword = no provider. */
    mode: z.enum(["semantic", "lexical_hash", "keyword"]),
    results: z
      .array(
        z
          .object({
            sourceType: z.enum(CUSTOMER_CONTEXT_SOURCE_VALUES),
            sourceId: z.uuid(),
            content: z.string(),
            score: z.number(),
            similarity: z.number().nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type CustomerContextSearch = z.infer<typeof customerContextSearchSchema>;

export const reindexRequestSchema = z
  .object({
    afterContactId: z.uuid().nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
