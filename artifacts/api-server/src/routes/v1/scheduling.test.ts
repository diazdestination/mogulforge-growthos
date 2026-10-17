import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { ReconcileSchedulingOperationResponse } from "@workspace/api-zod";
import { schedulingConflictExplanationSchema, type ManualSchedulingCommand } from "@workspace/scheduling-core";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  getSchedulingReviewContext,
  saveSchedulingPolicy,
  assertSchedulingActor,
  lockSchedulingConfiguration,
} from "../../services/scheduling-policy";
import { runManualSchedulingCreate } from "../../services/manual-scheduling-receipt";
import * as receipt from "../../services/manual-scheduling-receipt";

let server: Server, origin: string;
const orgs: string[] = [];
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await deleteTestOrgs(...orgs);
});
async function fixture() {
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic reconcile route",
      timezone: "UTC",
      slug: `receipt-route-${randomUUID()}`,
    })
    .returning();
  orgs.push(org.id);
  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      role: "owner",
      emailVerifiedAt: new Date(),
    })
    .returning();
  const sid = await createSession({
    user: {
      id: user.id,
      email: user.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-session",
  });
  const actor = { organizationId: org.id, userId: user.id };
  const command: ManualSchedulingCommand = {
    operationId: randomUUID(),
    kind: "appointment_create",
    body: { scheduledStart: "2035-01-02T10:00:00Z", type: "other" },
    review: {
      context: {
        organizationId: org.id,
        policyRevision: 0,
        policyDigest: null,
        companyTimeZone: "UTC",
        inspection: null,
        applicableRules: {
          newTravelGapMinutes: 0,
          companyCeiling: null,
          inspectionCeiling: null,
        },
        source: {
          sourceKind: "unlinked_manual",
          leadId: null,
          contactId: null,
          propertyId: null,
          estimateId: null,
        },
        targetVersion: null,
        targetFingerprint: null,
      },
      duration: { kind: "explicit", preset: null },
      startWallTime: null,
      endWallTime: null,
    },
  };
  return { org: org.id, actor, command, sid, user };
}
function request(
  sid: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/v1/scheduling/operations/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "https://growth.example",
      ...(sid ? { cookie: `sid=${sid}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
it("returns a direct closed HTTP200 terminal ack, then the same outcome, without creating", async () => {
  const f = await fixture(),
    res = await request(f.sid, f.command);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const ack = await res.json();
  expect(ReconcileSchedulingOperationResponse.parse(ack)).toEqual(ack);
  expect(ack).toMatchObject({
    operationId: f.command.operationId,
    organizationId: f.org,
    actorUserId: f.user.id,
    outcome: "no_commit_refused",
    refusalCode: "original_create_fenced",
  });
  expect(await (await request(f.sid, f.command)).json()).toEqual(ack);
  expect(
    await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org)),
  ).toEqual([]);
});
it("returns HTTP200 committed-unavailable after target deletion", async () => {
  const f = await fixture();
  const result = await db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, f.org);
    await assertSchedulingActor(tx, f.actor, "crm.write");
    return runManualSchedulingCreate(tx, f.actor, f.command, async (tx) => {
      const [target] = await tx
        .insert(appointmentsTable)
        .values({
          organizationId: f.org,
          scheduledStart: new Date("2035-01-02T10:00:00Z"),
        })
        .returning();
      return { kind: "appointment", id: target.id };
    });
  });
  await db
    .delete(appointmentsTable)
    .where(eq(appointmentsTable.id, result.ack.target!.id));
  const res = await request(f.sid, f.command);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ...result.ack,
    target: { ...result.ack.target!, available: false },
  });
});
it.each([
  "outer-actor",
  "body-snapshot",
  "nested-extra",
  "wrong-org",
  "source-mismatch",
] as const)("rejects closed original %s with no receipt", async (kind) => {
  const f = await fixture(),
    body: any = structuredClone(f.command);
  if (kind === "outer-actor") body.actorUserId = f.user.id;
  if (kind === "body-snapshot") body.body.schedulingReservation = {};
  if (kind === "nested-extra") body.review.context.source.secret = true;
  if (kind === "wrong-org") body.review.context.organizationId = randomUUID();
  if (kind === "source-mismatch") body.body.contactId = randomUUID();
  const res = await request(f.sid, body);
  expect(res.status).toBe(400);
  expect(await res.json()).not.toHaveProperty("outcome");
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org)),
  ).toEqual([]);
});
it.each([
  "unauthenticated",
  "viewer",
  "inactive",
  "unverified",
  "origin",
  "cross-site",
  "same-site",
  "content-type",
] as const)(
  "retains existing %s protection without terminal proof",
  async (kind) => {
    const f = await fixture(),
      headers: Record<string, string> = {};
    if (kind === "viewer")
      await db
        .update(usersTable)
        .set({ role: "viewer" })
        .where(eq(usersTable.id, f.user.id));
    if (kind === "inactive")
      await db
        .update(usersTable)
        .set({ isActive: false })
        .where(eq(usersTable.id, f.user.id));
    if (kind === "unverified")
      await db
        .update(usersTable)
        .set({ emailVerifiedAt: null })
        .where(eq(usersTable.id, f.user.id));
    if (kind === "origin") headers.Origin = "https://other.example";
    if (kind === "cross-site" || kind === "same-site")
      headers["sec-fetch-site"] = kind;
    if (kind === "content-type") headers["content-type"] = "text/plain";
    const res = await request(
      kind === "unauthenticated" ? "" : f.sid,
      f.command,
      headers,
    );
    expect(res.status).toBe(
      kind === "unauthenticated" ? 401 : kind === "content-type" ? 415 : 403,
    );
    expect(await res.json()).not.toHaveProperty("outcome");
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.organizationId, f.org)),
    ).toEqual([]);
  },
);
it("ordinary audit collision returns only opaque409 without original capability or metadata", async () => {
  const f = await fixture(),
    target = randomUUID();
  await db.insert(auditEventsTable).values({
    id: f.command.operationId,
    organizationId: f.org,
    actorUserId: f.user.id,
    action: "private.synthetic",
    entityType: "appointment",
    entityId: target,
    metadata: { secret: "private-synthetic" },
  });
  const res = await request(f.sid, f.command),
    body = await res.json();
  expect(res.status).toBe(409);
  expect(body).toEqual({
    code: "operation_identity_conflict",
    error: expect.any(String),
  });
  expect(JSON.stringify(body)).not.toMatch(
    new RegExp(`${target}|private-synthetic|${f.command.operationId}`),
  );
});
it("database or transport failure remains unknown rather than a terminal acknowledgement", async () => {
  const f = await fixture();
  vi.spyOn(receipt, "reconcileManualScheduling").mockRejectedValueOnce(
    new Error("Synthetic connection unavailable"),
  );
  const res = await request(f.sid, f.command);
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({
    error: expect.any(String),
    code: "scheduling_outcome_unknown",
  });
  expect(JSON.stringify(body)).not.toContain(
    "Synthetic connection unavailable",
  );
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org)),
  ).toEqual([]);
});

it("lost reconciliation response after COMMIT leaves its permanent fence available to the exact original", async () => {
  const f = await fixture(),
    actual = receipt.reconcileManualScheduling;
  let committed: Awaited<ReturnType<typeof actual>> | undefined;
  vi.spyOn(receipt, "reconcileManualScheduling").mockImplementationOnce(
    async (actor, original) => {
      committed = await actual(actor, original);
      throw Error("Synthetic response lost after reconciliation COMMIT");
    },
  );
  const lost = await request(f.sid, f.command);
  expect(lost.status).toBe(500);
  expect(await lost.json()).not.toHaveProperty("outcome");
  const retry = await request(f.sid, f.command);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(committed);
  expect(
    await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org)),
  ).toEqual([]);
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org)),
  ).toHaveLength(2);
});

it('explains only a current authorized adjacent conflict without creating an operation', async () => {
  const f = await fixture();
  await saveSchedulingPolicy(f.actor, { expectedRevision: 0, expectedCompanyTimeZone: 'UTC', enabled: true, minimumTravelGapMinutes: 60, maxConcurrentReservations: 1, durationPresets: [] });
  const [neighbor] = await db.insert(appointmentsTable).values({ organizationId: f.org, assignedUserId: f.user.id, type: 'other', scheduledStart: new Date('2035-01-02T10:00:00Z'), scheduledEnd: new Date('2035-01-02T11:00:00Z'), notes: 'PRIVATE NEIGHBOR NOTES' }).returning();
  const query = { sourceKind: 'unlinked_manual' as const, reservationKind: 'appointment' as const, appointmentType: 'other' as const };
  const context = await getSchedulingReviewContext(f.actor, query);
  const body = { query, context, interval: { startAt: '2035-01-02T11:30:00.000Z', endAt: '2035-01-02T12:30:00.000Z', resourceUserIds: [f.user.id] } };
  const auditBefore = await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org));
  const explain = (input: unknown, sid = f.sid) => fetch(`${origin}/api/v1/scheduling/conflict-explanation`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `sid=${sid}`, Origin: 'https://growth.example' }, body: JSON.stringify(input) });
  const res = await explain(body);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const value = schedulingConflictExplanationSchema.parse(await res.json());
  expect(Object.keys(value).sort()).toEqual(['basis', 'conflict', 'context', 'evaluatedAt']);
  expect(value).toMatchObject({ basis: 'current_schedule', context, conflict: { reservationKind: 'appointment', reservationId: neighbor.id, resourceUserId: f.user.id, reason: 'travel_gap', requiredGapMinutes: 60 } });
  expect(JSON.stringify(value)).not.toContain('PRIVATE');
  expect(schedulingConflictExplanationSchema.parse(await (await explain({ ...body, interval: { ...body.interval, startAt: '2035-01-02T10:30:00.000Z' } })).json()).conflict?.reason).toBe('resource_overlap');
  expect(schedulingConflictExplanationSchema.parse(await (await explain({ ...body, interval: { ...body.interval, startAt: '2035-01-02T12:00:00.000Z' } })).json()).conflict).toBeNull();
  const targetQuery = { ...query, targetKind: 'appointment' as const, targetId: neighbor.id };
  const targetContext = await getSchedulingReviewContext(f.actor, targetQuery);
  expect(schedulingConflictExplanationSchema.parse(await (await explain({ ...body, query: targetQuery, context: targetContext })).json()).conflict).toBeNull();
  expect((await explain(body, 'missing-session')).status).toBe(401);
  await db.update(appointmentsTable).set({ schedulingReservation: { formatVersion: 1, reservationRevision: 1, sourcePolicyRevision: context.policyRevision, sourcePolicyDigest: context.policyDigest!, approvedTimeZone: 'UTC', inspection: null, startAt: neighbor.scheduledStart.toISOString(), endAt: '2035-01-02T13:00:00.000Z', resourceUserIds: [f.user.id], minimumTravelGapMinutes: 60, duration: { kind: 'explicit', preset: null }, admittedAt: neighbor.createdAt.toISOString(), admittedByUserId: f.user.id, target: { kind: 'appointment', id: neighbor.id }, lastTransition: { kind: 'admission', actorUserId: f.user.id, at: neighbor.createdAt.toISOString() } }, updatedAt: neighbor.updatedAt }).where(eq(appointmentsTable.id, neighbor.id));
  const corrupt = await explain(body); expect(corrupt.status).toBe(409); expect(JSON.stringify(await corrupt.json())).not.toContain(neighbor.id);
  await db.update(appointmentsTable).set({ schedulingReservation: null, updatedAt: neighbor.updatedAt }).where(eq(appointmentsTable.id, neighbor.id));
  const foreign = await fixture();
  for (const input of [{ ...body, ignoreReservationIds: [neighbor.id] }, { ...body, query: { ...query, sourceKind: 'direct_customer', sourceId: randomUUID() } }, { ...body, actorUserId: f.user.id }, { ...body, context: { ...context, policyRevision: 90 } }, { ...body, interval: { ...body.interval, resourceUserIds: [foreign.user.id] } }, { ...body, query: { ...query, targetKind: 'appointment', targetId: randomUUID() } }, { ...body, interval: { ...body.interval, endAt: 'bad' } }]) {
    const denied = await explain(input); expect(denied.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(await denied.json())).not.toContain(neighbor.id);
  }
  expect((await explain(body, foreign.sid)).status).toBeGreaterThanOrEqual(400);
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.user.id));
  expect((await explain(body)).status).toBeGreaterThanOrEqual(400);
  expect(await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org))).toEqual(auditBefore);
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toEqual([neighbor]);
});
