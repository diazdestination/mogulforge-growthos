import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  EmbeddingError,
  OPENAI_EMBEDDINGS_URL,
  createOpenAiEmbeddingProvider,
  getEmbeddingProvider,
  hashEmbedding,
  hashEmbeddingProvider,
} from "./embeddings";

function vectorOf(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === seed ? 1 : 0));
}

describe("OpenAI embedding provider", () => {
  it("sends the documented request shape and returns vectors in input order", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      // Deliberately out of order: the provider must sort by index.
      const data = body.input.map((_, index) => ({ index, embedding: vectorOf(index) })).reverse();
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = createOpenAiEmbeddingProvider({ apiKey: "sk-test-only", fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.embed(["first redacted text", "second redacted text"]);
    expect(provider.model).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(provider.quality).toBe("semantic");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(OPENAI_EMBEDDINGS_URL);
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test-only");
    expect(JSON.parse(String(init!.body))).toEqual({
      model: "text-embedding-3-small",
      input: ["first redacted text", "second redacted text"],
      dimensions: 1536,
      encoding_format: "float",
    });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(result[0]![0]).toBe(1);
    expect(result[1]![1]).toBe(1);
  });

  it("batches large inputs and honours the model override", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { model: string; input: string[] };
      expect(body.model).toBe("text-embedding-3-large");
      return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: vectorOf(0) })) }));
    });
    const provider = getEmbeddingProvider({
      EMBEDDINGS_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test-only",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-large",
    } as NodeJS.ProcessEnv)!;
    expect(provider.model).toBe("text-embedding-3-large");
    const batched = createOpenAiEmbeddingProvider({ apiKey: "k", model: "text-embedding-3-large", fetchImpl: fetchImpl as typeof fetch });
    const out = await batched.embed(Array.from({ length: 130 }, (_, i) => `text ${i}`));
    expect(out).toHaveLength(130);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never puts submitted text or provider bodies into errors", async () => {
    const secretText = "Customer jane@example.com said the gate code is 4411";
    const failing = createOpenAiEmbeddingProvider({
      apiKey: "k",
      fetchImpl: (async () => new Response(`echo: ${secretText}`, { status: 400 })) as typeof fetch,
    });
    const error = await failing.embed([secretText]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe("embedding_request_failed");
    expect((error as EmbeddingError).status).toBe(400);
    expect(JSON.stringify(error)).not.toContain("gate code");
    expect(String(error)).not.toContain("gate code");

    const malformed = createOpenAiEmbeddingProvider({
      apiKey: "k",
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }))) as typeof fetch,
    });
    await expect(malformed.embed(["x"])).rejects.toMatchObject({ code: "embedding_response_invalid" });

    const timedOut = createOpenAiEmbeddingProvider({
      apiKey: "k",
      fetchImpl: (async () => {
        throw new DOMException("timed out", "TimeoutError");
      }) as typeof fetch,
    });
    await expect(timedOut.embed(["x"])).rejects.toMatchObject({ code: "embedding_timeout" });
  });
});

describe("provider selection", () => {
  it("is explicit opt-in: an OpenAI key alone never enables embedding spend", () => {
    expect(getEmbeddingProvider({ OPENAI_API_KEY: "sk-test-only" } as NodeJS.ProcessEnv)).toBeNull();
    expect(getEmbeddingProvider({ EMBEDDINGS_PROVIDER: "none" } as NodeJS.ProcessEnv)).toBeNull();
    expect(getEmbeddingProvider({ EMBEDDINGS_PROVIDER: "hash" } as NodeJS.ProcessEnv)).toBe(hashEmbeddingProvider);
    expect(() => getEmbeddingProvider({ EMBEDDINGS_PROVIDER: "openai" } as NodeJS.ProcessEnv)).toThrow(EmbeddingError);
    expect(() => getEmbeddingProvider({ EMBEDDINGS_PROVIDER: "mystery" } as NodeJS.ProcessEnv)).toThrow(EmbeddingError);
  });
});

describe("hash embedder", () => {
  it("is deterministic, normalised and lexical", async () => {
    const a = hashEmbedding("Furnace repair and tune-up");
    expect(a).toHaveLength(1536);
    expect(hashEmbedding("Furnace repair and tune-up")).toEqual(a);
    expect(Math.sqrt(a.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 10);
    const [related, unrelated] = await hashEmbeddingProvider.embed(["furnace repairs", "swallow airspeed"]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a, related!)).toBeGreaterThan(dot(a, unrelated!));
    expect(hashEmbeddingProvider.quality).toBe("lexical_hash");
    // Stop-word-only text still yields a valid non-zero vector for pgvector.
    expect(hashEmbedding("the and of").some((v) => v !== 0)).toBe(true);
  });
});
