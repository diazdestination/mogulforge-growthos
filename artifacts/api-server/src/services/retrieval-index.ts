/**
 * Retrieval index writes: redact → hash → embed only what changed → upsert.
 *
 * Every function takes the organizationId explicitly and every statement is
 * filtered by it. Chunks are derived data; a failed embedding never blocks the
 * source write (callers get an IndexStatus, and the failure is logged without
 * any text).
 */
import {
  appointmentsTable,
  activitiesTable,
  contactsTable,
  customerMemoriesTable,
  customerWorkRootsTable,
  db,
  estimatesTable,
  invoicesTable,
  knowledgeEntriesTable,
  leadsTable,
  retrievalChunksTable,
  type RetrievalScope,
  type RetrievalSourceType,
} from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { logger } from "../lib/logger";
import {
  EMBEDDING_INPUT_MAX_CHARS,
  sha256Hex,
  tryGetEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";
import { redactEvidenceText } from "./evidence-redaction";

export type IndexStatus = "indexed" | "unchanged" | "removed" | "skipped_no_provider" | "failed";

export interface IndexDocument {
  scope: RetrievalScope;
  contactId: string | null;
  sourceType: RetrievalSourceType;
  sourceId: string;
  /** Raw source text; redacted here before it is stored or embedded. */
  text: string;
}

export interface PreparedDocument extends IndexDocument {
  content: string;
  contentSha256: string;
}

/** Per-type cap so one very long customer history cannot exhaust a request. */
export const CUSTOMER_HISTORY_PER_SOURCE_LIMIT = 100;

/**
 * Redaction helper reused from Evidence Intelligence: email, phone, SSN and
 * policy/claim/account identifiers are replaced before any text is stored in
 * retrieval_chunks or sent to an embedding provider. Names and street
 * addresses are not reliably detectable by pattern; history documents are
 * built without the contact's name/email/phone/address fields for that reason.
 */
export function redactForRetrieval(text: string): string {
  return redactEvidenceText(text.replace(/\s+/g, " ").trim()).text.slice(0, EMBEDDING_INPUT_MAX_CHARS);
}

export function prepareDocument(document: IndexDocument): PreparedDocument | null {
  const content = redactForRetrieval(document.text);
  if (!content) return null;
  return { ...document, content, contentSha256: sha256Hex(content) };
}

export function logIndexFailure(organizationId: string, sourceType: string, error: unknown): void {
  // Never log text, vectors, provider bodies or credentials.
  logger.warn(
    {
      event: "retrieval_index_failed",
      organizationId,
      sourceType,
      code: (error as { code?: unknown })?.code ?? (error as Error)?.name ?? "unknown",
    },
    "Retrieval index update skipped; source record is unaffected",
  );
}

export function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

/**
 * Upsert prepared documents for one company. Only documents whose redacted
 * content hash changed (or that have no chunk for this model) are embedded.
 */
export async function upsertChunks(
  provider: EmbeddingProvider,
  organizationId: string,
  documents: PreparedDocument[],
): Promise<{ indexed: number; unchanged: number }> {
  if (documents.length === 0) return { indexed: 0, unchanged: 0 };
  const existing = await db
    .select({
      sourceType: retrievalChunksTable.sourceType,
      sourceId: retrievalChunksTable.sourceId,
      contentSha256: retrievalChunksTable.contentSha256,
      contactId: retrievalChunksTable.contactId,
    })
    .from(retrievalChunksTable)
    .where(
      and(
        eq(retrievalChunksTable.organizationId, organizationId),
        eq(retrievalChunksTable.embeddingModel, provider.model),
        inArray(retrievalChunksTable.sourceId, documents.map((d) => d.sourceId)),
      ),
    );
  const known = new Map(existing.map((row) => [`${row.sourceType}:${row.sourceId}`, row]));
  const changed = documents.filter((d) => {
    const row = known.get(`${d.sourceType}:${d.sourceId}`);
    return !row || row.contentSha256 !== d.contentSha256 || row.contactId !== d.contactId;
  });
  if (changed.length === 0) return { indexed: 0, unchanged: documents.length };
  const vectors = await provider.embed(changed.map((d) => d.content));
  const now = new Date();
  await db
    .insert(retrievalChunksTable)
    .values(
      changed.map((d, index) => ({
        organizationId,
        scope: d.scope,
        contactId: d.contactId,
        sourceType: d.sourceType,
        sourceId: d.sourceId,
        content: d.content,
        contentSha256: d.contentSha256,
        embeddingModel: provider.model,
        embedding: vectors[index]!,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        retrievalChunksTable.organizationId,
        retrievalChunksTable.sourceType,
        retrievalChunksTable.sourceId,
        retrievalChunksTable.embeddingModel,
      ],
      set: {
        scope: sql`excluded.scope`,
        contactId: sql`excluded.contact_id`,
        content: sql`excluded.content`,
        contentSha256: sql`excluded.content_sha256`,
        embedding: sql`excluded.embedding`,
        updatedAt: now,
      },
    });
  return { indexed: changed.length, unchanged: documents.length - changed.length };
}

type Executor = Pick<typeof db, "delete">;

/** Remove every model's chunk for the given source records (no provider needed). */
export async function removeChunks(
  organizationId: string,
  sourceType: RetrievalSourceType,
  sourceIds: string[],
  executor: Executor = db,
): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const rows = await executor
    .delete(retrievalChunksTable)
    .where(
      and(
        eq(retrievalChunksTable.organizationId, organizationId),
        eq(retrievalChunksTable.sourceType, sourceType),
        inArray(retrievalChunksTable.sourceId, sourceIds),
      ),
    )
    .returning({ id: retrievalChunksTable.id });
  return rows.length;
}

/* -------------------------------------------------------------- knowledge */

export function knowledgeDocument(entry: { id: string; title: string; content: string }): PreparedDocument | null {
  return prepareDocument({
    scope: "knowledge",
    contactId: null,
    sourceType: "knowledge_entry",
    sourceId: entry.id,
    text: `${entry.title}\n${entry.content}`,
  });
}

/**
 * Bring one knowledge entry's chunk in line with the entry (best-effort).
 * Inactive or deleted entries lose their chunks even without a provider.
 */
export async function syncKnowledgeEntryIndex(organizationId: string, entryId: string): Promise<IndexStatus> {
  try {
    const [entry] = await db
      .select()
      .from(knowledgeEntriesTable)
      .where(and(eq(knowledgeEntriesTable.organizationId, organizationId), eq(knowledgeEntriesTable.id, entryId)));
    if (!entry || !entry.isActive) {
      await removeChunks(organizationId, "knowledge_entry", [entryId]);
      return "removed";
    }
    const { provider, misconfigured } = tryGetEmbeddingProvider();
    if (misconfigured) logIndexFailure(organizationId, "knowledge_entry", { code: "embedding_provider_misconfigured" });
    if (!provider) return "skipped_no_provider";
    const document = knowledgeDocument(entry);
    if (!document) return "unchanged";
    const result = await upsertChunks(provider, organizationId, [document]);
    return result.indexed ? "indexed" : "unchanged";
  } catch (error) {
    logIndexFailure(organizationId, "knowledge_entry", error);
    return "failed";
  }
}

/** Re-embed all active knowledge entries of one company and drop stale chunks. */
export async function reindexKnowledge(
  provider: EmbeddingProvider,
  organizationId: string,
): Promise<{ indexed: number; unchanged: number; removed: number }> {
  const entries = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(and(eq(knowledgeEntriesTable.organizationId, organizationId), eq(knowledgeEntriesTable.isActive, true)));
  const documents = entries.map(knowledgeDocument).filter((d): d is PreparedDocument => d !== null);
  const result = await upsertChunks(provider, organizationId, documents);
  const keep = documents.map((d) => d.sourceId);
  const removed = await db
    .delete(retrievalChunksTable)
    .where(
      and(
        eq(retrievalChunksTable.organizationId, organizationId),
        eq(retrievalChunksTable.scope, "knowledge"),
        keep.length ? notInArray(retrievalChunksTable.sourceId, keep) : sql`true`,
      ),
    )
    .returning({ id: retrievalChunksTable.id });
  return { ...result, removed: removed.length };
}

/* ------------------------------------------------------- customer history */

function money(cents: number | null | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "";
}

function day(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

function itemDescriptions(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => (item && typeof item === "object" ? String((item as { description?: unknown }).description ?? "") : ""))
    .filter(Boolean)
    .slice(0, 30)
    .join("; ");
}

/**
 * Deterministically collect one customer's history as index documents.
 * Strictly filtered by organization AND contact (directly, or through that
 * contact's leads / customer-work roots in the same organization). Contact
 * identity fields (name, email, phone, address) are never included.
 */
export async function collectCustomerHistory(organizationId: string, contactId: string): Promise<IndexDocument[]> {
  const limit = CUSTOMER_HISTORY_PER_SOURCE_LIMIT;
  const [contact] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, contactId)));
  if (!contact) return [];

  const leads = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.contactId, contactId)))
    .orderBy(desc(leadsTable.createdAt), asc(leadsTable.id))
    .limit(limit);
  const leadIds = leads.map((lead) => lead.id);
  const roots = await db
    .select({ id: customerWorkRootsTable.id })
    .from(customerWorkRootsTable)
    .where(and(eq(customerWorkRootsTable.organizationId, organizationId), eq(customerWorkRootsTable.contactId, contactId)))
    .limit(limit);
  const rootIds = roots.map((root) => root.id);

  const activities = await db
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.organizationId, organizationId),
        leadIds.length
          ? or(eq(activitiesTable.contactId, contactId), inArray(activitiesTable.leadId, leadIds))
          : eq(activitiesTable.contactId, contactId),
      ),
    )
    .orderBy(desc(activitiesTable.occurredAt), asc(activitiesTable.id))
    .limit(limit);
  const appointments = await db
    .select()
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        leadIds.length
          ? or(eq(appointmentsTable.contactId, contactId), inArray(appointmentsTable.leadId, leadIds))
          : eq(appointmentsTable.contactId, contactId),
      ),
    )
    .orderBy(desc(appointmentsTable.scheduledStart), asc(appointmentsTable.id))
    .limit(limit);
  const workScope = (lead: AnyPgColumn, work: AnyPgColumn): SQL | undefined | null =>
    leadIds.length && rootIds.length
      ? or(inArray(lead, leadIds), inArray(work, rootIds))
      : leadIds.length
        ? inArray(lead, leadIds)
        : rootIds.length
          ? inArray(work, rootIds)
          : null;
  const estimateScope = workScope(estimatesTable.leadId, estimatesTable.customerWorkId);
  const estimates = estimateScope
    ? await db
        .select()
        .from(estimatesTable)
        .where(and(eq(estimatesTable.organizationId, organizationId), estimateScope))
        .orderBy(desc(estimatesTable.createdAt), asc(estimatesTable.id))
        .limit(limit)
    : [];
  const invoiceScope = workScope(invoicesTable.leadId, invoicesTable.customerWorkId);
  const invoices = invoiceScope
    ? await db
        .select()
        .from(invoicesTable)
        .where(and(eq(invoicesTable.organizationId, organizationId), invoiceScope))
        .orderBy(desc(invoicesTable.createdAt), asc(invoicesTable.id))
        .limit(limit)
    : [];
  const memories = await db
    .select()
    .from(customerMemoriesTable)
    .where(
      and(
        eq(customerMemoriesTable.organizationId, organizationId),
        eq(customerMemoriesTable.contactId, contactId),
        eq(customerMemoriesTable.status, "active"),
      ),
    )
    .orderBy(desc(customerMemoriesTable.createdAt), asc(customerMemoriesTable.id))
    .limit(limit);

  const doc = (sourceType: RetrievalSourceType, sourceId: string, parts: Array<string | null | undefined>): IndexDocument => ({
    scope: "customer",
    contactId,
    sourceType,
    sourceId,
    text: parts.filter((part) => part && part.trim()).join(" "),
  });
  return [
    ...memories.map((m) => doc("customer_memory", m.id, [`Customer memory (${m.kind}):`, m.content])),
    ...leads.map((l) =>
      doc("lead", l.id, [
        `Lead ${day(l.createdAt)} status ${l.status}.`,
        l.serviceType && `Service: ${l.serviceType}.`,
        l.source && `Source: ${l.source}.`,
        l.summary,
        l.lostReason && `Lost reason: ${l.lostReason}.`,
      ]),
    ),
    ...activities.map((a) => doc("activity", a.id, [`Activity ${day(a.occurredAt)} ${a.type}:`, a.title + ".", a.body])),
    ...appointments.map((a) =>
      doc("appointment", a.id, [`${a.type} appointment ${day(a.scheduledStart)} status ${a.status}.`, a.notes]),
    ),
    ...estimates.map((e) =>
      doc("estimate", e.id, [
        `Estimate ${day(e.createdAt)} "${e.title}" status ${e.status} total ${money(e.totalCents)}.`,
        itemDescriptions(e.lineItems) && `Items: ${itemDescriptions(e.lineItems)}.`,
        e.notes,
      ]),
    ),
    ...invoices.map((i) => {
      // Issued snapshot when present; never customerName/customerAddress.
      const document = i.issuedDocument ?? i.draftDocument;
      return doc("invoice", i.id, [
        `Invoice ${i.invoiceNumber ?? "draft"} ${day(i.issuedAt ?? i.createdAt)} status ${i.status} total ${money(document?.totalCents)}.`,
        document?.title && `Title: ${document.title}.`,
        itemDescriptions(document?.lineItems) && `Items: ${itemDescriptions(document?.lineItems)}.`,
        document?.notes,
      ]);
    }),
  ];
}

/**
 * Sync one customer's chunks with their current history (idempotent): changed
 * records are re-embedded, unchanged ones skipped, vanished ones removed.
 */
export async function syncCustomerHistoryIndex(
  provider: EmbeddingProvider,
  organizationId: string,
  contactId: string,
  history?: IndexDocument[],
): Promise<{ indexed: number; unchanged: number; removed: number }> {
  const documents = (history ?? (await collectCustomerHistory(organizationId, contactId)))
    .map(prepareDocument)
    .filter((d): d is PreparedDocument => d !== null);
  const result = await upsertChunks(provider, organizationId, documents);
  const keep = documents.map((d) => d.sourceId);
  const removed = await db
    .delete(retrievalChunksTable)
    .where(
      and(
        eq(retrievalChunksTable.organizationId, organizationId),
        eq(retrievalChunksTable.scope, "customer"),
        eq(retrievalChunksTable.contactId, contactId),
        eq(retrievalChunksTable.embeddingModel, provider.model),
        keep.length ? notInArray(retrievalChunksTable.sourceId, keep) : sql`true`,
      ),
    )
    .returning({ id: retrievalChunksTable.id });
  return { ...result, removed: removed.length };
}

export const REINDEX_MAX_CONTACTS = 200;

/**
 * Backfill one company: all knowledge, then up to `limit` customers after the
 * cursor (contact id order). Callers page with `nextAfterContactId`.
 */
export async function reindexOrganization(
  provider: EmbeddingProvider,
  organizationId: string,
  options: { afterContactId?: string | null; limit?: number } = {},
) {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), REINDEX_MAX_CONTACTS);
  const knowledge = options.afterContactId ? null : await reindexKnowledge(provider, organizationId);
  const contacts = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, organizationId),
        options.afterContactId ? gt(contactsTable.id, options.afterContactId) : undefined,
      ),
    )
    .orderBy(asc(contactsTable.id))
    .limit(limit);
  const totals = { processed: 0, indexed: 0, unchanged: 0, removed: 0 };
  for (const contact of contacts) {
    const result = await syncCustomerHistoryIndex(provider, organizationId, contact.id);
    totals.processed += 1;
    totals.indexed += result.indexed;
    totals.unchanged += result.unchanged;
    totals.removed += result.removed;
  }
  return {
    embeddingModel: provider.model,
    quality: provider.quality,
    knowledge,
    customers: totals,
    nextAfterContactId: contacts.length === limit ? contacts[contacts.length - 1]!.id : null,
  };
}
