/**
 * Embedding providers for the retrieval layer.
 *
 * Selection is deterministic and explicit (EMBEDDINGS_PROVIDER):
 * - unset / "none"  → no provider. Retrieval uses the existing keyword logic.
 * - "openai"        → OpenAI `text-embedding-3-small` (override with
 *                     OPENAI_EMBEDDING_MODEL) at 1536 dimensions. Requires
 *                     OPENAI_API_KEY. Opt-in only: having an OpenAI key for
 *                     other features never starts embedding spend by itself.
 * - "hash"          → deterministic local feature-hashing embedder. It is
 *                     LEXICAL (shared words), not semantic, and labels itself
 *                     so; used in tests and offline/local development.
 *
 * Text handed to `embed` must already be redacted by the caller. Errors never
 * include the submitted text or the provider response body.
 */
import { createHash } from "node:crypto";

import { RETRIEVAL_EMBEDDING_DIMENSIONS } from "@workspace/db";

export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const HASH_EMBEDDING_MODEL = "local-hash-v1";
const OPENAI_BATCH_SIZE = 64;
const OPENAI_TIMEOUT_MS = 15_000;
/** Per-input character cap before embedding (~2k tokens); chunks are short anyway. */
export const EMBEDDING_INPUT_MAX_CHARS = 8000;

export type EmbeddingQuality = "semantic" | "lexical_hash";

export interface EmbeddingProvider {
  /** Stored with every chunk; retrieval only compares vectors from the same model. */
  readonly model: string;
  readonly quality: EmbeddingQuality;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(
    public readonly code:
      | "embedding_provider_misconfigured"
      | "embedding_request_failed"
      | "embedding_timeout"
      | "embedding_response_invalid",
    public readonly status?: number,
  ) {
    super(code);
    this.name = "EmbeddingError";
  }
}

/* ------------------------------------------------------- hash embedder */

const HASH_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "do", "does", "you", "your", "we", "our", "i", "my", "me", "it", "that",
  "this", "with", "can", "how", "what", "when", "where", "who", "why", "have",
  "has", "will", "would", "should", "could", "be", "was", "were", "about",
  "any", "get", "if", "at", "by", "from", "there", "they", "them",
]);

function hashTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !HASH_STOP_WORDS.has(word))
    // Light stemming so "leak"/"leaks"/"leaking" share a bucket.
    .map((word) => word.replace(/(?:ing|ed|es|s)$/, "") || word);
}

/** Deterministic signed feature hashing into 1536 buckets, L2-normalised. */
export function hashEmbedding(text: string): number[] {
  const vector = new Array<number>(RETRIEVAL_EMBEDDING_DIMENSIONS).fill(0);
  for (const token of hashTokens(text)) {
    const digest = createHash("sha256").update(token).digest();
    const bucket = digest.readUInt32BE(0) % RETRIEVAL_EMBEDDING_DIMENSIONS;
    vector[bucket] += digest[4]! & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  // pgvector cannot compute a cosine distance for an all-zero vector, so an
  // empty/stop-word-only text gets a fixed tiny basis vector instead.
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export const hashEmbeddingProvider: EmbeddingProvider = {
  model: HASH_EMBEDDING_MODEL,
  quality: "lexical_hash",
  async embed(texts) {
    return texts.map((text) => hashEmbedding(text));
  },
};

/* ----------------------------------------------------- OpenAI embedder */

export function createOpenAiEmbeddingProvider(options: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): EmbeddingProvider {
  const model = options.model?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPENAI_TIMEOUT_MS;
  return {
    model,
    quality: "semantic",
    async embed(texts) {
      const result: number[][] = [];
      for (let start = 0; start < texts.length; start += OPENAI_BATCH_SIZE) {
        const batch = texts
          .slice(start, start + OPENAI_BATCH_SIZE)
          .map((text) => text.slice(0, EMBEDDING_INPUT_MAX_CHARS));
        let response: Response;
        try {
          response = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model,
              input: batch,
              dimensions: RETRIEVAL_EMBEDDING_DIMENSIONS,
              encoding_format: "float",
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const name = (error as { name?: string })?.name;
          throw new EmbeddingError(
            name === "TimeoutError" || name === "AbortError" ? "embedding_timeout" : "embedding_request_failed",
          );
        }
        // The response body is never read into an error: it can echo input.
        if (!response.ok) throw new EmbeddingError("embedding_request_failed", response.status);
        const body = (await response.json().catch(() => null)) as {
          data?: Array<{ index?: number; embedding?: unknown }>;
        } | null;
        const data = body?.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new EmbeddingError("embedding_response_invalid");
        }
        const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const item of ordered) {
          const embedding = item.embedding;
          if (
            !Array.isArray(embedding) ||
            embedding.length !== RETRIEVAL_EMBEDDING_DIMENSIONS ||
            !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
          ) {
            throw new EmbeddingError("embedding_response_invalid");
          }
          result.push(embedding as number[]);
        }
      }
      return result;
    },
  };
}

/* ------------------------------------------------------------ selection */

let override: EmbeddingProvider | null | undefined;

/** Test seam: force a provider (or `null` for none). Pass `undefined` to restore env selection. */
export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
  override = provider;
}

/**
 * The configured provider, or null when retrieval must use keyword matching.
 * Throws for an explicit-but-broken configuration so it is never silently
 * downgraded to a different quality.
 */
export function getEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  if (override !== undefined) return override;
  const selected = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase() ?? "";
  if (selected === "" || selected === "none") return null;
  if (selected === "hash") return hashEmbeddingProvider;
  if (selected === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new EmbeddingError("embedding_provider_misconfigured");
    return createOpenAiEmbeddingProvider({ apiKey, model: env.OPENAI_EMBEDDING_MODEL });
  }
  throw new EmbeddingError("embedding_provider_misconfigured");
}

/** Like getEmbeddingProvider, but a misconfiguration means "no provider" (callers log it). */
export function tryGetEmbeddingProvider(env: NodeJS.ProcessEnv = process.env):
  | { provider: EmbeddingProvider | null; misconfigured: false }
  | { provider: null; misconfigured: true } {
  try {
    return { provider: getEmbeddingProvider(env), misconfigured: false };
  } catch {
    return { provider: null, misconfigured: true };
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
