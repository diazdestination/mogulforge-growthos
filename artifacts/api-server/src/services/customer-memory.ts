/**
 * Per-customer memory: short, staff-authored notes that should travel with a
 * customer ("prefers text over calls", "dog in backyard — call first").
 *
 * Deterministic rules only: tenant + contact checks are SQL filters, provenance
 * links are verified against the same customer, and retirement is a recorded
 * human decision (the row stays for provenance; its retrieval chunk is removed
 * in the same transaction). Indexing a new memory is best-effort.
 */
import {
  activitiesTable,
  appointmentsTable,
  contactsTable,
  customerMemoriesTable,
  customerWorkRootsTable,
  db,
  estimatesTable,
  invoicesTable,
  leadsTable,
  type CustomerMemory,
} from "@workspace/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";

import type { CreateCustomerMemoryInput, CustomerMemoryDto } from "./customer-memory-contract";
import { createCustomerMemorySchema } from "./customer-memory-contract";
import { tryGetEmbeddingProvider } from "./embeddings";
import { logIndexFailure, prepareDocument, removeChunks, upsertChunks, type IndexStatus } from "./retrieval-index";

export class CustomerMemoryError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code:
      | "customer_not_found"
      | "memory_invalid"
      | "memory_source_not_found"
      | "memory_not_found"
      | "memory_already_retired",
  ) {
    super(code);
    this.name = "CustomerMemoryError";
  }
}

export const MAX_LISTED_MEMORIES = 200;

export function toCustomerMemoryDto(row: CustomerMemory): CustomerMemoryDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    contactId: row.contactId,
    kind: row.kind,
    content: row.content,
    sourceType: row.sourceType,
    sourceId: row.sourceId ?? null,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    retiredByUserId: row.retiredByUserId ?? null,
  };
}

async function contactExists(organizationId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, contactId)));
  return Boolean(row);
}

/** True only when the cited record belongs to this organization AND this customer. */
export async function customerOwnsSource(
  organizationId: string,
  contactId: string,
  sourceType: Exclude<CustomerMemoryDto["sourceType"], "manual">,
  sourceId: string,
): Promise<boolean> {
  const leadIds = (
    await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.contactId, contactId)))
  ).map((row) => row.id);
  const rootIds = (
    await db
      .select({ id: customerWorkRootsTable.id })
      .from(customerWorkRootsTable)
      .where(and(eq(customerWorkRootsTable.organizationId, organizationId), eq(customerWorkRootsTable.contactId, contactId)))
  ).map((row) => row.id);
  const viaLead = <T>(column: T) => (leadIds.length ? inArray(column as never, leadIds) : undefined);
  const viaRoot = <T>(column: T) => (rootIds.length ? inArray(column as never, rootIds) : undefined);
  switch (sourceType) {
    case "lead":
      return leadIds.includes(sourceId);
    case "activity": {
      const [row] = await db
        .select({ id: activitiesTable.id })
        .from(activitiesTable)
        .where(
          and(
            eq(activitiesTable.organizationId, organizationId),
            eq(activitiesTable.id, sourceId),
            or(eq(activitiesTable.contactId, contactId), viaLead(activitiesTable.leadId)),
          ),
        );
      return Boolean(row);
    }
    case "appointment": {
      const [row] = await db
        .select({ id: appointmentsTable.id })
        .from(appointmentsTable)
        .where(
          and(
            eq(appointmentsTable.organizationId, organizationId),
            eq(appointmentsTable.id, sourceId),
            or(eq(appointmentsTable.contactId, contactId), viaLead(appointmentsTable.leadId)),
          ),
        );
      return Boolean(row);
    }
    case "estimate": {
      const scope = or(viaLead(estimatesTable.leadId), viaRoot(estimatesTable.customerWorkId));
      if (!scope) return false;
      const [row] = await db
        .select({ id: estimatesTable.id })
        .from(estimatesTable)
        .where(and(eq(estimatesTable.organizationId, organizationId), eq(estimatesTable.id, sourceId), scope));
      return Boolean(row);
    }
    case "invoice": {
      const scope = or(viaLead(invoicesTable.leadId), viaRoot(invoicesTable.customerWorkId));
      if (!scope) return false;
      const [row] = await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.organizationId, organizationId), eq(invoicesTable.id, sourceId), scope));
      return Boolean(row);
    }
  }
}

export async function listCustomerMemories(
  organizationId: string,
  contactId: string,
  options: { includeRetired?: boolean } = {},
): Promise<CustomerMemory[] | null> {
  if (!(await contactExists(organizationId, contactId))) return null;
  return db
    .select()
    .from(customerMemoriesTable)
    .where(
      and(
        eq(customerMemoriesTable.organizationId, organizationId),
        eq(customerMemoriesTable.contactId, contactId),
        options.includeRetired ? undefined : eq(customerMemoriesTable.status, "active"),
      ),
    )
    .orderBy(desc(customerMemoriesTable.createdAt), desc(customerMemoriesTable.id))
    .limit(MAX_LISTED_MEMORIES);
}

async function indexMemory(row: CustomerMemory): Promise<IndexStatus> {
  try {
    const { provider, misconfigured } = tryGetEmbeddingProvider();
    if (misconfigured) logIndexFailure(row.organizationId, "customer_memory", { code: "embedding_provider_misconfigured" });
    if (!provider) return "skipped_no_provider";
    const document = prepareDocument({
      scope: "customer",
      contactId: row.contactId,
      sourceType: "customer_memory",
      sourceId: row.id,
      text: `Customer memory (${row.kind}): ${row.content}`,
    });
    if (!document) return "unchanged";
    const result = await upsertChunks(provider, row.organizationId, [document]);
    return result.indexed ? "indexed" : "unchanged";
  } catch (error) {
    logIndexFailure(row.organizationId, "customer_memory", error);
    return "failed";
  }
}

export async function createCustomerMemory(
  organizationId: string,
  contactId: string,
  actorUserId: string,
  input: CreateCustomerMemoryInput,
): Promise<{ memory: CustomerMemory; retrievalIndex: IndexStatus }> {
  const parsed = createCustomerMemorySchema.safeParse(input);
  if (!parsed.success) throw new CustomerMemoryError(400, "memory_invalid");
  const value = parsed.data;
  if (!(await contactExists(organizationId, contactId))) throw new CustomerMemoryError(404, "customer_not_found");
  if (value.sourceType !== "manual") {
    if (!value.sourceId || !(await customerOwnsSource(organizationId, contactId, value.sourceType, value.sourceId))) {
      throw new CustomerMemoryError(404, "memory_source_not_found");
    }
  }
  const [memory] = await db
    .insert(customerMemoriesTable)
    .values({
      organizationId,
      contactId,
      kind: value.kind,
      content: value.content,
      sourceType: value.sourceType,
      sourceId: value.sourceType === "manual" ? null : value.sourceId!,
      createdByUserId: actorUserId,
    })
    .returning();
  return { memory: memory!, retrievalIndex: await indexMemory(memory!) };
}

export async function retireCustomerMemory(
  organizationId: string,
  contactId: string,
  memoryId: string,
  actorUserId: string,
): Promise<CustomerMemory> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(customerMemoriesTable)
      .where(
        and(
          eq(customerMemoriesTable.organizationId, organizationId),
          eq(customerMemoriesTable.contactId, contactId),
          eq(customerMemoriesTable.id, memoryId),
        ),
      )
      .for("update");
    if (!current) throw new CustomerMemoryError(404, "memory_not_found");
    if (current.status === "retired") throw new CustomerMemoryError(409, "memory_already_retired");
    const [retired] = await tx
      .update(customerMemoriesTable)
      .set({ status: "retired", retiredAt: new Date(), retiredByUserId: actorUserId })
      .where(
        and(
          eq(customerMemoriesTable.organizationId, organizationId),
          eq(customerMemoriesTable.id, memoryId),
          eq(customerMemoriesTable.status, "active"),
        ),
      )
      .returning();
    // Retired memories leave retrieval atomically, for every embedding model.
    await removeChunks(organizationId, "customer_memory", [memoryId], tx);
    return retired!;
  });
}
