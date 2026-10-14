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
import type { ManualSchedulingCommand } from "@workspace/scheduling-core";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
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
