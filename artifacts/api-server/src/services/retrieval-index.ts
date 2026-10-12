/**
 * Retrieval index writes: redact → hash → embed only what changed → lock,
 * revalidate against the authoritative source → atomic upsert.
 *
 * Correctness rules:
 * - Embedding (slow, external) happens outside any transaction. Before writing,
 *   the writer takes the same lock that source removals take (the knowledge
 *   row lock, or the per-customer advisory lock), re-reads the source and only
 *   writes a vector whose content hash still matches the CURRENT source. So an
 *   in-flight request can never resurrect retired/deleted content or overwrite
 *   a newer embedding with older text.
 * - Customer history follows the customer-workspace canonical coherence graph:
 *   a row whose parents disagree about the customer is in nobody's history.
 * - The shared index stores every coherent source (including invoice-restricted
 *   ones, flagged) independent of who triggered indexing; caller visibility is
 *   applied only when reading (services/retrieval.ts).
 *
 * Every statement is filtered by organization; failures never block the source
 * write and are logged without text.
 */
import {
  contactsTable,
  db,
  knowledgeEntriesTable,
  retrievalChunksTable,
  type RetrievalScope,
  type RetrievalSourceType,
} from "@workspace/db";
import { and, asc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";

import { logger } from "../lib/logger";
import {
  RESTRICTED_INVOICE_ACTIVITY_TYPES,
  coherentCustomerActivity,
  coherentCustomerActivityJoins,
  customerRecordGraph,
} from "./customer-workspace";
import {
  EMBEDDING_INPUT_MAX_CHARS,
  sha256Hex,
  tryGetEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";
import { redactEvidenceText } from "./evidence-redaction";

export type IndexStatus =
  | "indexed"
  | "unchanged"
  | "removed"
  | "superseded"
  | "skipped_no_provider"
  | "failed";

export interface IndexDocument {
  scope: RetrievalScope;
  contactId: string | null;
  sourceType: RetrievalSourceType;
  sourceId: string;
  /** Raw source text; redacted here before it is stored or embedded. */
  text: string;
  /** True when reading this source requires invoices.read (invoices, invoice activity). */
  restricted: boolean;
}

export interface PreparedDocument extends IndexDocument {
  content: string;
  contentSha256: string;
}

/** Per-type cap so one very long customer history cannot exhaust a request. */
export const CUSTOMER_HISTORY_PER_SOURCE_LIMIT = 100;

type Executor = Pick<typeof db, "select" | "insert" | "delete" | "execute">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

function prepareAll(documents: IndexDocument[]): PreparedDocument[] {
  return documents.map(prepareDocument).filter((d): d is PreparedDocument => d !== null);
}

export const documentKey = (d: { sourceType: string; sourceId: string }) => `${d.sourceType}:${d.sourceId}`;

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

/** Serializes every chunk write/removal for one customer (memory retirement uses it too). */
export async function lockCustomerIndex(tx: Pick<typeof db, "execute">, organizationId: string, contactId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`retrieval:customer:${organizationId}:${contactId}`}, 0))`);
}

async function existingHashes(executor: Executor, organizationId: string, model: string, sourceIds: string[]) {
  if (sourceIds.length === 0) return new Map<string, string>();
  const rows = await executor
    .select({
      sourceType: retrievalChunksTable.sourceType,
      sourceId: retrievalChunksTable.sourceId,
      contentSha256: retrievalChunksTable.contentSha256,
    })
    .from(retrievalChunksTable)
    .where(
      and(
        eq(retrievalChunksTable.organizationId, organizationId),
        eq(retrievalChunksTable.embeddingModel, model),
        inArray(retrievalChunksTable.sourceId, sourceIds),
      ),
    );
  return new Map(rows.map((row) => [documentKey(row), row.contentSha256]));
}

/** Documents whose stored chunk (for this model) is missing or has different content. */
async function changedDocuments(
  provider: EmbeddingProvider,
  organizationId: string,
  documents: PreparedDocument[],
): Promise<PreparedDocument[]> {
  const known = await existingHashes(db, organizationId, provider.model, documents.map((d) => d.sourceId));
  return documents.filter((d) => known.get(documentKey(d)) !== d.contentSha256);
}

/** Unlocked write; callers must hold the source lock and have revalidated `documents`. */
async function writeChunks(
  executor: Executor,
  model: string,
  organizationId: string,
  documents: Array<PreparedDocument & { embedding: number[] }>,
): Promise<void> {
  if (documents.length === 0) return;
  const now = new Date();
  await executor
    .insert(retrievalChunksTable)
    .values(
      documents.map((d) => ({
        organizationId,
        scope: d.scope,
        contactId: d.contactId,
        sourceType: d.sourceType,
        sourceId: d.sourceId,
        content: d.content,
        contentSha256: d.contentSha256,
        embeddingModel: model,
        embedding: d.embedding,
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
}

/** Remove every model's chunk for the given source records (no provider needed). */
export async function removeChunks(
  organizationId: string,
  sourceType: RetrievalSourceType,
  sourceIds: string[],
  executor: Pick<typeof db, "delete"> = db,
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
    restricted: false,
  });
}

/**
 * Write knowledge vectors only for entries that are still active and still have
 * exactly the embedded content. Entry rows are locked FOR UPDATE (in id order),
 * the same lock deactivation and deletion take, so their chunk removal always
 * runs strictly before or after this write.
 */
async function commitKnowledge(
  model: string,
  organizationId: string,
  embedded: Array<PreparedDocument & { embedding: number[] }>,
  options: { removeInactive?: boolean } = {},
): Promise<{ written: number; superseded: number; removed: number; gone: number }> {
  return db.transaction(async (tx) => {
    const ids = embedded.map((d) => d.sourceId);
    const current = ids.length
      ? await tx
          .select()
          .from(knowledgeEntriesTable)
          .where(and(eq(knowledgeEntriesTable.organizationId, organizationId), inArray(knowledgeEntriesTable.id, ids)))
          .orderBy(asc(knowledgeEntriesTable.id))
          .for("update")
      : [];
    const byId = new Map(current.map((entry) => [entry.id, entry]));
    const writable: typeof embedded = [];
    const gone: string[] = [];
    let superseded = 0;
    for (const document of embedded) {
      const entry = byId.get(document.sourceId);
      if (!entry || !entry.isActive) {
        gone.push(document.sourceId);
        continue;
      }
      if (knowledgeDocument(entry)?.contentSha256 !== document.contentSha256) {
        superseded += 1; // A newer edit owns this entry; its own sync writes it.
        continue;
      }
      writable.push(document);
    }
    await writeChunks(tx, model, organizationId, writable);
    let removed = await removeChunks(organizationId, "knowledge_entry", gone, tx);
    if (options.removeInactive) {
      const active = await tx
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(and(eq(knowledgeEntriesTable.organizationId, organizationId), eq(knowledgeEntriesTable.isActive, true)));
      const keep = active.map((row) => row.id);
      const stale = await tx
        .delete(retrievalChunksTable)
        .where(
          and(
            eq(retrievalChunksTable.organizationId, organizationId),
            eq(retrievalChunksTable.scope, "knowledge"),
            keep.length ? notInArray(retrievalChunksTable.sourceId, keep) : sql`true`,
          ),
        )
        .returning({ id: retrievalChunksTable.id });
      removed += stale.length;
    }
    return { written: writable.length, superseded, removed, gone: gone.length };
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
      await db.transaction(async (tx) => {
        // Same row lock as the writers; a concurrently re-activated entry keeps its chunk.
        const [locked] = await tx
          .select()
          .from(knowledgeEntriesTable)
          .where(and(eq(knowledgeEntriesTable.organizationId, organizationId), eq(knowledgeEntriesTable.id, entryId)))
          .for("update");
        if (!locked || !locked.isActive) await removeChunks(organizationId, "knowledge_entry", [entryId], tx);
      });
      return "removed";
    }
    const { provider, misconfigured } = tryGetEmbeddingProvider();
    if (misconfigured) logIndexFailure(organizationId, "knowledge_entry", { code: "embedding_provider_misconfigured" });
    if (!provider) return "skipped_no_provider";
    const document = knowledgeDocument(entry);
    if (!document) return "unchanged";
    const [changed] = await changedDocuments(provider, organizationId, [document]);
    if (!changed) return "unchanged";
    const [embedding] = await provider.embed([changed.content]);
    const result = await commitKnowledge(provider.model, organizationId, [{ ...changed, embedding: embedding! }]);
    return result.written ? "indexed" : result.gone ? "removed" : "superseded";
  } catch (error) {
    logIndexFailure(organizationId, "knowledge_entry", error);
    return "failed";
  }
}

/** Re-embed all active knowledge entries of one company and drop stale chunks. */
export async function reindexKnowledge(
  provider: EmbeddingProvider,
  organizationId: string,
): Promise<{ indexed: number; unchanged: number; removed: number; superseded: number }> {
  const entries = await db
    .select()
    .from(knowledgeEntriesTable)
    .where(and(eq(knowledgeEntriesTable.organizationId, organizationId), eq(knowledgeEntriesTable.isActive, true)));
  const documents = entries.map(knowledgeDocument).filter((d): d is PreparedDocument => d !== null);
  const changed = await changedDocuments(provider, organizationId, documents);
  const vectors = changed.length ? await provider.embed(changed.map((d) => d.content)) : [];
  const result = await commitKnowledge(
    provider.model,
    organizationId,
    changed.map((d, index) => ({ ...d, embedding: vectors[index]! })),
    { removeInactive: true },
  );
  return {
    indexed: result.written,
    unchanged: documents.length - changed.length,
    removed: result.removed,
    superseded: result.superseded,
  };
}

/* ------------------------------------------------------- customer history */

function money(cents: unknown): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "";
}

function day(value: unknown): string {
  if (!value) return "";
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function itemDescriptions(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => (item && typeof item === "object" ? String((item as { description?: unknown }).description ?? "") : ""))
    .filter(Boolean)
    .slice(0, 30)
    .join("; ");
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Deterministically collect one customer's history as index documents using
 * the customer-workspace canonical graph: a lead, appointment, estimate,
 * invoice or activity is included only when every populated parent exists in
 * this company and agrees on THIS customer. Contact identity fields (name,
 * email, phone, address) and invoice customerName/customerAddress are never
 * included. Invoice documents and invoice activity are flagged `restricted`.
 */
export async function collectCustomerHistory(
  organizationId: string,
  contactId: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<IndexDocument[]> {
  const limit = CUSTOMER_HISTORY_PER_SOURCE_LIMIT;
  const exists = await executor.execute(
    sql`SELECT 1 FROM contacts WHERE organization_id=${organizationId} AND id=${contactId} LIMIT 1`,
  );
  if (!exists.rows[0]) return [];
  const graph = customerRecordGraph(organizationId, contactId);
  const run = async (selection: ReturnType<typeof sql>) => (await executor.execute<Row>(sql`${graph} ${selection}`)).rows;

  const leads = await run(sql`SELECT l.id,l.created_at,l.status,l.service_type,l.source,l.summary,l.lost_reason
    FROM valid_leads l ORDER BY l.created_at DESC,l.id LIMIT ${limit}`);
  const activities = await run(sql`SELECT a.id,a.type,a.title,a.body,a.occurred_at
    FROM activities a ${coherentCustomerActivityJoins(organizationId)}
    WHERE ${coherentCustomerActivity(organizationId, contactId)}
    ORDER BY a.occurred_at DESC,a.id LIMIT ${limit}`);
  const appointments = await run(sql`SELECT a.id,a.type,a.status,a.scheduled_start,a.notes
    FROM valid_appointments a WHERE a.resolved_contact_id=${contactId}
    ORDER BY a.scheduled_start DESC,a.id LIMIT ${limit}`);
  const estimates = await run(sql`SELECT e.id,e.created_at,e.title,e.status,e.total_cents,e.line_items,e.notes
    FROM valid_estimates e WHERE e.resolved_contact_id=${contactId}
    ORDER BY e.created_at DESC,e.id LIMIT ${limit}`);
  const invoices = await run(sql`SELECT i.id,i.created_at,i.issued_at,i.invoice_number,i.status,
      coalesce(i.issued_document,i.draft_document) AS document
    FROM valid_invoices i WHERE i.resolved_contact_id=${contactId}
    ORDER BY i.created_at DESC,i.id LIMIT ${limit}`);
  const memories = (
    await executor.execute<Row>(sql`SELECT id,kind,content FROM customer_memories
      WHERE organization_id=${organizationId} AND contact_id=${contactId} AND status='active'
      ORDER BY created_at DESC,id LIMIT ${limit}`)
  ).rows;

  const doc = (
    sourceType: RetrievalSourceType,
    sourceId: unknown,
    parts: Array<string | null | undefined | false>,
    restricted = false,
  ): IndexDocument => ({
    scope: "customer",
    contactId,
    sourceType,
    sourceId: String(sourceId),
    text: parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" "),
    restricted,
  });
  return [
    ...memories.map((m) => doc("customer_memory", m.id, [`Customer memory (${text(m.kind)}):`, text(m.content)])),
    ...leads.map((l) =>
      doc("lead", l.id, [
        `Lead ${day(l.created_at)} status ${text(l.status)}.`,
        text(l.service_type) && `Service: ${text(l.service_type)}.`,
        text(l.source) && `Source: ${text(l.source)}.`,
        text(l.summary),
        text(l.lost_reason) && `Lost reason: ${text(l.lost_reason)}.`,
      ]),
    ),
    ...activities.map((a) =>
      doc(
        "activity",
        a.id,
        [`Activity ${day(a.occurred_at)} ${text(a.type)}:`, `${text(a.title)}.`, text(a.body)],
        RESTRICTED_INVOICE_ACTIVITY_TYPES.includes(text(a.type)),
      ),
    ),
    ...appointments.map((a) =>
      doc("appointment", a.id, [`${text(a.type)} appointment ${day(a.scheduled_start)} status ${text(a.status)}.`, text(a.notes)]),
    ),
    ...estimates.map((e) =>
      doc("estimate", e.id, [
        `Estimate ${day(e.created_at)} "${text(e.title)}" status ${text(e.status)} total ${money(e.total_cents)}.`,
        itemDescriptions(e.line_items) && `Items: ${itemDescriptions(e.line_items)}.`,
        text(e.notes),
      ]),
    ),
    ...invoices.map((i) => {
      // Issued snapshot when present; never customerName/customerAddress.
      const document = (i.document ?? {}) as { title?: unknown; totalCents?: unknown; lineItems?: unknown; notes?: unknown };
      return doc(
        "invoice",
        i.id,
        [
          `Invoice ${text(i.invoice_number) || "draft"} ${day(i.issued_at ?? i.created_at)} status ${text(i.status)} total ${money(document.totalCents)}.`,
          text(document.title) && `Title: ${text(document.title)}.`,
          itemDescriptions(document.lineItems) && `Items: ${itemDescriptions(document.lineItems)}.`,
          text(document.notes),
        ],
        true,
      );
    }),
  ];
}

/** Current coherent history for one customer, prepared (redacted + hashed). */
export async function currentCustomerDocuments(
  organizationId: string,
  contactId: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<PreparedDocument[]> {
  return prepareAll(await collectCustomerHistory(organizationId, contactId, executor));
}

/**
 * Sync one customer's chunks with their current history (idempotent).
 * Embeds changed records outside a transaction, then under the per-customer
 * advisory lock re-collects the authoritative history and writes only vectors
 * whose source still exists, is still coherent for this customer and still
 * has the embedded content. Chunks for vanished sources are removed.
 */
export async function syncCustomerHistoryIndex(
  provider: EmbeddingProvider,
  organizationId: string,
  contactId: string,
): Promise<{ indexed: number; unchanged: number; removed: number; superseded: number }> {
  const documents = await currentCustomerDocuments(organizationId, contactId);
  const changed = await changedDocuments(provider, organizationId, documents);
  const vectors = changed.length ? await provider.embed(changed.map((d) => d.content)) : [];
  return db.transaction(async (tx: Tx) => {
    await lockCustomerIndex(tx, organizationId, contactId);
    const current = new Map(
      (await currentCustomerDocuments(organizationId, contactId, tx)).map((d) => [documentKey(d), d]),
    );
    const writable = changed
      .map((d, index) => ({ ...d, embedding: vectors[index]! }))
      .filter((d) => current.get(documentKey(d))?.contentSha256 === d.contentSha256);
    await writeChunks(tx, provider.model, organizationId, writable);
    const keep = [...current.values()].map((d) => d.sourceId);
    const removed = await tx
      .delete(retrievalChunksTable)
      .where(
        and(
          eq(retrievalChunksTable.organizationId, organizationId),
          eq(retrievalChunksTable.scope, "customer"),
          eq(retrievalChunksTable.contactId, contactId),
          keep.length ? notInArray(retrievalChunksTable.sourceId, keep) : sql`true`,
        ),
      )
      .returning({ id: retrievalChunksTable.id });
    return {
      indexed: writable.length,
      unchanged: documents.length - changed.length,
      removed: removed.length,
      superseded: changed.length - writable.length,
    };
  });
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
  const totals = { processed: 0, indexed: 0, unchanged: 0, removed: 0, superseded: 0 };
  for (const contact of contacts) {
    const result = await syncCustomerHistoryIndex(provider, organizationId, contact.id);
    totals.processed += 1;
    totals.indexed += result.indexed;
    totals.unchanged += result.unchanged;
    totals.removed += result.removed;
    totals.superseded += result.superseded;
  }
  return {
    embeddingModel: provider.model,
    quality: provider.quality,
    knowledge,
    customers: totals,
    nextAfterContactId: contacts.length === limit ? contacts[contacts.length - 1]!.id : null,
  };
}
