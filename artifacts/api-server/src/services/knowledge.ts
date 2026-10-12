/**
 * Org knowledge base — admin-managed facts that ground the concierge and
 * outreach drafting. The concierge can never invent an answer: it either
 * quotes a stored entry or admits it doesn't know. Which entry is chosen is
 * decided by services/retrieval.ts (pgvector similarity merged with the
 * deterministic keyword rule below, or keyword-only without a provider).
 *
 * Retrieval chunks are derived data: CRUD never fails because embedding
 * failed. Deactivation/deletion removes the entry's chunks in the same
 * transaction; create/update re-index best-effort afterwards.
 */
import {
  db,
  knowledgeEntriesTable,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeCategory,
  type KnowledgeEntry,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

import { removeChunks, syncKnowledgeEntryIndex, type IndexStatus } from "./retrieval-index";

const MAX_TITLE = 200;
const MAX_CONTENT = 4000;

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}

/** Receives the best-effort retrieval index outcome (never an exception). */
export interface KnowledgeIndexOptions {
  onIndexStatus?: (status: IndexStatus) => void;
}

export async function listKnowledgeEntries(organizationId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.organizationId, organizationId))
    .orderBy(asc(knowledgeEntriesTable.category), asc(knowledgeEntriesTable.createdAt));
}

export async function createKnowledgeEntry(
  organizationId: string,
  input: { category: string; title: string; content: string; source?: string; isActive?: boolean },
  options: KnowledgeIndexOptions = {},
): Promise<KnowledgeEntry | null> {
  if (!isKnowledgeCategory(input.category)) return null;
  const title = input.title.trim().slice(0, MAX_TITLE);
  const content = input.content.trim().slice(0, MAX_CONTENT);
  if (!title || !content) return null;
  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      organizationId,
      category: input.category,
      title,
      content,
      source: input.source === "seed" ? "seed" : "manual",
      isActive: input.isActive ?? true,
    })
    .returning();
  if (row) {
    // Always sync; the callback only observes the outcome.
    const status = await syncKnowledgeEntryIndex(organizationId, row.id);
    options.onIndexStatus?.(status);
  }
  return row;
}

export async function updateKnowledgeEntry(
  organizationId: string,
  id: string,
  patch: { category?: string; title?: string; content?: string; isActive?: boolean },
  options: KnowledgeIndexOptions = {},
): Promise<KnowledgeEntry | null | "invalid"> {
  const set: Record<string, unknown> = {};
  if (patch.category !== undefined) {
    if (!isKnowledgeCategory(patch.category)) return "invalid";
    set.category = patch.category;
  }
  if (patch.title !== undefined) {
    const t = patch.title.trim().slice(0, MAX_TITLE);
    if (!t) return "invalid";
    set.title = t;
  }
  if (patch.content !== undefined) {
    const c = patch.content.trim().slice(0, MAX_CONTENT);
    if (!c) return "invalid";
    set.content = c;
  }
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (Object.keys(set).length === 0) return "invalid";
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(knowledgeEntriesTable)
      .set(set)
      .where(
        and(
          eq(knowledgeEntriesTable.id, id),
          eq(knowledgeEntriesTable.organizationId, organizationId),
        ),
      )
      .returning();
    // A deactivated entry must leave retrieval atomically with the change.
    if (updated && !updated.isActive) await removeChunks(organizationId, "knowledge_entry", [id], tx);
    return updated;
  });
  if (row) {
    const status = row.isActive ? await syncKnowledgeEntryIndex(organizationId, row.id) : "removed";
    options.onIndexStatus?.(status);
  }
  return row ?? null;
}

export async function deleteKnowledgeEntry(
  organizationId: string,
  id: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.id, id),
          eq(knowledgeEntriesTable.organizationId, organizationId),
        ),
      )
      .returning({ id: knowledgeEntriesTable.id });
    if (rows.length > 0) await removeChunks(organizationId, "knowledge_entry", [id], tx);
    return rows.length > 0;
  });
}

async function activeEntries(organizationId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.organizationId, organizationId),
        eq(knowledgeEntriesTable.isActive, true),
      ),
    )
    .orderBy(asc(knowledgeEntriesTable.category), asc(knowledgeEntriesTable.createdAt));
}

/**
 * Compact "Org knowledge" fact lines for AI prompts (sales summaries,
 * outreach drafting). Bounded so a huge knowledge base can't blow the prompt.
 */
export async function buildKnowledgeFacts(
  organizationId: string,
  maxEntries = 30,
): Promise<string[]> {
  const entries = await activeEntries(organizationId);
  return entries
    .slice(0, maxEntries)
    .map((e) => `Org knowledge [${e.category}] ${e.title}: ${e.content.slice(0, 400)}`);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "do", "does", "you", "your", "we", "our", "i", "my", "me", "it", "that",
  "this", "with", "can", "how", "what", "when", "where", "who", "why", "have",
  "has", "will", "would", "should", "could", "be", "was", "were", "about",
  "any", "get", "if", "at", "by", "from", "there", "they", "them",
]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

export interface KeywordKnowledgeMatch {
  entry: KnowledgeEntry;
  /** +2 per significant word found in the title, +1 per word found only in the body. */
  score: number;
}

/**
 * Deterministic keyword scoring (no AI): an entry is a meaningful match when
 * ≥2 significant question words overlap it, or 1 overlaps and appears in the
 * title. Returned best-first; ties keep the input (category, created) order.
 */
export function scoreKnowledgeKeywords(
  entries: KnowledgeEntry[],
  question: string,
): KeywordKnowledgeMatch[] {
  const words = significantWords(question);
  if (words.length === 0) return [];
  const matches: KeywordKnowledgeMatch[] = [];
  for (const entry of entries) {
    const haystackTitle = entry.title.toLowerCase();
    const haystackBody = entry.content.toLowerCase();
    let score = 0;
    let titleHit = false;
    for (const w of words) {
      if (haystackTitle.includes(w)) {
        score += 2;
        titleHit = true;
      } else if (haystackBody.includes(w)) {
        score += 1;
      }
    }
    const overlaps = words.filter(
      (w) => haystackTitle.includes(w) || haystackBody.includes(w),
    ).length;
    if (overlaps >= 2 || (overlaps === 1 && titleHit)) matches.push({ entry, score });
  }
  // Stable sort: equal scores keep the earlier entry first, as before.
  return matches.sort((a, b) => b.score - a.score);
}

/** Active entries for one company, in deterministic (category, created) order. */
export async function listActiveKnowledgeEntries(organizationId: string): Promise<KnowledgeEntry[]> {
  return activeEntries(organizationId);
}

/**
 * Keyword-only knowledge lookup (the pre-retrieval behaviour). Returns null
 * when the knowledge base can't answer — callers must then use the
 * "I don't know" fallback rather than guessing. The concierge now uses
 * searchKnowledge (services/retrieval.ts), which merges vector similarity
 * with this same keyword rule and falls back to it without a provider.
 */
export async function findKnowledgeAnswer(
  organizationId: string,
  question: string,
): Promise<KnowledgeEntry | null> {
  if (significantWords(question).length === 0) return null;
  const entries = await activeEntries(organizationId);
  return scoreKnowledgeKeywords(entries, question)[0]?.entry ?? null;
}
