/**
 * Retrieval reads: knowledge-base search (concierge) and per-customer context
 * (staff search + the assistant's read-only tool).
 *
 * Ranking is deterministic for a given index and query:
 * - With an embedding provider, pgvector cosine similarity over the company's
 *   own chunks (exact scan of the tenant-filtered rows, so an approximate index
 *   scan can never drop rows after filtering), merged with the keyword rule.
 * - Without one (or if the query embedding fails), keyword matching answers
 *   alone and the result says `mode: "keyword"`.
 * - The hash embedder reports `mode: "lexical_hash"`; never "semantic".
 *
 * A stored vector is only a ranking hint. Every candidate is checked against
 * the CURRENT authoritative source before it is returned: knowledge entries
 * must be active with unchanged content; customer sources must be in the
 * customer's current coherent history, unchanged, and visible to the caller
 * (invoice sources and invoice activity require invoices.read). Returned text
 * always comes from the current source, never from a possibly stale chunk.
 */
import { db, knowledgeEntriesTable, type KnowledgeEntry } from "@workspace/db";
import { sql } from "drizzle-orm";

import { tryGetEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { listActiveKnowledgeEntries, scoreKnowledgeKeywords } from "./knowledge";
import {
  currentCustomerDocuments,
  documentKey,
  knowledgeDocument,
  logIndexFailure,
  redactForRetrieval,
  syncCustomerHistoryIndex,
  vectorLiteral,
  type PreparedDocument,
} from "./retrieval-index";

export type RetrievalMode = "semantic" | "lexical_hash" | "keyword";

/** What the caller may read from a customer's history (from resolveCustomerReadAccess). */
export interface CustomerRetrievalAccess {
  canReadInvoices: boolean;
}

/** Minimum cosine similarity before a knowledge chunk may answer a visitor. */
export const KNOWLEDGE_MIN_SIMILARITY = { semantic: 0.4, lexical_hash: 0.3 } as const;
/** Customer context is staff-facing; a lower bar still drops unrelated records. */
export const CUSTOMER_MIN_SIMILARITY = { semantic: 0.2, lexical_hash: 0.15 } as const;
/** Bonus that lets a deterministic keyword hit outrank a weak vector neighbour. */
const KEYWORD_BONUS = 0.25;
export const MAX_RETRIEVAL_RESULTS = 10;
/** Vector candidates scanned per customer before visibility/currency filtering. */
const CUSTOMER_VECTOR_CANDIDATES = 500;

function clampK(k: number | undefined, fallback: number): number {
  const n = Math.floor(Number(k));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_RETRIEVAL_RESULTS) : fallback;
}

function modeOf(provider: EmbeddingProvider): Exclude<RetrievalMode, "keyword"> {
  return provider.quality === "semantic" ? "semantic" : "lexical_hash";
}

async function embedQuery(
  provider: EmbeddingProvider | null,
  organizationId: string,
  query: string,
  sourceType: string,
): Promise<number[] | null> {
  if (!provider) return null;
  const text = redactForRetrieval(query);
  if (!text) return null;
  try {
    const [vector] = await provider.embed([text]);
    return vector ?? null;
  } catch (error) {
    logIndexFailure(organizationId, sourceType, error);
    return null;
  }
}

function providerFor(organizationId: string): EmbeddingProvider | null {
  const { provider, misconfigured } = tryGetEmbeddingProvider();
  if (misconfigured) logIndexFailure(organizationId, "query", { code: "embedding_provider_misconfigured" });
  return provider;
}

/* -------------------------------------------------------------- knowledge */

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  score: number;
  similarity: number | null;
  keywordScore: number;
}

export async function searchKnowledge(
  organizationId: string,
  query: string,
  k = 3,
): Promise<{ mode: RetrievalMode; results: KnowledgeSearchResult[] }> {
  const limit = clampK(k, 3);
  const entries = await listActiveKnowledgeEntries(organizationId);
  const keyword = scoreKnowledgeKeywords(entries, query);
  const provider = providerFor(organizationId);
  const queryVector = await embedQuery(provider, organizationId, query, "knowledge_query");
  if (!provider || !queryVector) {
    return {
      mode: "keyword",
      results: keyword.slice(0, limit).map((m) => ({ entry: m.entry, score: m.score, similarity: null, keywordScore: m.score })),
    };
  }
  const mode = modeOf(provider);
  const literal = vectorLiteral(queryVector);
  const rows = await db.execute<{ source_id: string; content_sha256: string; similarity: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT c.source_id, c.content_sha256, c.embedding
      FROM retrieval_chunks c
      JOIN ${knowledgeEntriesTable} k
        ON k.id = c.source_id AND k.organization_id = c.organization_id AND k.is_active
      WHERE c.organization_id = ${organizationId}
        AND c.scope = 'knowledge'
        AND c.embedding_model = ${provider.model}
    )
    SELECT source_id, content_sha256, 1 - (embedding <=> ${literal}::vector) AS similarity
    FROM candidates
    ORDER BY embedding <=> ${literal}::vector, source_id
    LIMIT ${MAX_RETRIEVAL_RESULTS * 2}
  `);
  const threshold = KNOWLEDGE_MIN_SIMILARITY[mode];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const keywordById = new Map(keyword.map((m) => [m.entry.id, m.score]));
  const merged = new Map<string, KnowledgeSearchResult>();
  for (const row of rows.rows) {
    const similarity = Number(row.similarity);
    const entry = byId.get(row.source_id);
    if (!entry || !(similarity >= threshold)) continue;
    // A vector embedded from older text must not rank the current entry.
    if (knowledgeDocument(entry)?.contentSha256 !== row.content_sha256) continue;
    const keywordScore = keywordById.get(entry.id) ?? 0;
    merged.set(entry.id, { entry, similarity, keywordScore, score: similarity + (keywordScore ? KEYWORD_BONUS : 0) });
  }
  for (const m of keyword) {
    if (merged.has(m.entry.id)) continue;
    merged.set(m.entry.id, { entry: m.entry, similarity: null, keywordScore: m.score, score: KEYWORD_BONUS });
  }
  const order = new Map(entries.map((entry, index) => [entry.id, index]));
  const results = [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.keywordScore - a.keywordScore ||
        (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0),
    )
    .slice(0, limit);
  return { mode, results };
}

/**
 * The concierge's grounded answer: the best stored entry or null (→ the
 * "I don't know" fallback). The answer text is always the stored entry,
 * never generated.
 */
export async function answerFromKnowledge(organizationId: string, question: string): Promise<KnowledgeEntry | null> {
  return (await searchKnowledge(organizationId, question, 1)).results[0]?.entry ?? null;
}

/* ------------------------------------------------------- customer context */

export interface CustomerContextResult {
  sourceType: PreparedDocument["sourceType"];
  sourceId: string;
  /** Redacted text of the CURRENT source; never raw email/phone/SSN/policy identifiers. */
  content: string;
  score: number;
  similarity: number | null;
}

function keywordTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    ),
  ];
}

function keywordScore(terms: string[], content: string): number {
  const haystack = content.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

/**
 * Context for ONE customer, as visible to the caller. Returns null when the
 * contact is not in this organization, so callers answer 404 without
 * revealing other tenants. Every query is filtered by organization_id AND
 * contact_id, and every result is re-validated against the current coherent
 * history and the caller's invoice visibility.
 */
export async function retrieveCustomerContext(
  organizationId: string,
  contactId: string,
  query: string,
  k: number,
  access: CustomerRetrievalAccess,
): Promise<{ mode: RetrievalMode; results: CustomerContextResult[] } | null> {
  const limit = clampK(k, 5);
  const exists = await db.execute(
    sql`SELECT 1 FROM contacts WHERE organization_id=${organizationId} AND id=${contactId} LIMIT 1`,
  );
  if (!exists.rows[0]) return null;

  const provider = providerFor(organizationId);
  if (provider) {
    try {
      // Shared index maintenance is independent of the caller's visibility:
      // it indexes every coherent source and never deletes what a more
      // privileged reader can see.
      await syncCustomerHistoryIndex(provider, organizationId, contactId);
    } catch (error) {
      logIndexFailure(organizationId, "customer_history", error);
    }
  }
  // Authoritative, caller-visible current history (read after the sync).
  const visible = (await currentCustomerDocuments(organizationId, contactId)).filter(
    (d) => !d.restricted || access.canReadInvoices,
  );
  const visibleByKey = new Map(visible.map((d) => [documentKey(d), d]));
  const terms = keywordTerms(redactForRetrieval(query));
  const keywordResults = visible.map((d) => ({ d, score: keywordScore(terms, d.content) })).filter((r) => r.score > 0);

  const queryVector = await embedQuery(provider, organizationId, query, "customer_query");
  if (!provider || !queryVector) {
    return {
      mode: "keyword",
      results: keywordResults
        .sort((a, b) => b.score - a.score || a.d.sourceId.localeCompare(b.d.sourceId))
        .slice(0, limit)
        .map(({ d, score }) => ({ sourceType: d.sourceType, sourceId: d.sourceId, content: d.content, score, similarity: null })),
    };
  }
  const mode = modeOf(provider);
  const literal = vectorLiteral(queryVector);
  const rows = await db.execute<{ source_type: CustomerContextResult["sourceType"]; source_id: string; content_sha256: string; similarity: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT source_type, source_id, content_sha256, embedding
      FROM retrieval_chunks
      WHERE organization_id = ${organizationId}
        AND scope = 'customer'
        AND contact_id = ${contactId}
        AND embedding_model = ${provider.model}
    )
    SELECT source_type, source_id, content_sha256, 1 - (embedding <=> ${literal}::vector) AS similarity
    FROM candidates
    ORDER BY embedding <=> ${literal}::vector, source_id
    LIMIT ${CUSTOMER_VECTOR_CANDIDATES}
  `);
  const threshold = CUSTOMER_MIN_SIMILARITY[mode];
  const keywordById = new Map(keywordResults.map((r) => [documentKey(r.d), r.score]));
  const merged = new Map<string, CustomerContextResult>();
  for (const row of rows.rows) {
    const similarity = Number(row.similarity);
    if (!(similarity >= threshold)) continue;
    const key = documentKey({ sourceType: row.source_type, sourceId: row.source_id });
    const current = visibleByKey.get(key);
    // Hidden, retired, deleted, incoherent or changed sources never surface.
    if (!current || current.contentSha256 !== row.content_sha256) continue;
    const kw = keywordById.get(key) ?? 0;
    merged.set(key, {
      sourceType: current.sourceType,
      sourceId: current.sourceId,
      content: current.content,
      similarity,
      score: similarity + (kw ? KEYWORD_BONUS : 0),
    });
  }
  for (const { d } of keywordResults) {
    const key = documentKey(d);
    if (merged.has(key)) continue;
    merged.set(key, { sourceType: d.sourceType, sourceId: d.sourceId, content: d.content, similarity: null, score: KEYWORD_BONUS });
  }
  const results = [...merged.values()]
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
    .slice(0, limit);
  return { mode, results };
}
