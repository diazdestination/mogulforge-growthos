import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  db, pool, organizationsTable, usersTable, sessionsTable, contactsTable,
  identityTokensTable, storedObjectsTable, activitiesTable, gmailConnectionsTable,
  emailIntelligenceSourcesTable, emailIntelligenceMessagesTable, apiKeysTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../app";
import * as auth from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  createDataLifecycleInventoryReader, getDataLifecycleSourceSchema, validateDataLifecycleSchema,
  type DataLifecycleInventory, type InventoryClient, type InventoryTableShape,
} from "../../services/data-lifecycle-inventory";
import { isDataLifecycleInventoryRead } from "../../services/data-lifecycle-inventory-session";
import * as inventoryService from "../../services/data-lifecycle-inventory";

let server: Server, base: string, orgA: string, orgB: string, ownerId: string,
  platformId: string, owner: string, admin: string, viewer: string, inactive: string,
  otherOwner: string, platformWithoutOrg: string, sessionExpired: string, tokenExpired: string,
  malformedExpiry: string, noIdentity: string, apiKey: string, apiKeyId: string,
  unownedObject: string;
const sessions: string[] = [];
const canary = `CANARY_PRIVATE_${randomUUID()}`;

beforeAll(async () => {
  const orgs = await db.insert(organizationsTable).values([
    { name: `${canary}_A`, slug: `lifecycle-a-${randomUUID()}` },
    { name: `${canary}_B`, slug: `lifecycle-b-${randomUUID()}` },
  ]).returning();
  orgA = orgs[0]!.id; orgB = orgs[1]!.id;
  const member = async (organizationId: string | null, role: "owner" | "admin" | "viewer", active = true, platform = false) => {
    const [user] = await db.insert(usersTable).values({ organizationId, role, isActive: active, isPlatformAdmin: platform, passwordHash: canary }).returning();
    const sid = await auth.createSession({ user: { id: user!.id, email: `${canary}@example.invalid`, firstName: null, lastName: null, profileImageUrl: null }, access_token: canary, refresh_token: canary, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    sessions.push(sid);
    return { sid, user: user! };
  };
  const a = await member(orgA, "owner", true, true); ownerId = a.user.id; owner = a.sid;
  admin = (await member(orgA, "admin")).sid;
  viewer = (await member(orgA, "viewer")).sid;
  inactive = (await member(orgA, "owner", false)).sid;
  const b = await member(orgB, "owner"); otherOwner = b.sid;
  const platform = await member(null, "owner", true, true); platformWithoutOrg = platform.sid; platformId = platform.user.id;
  const sessionForOwner = async (overrides: Record<string, unknown>, expiredRow = false) => {
    const sid = randomUUID(); sessions.push(sid);
    await db.insert(sessionsTable).values({ sid, sess: { user: { id: ownerId }, access_token: canary, refresh_token: canary, expires_at: Math.floor(Date.now() / 1000) + 3600, ...overrides }, expire: new Date(Date.now() + (expiredRow ? -60_000 : 60_000)) });
    return sid;
  };
  sessionExpired = await sessionForOwner({}, true);
  tokenExpired = await sessionForOwner({ expires_at: 1 });
  malformedExpiry = await sessionForOwner({ expires_at: "not-a-timestamp" });
  noIdentity = await sessionForOwner({ user: {} });
  const createdKey = await createApiKey({ organizationId: orgA, name: canary, role: "owner", createdByUserId: ownerId });
  apiKey = createdKey.key; apiKeyId = createdKey.record.id;
  await db.insert(contactsTable).values([
    { organizationId: orgA, firstName: canary, email: `${canary}@example.invalid` },
    { organizationId: orgB, firstName: `${canary}_B1` },
    { organizationId: orgB, firstName: `${canary}_B2` },
  ]);
  await db.insert(identityTokensTable).values([
    { userId: ownerId, purpose: "reset", tokenDigest: `a-${canary}`, expiresAt: new Date(Date.now() + 60_000) },
    { userId: b.user.id, purpose: "reset", tokenDigest: `b-${canary}`, expiresAt: new Date(Date.now() + 60_000) },
    { userId: platformId, purpose: "reset", tokenDigest: `p-${canary}`, expiresAt: new Date(Date.now() + 60_000) },
  ]);
  unownedObject = randomUUID();
  const otherObject = randomUUID();
  await db.insert(storedObjectsTable).values([
    { id: randomUUID(), organizationId: orgA, data: Buffer.from(canary), contentType: "image/png", sizeBytes: canary.length },
    { id: otherObject, organizationId: orgB, data: Buffer.from(canary), contentType: "image/png", sizeBytes: canary.length },
    { id: unownedObject, organizationId: null, data: Buffer.from(canary), contentType: "image/png", sizeBytes: canary.length },
  ]);
  await db.insert(activitiesTable).values({ organizationId: orgA, type: "photo", title: canary, body: canary, metadata: { unownedObject, sharedObject: otherObject, externalMedia: "https://example.invalid/private" } });
  await db.insert(gmailConnectionsTable).values({ organizationId: orgA, userId: ownerId, email: `${canary}@example.invalid`, encryptedRefreshToken: canary });
  const [source] = await db.insert(emailIntelligenceSourcesTable).values({ organizationId: orgA, intakeAlias: randomUUID() }).returning();
  await db.insert(emailIntelligenceMessagesTable).values({ organizationId: orgA, sourceId: source!.id, externalMessageId: canary, contentSha256: canary, forwardedBy: `${canary}@example.invalid`, fromEmail: `${canary}@example.invalid`, redactedSubject: canary, encryptedRawText: canary, rawExpiresAt: new Date(Date.now() + 60_000) });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const sid of sessions) await auth.deleteSession(sid);
  if (unownedObject) await db.delete(storedObjectsTable).where(eq(storedObjectsTable.id, unownedObject));
  if (platformId) await db.delete(usersTable).where(eq(usersTable.id, platformId));
  await deleteTestOrgs(orgA, orgB);
});
const read = (sid = "", path = "/api/v1/data-lifecycle/inventory", extra: RequestInit = {}) => fetch(`${base}${path}`, { ...extra, headers: { cookie: `sid=${sid}`, ...extra.headers } });
const table = (body: DataLifecycleInventory, name: string) => body.tables.find((entry) => entry.table === name)!;

describe("read-only lifecycle inventory tenant boundary", () => {
  it("matches all reviewed deployed synthetic tables and counts in a server-enforced read-only snapshot", async () => {
    let readOnly = "", schemaRows: InventoryTableShape[] = [];
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const query = client.query.bind(client);
    const wrapped: InventoryClient = {
      connect: () => client.connect(), end: () => client.end(), on: (event, handler) => client.on(event, handler),
      query: async (config) => {
        if (config.text.includes("UNION ALL")) readOnly = (await query("SHOW transaction_read_only")).rows[0].transaction_read_only;
        const response = await query(config);
        if (config.text.includes("pg_catalog.pg_class c JOIN")) schemaRows = response.rows as InventoryTableShape[];
        return response;
      },
    };
    const inventory = await createDataLifecycleInventoryReader({ createClient: () => wrapped })(orgA);
    const expected = getDataLifecycleSourceSchema();
    const failures = schemaRows.filter((actual) => !validateDataLifecycleSchema([actual, ...expected.filter((t) => t.name !== actual.name)]).matched);
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(inventory.status).toBe("bounded_preview");
    expect(readOnly).toBe("on");
    expect(inventory.coverage).toMatchObject({ classifiedTables: 118, countedTables: 113, excludedTables: 5, deployedSchema: "matched", reasons: [] });
    for (const name of ["missed_call_care_policies", "missed_call_care_cases"])
      expect(table(inventory, name)).toMatchObject({ ownership: "direct_org", rowCount: 0, countStatus: "exact_in_snapshot" });
  });

  it("requires active owner/admin membership and does not elevate an unscoped platform session", async () => {
    for (const [sid, status] of [["", 401], [viewer, 403], [inactive, 403], [platformWithoutOrg, 403]] as const) {
      expect((await read(sid)).status).toBe(status);
    }
    expect((await read(admin)).status).toBe(200);
  });

  it("returns only scoped counts with explicit shared and unresolved ownership exceptions", async () => {
    const before = await db.execute(sql`SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY id)) AS digest FROM contacts t WHERE organization_id IN (${orgA}::uuid, ${orgB}::uuid)`);
    const response = await read(owner, undefined, { headers: { "x-organization-id": orgB, "x-org-id": orgB } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as DataLifecycleInventory;
    expect(body).toMatchObject({ complete: false, exportReady: false, deletionReady: false });
    expect(table(body, "contacts")).toMatchObject({ rowCount: 1, countStatus: "exact_in_snapshot" });
    expect(table(body, "identity_tokens")).toMatchObject({ rowCount: 1, ownership: "indirect_org" });
    expect(table(body, "stored_objects").rowCount).toBe(1);
    expect(table(body, "email_intelligence_messages").rowCount).toBe(1);
    for (const name of ["sessions", "scheduler_runtime", "rate_limit_counters"]) expect(table(body, name)).toMatchObject({ rowCount: null, countStatus: "excluded" });
    const text = JSON.stringify(body);
    for (const privateValue of [canary, orgA, orgB, ownerId, unownedObject, apiKey]) expect(text).not.toContain(privateValue);
    expect(body.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["json_text_links_unresolved", "media_ownership_unresolved", "restricted_email_content", "global_identity_sessions_unresolved"]));
    const other = await (await read(otherOwner)).json() as DataLifecycleInventory;
    expect(table(other, "contacts").rowCount).toBe(2);
    expect(table(other, "email_intelligence_messages").rowCount).toBe(0);
    const after = await db.execute(sql`SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY id)) AS digest FROM contacts t WHERE organization_id IN (${orgA}::uuid, ${orgB}::uuid)`);
    expect(after.rows).toEqual(before.rows);
  });

  it("rejects query selectors and arbitrary content without disclosing selected organizations", async () => {
    for (const query of [`?organizationId=${orgB}`, `?orgId=${randomUUID()}`, "?page=1"]) {
      const response = await read(owner, `/api/v1/data-lifecycle/inventory${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Inventory does not accept request selectors" });
    }
    expect((await read(owner, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: orgB }) })).status).toBe(404);
    // Fetch forbids a GET body; native HTTP proves the server boundary itself.
    const payload = JSON.stringify({ organizationId: orgB });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/v1/data-lifecycle/inventory`, {
        method: "GET", headers: { cookie: `sid=${owner}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end(payload);
    });
    expect(status).toBe(400);
  });

  it("rechecks current membership permissions even when the owner session is still valid", async () => {
    await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, ownerId));
    try { expect((await read(owner)).status).toBe(403); }
    finally { await db.update(usersTable).set({ role: "owner" }).where(eq(usersTable.id, ownerId)); }
  });

  it("does not queue shared-pool work for authentication or inventory", async () => {
    const sharedPool = vi.spyOn(pool, "connect");
    try {
      expect((await read(owner)).status).toBe(200);
      expect(sharedPool).not.toHaveBeenCalled();
    } finally { sharedPool.mockRestore(); }
  });

  it("rejects a revoked session without attempting repair", async () => {
    const sid = await auth.createSession({ user: { id: ownerId, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: canary });
    await auth.deleteSession(sid);
    expect((await read(sid)).status).toBe(401);
  });

  it("returns a fixed service failure without SQL, connection or row details", async () => {
    const unavailable = vi.spyOn(inventoryService, "getDataLifecycleInventory").mockRejectedValueOnce(new Error(`postgres://${canary}@private-host/raw-customer-row`));
    try {
      const response = await read(owner);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Data lifecycle inventory is unavailable", code: "inventory_unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally { unavailable.mockRestore(); }
  });

  it("rejects API keys including an empty header before usage timestamps or shared throttles change", async () => {
    const before = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, apiKeyId));
    for (const key of [apiKey, "", "not-a-key"]) {
      expect((await read(owner, undefined, { headers: { "x-api-key": key } })).status).toBe(403);
    }
    const after = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, apiKeyId));
    expect(after).toEqual(before);
  });
});

describe("inventory authentication never performs normal session repair", () => {
  it.each(["GET", "HEAD"])("rejects expired/malformed %s sessions across route aliases without cleanup, refresh or cookie writes", async (method) => {
    const normalRead = vi.spyOn(auth, "getSession");
    const oidc = vi.spyOn(auth, "getOidcConfig");
    const refreshWrite = vi.spyOn(auth, "updateSession");
    const clear = vi.spyOn(auth, "clearSession");
    try {
      for (const sid of [sessionExpired, tokenExpired, malformedExpiry, noIdentity]) {
        const before = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
        for (const path of ["/api/v1/data-lifecycle/inventory", "/API/V1/DATA-LIFECYCLE/INVENTORY/"]) {
          const response = await read(sid, path, { method });
          expect(response.status).toBe(401);
          expect(response.headers.get("set-cookie")).toBeNull();
        }
        expect(await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid))).toEqual(before);
      }
      expect(normalRead).not.toHaveBeenCalled();
      expect(oidc).not.toHaveBeenCalled();
      expect(refreshWrite).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it("retains ordinary expired-session cleanup for another protected route", async () => {
    const sid = randomUUID();
    await db.insert(sessionsTable).values({ sid, sess: { user: { id: ownerId }, access_token: canary }, expire: new Date(Date.now() - 60_000) });
    const response = await read(sid, "/api/v1/contacts");
    expect(response.status).toBe(401);
    expect(await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid))).toEqual([]);
    expect(response.headers.get("set-cookie")).not.toBeNull();
  });

  it("does not apply the read-only auth branch to unrelated route prefixes or writes", () => {
    expect(isDataLifecycleInventoryRead({ method: "GET", path: "/api/v1/data-lifecycle/inventory/extra" })).toBe(false);
    expect(isDataLifecycleInventoryRead({ method: "POST", path: "/api/v1/data-lifecycle/inventory" })).toBe(false);
    expect(isDataLifecycleInventoryRead({ method: "GET", path: "/api/v1/contacts" })).toBe(false);
  });
});
