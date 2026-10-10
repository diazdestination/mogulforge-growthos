import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEventsTable, contactsTable, db, organizationsTable, propertiesTable, usersTable, type UserRole } from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { customerDetailSnapshotSchema } from "../../services/customer-detail-correction-contract";

const ownedOrgs: string[] = [];
let server: Server;
let base: string;

async function fixture(role: UserRole = "office") {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic customer corrections", slug: randomUUID() }).returning();
  ownedOrgs.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, email: `${randomUUID()}@example.invalid`, role }).returning();
  const sid = await createSession({ user: { id: user.id, email: user.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-correction-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic", phone: "+12025550101", email: "customer@example.invalid", doNotContact: true, doNotContactSms: true }).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org.id, contactId: contact.id, addressLine1: "100 Example Street", city: "Synthetic", state: "GA", postalCode: "30000" }).returning();
  return { org, user, sid, contact, property };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function request(f: Fixture, suffix: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/contacts/${f.contact.id}/${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${f.sid}`, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function snapshot(f: Fixture, propertyId: string | null = f.property.id) {
  const response = await request(f, `detail-correction${propertyId ? `?propertyId=${propertyId}` : ""}`);
  expect(response.status).toBe(200);
  return customerDetailSnapshotSchema.parse(await response.json());
}
async function auditCount(f: Fixture) {
  return (await db.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org.id), eq(auditEventsTable.action, "customer.details.corrected")))).length;
}

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await deleteTestOrgs(...ownedOrgs);
});

describe("staff customer detail corrections through mounted HTTP routes", () => {
  it("requires an active staff session and refuses API keys even alongside a valid session", async () => {
    const f = await fixture();
    expect((await fetch(`${base}/contacts/${f.contact.id}/detail-correction`)).status).toBe(401);
    expect((await request(f, "detail-correction", undefined, { "x-api-key": "synthetic-key" })).status).toBe(403);
    expect((await request(f, "detail-correction", undefined, { "x-api-key": "" })).status).toBe(403);
    const privateRead = await request(f, "detail-correction");
    expect(privateRead.headers.get("cache-control")).toBe("no-store");
    expect(privateRead.headers.get("referrer-policy")).toBe("no-referrer");
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.user.id));
    expect((await request(f, "detail-correction")).status).toBe(403);
  });

  it.each(["viewer", "sales_rep", "production"] as const)("does not treat %s CRM access as office review permission", async role => {
    const f = await fixture(role);
    expect((await request(f, "detail-correction")).status).toBe(403);
    expect(await auditCount(f)).toBe(0);
  });

  it("rejects foreign browser origins and extra company selectors before reading or saving", async () => {
    const f = await fixture(); const original = await snapshot(f, null);
    const input = { requestId: randomUUID(), propertyId: null, expectedVersion: original.version, changes: { firstName: "Foreign save" } };
    const headersToRefuse: Record<string, string>[] = [{ origin: "https://untrusted.example.invalid" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of headersToRefuse) {
      expect((await request(f, "detail-correction", undefined, headers)).status).toBe(403);
      expect((await request(f, "detail-corrections", input, headers)).status).toBe(403);
      expect((await request(f, `detail-corrections/${input.requestId}`, undefined, headers)).status).toBe(403);
    }
    expect((await request(f, `detail-correction?organizationId=${randomUUID()}`)).status).toBe(400);
    expect(await auditCount(f)).toBe(0);
  });

  it("keeps customer and explicitly selected property in the authenticated company", async () => {
    const a = await fixture(); const b = await fixture();
    expect((await fetch(`${base}/contacts/${b.contact.id}/detail-correction`, { headers: { authorization: `Bearer ${a.sid}` } })).status).toBe(404);
    expect((await request(a, `detail-correction?propertyId=${b.property.id}`)).status).toBe(404);
    const [other] = await db.insert(contactsTable).values({ organizationId: a.org.id, firstName: "Another customer" }).returning();
    await db.update(propertiesTable).set({ contactId: other.id }).where(eq(propertiesTable.id, a.property.id));
    expect((await request(a, `detail-correction?propertyId=${a.property.id}`)).status).toBe(409);
    const contactOnly = await snapshot(a, null);
    expect(contactOnly).toMatchObject({ organizationId: a.org.id, contactId: a.contact.id, propertyId: null, details: { property: null }, version: { propertyUpdatedAt: null } });
  });

  it("commits one reviewed correction and reconciles a lost response without repeating the write", async () => {
    const f = await fixture(); const original = await snapshot(f);
    const input = { requestId: randomUUID(), propertyId: f.property.id, expectedVersion: original.version, changes: { firstName: "Reviewed", email: null, property: { addressLine1: "200 Corrected Street" } } };
    const response = await request(f, "detail-corrections", input);
    expect(response.status).toBe(200);
    // The original response body is deliberately discarded. Reconciliation is
    // a read of its exact receipt, not another save with a newly invented ID.
    const recovered = await request(f, `detail-corrections/${input.requestId}`);
    expect(recovered.status).toBe(200);
    const receipt = await recovered.json();
    expect(receipt).toMatchObject({ requestId: input.requestId, status: "saved", snapshot: { organizationId: f.org.id, contactId: f.contact.id, propertyId: f.property.id, details: { firstName: "Reviewed", email: null, property: { addressLine1: "200 Corrected Street" } } } });
    const replay = await request(f, "detail-corrections", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ receipt, replayed: true });
    expect(await auditCount(f)).toBe(1);
    const [current] = await db.select().from(contactsTable).where(eq(contactsTable.id, f.contact.id));
    expect(current).toMatchObject({ doNotContact: true, doNotContactSms: true, organizationId: f.org.id });
  });

  it("refuses a changed payload under a consumed request ID and hides its receipt from another actor", async () => {
    const f = await fixture(); const original = await snapshot(f, null);
    const input = { requestId: randomUUID(), propertyId: null, expectedVersion: original.version, changes: { firstName: "First review" } };
    expect((await request(f, "detail-corrections", input)).status).toBe(200);
    expect((await request(f, "detail-corrections", { ...input, changes: { firstName: "Changed replay" } })).status).toBe(409);
    const [other] = await db.insert(usersTable).values({ organizationId: f.org.id, role: "office", email: `${randomUUID()}@example.invalid` }).returning();
    const otherSid = await createSession({ user: { id: other.id, email: other.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-other-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    expect((await request({ ...f, sid: otherSid }, `detail-corrections/${input.requestId}`)).status).toBe(404);
    expect(await auditCount(f)).toBe(1);
  });

  it("holds stale contact and property edits rather than overwriting the intervening save", async () => {
    const f = await fixture(); const original = await snapshot(f);
    const first = { requestId: randomUUID(), propertyId: f.property.id, expectedVersion: original.version, changes: { phone: "+12025550102" } };
    expect((await request(f, "detail-corrections", first)).status).toBe(200);
    expect((await request(f, "detail-corrections", { ...first, requestId: randomUUID(), changes: { firstName: "Stale save" } })).status).toBe(409);
    const fresh = await snapshot(f);
    await db.update(propertiesTable).set({ city: "Changed by another editor" }).where(eq(propertiesTable.id, f.property.id));
    expect((await request(f, "detail-corrections", { requestId: randomUUID(), propertyId: f.property.id, expectedVersion: fresh.version, changes: { property: { city: "Stale city" } } })).status).toBe(409);
    const [current] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, f.property.id));
    expect(current.city).toBe("Changed by another editor");
    expect(await auditCount(f)).toBe(1);
  });

  it("rejects protected fields, malformed IDs and address edits without a selected property", async () => {
    const f = await fixture(); const original = await snapshot(f, null);
    const baseInput = { requestId: randomUUID(), propertyId: null, expectedVersion: original.version };
    for (const changes of [{ doNotContact: false }, { organizationId: randomUUID() }, { contactId: randomUUID() }, { property: { contactId: randomUUID() } }, { property: { city: "Wrong property" } }, { phone: "bad\nvalue" }]) {
      expect((await request(f, "detail-corrections", { ...baseInput, changes })).status).toBe(400);
    }
    expect((await request(f, "detail-corrections/not-a-uuid")).status).toBe(400);
    expect((await request(f, "detail-correction?propertyId[]=bad")).status).toBe(400);
    expect(await auditCount(f)).toBe(0);
  });
});
