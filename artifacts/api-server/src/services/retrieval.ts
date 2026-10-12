/**
 * Retrieval reads: knowledge-base search (concierge) and per-customer context
 * (staff search + the assistant's read-only tool).
 *
 * Ranking is deterministic for a given index and query:
 * - With an embedding provider, pgvector cosine similarity over the company's
 *   own chunks (exact scan of the tenant-filtered rows, so the HNSW index can
 *   never drop rows another tenant "used up"), merged with the keyword rule.
 * - Without one (or if the query embedding fails), the existing keyword
 *   matching answers alone and the result says `mode: "keyword"`.
 * - The hash embedder reports `mode: "lexical_hash"`; it is never presented
 *   as semantic search.
 */
import { contactsTable, db, knowledgeEntriesTable, type KnowledgeEntry } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

import { tryGetEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { listActiveKnowledgeEntries, scoreKnowledgeKeywords } from "./knowledge";
import {
  collectCustomerHistory,
  logIndexFailure,
  prepareDocument,
  redactForRetrieval,
  syncCustomerHistoryIndex,
  vectorLiteral,
  type PreparedDocument,
} from "./retrieval-index";

export type RetrievalMode = "semantic" | "lexical_hash" | "keyword";

/** Minimum cosine similarity before a knowledge chunk may answer a visitor. */
export const KNOWLEDGE_MIN_SIMILARITY = { semantic: 0.4, lexical_hash: 0.3 } as const;
/** Customer context is staff-facing; a lower bar still drops unrelated records. */
export const CUSTOMER_MIN_SIMILARITY = { semantic: 0.2, lexical_hash: 0.15 } as const;
/** Bonus that lets a deterministic keyword hit outrank a weak vector neighbour. */
const KEYWORD_BONUS = 0.25;
export const MAX_RETRIEVAL_RESULTS = 10;

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
  // Exact tenant-filtered scan; inactive entries are excluded by the join
  // even if a stale chunk survived.
  const rows = await db.execute<{ source_id: string; similarity: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT c.source_id, c.embedding
      FROM retrieval_chunks c
      JOIN ${knowledgeEntriesTable} k
        ON k.id = c.source_id AND k.organization_id = c.organization_id AND k.is_active
      WHERE c.organization_id = ${organizationId}
        AND c.scope = 'knowledge'
        AND c.embedding_model = ${provider.model}
    )
    SELECT source_id, 1 - (embedding <=> ${literal}::vector) AS similarity
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
  /** Redacted text; never raw email/phone/SSN/policy identifiers. */
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
 * Context for ONE customer. Returns null when the contact is not in this
 * organization, so callers answer 404 without revealing other tenants.
 * Every query is filtered by organization_id AND contact_id.
 */
export async function retrieveCustomerContext(
  organizationId: string,
  contactId: string,
  query: string,
  k = 5,
): Promise<{ mode: RetrievalMode; results: CustomerContextResult[] } | null> {
  const limit = clampK(k, 5);
  const [contact] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, contactId)));
  if (!contact) return null;
  const history = await collectCustomerHistory(organizationId, contactId);
  const documents = history.map(prepareDocument).filter((d): d is PreparedDocument => d !== null);
  const terms = keywordTerms(redactForRetrieval(query));
  const keywordResults = documents
    .map((d) => ({ d, score: keywordScore(terms, d.content) }))
    .filter((r) => r.score > 0);

  const provider = providerFor(organizationId);
  let queryVector: number[] | null = null;
  if (provider) {
    try {
      // Freshen this customer's chunks first (idempotent; only changed records embed).
      await syncCustomerHistoryIndex(provider, organizationId, contactId, history);
      queryVector = await embedQuery(provider, organizationId, query, "customer_query");
    } catch (error) {
      logIndexFailure(organizationId, "customer_history", error);
    }
  }
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
  const rows = await db.execute<{ source_type: CustomerContextResult["sourceType"]; source_id: string; content: string; similarity: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT source_type, source_id, content, embedding
      FROM retrieval_chunks
      WHERE organization_id = ${organizationId}
        AND scope = 'customer'
        AND contact_id = ${contactId}
        AND embedding_model = ${provider.model}
    )
    SELECT source_type, source_id, content, 1 - (embedding <=> ${literal}::vector) AS similarity
    FROM candidates
    ORDER BY embedding <=> ${literal}::vector, source_id
    LIMIT ${MAX_RETRIEVAL_RESULTS * 2}
  `);
  const threshold = CUSTOMER_MIN_SIMILARITY[mode];
  const keywordById = new Map(keywordResults.map((r) => [r.d.sourceId, r.score]));
  const merged = new Map<string, CustomerContextResult>();
  for (const row of rows.rows) {
    const similarity = Number(row.similarity);
    if (!(similarity >= threshold)) continue;
    const kw = keywordById.get(row.source_id) ?? 0;
    merged.set(row.source_id, {
      sourceType: row.source_type,
      sourceId: row.source_id,
      content: row.content,
      similarity,
      score: similarity + (kw ? KEYWORD_BONUS : 0),
    });
  }
  for (const { d } of keywordResults) {
    if (merged.has(d.sourceId)) continue;
    merged.set(d.sourceId, { sourceType: d.sourceType, sourceId: d.sourceId, content: d.content, similarity: null, score: KEYWORD_BONUS });
  }
  const results = [...merged.values()]
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
    .slice(0, limit);
  return { mode, results };
}
