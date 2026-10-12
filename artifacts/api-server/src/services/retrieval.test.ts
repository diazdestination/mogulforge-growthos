import {
  activitiesTable,
  appointmentsTable,
  contactsTable,
  customerMemoriesTable,
  db,
  invoicesTable,
  knowledgeEntriesTable,
  leadsTable,
  organizationsTable,
  retrievalChunksTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
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
import {
  knowledgeDocument,
  redactForRetrieval,
  reindexOrganization,
  syncCustomerHistoryIndex,
  syncKnowledgeEntryIndex,
} from "./retrieval-index";

const stamp = Date.now();
const ALL = { canReadInvoices: true };
const NO_INVOICES = { canReadInvoices: false };
let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
let alice: string; // org A customer
let bob: string; // org A customer
let carol: string; // org B customer
let aliceLead: string;
let invoiceId: string;
let invoiceActivityId: string;
let contradictoryActivityId: string;
let contradictoryAppointmentId: string;

async function chunkCount(organizationId: string, extra?: SQL) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(retrievalChunksTable)
    .where(and(eq(retrievalChunksTable.organizationId, organizationId), extra));
  return row!.n;
}

const text = (result: Awaited<ReturnType<typeof retrieveCustomerContext>>) =>
  result!.results.map((r) => r.content).join("\n");

/**
 * A provider whose FIRST embed call blocks until released, so a test can act
 * while an index write is in flight. Same model as the hash embedder.
 */
function gatedProvider() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  const provider: EmbeddingProvider = {
    model: hashEmbeddingProvider.model,
    quality: "lexical_hash",
    async embed(texts) {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return hashEmbeddingProvider.embed(texts);
    },
  };
  return { provider, release, started };
}

/**
 * A provider whose QUERY embedding (the single text equal to `query`) blocks
 * until released, then returns a vector ("semantic") or throws ("fallback").
 * Index embeddings use the hash embedder, or fail when `indexFails` so an old
 * chunk deliberately survives an edit.
 */
function queryGatedProvider(query: string, outcome: "semantic" | "fallback", indexFails = false) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const target = redactForRetrieval(query);
  const provider: EmbeddingProvider = {
    model: hashEmbeddingProvider.model,
    quality: "lexical_hash",
    async embed(texts) {
      if (texts.length === 1 && texts[0] === target) {
        entered();
        await gate;
        if (outcome === "fallback") throw Object.assign(new Error("query embed failed"), { code: "embedding_request_failed" });
        return hashEmbeddingProvider.embed(texts);
      }
      if (indexFails) throw Object.assign(new Error("index embed failed"), { code: "embedding_request_failed" });
      return hashEmbeddingProvider.embed(texts);
    },
  };
  return { provider, release, started };
}

beforeAll(async () => {
  const [a] = await db.insert(organizationsTable).values({ name: "Retrieval Org A", slug: `test-retrieval-a-${stamp}` }).returning();
  const [b] = await db.insert(organizationsTable).values({ name: "Retrieval Org B", slug: `test-retrieval-b-${stamp}` }).returning();
  orgA = a!.id;
  orgB = b!.id;
  const verified = new Date();
  const [ua] = await db
    .insert(usersTable)
    .values({ email: `retrieval-a-${stamp}@example.com`, organizationId: orgA, role: "admin", emailVerifiedAt: verified })
    .returning();
  const [ub] = await db
    .insert(usersTable)
    .values({ email: `retrieval-b-${stamp}@example.com`, organizationId: orgB, role: "admin", emailVerifiedAt: verified })
    .returning();
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
  aliceLead = lead!.id;
  await db.insert(activitiesTable).values({
    organizationId: orgA,
    leadId: aliceLead,
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
  // Contradictory parents: directly Bob's, but through Alice's lead.
  const [contradictory] = await db
    .insert(activitiesTable)
    .values({ organizationId: orgA, contactId: bob, leadId: aliceLead, type: "note", title: "Zebra crossing", body: "Zebra contradiction marker." })
    .returning();
  contradictoryActivityId = contradictory!.id;
  const [appointment] = await db
    .insert(appointmentsTable)
    .values({ organizationId: orgA, contactId: bob, leadId: aliceLead, scheduledStart: new Date("2035-01-02T15:00:00Z"), notes: "Zebra visit marker." })
    .returning();
  contradictoryAppointmentId = appointment!.id;
  // Invoice-restricted sources for Alice.
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      organizationId: orgA,
      leadId: aliceLead,
      createdByUserId: userA,
      draftDocument: {
        title: "Compressor replacement",
        currency: "USD",
        issuerName: "Synthetic HVAC",
        issuerAddress: null,
        customerName: "Alice Rivers",
        customerAddress: "1 Private Lane",
        dueDate: null,
        notes: "Compressor warranty registered.",
        lineItems: [{ description: "Compressor unit", quantity: "1", unitPriceCents: 120000, totalCents: 120000 }],
        subtotalCents: 120000,
        taxCents: 0,
        totalCents: 120000,
      },
    })
    .returning();
  invoiceId = invoice!.id;
  const [invoiceActivity] = await db
    .insert(activitiesTable)
    .values({ organizationId: orgA, contactId: alice, type: "invoice_event", title: "Invoice sent", body: "Compressor balance due." })
    .returning();
  invoiceActivityId = invoiceActivity!.id;
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
    expect(await answerFromKnowledge(orgA, "What is the airspeed of a swallow?")).toBeNull();
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
    const result = await searchKnowledge(orgA, "What are your office hours?", 1);
    expect(result.mode).toBe("keyword");
    expect(result.results[0]?.entry.id).toBe(entry!.id);
    expect(await deleteKnowledgeEntry(orgA, entry!.id)).toBe(true);
  });

  it("indexes without a status callback, removes chunks on deactivate/delete, and reindex is idempotent", async () => {
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

describe("in-flight index writes never resurrect or overwrite", () => {
  it("a knowledge entry deleted while its embedding is in flight leaves no chunk", async () => {
    setEmbeddingProviderForTests(null);
    const entry = await createKnowledgeEntry(orgA, { category: "faq", title: "Gutter guards", content: "We install mesh gutter guards." });
    const gated = gatedProvider();
    setEmbeddingProviderForTests(gated.provider);
    const pending = syncKnowledgeEntryIndex(orgA, entry!.id);
    await gated.started;
    expect(await deleteKnowledgeEntry(orgA, entry!.id)).toBe(true);
    gated.release();
    expect(await pending).toBe("removed");
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, entry!.id))).toBe(0);
  });

  it("a deactivated entry is not re-indexed by an in-flight write", async () => {
    setEmbeddingProviderForTests(null);
    const entry = await createKnowledgeEntry(orgA, { category: "faq", title: "Skylights", content: "We repair skylight flashing." });
    const gated = gatedProvider();
    setEmbeddingProviderForTests(gated.provider);
    const pending = syncKnowledgeEntryIndex(orgA, entry!.id);
    await gated.started;
    await updateKnowledgeEntry(orgA, entry!.id, { isActive: false });
    gated.release();
    expect(await pending).toBe("removed");
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, entry!.id))).toBe(0);
    expect((await searchKnowledge(orgA, "skylight flashing repair", 3)).results.some((r) => r.entry.id === entry!.id)).toBe(false);
  });

  it("an older in-flight embedding never overwrites a newer edit", async () => {
    setEmbeddingProviderForTests(null);
    const entry = await createKnowledgeEntry(orgA, { category: "faq", title: "Chimney caps", content: "Copper chimney caps only." });
    const gated = gatedProvider();
    setEmbeddingProviderForTests(gated.provider);
    const stale = syncKnowledgeEntryIndex(orgA, entry!.id); // embeds the OLD text, blocked
    await gated.started;
    const updated = await updateKnowledgeEntry(orgA, entry!.id, { content: "Stainless steel chimney caps now available." });
    gated.release();
    expect(await stale).toBe("superseded");
    const [chunk] = await db
      .select({ sha: retrievalChunksTable.contentSha256, content: retrievalChunksTable.content })
      .from(retrievalChunksTable)
      .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.sourceId, entry!.id)));
    expect(chunk!.sha).toBe(knowledgeDocument(updated as { id: string; title: string; content: string })!.contentSha256);
    expect(chunk!.content).toContain("Stainless steel");
  });

  it("a memory retired while customer indexing is in flight is never resurrected or returned", async () => {
    setEmbeddingProviderForTests(null);
    const { memory } = await createCustomerMemory(orgA, alice, userA, { kind: "access_note", content: "Lockbox code with the office manager." }, ALL);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, memory.id))).toBe(0);
    const gated = gatedProvider();
    const pending = syncCustomerHistoryIndex(gated.provider, orgA, alice);
    await gated.started;
    await retireCustomerMemory(orgA, alice, memory.id, userA);
    gated.release();
    const result = await pending;
    expect(result.superseded).toBeGreaterThanOrEqual(1);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, memory.id))).toBe(0);
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const found = await retrieveCustomerContext(orgA, alice, "lockbox code office manager", 5, ALL);
    expect(found!.results.some((r) => r.sourceId === memory.id)).toBe(false);
  });

  it("a stale chunk for a retired memory is never returned and is cleaned up", async () => {
    setEmbeddingProviderForTests(null);
    const { memory } = await createCustomerMemory(orgA, alice, userA, { kind: "fact", content: "Prefers brass fittings." }, ALL);
    await retireCustomerMemory(orgA, alice, memory.id, userA);
    // Simulate a chunk that survived (e.g. written by an older build).
    const [vector] = await hashEmbeddingProvider.embed(["Customer memory (fact): Prefers brass fittings."]);
    await db.execute(sql`INSERT INTO retrieval_chunks (organization_id, scope, contact_id, source_type, source_id, content, content_sha256, embedding_model, embedding)
      VALUES (${orgA}, 'customer', ${alice}, 'customer_memory', ${memory.id}, 'Customer memory (fact): Prefers brass fittings.', ${"b".repeat(64)}, ${hashEmbeddingProvider.model}, ${`[${vector!.join(",")}]`}::vector)`);
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const found = await retrieveCustomerContext(orgA, alice, "brass fittings", 5, ALL);
    expect(text(found)).not.toContain("brass");
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, memory.id))).toBe(0);
  });
});

describe("changes completed while the QUERY embedding is in flight", () => {
  for (const outcome of ["semantic", "fallback"] as const) {
    it(`a memory retired mid-query is not returned (${outcome})`, async () => {
      const marker = `kestrel${outcome}`;
      setEmbeddingProviderForTests(hashEmbeddingProvider);
      const { memory } = await createCustomerMemory(orgA, alice, userA, { kind: "access_note", content: `Spare key under the ${marker} planter.` }, ALL);
      expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, memory.id))).toBe(1);
      const query = `spare key ${marker} planter`;
      const gated = queryGatedProvider(query, outcome);
      setEmbeddingProviderForTests(gated.provider);
      const pending = retrieveCustomerContext(orgA, alice, query, 10, ALL);
      await gated.started;
      await retireCustomerMemory(orgA, alice, memory.id, userA);
      gated.release();
      const result = await pending;
      expect(result!.mode).toBe(outcome === "semantic" ? "lexical_hash" : "keyword");
      expect(result!.results.some((r) => r.sourceId === memory.id)).toBe(false);
      expect(text(result)).not.toContain(marker);
    });

    it(`a knowledge entry deactivated mid-query is not returned (${outcome})`, async () => {
      const marker = `ospreyd${outcome}`;
      setEmbeddingProviderForTests(hashEmbeddingProvider);
      const entry = await createKnowledgeEntry(orgA, { category: "faq", title: `Attic fans ${marker}`, content: `Solar attic fans ${marker} installed in a day.` });
      expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, entry!.id))).toBe(1);
      const query = `solar attic fans ${marker}`;
      const gated = queryGatedProvider(query, outcome);
      setEmbeddingProviderForTests(gated.provider);
      const pending = searchKnowledge(orgA, query, 5);
      await gated.started;
      await updateKnowledgeEntry(orgA, entry!.id, { isActive: false });
      gated.release();
      const result = await pending;
      expect(result.mode).toBe(outcome === "semantic" ? "lexical_hash" : "keyword");
      expect(result.results.some((r) => r.entry.id === entry!.id)).toBe(false);
    });

    it(`a knowledge entry deleted mid-query is not returned (${outcome})`, async () => {
      const marker = `ospreyx${outcome}`;
      setEmbeddingProviderForTests(hashEmbeddingProvider);
      const entry = await createKnowledgeEntry(orgA, { category: "faq", title: `Ridge vents ${marker}`, content: `Ridge vents ${marker} improve airflow.` });
      const query = `ridge vents ${marker} airflow`;
      const gated = queryGatedProvider(query, outcome);
      setEmbeddingProviderForTests(gated.provider);
      const pending = searchKnowledge(orgA, query, 5);
      await gated.started;
      expect(await deleteKnowledgeEntry(orgA, entry!.id)).toBe(true);
      gated.release();
      const result = await pending;
      expect(result.results.some((r) => r.entry.id === entry!.id)).toBe(false);
    });

    it(`a customer source edited mid-query never returns its old text or hash (${outcome})`, async () => {
      const marker = `heron${outcome}`;
      setEmbeddingProviderForTests(hashEmbeddingProvider);
      const [activity] = await db
        .insert(activitiesTable)
        .values({ organizationId: orgA, contactId: alice, type: "note", title: "Valve note", body: `Old ${marker} valve reading recorded.` })
        .returning();
      await syncCustomerHistoryIndex(hashEmbeddingProvider, orgA, alice);
      const [oldChunk] = await db
        .select({ sha: retrievalChunksTable.contentSha256 })
        .from(retrievalChunksTable)
        .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.sourceId, activity!.id)));
      expect(oldChunk).toBeDefined();
      const query = `old ${marker} valve reading`;
      // Index embeddings fail, so the OLD chunk (old hash) is still stored when candidates are read.
      const gated = queryGatedProvider(query, outcome, true);
      setEmbeddingProviderForTests(gated.provider);
      const pending = retrieveCustomerContext(orgA, alice, query, 10, ALL);
      await gated.started;
      await db.update(activitiesTable).set({ body: "Pressure normal after replacement." }).where(eq(activitiesTable.id, activity!.id));
      gated.release();
      const result = await pending;
      expect(text(result)).not.toContain(marker);
      for (const r of result!.results.filter((x) => x.sourceId === activity!.id)) {
        expect(r.content).toContain("Pressure normal");
        expect(r.similarity).toBeNull(); // the old vector never scores the new text
      }
      const [stillOld] = await db
        .select({ sha: retrievalChunksTable.contentSha256 })
        .from(retrievalChunksTable)
        .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.sourceId, activity!.id)));
      expect(stillOld?.sha).toBe(oldChunk!.sha); // the stale chunk existed during the read
    });

    it(`a knowledge entry edited mid-query never returns old text or an old-hash score (${outcome})`, async () => {
      const marker = `marmot${outcome}`;
      setEmbeddingProviderForTests(hashEmbeddingProvider);
      const entry = await createKnowledgeEntry(orgA, { category: "faq", title: `Gutters ${marker}`, content: `Copper gutters ${marker} only.` });
      const oldSha = knowledgeDocument(entry!)!.contentSha256;
      const query = `copper gutters ${marker}`;
      const gated = queryGatedProvider(query, outcome, true);
      setEmbeddingProviderForTests(gated.provider);
      const pending = searchKnowledge(orgA, query, 5);
      await gated.started;
      // Re-index of the edit fails, so the old-hash chunk survives into candidate selection.
      const updated = await updateKnowledgeEntry(orgA, entry!.id, { title: "Gutters", content: "Aluminum seamless gutters now standard." });
      gated.release();
      const result = await pending;
      const [chunk] = await db
        .select({ sha: retrievalChunksTable.contentSha256 })
        .from(retrievalChunksTable)
        .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.sourceId, entry!.id)));
      expect(chunk?.sha).toBe(oldSha);
      for (const r of result.results.filter((x) => x.entry.id === entry!.id)) {
        expect(r.entry.content).toBe((updated as { content: string }).content);
        expect(r.similarity).toBeNull();
      }
      expect(result.results.map((r) => `${r.entry.title} ${r.entry.content}`).join(" ")).not.toContain(marker);
    });
  }
});

describe("customer context retrieval", () => {
  it("is strictly filtered by organization and contact, and redacts identifiers", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const own = await retrieveCustomerContext(orgA, alice, "furnace flame sensor repair", 5, ALL);
    expect(own?.mode).toBe("lexical_hash");
    expect(own!.results.length).toBeGreaterThan(0);
    expect(text(own)).toContain("flame sensor");
    expect(text(own)).not.toContain("alice@example.com");
    expect(text(own)).not.toContain("555-201-3344");
    expect(text(own)).not.toContain("Org B");
    const other = await retrieveCustomerContext(orgA, bob, "furnace flame sensor repair", 5, ALL);
    expect(text(other)).not.toContain("flame sensor");
    expect(await retrieveCustomerContext(orgB, alice, "furnace", 5, ALL)).toBeNull();
    expect(await retrieveCustomerContext(orgA, carol, "furnace", 5, ALL)).toBeNull();
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
    expect(second).toEqual({ indexed: 0, unchanged: first.indexed + first.unchanged, removed: 0, superseded: 0 });
    const after = await db
      .select({ updatedAt: retrievalChunksTable.updatedAt })
      .from(retrievalChunksTable)
      .where(and(eq(retrievalChunksTable.organizationId, orgA), eq(retrievalChunksTable.contactId, alice)));
    expect(after.map((r) => r.updatedAt.getTime()).sort()).toEqual(before.map((r) => r.updatedAt.getTime()).sort());
    const ranked = await retrieveCustomerContext(orgA, alice, "flame sensor replaced tune-up", 3, ALL);
    expect(ranked!.results[0]?.sourceType).toBe("activity");
  });

  it("indexes memories, and retiring one removes it from retrieval", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const { memory, retrievalIndex } = await createCustomerMemory(
      orgA,
      alice,
      userA,
      { kind: "access_note", content: "Gate code is kept by the office; large dog in the backyard." },
      ALL,
    );
    expect(retrievalIndex).toBe("indexed");
    const found = await retrieveCustomerContext(orgA, alice, "gate code dog backyard", 3, ALL);
    expect(found!.results[0]).toMatchObject({ sourceType: "customer_memory", sourceId: memory.id });
    await expect(retireCustomerMemory(orgB, alice, memory.id, userB)).rejects.toMatchObject({ code: "memory_not_found" });
    await retireCustomerMemory(orgA, alice, memory.id, userA);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, memory.id))).toBe(0);
    const gone = await retrieveCustomerContext(orgA, alice, "gate code dog backyard", 3, ALL);
    expect(gone!.results.some((r) => r.sourceId === memory.id)).toBe(false);
    await expect(retireCustomerMemory(orgA, alice, memory.id, userA)).rejects.toMatchObject({ code: "memory_already_retired" });
    const [row] = await db.select().from(customerMemoriesTable).where(eq(customerMemoriesTable.id, memory.id));
    expect(row).toMatchObject({ status: "retired", retiredByUserId: userA });
  });

  it("uses keyword matching without a provider", async () => {
    setEmbeddingProviderForTests(null);
    const result = await retrieveCustomerContext(orgA, bob, "hail shingles", 5, ALL);
    expect(result!.mode).toBe("keyword");
    expect(result!.results[0]?.content).toContain("Hail damage");
  });
});

describe("canonical customer coherence", () => {
  for (const [mode, provider] of [["keyword", null], ["vector", hashEmbeddingProvider]] as const) {
    it(`excludes contradictory-parent records from every customer (${mode})`, async () => {
      setEmbeddingProviderForTests(provider);
      for (const contact of [alice, bob]) {
        const result = await retrieveCustomerContext(orgA, contact, "zebra contradiction visit marker crossing", 10, ALL);
        expect(text(result)).not.toMatch(/zebra/i);
      }
      expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, contradictoryActivityId))).toBe(0);
      expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, contradictoryAppointmentId))).toBe(0);
    });
  }

  it("rejects memory provenance that is not coherent for the customer", async () => {
    for (const contact of [alice, bob]) {
      await expect(
        createCustomerMemory(orgA, contact, userA, { kind: "fact", content: "x", sourceType: "activity", sourceId: contradictoryActivityId }, ALL),
      ).rejects.toMatchObject({ code: "memory_source_not_found" });
      await expect(
        createCustomerMemory(orgA, contact, userA, { kind: "fact", content: "x", sourceType: "appointment", sourceId: contradictoryAppointmentId }, ALL),
      ).rejects.toMatchObject({ code: "memory_source_not_found" });
    }
    const [bobActivity] = await db
      .select({ id: activitiesTable.id })
      .from(activitiesTable)
      .where(and(eq(activitiesTable.organizationId, orgA), eq(activitiesTable.contactId, bob), eq(activitiesTable.title, "Roof inspection")));
    await expect(
      createCustomerMemory(orgA, alice, userA, { kind: "fact", content: "Borrowed note", sourceType: "activity", sourceId: bobActivity!.id }, ALL),
    ).rejects.toMatchObject({ code: "memory_source_not_found" });
    const noted = await createCustomerMemory(
      orgA,
      bob,
      userA,
      { kind: "fact", content: "North slope hail damage noted", sourceType: "activity", sourceId: bobActivity!.id },
      ALL,
    );
    expect(noted.memory.sourceId).toBe(bobActivity!.id);
    await expect(createCustomerMemory(orgB, alice, userB, { kind: "fact", content: "x" }, ALL)).rejects.toMatchObject({ code: "customer_not_found" });
  });

  it("requires invoice visibility for invoice provenance", async () => {
    await expect(
      createCustomerMemory(orgA, alice, userA, { kind: "fact", content: "Paid by check", sourceType: "invoice", sourceId: invoiceId }, NO_INVOICES),
    ).rejects.toMatchObject({ code: "memory_source_not_found" });
    await expect(
      createCustomerMemory(orgA, alice, userA, { kind: "fact", content: "Paid by check", sourceType: "activity", sourceId: invoiceActivityId }, NO_INVOICES),
    ).rejects.toMatchObject({ code: "memory_source_not_found" });
    const ok = await createCustomerMemory(orgA, alice, userA, { kind: "fact", content: "Paid by check", sourceType: "invoice", sourceId: invoiceId }, ALL);
    expect(ok.memory.sourceType).toBe("invoice");
  });
});

describe("invoice visibility", () => {
  for (const [mode, provider] of [["keyword", null], ["vector", hashEmbeddingProvider]] as const) {
    it(`hides invoices and invoice activity without invoices.read (${mode})`, async () => {
      setEmbeddingProviderForTests(provider);
      const hidden = await retrieveCustomerContext(orgA, alice, "compressor replacement balance warranty unit", 10, NO_INVOICES);
      expect(text(hidden)).not.toMatch(/compressor/i);
      expect(hidden!.results.some((r) => r.sourceType === "invoice" || r.sourceId === invoiceActivityId)).toBe(false);
      const shown = await retrieveCustomerContext(orgA, alice, "compressor replacement balance warranty unit", 10, ALL);
      expect(shown!.results.some((r) => r.sourceId === invoiceId)).toBe(true);
      expect(shown!.results.some((r) => r.sourceId === invoiceActivityId)).toBe(true);
      expect(text(shown)).not.toContain("1 Private Lane");
      expect(text(shown)).not.toContain("Alice Rivers");
    });
  }

  it("restricted reads never delete the shared invoice chunks", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    await retrieveCustomerContext(orgA, alice, "compressor", 5, ALL);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, invoiceId))).toBe(1);
    await retrieveCustomerContext(orgA, alice, "compressor", 5, NO_INVOICES);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, invoiceId))).toBe(1);
    expect(await chunkCount(orgA, eq(retrievalChunksTable.sourceId, invoiceActivityId))).toBe(1);
  });
});

describe("assistant search_customer_history tool", () => {
  const admin = () => ({ userId: userA, role: "admin" as const });
  it("is scoped to the chat's organization and caller", async () => {
    setEmbeddingProviderForTests(null);
    const tool = TOOLS.search_customer_history!;
    expect(await tool.run(orgA, { query: "flame sensor", contactId: alice })).toMatchObject({ error: expect.any(String) });
    const own = (await tool.run(orgA, { query: "flame sensor", contactId: alice }, admin())) as { found: boolean; snippets: Array<{ text: string }> };
    expect(own.found).toBe(true);
    expect(own.snippets.map((s) => s.text).join(" ")).toContain("flame sensor");
    // Another company's principal cannot use it against org A, and model ids do not cross tenants.
    expect(await tool.run(orgA, { query: "flame sensor", contactId: alice }, { userId: userB, role: "admin" })).toMatchObject({ error: expect.any(String) });
    const foreign = (await tool.run(orgB, { query: "flame sensor", contactId: alice }, { userId: userB, role: "admin" })) as { found: boolean };
    expect(foreign.found).toBe(false);
    const byName = (await tool.run(orgB, { query: "furnace", customer: "Alice Rivers" }, { userId: userB, role: "admin" })) as { found: boolean };
    expect(byName.found).toBe(false);
    const resolved = (await tool.run(orgA, { query: "furnace", customer: "Alice Rivers" }, admin())) as { contactId: string };
    expect(resolved.contactId).toBe(alice);
    expect(await tool.run(orgA, { query: "furnace", contactId: "not-a-uuid" }, admin())).toMatchObject({ error: expect.any(String) });
  });

  for (const [mode, provider] of [["keyword", null], ["vector", hashEmbeddingProvider]] as const) {
    it(`applies the effective (capped) role to invoice visibility (${mode})`, async () => {
      setEmbeddingProviderForTests(provider);
      const tool = TOOLS.search_customer_history!;
      const capped = (await tool.run(orgA, { query: "compressor balance unit", contactId: alice }, { userId: userA, role: "sales_rep" })) as {
        snippets: Array<{ text: string }>;
        invoiceDetailsIncluded: boolean;
      };
      expect(capped.invoiceDetailsIncluded).toBe(false);
      expect(capped.snippets.map((s) => s.text).join(" ")).not.toMatch(/compressor/i);
      const full = (await tool.run(orgA, { query: "compressor balance unit", contactId: alice }, admin())) as { snippets: Array<{ text: string }> };
      expect(full.snippets.map((s) => s.text).join(" ")).toMatch(/compressor/i);
    });
  }
});

describe("schema guards", () => {
  it("rejects a knowledge chunk tied to a customer, a customer chunk without one, and a cross-tenant contact", async () => {
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
    await expect(
      db.execute(sql`INSERT INTO retrieval_chunks (organization_id, scope, contact_id, source_type, source_id, content, content_sha256, embedding_model, embedding)
        VALUES (${orgB}, 'customer', ${alice}, 'lead', ${entry!.id}, 'x', ${"a".repeat(64)}, 'm', ${vector}::vector)`),
    ).rejects.toThrow();
  });
});
