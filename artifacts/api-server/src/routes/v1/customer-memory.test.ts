import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { activitiesTable, auditEventsTable, contactsTable, db, invoicesTable, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";
import { hashEmbeddingProvider, setEmbeddingProviderForTests } from "../../services/embeddings";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server;
let baseUrl: string;
const stamp = Date.now();
const orgs: string[] = [];

type Role = "admin" | "sales_rep" | "viewer" | "office";
async function member(orgId: string, slug: string, role: Role) {
  const [user] = await db
    .insert(usersTable)
    .values({ email: `memory-route-${slug}-${stamp}@example.com`, organizationId: orgId, role, emailVerifiedAt: new Date() })
    .returning();
  const sid = await createSession({
    user: { id: user!.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  return { userId: user!.id, sid };
}

async function org(slug: string) {
  const [row] = await db.insert(organizationsTable).values({ name: `Memory Route ${slug}`, slug: `memory-route-${slug}-${stamp}` }).returning();
  orgs.push(row!.id);
  return row!.id;
}

function call(auth: { sid?: string; key?: string }, path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}/v1${path}`, {
    ...init,
    headers: {
      ...(auth.sid ? { authorization: `Bearer ${auth.sid}` } : {}),
      ...(auth.key ? { "x-api-key": auth.key } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

let orgA: string;
let contactA: string;
let admin: { userId: string; sid: string };
let rep: { userId: string; sid: string };
let viewer: { userId: string; sid: string };
let office: { userId: string; sid: string };
let outsider: { userId: string; sid: string };

beforeAll(async () => {
  orgA = await org("a");
  const orgB = await org("b");
  admin = await member(orgA, "admin", "admin");
  rep = await member(orgA, "rep", "sales_rep");
  viewer = await member(orgA, "viewer", "viewer");
  office = await member(orgA, "office", "office");
  outsider = await member(orgB, "outsider", "admin");
  const [contact] = await db.insert(contactsTable).values({ organizationId: orgA, firstName: "Dana", lastName: "Lake" }).returning();
  contactA = contact!.id;
  const [lead] = await db.insert(leadsTable).values({ organizationId: orgA, contactId: contactA, summary: "Boiler service" }).returning();
  await db.insert(invoicesTable).values({
    organizationId: orgA,
    leadId: lead!.id,
    createdByUserId: admin.userId,
    draftDocument: {
      title: "Boiler overhaul", currency: "USD", issuerName: "Synthetic", issuerAddress: null, customerName: "Dana Lake",
      customerAddress: null, dueDate: null, notes: "Overhaul invoice notes",
      lineItems: [{ description: "Overhaul labor", quantity: "1", unitPriceCents: 50000, totalCents: 50000 }],
      subtotalCents: 50000, taxCents: 0, totalCents: 50000,
    },
  });
  await db.insert(activitiesTable).values({ organizationId: orgA, contactId: contactA, type: "invoice_event", title: "Invoice sent", body: "Overhaul balance due" });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(() => setEmbeddingProviderForTests(undefined));

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(...orgs);
});

async function search(auth: { sid?: string; key?: string }, q: string) {
  const res = await call(auth, `/contacts/${contactA}/context-search?q=${encodeURIComponent(q)}&limit=10`);
  expect(res.status).toBe(200);
  return (await res.json()) as { mode: string; results: Array<{ sourceId: string; sourceType: string; content: string }> };
}

describe("customer memory routes", () => {
  it("creates, lists, searches and retires a memory with audits and role checks", async () => {
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const created = await call(rep, `/contacts/${contactA}/memories`, {
      method: "POST",
      body: JSON.stringify({ kind: "preference", content: "Prefers text messages before morning visits." }),
    });
    expect(created.status).toBe(201);
    const memory = (await created.json()) as { id: string; status: string; organizationId: string };
    expect(memory).toMatchObject({ status: "active", organizationId: orgA });

    const listed = await call(viewer, `/contacts/${contactA}/memories`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { memories: unknown[] }).memories).toHaveLength(1);
    const denied = await call(viewer, `/contacts/${contactA}/memories`, {
      method: "POST",
      body: JSON.stringify({ kind: "fact", content: "nope" }),
    });
    expect(denied.status).toBe(403);

    const found = await search(viewer, "text messages morning");
    expect(found.mode).toBe("lexical_hash");
    expect(found.results[0]?.sourceId).toBe(memory.id);

    const retired = await call(rep, `/contacts/${contactA}/memories/${memory.id}/retire`, { method: "POST" });
    expect(retired.status).toBe(200);
    expect(((await retired.json()) as { status: string }).status).toBe("retired");
    expect((await call(rep, `/contacts/${contactA}/memories/${memory.id}/retire`, { method: "POST" })).status).toBe(409);
    const all = (await (await call(viewer, `/contacts/${contactA}/memories?status=all`)).json()) as { memories: unknown[] };
    expect(all.memories).toHaveLength(1);
    const active = (await (await call(viewer, `/contacts/${contactA}/memories`)).json()) as { memories: unknown[] };
    expect(active.memories).toHaveLength(0);
    expect((await search(viewer, "text messages morning")).results.some((r) => r.sourceId === memory.id)).toBe(false);

    const audits = await db
      .select({ action: auditEventsTable.action, metadata: auditEventsTable.metadata })
      .from(auditEventsTable)
      .where(and(eq(auditEventsTable.organizationId, orgA), eq(auditEventsTable.entityId, memory.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["customer_memory.created", "customer_memory.retired"]);
    expect(JSON.stringify(audits)).not.toContain("morning visits");
  });

  for (const [mode, provider] of [["keyword", null], ["indexed", hashEmbeddingProvider]] as const) {
    it(`applies invoice visibility for roles and capped API keys (${mode})`, async () => {
      setEmbeddingProviderForTests(provider);
      const reveals = (body: Awaited<ReturnType<typeof search>>) => /overhaul/i.test(body.results.map((r) => r.content).join(" "));
      // Sessions: roles without invoices.read never see invoice sources or invoice activity.
      expect(reveals(await search(viewer, "overhaul balance labor"))).toBe(false);
      expect(reveals(await search(rep, "overhaul balance labor"))).toBe(false);
      expect(reveals(await search(admin, "overhaul balance labor"))).toBe(true);
      expect(reveals(await search(office, "overhaul balance labor"))).toBe(true);
      // API keys created by an admin are capped at the key's role.
      const repKey = await createApiKey({ organizationId: orgA, name: `rep key ${mode}`, role: "sales_rep", createdByUserId: admin.userId });
      const officeKey = await createApiKey({ organizationId: orgA, name: `office key ${mode}`, role: "office", createdByUserId: admin.userId });
      expect(reveals(await search({ key: repKey.key }, "overhaul balance labor"))).toBe(false);
      expect(reveals(await search({ key: officeKey.key }, "overhaul balance labor"))).toBe(true);
    });
  }

  it("hides another company's customer and rejects malformed input", async () => {
    expect((await call(outsider, `/contacts/${contactA}/memories`)).status).toBe(404);
    expect((await call(outsider, `/contacts/${contactA}/context-search?q=text`)).status).toBe(404);
    const write = await call(outsider, `/contacts/${contactA}/memories`, {
      method: "POST",
      body: JSON.stringify({ kind: "fact", content: "cross-tenant" }),
    });
    expect(write.status).toBe(404);
    const bad = await call(rep, `/contacts/${contactA}/memories`, {
      method: "POST",
      body: JSON.stringify({ kind: "fact", content: "x", extra: true }),
    });
    expect(bad.status).toBe(400);
    expect((await call(rep, `/contacts/${contactA}/context-search`)).status).toBe(400);
  });

  it("gates the company backfill to owners/admins and reports a missing provider", async () => {
    setEmbeddingProviderForTests(null);
    expect((await call(rep, "/retrieval/reindex", { method: "POST", body: "{}" })).status).toBe(403);
    const none = await call(admin, "/retrieval/reindex", { method: "POST", body: "{}" });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { code: string }).code).toBe("embedding_provider_not_configured");
    setEmbeddingProviderForTests(hashEmbeddingProvider);
    const ran = await call(admin, "/retrieval/reindex", { method: "POST", body: JSON.stringify({ limit: 10 }) });
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({ embeddingModel: "local-hash-v1", quality: "lexical_hash", nextAfterContactId: null });
  });
});
