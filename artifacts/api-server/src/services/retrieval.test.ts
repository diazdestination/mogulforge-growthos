import {
  activitiesTable,
  contactsTable,
  customerMemoriesTable,
  db,
  knowledgeEntriesTable,
  leadsTable,
  organizationsTable,
  retrievalChunksTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { TOOLS } from "./assistant";
import { handleMessage, startConversation } from "./concierge";
import { createCustomerMemory, retireCustomerMemory } from "./customer-memory";
import {
  hashEmbeddingProvider,
  setEmbeddingProviderForTests,
  type EmbeddingProvider,
} from "./embeddings";
import { createKnowledgeEntry, deleteKnowledgeEntry, updateKnowledgeEntry } from "./knowledge";
import { answerFromKnowledge, retrieveCustomerContext, searchKnowledge } from "./retrieval";
import { reindexOrganization, syncCustomerHistoryIndex } from "./retrieval-index";

const stamp = Date.now();
let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
let alice: string; // org A customer
let bob: string; // org A customer
let carol: string; // org B customer

async function chunkCount(organizationId: string, extra?: ReturnType<typeof eq>) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(retrievalChunksTable)
    .where(and(eq(retrievalChunksTable.organizationId, organizationId), extra));
  return row!.n;
}

beforeAll(async () => {
  const [a] = await db.insert(organizationsTable).values({ name: "Retrieval Org A", slug: `test-retrieval-a-${stamp}` }).returning();
  const [b] = await db.insert(organizationsTable).values({ name: "Retrieval Org B", slug: `test-retrieval-b-${stamp}` }).returning();
  orgA = a!.id;
  orgB = b!.id;
  const [ua] = await db.insert(usersTable).values({ email: `retrieval-a-${stamp}@example.com`, organizationId: orgA, role: "admin" }).returning();
  const [ub] = await db.insert(usersTable).values({ email: `retrieval-b-${stamp}@example.com`, organizationId: orgB, role: "admin" }).returning();
  userA = ua!.id;
  userB = ub!.id;
  const [c1] = await db
    .insert(contactsTable)
    .values({ organizationId: orgA, firstName: "Alice", lastName: "Rivers", email: "alice@example.com", phone: "555-201-3344" })
    .returning();
  const [c2] = await db.insert(contactsTable).values({ organizationId: orgA, firstName: "Bob", lastName: "Stone" }).returning();
  const [c3] = await db.insert(contactsTable).values({ organizationId: orgB, firstName: "Carol", lastName: "Hart" }).returning();
  alice = c1!.id;
  bob = c2!.id;
  carol = c3!.id;
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: orgA, contactId: alice, serviceType: "furnace repair", summary: "Furnace short cycling in basement. Call back at 555-201-3344 or alice@example.com." })
    .returning();
  await db.insert(activitiesTable).values({
    organizationId: orgA,
    leadId: lead!.id,
    type: "note",
    title: "Site visit notes",
    body: "Replaced flame sensor on the furnace; recommended annual tune-up.",
  });
  await db.insert(activitiesTable).values({
    organizationId: orgA,
    contactId: bob,
    type: "note",
    title: "Roof inspection",
    body: "Hail damage on north slope shingles.",
  });
  await db.insert(activitiesTable).values({
    organizationId: orgB,
    contactId: carol,
    type: "note",
    title: "Secret furnace note",
    body: "Org B furnace repair details must never reach org A.",
  });
});

afterEach(() => {
  setEmbeddingProviderForTests(undefined);
});

afterAll(async () => {
  setEmbeddingProviderForTests(undefined);
  await deleteTestOrgs(orgA, orgB);
});

describe("pgvector availability", () => {
  it("has the vector extension and the HNSW cosine index", async () => {
    const ext = await db.execute<{ extname: string }>(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(ext.rows).toHaveLength(1);
    const idx = await db.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'retrieval_chunks_embedding_hnsw_idx'`,
    );
    expect(idx.rows[0]?.indexdef).toMatch(/hnsw.*vector_cosine_ops/);
  });
});

describe("knowledge retrieval", () => {
  it("ranks the nearest entry first with the hash embedder and labels the mode honestly", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const warranty = await createKnowledgeEntry(orgA, {
      category: "warranty",
      title: "Workmanship warranty",
      content: "Every roof replacement includes a ten year workmanship warranty.",
    });
    const financing = await createKnowledgeEntry(orgA, {
      category: "financing",
      title: "Financing plans",
      content: "Twelve month same as cash financing on approved credit.",
    });
    const result = await searchKnowledge(orgA, "how long does the workmanship warranty last on a roof replacement", 2);
    expect(result.mode).toBe("lexical_hash");
    expect(result.results[0]?.entry.id).toBe(warranty!.id);
    expect(result.results[0]?.similarity).toBeGreaterThan(0.3);
    const second = await searchKnowledge(orgA, "same as cash financing credit", 2);
    expect(second.results[0]?.entry.id).toBe(financing!.id);
    // Unrelated questions never borrow an answer.
    expect(await answerFromKnowledge(orgA, "What is the airspeed of a swallow?")).toBeNull();
    // Tenant isolation: org B never sees org A entries or chunks.
    expect((await searchKnowledge(orgB, "workmanship warranty roof replacement", 3)).results).toEqual([]);
    expect(await chunkCount(orgB)).toBe(0);
  });

  it("falls back to keyword matching when no provider is configured", async () => {
    setEmbeddingProviderForTests(null);
    const result = await searchKnowledge(orgA, "Do you offer financing plans?", 3);
    expect(result.mode).toBe("keyword");
    expect(result.results[0]?.entry.title).toBe("Financing plans");
    expect(result.results[0]?.similarity).toBeNull();
  });

  it("keeps CRUD working when the embedder throws and records the failure status", async () => {
    const failing: EmbeddingProvider = {
      model: "failing-test-model",
      quality: "semantic",
      embed: async () => {
        throw Object.assign(new Error("provider down"), { code: "embedding_request_failed" });
      },
    };
    setEmbeddingProviderForTests(failing);
    const statuses: string[] = [];
    const entry = await createKnowledgeEntry(
      orgA,
      { category: "hours", title: "Office hours", content: "Open weekdays 8 to 5." },
      { onIndexStatus: (s) => statuses.push(s) },
    );
    expect(entry).not.toBeNull();
    expect(statuses).toEqual(["failed"]);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, entry!.id))).toBe(0);
    // A failing query embedding degrades to keyword answers, never an error.
    const result = await searchKnowledge(orgA, "What are your office hours?", 1);
    expect(result.mode).toBe("keyword");
    expect(result.results[0]?.entry.id).toBe(entry!.id);
    expect(await deleteKnowledgeEntry(orgA, entry!.id)).toBe(true);
  });

  it("removes chunks on deactivate and delete, and reindex is idempotent", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const entry = await createKnowledgeEntry(orgA, {
      category: "service_area",
      title: "Service area",
      content: "We serve the north county and the lake district.",
    });
    const sourceFilter = eq(retrievalChunksTable.sourceId, entry!.id);
    expect(await chunkCount(orgA, sourceFilter)).toBe(1);
    await updateKnowledgeEntry(orgA, entry!.id, { isActive: false });
    expect(await chunkCount(orgA, sourceFilter)).toBe(0);
    await updateKnowledgeEntry(orgA, entry!.id, { isActive: true });
    expect(await chunkCount(orgA, sourceFilter)).toBe(1);

    const first = await reindexOrganization(hashEmbeddingProvider, orgA, { limit: 50 });
    const second = await reindexOrganization(hashEmbeddingProvider, orgA, { limit: 50 });
    expect(second.knowledge).toMatchObject({ indexed: 0, removed: 0 });
    expect(second.knowledge!.unchanged).toBe(first.knowledge!.indexed + first.knowledge!.unchanged);
    expect(second.customers.indexed).toBe(0);
    expect(second.customers.unchanged).toBe(first.customers.indexed + first.customers.unchanged);

    expect(await deleteKnowledgeEntry(orgA, entry!.id)).toBe(true);
    expect(await chunkCount(orgA, sourceFilter)).toBe(0);
  });

  it("concierge still answers from the knowledge base with retrieval enabled", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    await createKnowledgeEntry(orgA, {
      category: "faq",
      title: "Emergency tarping",
      content: "We provide emergency roof tarping through Acme Tarps within 24 hours.",
    });
    const started = await startConversation({ organizationId: orgA });
    await handleMessage({ organizationId: orgA, conversationId: started.conversationId, content: "Roof leak or water damage" });
    await handleMessage({ organizationId: orgA, conversationId: started.conversationId, content: "No" });
    const reply = await handleMessage({
      organizationId: orgA,
      conversationId: started.conversationId,
      content: "Do you do emergency roof tarping?",
    });
    expect(reply!.messages.join("\n")).toContain("Acme Tarps");
  });
});

describe("customer context retrieval", () => {
  it("is strictly filtered by organization and contact, and redacts identifiers", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const own = await retrieveCustomerContext(orgA, alice, "furnace flame sensor repair", 5);
    expect(own?.mode).toBe("lexical_hash");
    expect(own!.results.length).toBeGreaterThan(0);
    const text = own!.results.map((r) => r.content).join("\n");
    expect(text).toContain("flame sensor");
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("555-201-3344");
    expect(text).not.toContain("Org B");
    // Another customer in the same company never sees Alice's records.
    const other = await retrieveCustomerContext(orgA, bob, "furnace flame sensor repair", 5);
    expect(other!.results.map((r) => r.content).join("\n")).not.toContain("flame sensor");
    // Org B cannot read an org A customer at all, and org A cannot read org B's.
    expect(await retrieveCustomerContext(orgB, alice, "furnace", 5)).toBeNull();
    expect(await retrieveCustomerContext(orgA, carol, "furnace", 5)).toBeNull();
    // Stored chunks never cross tenants.
    const leaked = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(retrievalChunksTable)
      .where(and(eq(retrievalChunksTable.organizationId, orgB), eq(retrievalChunksTable.contactId, alice)));
    expect(leaked[0]!.n).toBe(0);
  });

  it("returns the nearest history first and reindexes idempotently", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const first = await syncCustomerHistoryIndex(hashEmbeddingProvider, orgA, alice);
    const before = await db
      .select({ updatedAt: retrievalChunksTable.updatedAt })
      .from(retrievalChunksTable)
      .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.contactId, alice)));
    const second = await syncCustomerHistoryIndex(hashEmbeddingProvider, orgA, alice);
    expect(second).toEqual({ indexed: 0, unchanged: first.indexed + first.unchanged, removed: 0 });
    const after = await db
      .select({ updatedAt: retrievalChunksTable.updatedAt })
      .from(retrievalChunksTable)
      .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.contactId, alice)));
    expect(after.map((r) => r.updatedAt.getTime()).sort()).toEqual(before.map((r) => r.updatedAt.getTime()).sort());
    const ranked = await retrieveCustomerContext(orgA, alice, "flame sensor replaced tune-up", 3);
    expect(ranked!.results[0]?.sourceType).toBe("activity");
  });

  it("indexes memories, and retiring one removes it from retrieval", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const { memory, retrievalIndex } = await createCustomerMemory(orgA, alice, userA, {
      kind: "access_note",
      content: "Gate code is kept by the office; large dog in the backyard.",
    });
    expect(retrievalIndex).toBe("indexed");
    const found = await retrieveCustomerContext(orgA, alice, "gate code dog backyard", 3);
    expect(found!.results[0]).toMatchObject({ sourceType: "customer_memory", sourceId: memory.id });
    // Other company cannot retire or see it.
    await expect(retireCustomerMemory(orgB, alice, memory.id, userB)).rejects.toMatchObject({ code: "memory_not_found" });
    await retireCustomerMemory(orgA, alice, memory.id, userA);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, memory.id))).toBe(0);
    const gone = await retrieveCustomerContext(orgA, alice, "gate code dog backyard", 3);
    expect(gone!.results.some((r) => r.sourceId === memory.id)).toBe(false);
    await expect(retireCustomerMemory(orgA, alice, memory.id, userA)).rejects.toMatchObject({ code: "memory_already_retired" });
    const [row] = await db.select().from(customerMemoriesTable).where(eq(customerMemoriesTable.id, memory.id));
    expect(row).toMatchObject({ status: "retired", retiredByUserId: userA });
  });

  it("verifies memory provenance belongs to the same customer", async () => {
    const [bobActivity] = await db
      .select({ id: activitiesTable.id })
      .from(activitiesTable)
      .where(and(eq(activitiesTable.organizationId, orgA), eq(activitiesTable.contactId, bob)));
    await expect(
      createCustomerMemory(orgA, alice, userA, { kind: "fact", content: "Borrowed note", sourceType: "activity", sourceId: bobActivity!.id }),
    ).rejects.toMatchObject({ code: "memory_source_not_found" });
    const noted = await createCustomerMemory(orgA, bob, userA, {
      kind: "fact",
      content: "North slope hail damage noted",
      sourceType: "activity",
      sourceId: bobActivity!.id,
    });
    expect(noted.memory.sourceId).toBe(bobActivity!.id);
    await expect(createCustomerMemory(orgB, alice, userB, { kind: "fact", content: "x" })).rejects.toMatchObject({ code: "customer_not_found" });
  });

  it("uses keyword matching without a provider", async () => {
    setEmbeddingProviderForTests(null);
    const result = await retrieveCustomerContext(orgA, bob, "hail shingles", 5);
    expect(result!.mode).toBe("keyword");
    expect(result!.results[0]?.content).toContain("Hail damage");
  });
});

describe("assistant search_customer_history tool", () => {
  it("is scoped to the chat's organization", async () => {
    setEmbeddingProviderForTests(null);
    const tool = TOOLS.search_customer_history!;
    const own = (await tool.run(orgA, { query: "flame sensor", contactId: alice })) as { found: boolean; snippets: Array<{ text: string }> };
    expect(own.found).toBe(true);
    expect(own.snippets.map((s) => s.text).join(" ")).toContain("flame sensor");
    // A model-supplied id from another company is simply not found.
    const foreign = (await tool.run(orgB, { query: "flame sensor", contactId: alice })) as { found: boolean };
    expect(foreign.found).toBe(false);
    // Name lookup only searches the chat's own company.
    const byName = (await tool.run(orgB, { query: "furnace", customer: "Alice Rivers" })) as { found: boolean };
    expect(byName.found).toBe(false);
    const resolved = (await tool.run(orgA, { query: "furnace", customer: "Alice Rivers" })) as { contactId: string };
    expect(resolved.contactId).toBe(alice);
    expect(await tool.run(orgA, { query: "furnace", contactId: "not-a-uuid" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("schema guards", () => {
  it("rejects a knowledge chunk tied to a customer and a customer chunk without one", async () => {
    const vector = `[${new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
    const [entry] = await db.select({ id: knowledgeEntriesTable.id }).from(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.organizationId, orgA)).limit(1);
    await expect(
      db.execute(sql`INSERT INTO retrieval_chunks (organization_id, scope, contact_id, source_type, source_id, content, content_sha256, embedding_model, embedding)
        VALUES (${orgA}, 'knowledge', ${alice}, 'knowledge_entry', ${entry!.id}, 'x', ${"a".repeat(64)}, 'm', ${vector}::vector)`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO retrieval_chunks (organization_id, scope, contact_id, source_type, source_id, content, content_sha256, embedding_model, embedding)
        VALUES (${orgA}, 'customer', NULL, 'lead', ${entry!.id}, 'x', ${"a".repeat(64)}, 'm', ${vector}::vector)`),
    ).rejects.toThrow();
    // Cross-tenant contact link is refused by the composite foreign key.
    await expect(
      db.execute(sql`INSERT INTO retrieval_chunks (organization_id, scope, contact_id, source_type, source_id, content, content_sha256, embedding_model, embedding)
        VALUES (${orgB}, 'customer', ${alice}, 'lead', ${entry!.id}, 'x', ${"a".repeat(64)}, 'm', ${vector}::vector)`),
    ).rejects.toThrow();
  });
});
