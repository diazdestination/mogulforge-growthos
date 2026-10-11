/** Route tests for proposal-only specialists: run and list, permissions and input validation. */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

import { db, organizationsTable, sessionsTable, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

const { default: app } = await import("../../app");
import { createSession } from "../../lib/auth";

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

  it("enforces permissions: viewers cannot run; INVO also needs invoice access", async () => {
    expect((await call("POST", "/bie/specialists/scout/run", sids.viewer!, {})).status).toBe(403);
    expect((await call("POST", "/bie/specialists/scout/run", sids.sales_rep!, {})).status).toBe(201);
    const invo = await call("POST", "/bie/specialists/invo/run", sids.sales_rep!, {});
    expect(invo.status).toBe(403);
    expect(await invo.json()).toMatchObject({ code: "specialist_access_denied" });
  });
});
