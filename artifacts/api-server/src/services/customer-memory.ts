/**
 * Per-customer memory: short, staff-authored notes that should travel with a
 * customer ("prefers text over calls", "dog in backyard — call first").
 *
 * Deterministic rules only: tenant + contact checks are SQL filters,
 * provenance must be in the customer's canonical coherent record (the same
 * graph as the customer workspace), invoice provenance needs invoices.read,
 * and retirement is a recorded human decision. The row stays for provenance;
 * its retrieval chunks are removed in the same transaction under the
 * per-customer index lock, so an in-flight index write cannot resurrect it.
 */
import {
  contactsTable,
  customerMemoriesTable,
  db,
  type CustomerMemory,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

import type { CreateCustomerMemoryInput, CustomerMemoryDto } from "./customer-memory-contract";
import { createCustomerMemorySchema } from "./customer-memory-contract";
import {
  RESTRICTED_INVOICE_ACTIVITY_TYPES,
  coherentCustomerActivity,
  coherentCustomerActivityJoins,
  customerRecordGraph,
} from "./customer-workspace";
import { tryGetEmbeddingProvider } from "./embeddings";
import {
  lockCustomerIndex,
  logIndexFailure,
  removeChunks,
  syncCustomerHistoryIndex,
  type IndexStatus,
} from "./retrieval-index";

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

/**
 * True only when the cited record is in this customer's canonical coherent
 * record in this organization (every populated parent agrees on the
 * customer), and is visible to the caller (invoices need invoices.read).
 */
export async function customerOwnsSource(
  organizationId: string,
  contactId: string,
  sourceType: Exclude<CustomerMemoryDto["sourceType"], "manual">,
  sourceId: string,
  access: { canReadInvoices: boolean },
): Promise<boolean> {
  const graph = customerRecordGraph(organizationId, contactId);
  let selection;
  switch (sourceType) {
    case "lead":
      selection = sql`SELECT 1 FROM valid_leads l WHERE l.id=${sourceId}`;
      break;
    case "activity":
      selection = sql`SELECT 1 FROM activities a ${coherentCustomerActivityJoins(organizationId)}
        WHERE ${coherentCustomerActivity(organizationId, contactId)} AND a.id=${sourceId}
        ${access.canReadInvoices ? sql`` : sql`AND a.type NOT IN (${sql.join(RESTRICTED_INVOICE_ACTIVITY_TYPES.map((t) => sql`${t}`), sql`,`)})`}`;
      break;
    case "appointment":
      selection = sql`SELECT 1 FROM valid_appointments a WHERE a.id=${sourceId} AND a.resolved_contact_id=${contactId}`;
      break;
    case "estimate":
      selection = sql`SELECT 1 FROM valid_estimates e WHERE e.id=${sourceId} AND e.resolved_contact_id=${contactId}`;
      break;
    case "invoice":
      if (!access.canReadInvoices) return false;
      selection = sql`SELECT 1 FROM valid_invoices i WHERE i.id=${sourceId} AND i.resolved_contact_id=${contactId}`;
      break;
  }
  const result = await db.execute(sql`${graph} ${selection} LIMIT 1`);
  return result.rows.length > 0;
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

/** Best-effort: refresh this customer's index (only changed sources are embedded). */
async function indexCustomer(organizationId: string, contactId: string): Promise<IndexStatus> {
  try {
    const { provider, misconfigured } = tryGetEmbeddingProvider();
    if (misconfigured) logIndexFailure(organizationId, "customer_memory", { code: "embedding_provider_misconfigured" });
    if (!provider) return "skipped_no_provider";
    const result = await syncCustomerHistoryIndex(provider, organizationId, contactId);
    return result.indexed ? "indexed" : result.superseded ? "superseded" : "unchanged";
  } catch (error) {
    logIndexFailure(organizationId, "customer_memory", error);
    return "failed";
  }
}

export async function createCustomerMemory(
  organizationId: string,
  contactId: string,
  actorUserId: string,
  input: CreateCustomerMemoryInput,
  access: { canReadInvoices: boolean },
): Promise<{ memory: CustomerMemory; retrievalIndex: IndexStatus }> {
  const parsed = createCustomerMemorySchema.safeParse(input);
  if (!parsed.success) throw new CustomerMemoryError(400, "memory_invalid");
  const value = parsed.data;
  if (!(await contactExists(organizationId, contactId))) throw new CustomerMemoryError(404, "customer_not_found");
  if (value.sourceType !== "manual") {
    if (!value.sourceId || !(await customerOwnsSource(organizationId, contactId, value.sourceType, value.sourceId, access))) {
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
  return { memory: memory!, retrievalIndex: await indexCustomer(organizationId, contactId) };
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
    // Same lock as index writers: any in-flight write commits before this
    // removal, and any later one re-reads the memory as retired.
    await lockCustomerIndex(tx, organizationId, contactId);
    await removeChunks(organizationId, "customer_memory", [memoryId], tx);
    return retired!;
  });
}
