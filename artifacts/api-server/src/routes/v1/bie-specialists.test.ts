/** Route tests for proposal-only specialists: run and list, permissions and input validation. */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

import { contactsTable, db, leadsTable, organizationsTable, sessionsTable, usersTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

const { default: app } = await import("../../app");
import { createSession } from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";
import { createInvoice } from "../../services/invoices";

let server: Server, baseUrl: string, orgId: string;
const sids: Record<string, string> = {};

async function sessionFor(role: "owner" | "sales_rep" | "viewer") {
  const [user] = await db.insert(usersTable).values({ email: `specialists-${role}-${randomUUID()}@example.test`, organizationId: orgId, role, isActive: true, emailVerifiedAt: new Date() }).returning();
  return createSession({ user: { id: user!.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "test-token", expires_at: Math.floor(Date.now() / 1000) + 3600 });
}

beforeAll(async () => {
  orgId = (await db.insert(organizationsTable).values({ name: "Synthetic specialist routes", slug: `specialist-routes-${randomUUID()}` }).returning())[0]!.id;
  for (const role of ["owner", "sales_rep", "viewer"] as const) sids[role] = await sessionFor(role);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(sessionsTable).where(inArray(sessionsTable.sid, Object.values(sids)));
  await deleteTestOrgs(orgId);
});

const call = (method: string, path: string, sid: string, body?: unknown) => fetch(`${baseUrl}/api/v1${path}`, {
  method, headers: { "content-type": "application/json", Authorization: `Bearer ${sid}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("/bie/specialists", () => {
  it("runs SCOUT and INVO as proposal-only runs and lists by specialist", async () => {
    const scout = await call("POST", "/bie/specialists/scout/run", sids.owner!, {});
    expect(scout.status).toBe(201);
    expect(await scout.json()).toMatchObject({ specialist: "SCOUT", proposals: [], runId: expect.any(String) });
    const invo = await call("POST", "/bie/specialists/invo/run", sids.owner!, { warrantyDatesRequired: true });
    expect(invo.status).toBe(201);
    expect(await invo.json()).toMatchObject({ specialist: "INVO" });
    const list = await call("GET", "/bie/specialists/scout/proposals", sids.viewer!);
    expect(list.status).toBe(200);
    expect(Array.isArray(await list.json())).toBe(true);
  });

  it("validates the specialist key and options", async () => {
    expect((await call("POST", "/bie/specialists/assistant/run", sids.owner!, {})).status).toBe(400);
    expect((await call("POST", "/bie/specialists/execute/run", sids.owner!, {})).status).toBe(400);
    expect((await call("POST", "/bie/specialists/invo/run", sids.owner!, { status: "approved" })).status).toBe(400);
    expect((await call("GET", "/bie/specialists/bogus/proposals", sids.owner!)).status).toBe(400);
  });

  it("hides and protects populated INVO proposals from roles and capped API keys without invoice access", async () => {
    const [owner] = await db.select().from(usersTable).where(and(eq(usersTable.organizationId, orgId), eq(usersTable.role, "owner")));
    const [contact] = await db.insert(contactsTable).values({ organizationId: orgId, firstName: "Synthetic" }).returning();
    const [lead] = await db.insert(leadsTable).values({ organizationId: orgId, contactId: contact!.id, status: "won", source: "native_qa" }).returning();
    const draft = (await createInvoice(orgId, owner!.id, { requestId: randomUUID(), leadId: lead!.id, document: {
      title: "Synthetic service", currency: "USD", issuerName: "Synthetic", customerName: "Synthetic customer",
      lineItems: [{ description: "Repair A", quantity: "1", unitPriceCents: 1000 }, { description: "Repair B", quantity: "1", unitPriceCents: 2000 }], taxCents: 0 } })).invoice;
    const cappedKey = (await createApiKey({ organizationId: orgId, name: "capped sales key", role: "sales_rep", createdByUserId: owner!.id })).key;
    const officeKey = (await createApiKey({ organizationId: orgId, name: "office key", role: "office", createdByUserId: owner!.id })).key;
    const keyCall = (method: string, path: string, key: string, body?: unknown) => fetch(`${baseUrl}/api/v1${path}`, {
      method, headers: { "content-type": "application/json", "x-api-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    // An owner-created key capped to sales_rep has crm.write but not invoices.read.
    expect((await keyCall("POST", "/bie/specialists/invo/run", cappedKey, {})).status).toBe(403);
    const run = await (await call("POST", "/bie/specialists/invo/run", sids.owner!, {})).json() as { proposals: Array<{ id: string; payload: Record<string, unknown>; evidence: Record<string, unknown> }> };
    const review = run.proposals.find((p) => p.evidence.invoiceId === draft.id)!;
    expect(review).toBeTruthy();

    const ids = async (res: Response) => ((await res.json()) as Array<{ id: string }>).map((p) => p.id);
    expect(await ids(await call("GET", "/bie/actions", sids.owner!))).toContain(review.id);
    expect(await ids(await keyCall("GET", "/bie/actions", officeKey))).toContain(review.id);
    for (const denied of [() => call("GET", "/bie/actions", sids.viewer!), () => call("GET", "/bie/actions", sids.sales_rep!), () => keyCall("GET", "/bie/actions", cappedKey)])
      expect(await ids(await denied())).not.toContain(review.id);
    const desk = async (res: Response) => JSON.stringify(await res.json());
    expect(await desk(await call("GET", "/revenue/desk", sids.owner!))).toContain(review.id);
    expect(await desk(await call("GET", "/revenue/desk", sids.viewer!))).not.toContain(review.id);
    expect(await desk(await keyCall("GET", "/revenue/desk", cappedKey))).not.toContain(review.id);
    expect((await call("GET", "/bie/specialists/invo/proposals", sids.viewer!)).status).toBe(403);
    expect((await keyCall("GET", "/bie/specialists/invo/proposals", cappedKey)).status).toBe(403);
    expect((await call("GET", "/bie/specialists/invo/proposals", sids.owner!)).status).toBe(200);

    for (const action of ["approve", "reject", "execute"]) {
      expect((await call("POST", `/bie/actions/${review.id}/${action}`, sids.sales_rep!, { expectedPayload: review.payload })).status).toBe(403);
      expect((await keyCall("POST", `/bie/actions/${review.id}/${action}`, cappedKey, { expectedPayload: review.payload })).status).toBe(403);
    }
    expect((await call("POST", `/bie/actions/${review.id}/approve`, sids.owner!, { expectedPayload: review.payload })).status).toBe(200);
  });

  it("enforces permissions: viewers cannot run; INVO also needs invoice access", async () => {
    expect((await call("POST", "/bie/specialists/scout/run", sids.viewer!, {})).status).toBe(403);
    expect((await call("POST", "/bie/specialists/scout/run", sids.sales_rep!, {})).status).toBe(201);
    const invo = await call("POST", "/bie/specialists/invo/run", sids.sales_rep!, {});
    expect(invo.status).toBe(403);
    expect(await invo.json()).toMatchObject({ code: "specialist_access_denied" });
  });
});
