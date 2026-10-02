import { randomUUID, createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  activitiesTable, auditEventsTable, contactsTable, customerLifecycleTable, db,
  estimatesTable, leadsTable, organizationsTable, projectsTable, revenueExecutionEventsTable,
  revenueExecutionsTable, scheduledActionsTable, storedObjectsTable, usersTable,
} from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { assertCustomerLifecycleActive, transitionCustomerLifecycle } from "../../services/customer-lifecycle";
import { createCustomerLifecycleExporter } from "../../services/customer-lifecycle-export";

type Tenant = { org: string; owner: string; ownerSid: string; viewerSid: string; adminSid: string; inactiveSid: string; contact: string; lead: string; execution: string; marker: string; secret: string };
const tenants: Tenant[] = [], sessions: string[] = [];
let server: Server, base: string;
async function session(userId: string) {
  const sid = await createSession({ user: { id: userId, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "SYNTHETIC_SESSION_SECRET", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(sid); return sid;
}
const request = (sid: string | null, path = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/customer-lifecycle${path}`, {
  method, headers: { ...(sid ? { authorization: `Bearer ${sid}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const command = (action: string, expectedVersion: number, extras = {}) => ({ action, expectedVersion, reason: "Synthetic owner review for this test", ...extras });
beforeAll(async () => {
  if (process.env.RESTORE_DRILL_ONLY === "true") throw new Error("Normal authenticated mode required");
  for (const label of ["A", "B"]) {
    const marker = `LIFECYCLE_${label}_${randomUUID()}`, secret = `SECRET_${randomUUID()}`;
    const [org] = await db.insert(organizationsTable).values({ name: marker, slug: marker.toLowerCase(), stripeCustomerId: secret, stripeSubscriptionId: `sub_${secret}` }).returning();
    const [owner, viewer, admin, inactive] = await db.insert(usersTable).values([
      { organizationId: org.id, role: "owner", passwordHash: secret }, { organizationId: org.id, role: "viewer" },
      { organizationId: org.id, role: "admin" }, { organizationId: org.id, role: "owner", isActive: false },
    ]).returning();
    const [contact] = await db.insert(contactsTable).values([
      { organizationId: org.id, firstName: marker, email: `${randomUUID()}@example.test` },
      { organizationId: org.id, firstName: "Second synthetic contact" },
    ]).returning();
    const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id, summary: marker, firstTouch: { apiKey: secret } }).returning();
    await db.insert(activitiesTable).values({ organizationId: org.id, leadId: lead.id, contactId: contact.id, type: "note", title: marker, body: "Retain this customer's note", metadata: { token: secret } });
    await db.insert(estimatesTable).values({ organizationId: org.id, leadId: lead.id, title: marker, lineItems: [{ description: "Service", quantity: 1, unitPriceCents: 5000, totalCents: 5000, privateToken: secret } as never] });
    await db.insert(storedObjectsTable).values({ id: randomUUID(), organizationId: org.id, data: Buffer.from(secret), contentType: "image/png", sizeBytes: secret.length, metadata: { token: secret } });
    const [execution] = await db.insert(revenueExecutionsTable).values({ organizationId: org.id, actionKey: `synthetic:${randomUUID()}`, fingerprint: secret, kind: "create_task", state: "indeterminate", detail: secret, expiresAt: new Date(Date.now() + 60000) }).returning();
    await db.insert(revenueExecutionEventsTable).values({ organizationId: org.id, executionId: execution.id, state: "indeterminate", detail: secret });
    await db.insert(scheduledActionsTable).values({ organizationId: org.id, action: { type: "create_task", params: { title: marker } }, context: { leadId: lead.id }, runAt: new Date() });
    tenants.push({ org: org.id, owner: owner.id, ownerSid: await session(owner.id), viewerSid: await session(viewer.id), adminSid: await session(admin.id), inactiveSid: await session(inactive.id), contact: contact.id, lead: lead.id, execution: execution.id, marker, secret });
  }
  server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  base = `http://127.0.0.1:${address.port}`;
}, 20000);
beforeEach(async () => { await db.delete(customerLifecycleTable).where(inArray(customerLifecycleTable.organizationId, tenants.map((t) => t.org))); });
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...tenants.map((t) => t.org));
});

describe("normal-mode customer lifecycle ownership", () => {
  it.each([0, 1])("exports only caller %i's allowlisted records with independently checked child ownership", async (index) => {
    const own = tenants[index], foreign = tenants[1 - index];
    const [broken] = await db.insert(estimatesTable).values({ organizationId: own.org, leadId: foreign.lead, title: "WITHHELD_FOREIGN_PARENT" }).returning();
    const [brokenProject] = await db.insert(projectsTable).values({ organizationId: own.org, leadId: own.lead, estimateId: broken.id, name: "WITHHELD_INDIRECT_PARENT" }).returning();
    const [badEvent] = await db.insert(revenueExecutionEventsTable).values({ organizationId: own.org, executionId: foreign.execution, state: "indeterminate", detail: "WITHHELD_FOREIGN_EXECUTION" }).returning();
    try {
      const response = await request(own.ownerSid, "/export"); expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
      const result = await response.json() as Awaited<ReturnType<ReturnType<typeof createCustomerLifecycleExporter>>>, encoded = JSON.stringify(result);
      expect(encoded).toContain(own.marker);
      for (const canary of [foreign.marker, foreign.org, foreign.contact, foreign.lead, foreign.execution, own.secret, foreign.secret, "SYNTHETIC_SESSION_SECRET", "WITHHELD_"]) expect(encoded).not.toContain(canary);
      expect(result.manifest).toMatchObject({ completeAccountExport: false, deletionPerformed: false, scope: "core_customer_records" });
      expect(result.manifest.tables).toHaveLength(18);
      expect(result.manifest.tables.find((t) => t.table === "estimates")?.withheldInvalidLinks).toBe(1);
      expect(result.manifest.tables.find((t) => t.table === "projects")?.withheldInvalidLinks).toBe(1);
      expect(result.manifest.tables.find((t) => t.table === "revenue_execution_events")?.withheldInvalidLinks).toBe(1);
      expect(result.data.estimates[0].line_items).toEqual([{ description: "Service", quantity: 1, unitPriceCents: 5000, totalCents: 5000 }]);
      expect(result.manifest.dataSha256).toBe(createHash("sha256").update(JSON.stringify(result.data)).digest("hex"));
      const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, own.org), eq(auditEventsTable.action, "customer_lifecycle.export_prepared")));
      expect(audit.metadata).toMatchObject({ deliveryConfirmed: false });
    } finally {
      await db.delete(projectsTable).where(eq(projectsTable.id, brokenProject.id));
      await db.delete(estimatesTable).where(eq(estimatesTable.id, broken.id));
      await db.delete(revenueExecutionEventsTable).where(eq(revenueExecutionEventsTable.id, badEvent.id));
    }
  });
  it("rejects anonymous, non-admin, inactive and API-key access to reads, exports and transitions", async () => {
    const own = tenants[0];
    for (const [sid, expected] of [[null, 401], [own.viewerSid, 403], [own.inactiveSid, 403]] as const) {
      expect((await request(sid)).status).toBe(expected);
      expect((await request(sid, "/export")).status).toBe(expected);
      expect((await request(sid, "/transition", "POST", command("pause", 0))).status).toBe(expected);
    }
    expect((await request(own.ownerSid, "", "GET", undefined, { "x-api-key": "synthetic-key" })).status).toBe(403);
    expect((await request(own.ownerSid, "/export", "GET", undefined, { "x-api-key": "synthetic-key" })).status).toBe(403);
    expect((await request(own.ownerSid, "/transition", "POST", command("pause", 0), { "x-api-key": "synthetic-key" })).status).toBe(403);
    expect((await request(own.adminSid)).status).toBe(200);
  });
  it.each([0, 1])("ignores no forged company selectors and changes only authenticated tenant %i", async (index) => {
    const own = tenants[index], foreign = tenants[1 - index];
    expect((await request(own.ownerSid, `?organizationId=${foreign.org}`)).status).toBe(400);
    expect((await request(own.ownerSid, `/export?organizationId=${foreign.org}`)).status).toBe(400);
    expect((await request(own.ownerSid, "/transition", "POST", command("pause", 0, { organizationId: foreign.org }))).status).toBe(400);
    expect((await request(own.ownerSid, "/transition", "POST", command("pause", 0))).status).toBe(200);
    expect(await (await request(foreign.ownerSid)).json()).toMatchObject({ state: "active", version: 0 });
    await expect(transitionCustomerLifecycle(foreign.org, own.owner, command("pause", 0))).rejects.toMatchObject({ status: 403 });
  });
  it("keeps queued and indeterminate work, exports and history through pause/offboarding/cancel; resume requires fresh explicit review", async () => {
    const own = tenants[0];
    const queueBefore = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, own.org));
    const receiptsBefore = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, own.org));
    const pause = await request(own.adminSid, "/transition", "POST", command("pause", 0));
    expect(await pause.json()).toMatchObject({ state: "paused", version: 1, automationAllowed: false });
    await expect(assertCustomerLifecycleActive(own.org)).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
    expect((await request(own.ownerSid, "/export")).status).toBe(200);
    expect((await request(own.ownerSid, "/transition", "POST", command("resume", 1))).status).toBe(400);
    const requested = await request(own.ownerSid, "/transition", "POST", command("request_offboarding", 1));
    expect(await requested.json()).toMatchObject({ state: "offboarding_requested", version: 2, requestId: expect.any(String), deletionPerformed: false, billingChanged: false });
    expect((await request(own.ownerSid, "/transition", "POST", command("resume", 2, { resumeQueuedWork: true }))).status).toBe(409);
    expect(await (await request(own.ownerSid, "/transition", "POST", command("cancel_offboarding", 2))).json()).toMatchObject({ state: "paused", version: 3 });
    await expect(assertCustomerLifecycleActive(own.org)).rejects.toMatchObject({ status: 423 });
    expect((await request(own.ownerSid, "/transition", "POST", command("resume", 1, { resumeQueuedWork: true }))).status).toBe(409);
    expect(await (await request(own.ownerSid, "/transition", "POST", command("resume", 3, { resumeQueuedWork: true }))).json()).toMatchObject({ state: "active", version: 4 });
    await expect(assertCustomerLifecycleActive(own.org)).resolves.toBeUndefined();
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, own.org))).toEqual(queueBefore);
    expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, own.org))).toEqual(receiptsBefore);
    const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, own.org));
    expect(org.stripeCustomerId).toBe(own.secret);
    const actions = (await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, own.org))).map((row) => row.action);
    for (const action of ["pause", "request_offboarding", "cancel_offboarding", "resume"]) expect(actions).toContain(`customer_lifecycle.${action}`);
  });
  it("fails oversized exports without returning a partial document", async () => {
    const exporter = createCustomerLifecycleExporter({ maxRows: 1 });
    await expect(exporter(tenants[0].org, tenants[0].owner)).rejects.toMatchObject({ status: 413, code: "customer_export_limit" });
    await expect(createCustomerLifecycleExporter({ maxBytes: 100 })(tenants[0].org, tenants[0].owner)).rejects.toMatchObject({ status: 413 });
  });
  it("rejects cross-origin and non-JSON mutations before any state changes", async () => {
    const own = tenants[0], previousOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = "https://lifecycle.example.test";
    try {
      const rejectedHeaders: Record<string, string>[] = [{ origin: "https://other.example.test" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }];
      for (const headers of rejectedHeaders) {
        expect((await request(own.ownerSid, "/transition", "POST", command("pause", 0), headers)).status).toBe(403);
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        expect((await request(own.ownerSid, "/transition", "POST", command("pause", 0), { "content-type": type })).status).toBe(415);
      }
      expect(await (await request(own.ownerSid)).json()).toMatchObject({ state: "active", version: 0 });
      expect((await request(own.ownerSid, "/transition", "POST", command("pause", 0), { origin: process.env.APP_ORIGIN })).status).toBe(200);
    } finally {
      if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previousOrigin;
    }
  });
  it("fails closed for missing companies and a deactivated manager", async () => {
    await expect(assertCustomerLifecycleActive(randomUUID())).rejects.toMatchObject({ status: 404 });
    await db.insert(customerLifecycleTable).values({ organizationId: tenants[0].org, state: "paused", version: 1, reason: "Synthetic hold", updatedByUserId: tenants[0].owner });
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, tenants[0].owner));
    try { await expect(transitionCustomerLifecycle(tenants[0].org, tenants[0].owner, command("resume", 1, { resumeQueuedWork: true }))).rejects.toMatchObject({ status: 403 }); }
    finally { await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, tenants[0].owner)); }
  });
  it("rejects untrusted credentialed export reads including same-site and Express path aliases", async () => {
    const own = tenants[0], previousOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = 'https://app.example.test/';
    try {
      for (const path of ['/export', '/EXPORT/']) {
        const denied = await request(null, path, 'GET', undefined, { cookie: `sid=${own.ownerSid}`, origin: 'https://untrusted.example.test', 'sec-fetch-site': 'same-site' });
        expect(denied.status).toBe(403);
        expect(await denied.text()).not.toContain(own.marker);
      }
      expect((await request(null, '/export', 'GET', undefined, { cookie: `sid=${own.ownerSid}`, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await request(null, '/export', 'GET', undefined, { cookie: `sid=${own.ownerSid}`, origin: 'https://app.example.test', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    } finally {
      if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previousOrigin;
    }
  });
});
