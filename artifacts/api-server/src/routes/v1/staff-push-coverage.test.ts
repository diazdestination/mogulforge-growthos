import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod/v4";
import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  sessionsTable,
  staffLeadAlertCoverageTable as coverage,
  staffPushDeliveriesTable as deliveries,
  staffPushSubscriptionsTable as subscriptions,
  usersTable,
  type StaffLeadAlertRecipient,
  type StaffPushDeliveryState,
} from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession, SESSION_COOKIE } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import * as staffPush from "../../services/staff-push";

vi.mock("../../services/staff-push-transport", async (original) => ({
  ...(await original<typeof import("../../services/staff-push-transport")>()),
  sendStaffPush: vi.fn(async () => {
    throw new Error("Coverage reads must never contact a provider");
  }),
}));
import { sendStaffPush } from "../../services/staff-push-transport";

const currentOrigin = "https://growthos.example.invalid";
const occurredAt = new Date("2026-10-01T12:00:00.000Z");
const count = z.number().int().min(0).max(5);
const countsSchema = z
  .object({
    pending: count,
    dispatching: count,
    accepted: count,
    rejected: count,
    expired: count,
    cancelled: count,
    indeterminate: count,
    unavailable: count,
  })
  .strict();
const dtoSchema = z
  .object({
    organizationId: z.uuid(),
    leadId: z.uuid(),
    status: z.enum([
      "evaluated",
      "policy_unavailable",
      "policy_disabled",
      "historical_unknown",
      "coverage_not_recorded",
    ]),
    version: z.literal(1).nullable(),
    occurredAt: z.iso.datetime(),
    recordedAt: z.iso.datetime().nullable(),
    serverNow: z.iso.datetime(),
    receiptMeaning: z.literal("provider_accepted_not_received_or_read"),
    recipients: z
      .array(
        z
          .object({
            userId: z.string(),
            displayName: z.string().nullable(),
            outcome: z.enum([
              "queued",
              "recipient_unavailable",
              "no_eligible_device",
              "notification_expired",
            ]),
            queuedDeviceCount: count,
            deliveryStateCounts: countsSchema,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const zeroCounts = () => ({
  pending: 0,
  dispatching: 0,
  accepted: 0,
  rejected: 0,
  expired: 0,
  cancelled: 0,
  indeterminate: 0,
  unavailable: 0,
});

let server: Server, base: string;
let org: string,
  otherOrg: string,
  owner: string,
  admin: string,
  otherOwner: string;
let lead: string,
  foreignLead: string,
  contact: string,
  sid: string,
  adminSid: string,
  otherSid: string;
let sessions: string[], detachedUsers: string[];
const endpoint = (id = lead) => `/staff-push/leads/${id}/coverage`;
const request = (path = endpoint(), options: RequestInit = {}, session = sid) =>
  fetch(`${base}/api/v1${path}`, {
    ...options,
    headers: { authorization: `Bearer ${session}`, ...options.headers },
  });
async function sessionFor(id: string, extras = {}) {
  const value = await createSession({
    user: {
      id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "PRIVATE_SYNTHETIC_ACCESS_TOKEN",
    ...extras,
  });
  sessions.push(value);
  return value;
}
async function snapshot(
  recipients: StaffLeadAlertRecipient[],
  status: typeof coverage.$inferInsert.status = "evaluated",
) {
  await db.insert(coverage).values({
    organizationId: org,
    leadId: lead,
    occurredAt,
    status,
    recipients,
    policyFingerprint:
      status === "evaluated" || status === "policy_disabled"
        ? "a".repeat(64)
        : null,
  });
}
async function receipt(
  state: StaffPushDeliveryState,
  options: {
    organizationId?: string;
    userId?: string;
    sessionId?: string;
    leadId?: string;
  } = {},
) {
  const [device] = await db
    .insert(subscriptions)
    .values({
      organizationId: options.organizationId ?? org,
      userId: options.userId ?? owner,
      sessionId: options.sessionId ?? sid,
      endpointHash: `PRIVATE_ENDPOINT_HASH_${randomUUID()}`,
      encryptedSubscription: "PRIVATE_DEVICE_CIPHERTEXT_AND_KEY",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  const [effect] = await db
    .insert(deliveries)
    .values({
      organizationId: options.organizationId ?? org,
      leadId: options.leadId ?? lead,
      subscriptionId: device.id,
      state,
      expiresAt: new Date(Date.now() + 60_000),
      providerStatus: 201,
      reason: "PRIVATE_PROVIDER_RESPONSE",
    })
    .returning();
  return effect;
}
async function expectFailure(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = z
    .object({ error: z.string() })
    .strict()
    .parse(await response.json());
  expect(Object.keys(body)).toEqual(["error"]);
  expect(typeof body.error).toBe("string");
  expect(JSON.stringify(body)).not.toContain("PRIVATE_");
  return body;
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test listener unavailable");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", currentOrigin);
  vi.mocked(sendStaffPush).mockClear();
  sessions = [];
  detachedUsers = [];
  [org, otherOrg] = (
    await db
      .insert(organizationsTable)
      .values(
        ["A", "B"].map((label) => ({
          name: `Synthetic alert coverage ${label}`,
          slug: `coverage-http-${randomUUID()}`,
        })),
      )
      .returning()
  ).map((row) => row.id);
  [owner, admin, otherOwner] = (
    await db
      .insert(usersTable)
      .values([
        {
          organizationId: org,
          role: "owner" as const,
          firstName: "Synthetic",
          lastName: "Owner",
          email: `PRIVATE_OWNER_${randomUUID()}@example.invalid`,
          emailVerifiedAt: new Date(),
        },
        {
          organizationId: org,
          role: "admin" as const,
          firstName: "Synthetic",
          lastName: "Admin",
          emailVerifiedAt: new Date(),
        },
        {
          organizationId: otherOrg,
          role: "owner" as const,
          firstName: "PRIVATE_FOREIGN_NAME",
          emailVerifiedAt: new Date(),
        },
      ])
      .returning()
  ).map((row) => row.id);
  sid = await sessionFor(owner);
  adminSid = await sessionFor(admin);
  otherSid = await sessionFor(otherOwner);
  const contacts = await db
    .insert(contactsTable)
    .values(
      [org, otherOrg].map((organizationId) => ({
        organizationId,
        firstName: "PRIVATE_CUSTOMER_NAME",
        email: "PRIVATE_CUSTOMER_EMAIL@example.invalid",
        phone: "PRIVATE_CUSTOMER_PHONE",
      })),
    )
    .returning();
  contact = contacts[0].id;
  [lead, foreignLead] = (
    await db
      .insert(leadsTable)
      .values(
        contacts.map((row) => ({
          organizationId: row.organizationId,
          contactId: row.id,
          createdAt: occurredAt,
          summary: "PRIVATE_CUSTOMER_SUMMARY",
          firstTouch: { secret: "PRIVATE_CUSTOMER_METADATA" },
        })),
      )
      .returning()
  ).map((row) => row.id);
});
afterEach(async () => {
  expect(sendStaffPush).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const session of sessions) await deleteSession(session);
  await deleteTestOrgs(org, otherOrg);
  for (const id of detachedUsers)
    await db.delete(usersTable).where(eq(usersTable.id, id));
  vi.unstubAllEnvs();
});

describe("exact staff lead alert coverage HTTP contract", () => {
  it("returns historical unknown from a normal owner session without creating evidence or effects", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dtoSchema.parse(await response.json())).toMatchObject({
      organizationId: org,
      leadId: lead,
      status: "coverage_not_recorded",
      version: null,
      occurredAt: occurredAt.toISOString(),
      recordedAt: null,
      recipients: [],
    });
    expect(
      await db.select().from(coverage).where(eq(coverage.organizationId, org)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.organizationId, org)),
    ).toEqual([]);
  });

  it("accepts an admin cookie session and preserves admission separately from accepted effects", async () => {
    const effect = await receipt("accepted");
    await snapshot([
      { userId: owner, outcome: "queued", deliveryIds: [effect.id] },
      { userId: admin, outcome: "no_eligible_device", deliveryIds: [] },
    ]);
    const before = await db
      .select()
      .from(coverage)
      .where(eq(coverage.organizationId, org));
    const response = await fetch(`${base}/api/v1${endpoint()}`, {
      headers: {
        cookie: `${SESSION_COOKIE}=${adminSid}`,
        origin: currentOrigin,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text(),
      body = dtoSchema.parse(JSON.parse(text));
    expect(body.recipients).toEqual([
      {
        userId: owner,
        displayName: "Synthetic Owner",
        outcome: "queued",
        queuedDeviceCount: 1,
        deliveryStateCounts: { ...zeroCounts(), accepted: 1 },
      },
      {
        userId: admin,
        displayName: "Synthetic Admin",
        outcome: "no_eligible_device",
        queuedDeviceCount: 0,
        deliveryStateCounts: zeroCounts(),
      },
    ]);
    for (const hidden of [
      "PRIVATE_",
      sid,
      adminSid,
      effect.id,
      effect.subscriptionId,
      "a".repeat(64),
    ])
      expect(text).not.toContain(hidden);
    expect(
      await db.select().from(coverage).where(eq(coverage.organizationId, org)),
    ).toEqual(before);
    expect(
      (
        await db.select().from(deliveries).where(eq(deliveries.id, effect.id))
      )[0],
    ).toEqual(effect);
  });

  it.each([
    "policy_unavailable",
    "policy_disabled",
    "historical_unknown",
  ] as const)(
    "returns saved %s without inferring current coverage",
    async (status) => {
      await snapshot([], status);
      const response = await request();
      expect(response.status).toBe(200);
      expect(dtoSchema.parse(await response.json())).toMatchObject({
        status,
        version: 1,
        recipients: [],
        recordedAt: expect.any(String),
      });
    },
  );

  it("keeps current effect outcomes distinct and missing original receipts unavailable", async () => {
    const first = await receipt("pending"),
      second = await receipt("dispatching"),
      third = await receipt("indeterminate");
    await snapshot([
      {
        userId: owner,
        outcome: "queued",
        deliveryIds: [first.id, second.id, third.id, randomUUID()],
      },
    ]);
    const response = await request();
    expect(response.status).toBe(200);
    const body = dtoSchema.parse(await response.json());
    expect(body.recipients[0]).toMatchObject({
      queuedDeviceCount: 4,
      outcome: "queued",
      deliveryStateCounts: {
        ...zeroCounts(),
        pending: 1,
        dispatching: 1,
        indeterminate: 1,
        unavailable: 1,
      },
    });
  });

  it("does not resolve foreign member names or foreign/other-lead effect IDs", async () => {
    const own = await receipt("accepted");
    const foreign = await receipt("accepted", {
      organizationId: otherOrg,
      userId: otherOwner,
      sessionId: otherSid,
      leadId: foreignLead,
    });
    const [otherLead] = await db
      .insert(leadsTable)
      .values({ organizationId: org, contactId: contact })
      .returning();
    const other = await receipt("accepted", { leadId: otherLead.id });
    await snapshot([
      {
        userId: owner,
        outcome: "queued",
        deliveryIds: [own.id, foreign.id, other.id],
      },
      { userId: otherOwner, outcome: "recipient_unavailable", deliveryIds: [] },
    ]);
    const response = await request(),
      text = await response.text();
    expect(response.status).toBe(200);
    const body = dtoSchema.parse(JSON.parse(text));
    expect(body.recipients[0].deliveryStateCounts).toEqual({
      ...zeroCounts(),
      accepted: 1,
      unavailable: 2,
    });
    expect(body.recipients[1].displayName).toBeNull();
    expect(text).not.toContain("PRIVATE_");
  });

  it("reads the exact historical lead beyond the latest 100 device receipts", async () => {
    const original = await receipt("accepted");
    await snapshot([
      { userId: owner, outcome: "queued", deliveryIds: [original.id] },
    ]);
    const later = await db
      .insert(leadsTable)
      .values(
        Array.from({ length: 101 }, () => ({
          organizationId: org,
          contactId: contact,
        })),
      )
      .returning();
    await db.insert(deliveries).values(
      later.map((row) => ({
        organizationId: org,
        leadId: row.id,
        subscriptionId: original.subscriptionId,
        state: "pending" as const,
        createdAt: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 120_000),
      })),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(
      dtoSchema.parse(await response.json()).recipients[0].deliveryStateCounts,
    ).toEqual({ ...zeroCounts(), accepted: 1 });
  });

  it("returns identical no-store404 for missing and foreign leads and ignores tenant headers", async () => {
    const missing = await expectFailure(
      await request(endpoint(randomUUID())),
      404,
    );
    const foreign = await expectFailure(
      await request(endpoint(foreignLead)),
      404,
    );
    expect(foreign).toEqual(missing);
    expect(
      await expectFailure(await request(endpoint(), {}, otherSid), 404),
    ).toEqual(missing);
    const own = await request(endpoint(), {
      headers: { "x-organization-id": otherOrg },
    });
    expect(own.status).toBe(200);
    expect(dtoSchema.parse(await own.json()).organizationId).toBe(org);
  });

  it("rejects malformed IDs and all query selectors, including duplicate company keys", async () => {
    for (const path of [
      endpoint("not-a-uuid"),
      endpoint() + `?organizationId=${otherOrg}`,
      endpoint() + `?organizationId=${org}&organizationId=${otherOrg}`,
      endpoint() + "?leadId=anything",
      endpoint() + "?limit=100",
      endpoint() + "?unknown=",
    ])
      await expectFailure(await request(path), 400);
  });

  it("rejects anonymous, revoked and expired sessions", async () => {
    await expectFailure(await fetch(`${base}/api/v1${endpoint()}`), 401);
    await expectFailure(await request(endpoint(), {}, "invalid"), 401);
    await db
      .update(sessionsTable)
      .set({ expire: new Date(Date.now() - 1_000) })
      .where(eq(sessionsTable.sid, sid));
    await expectFailure(await request(), 401);
    const expiredToken = await sessionFor(owner, {
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
    await expectFailure(await request(endpoint(), {}, expiredToken), 401);
    await deleteSession(adminSid);
    await expectFailure(await request(endpoint(), {}, adminSid), 401);
  });

  it.each([
    "sales_manager",
    "sales_rep",
    "inspector",
    "production",
    "office",
    "viewer",
  ] as const)("denies ordinary %s company membership", async (role) => {
    await db.update(usersTable).set({ role }).where(eq(usersTable.id, owner));
    await expectFailure(await request(), 403);
  });

  it("denies unverified, inactive, pending-invitation and platform-only actors", async () => {
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: null })
      .where(eq(usersTable.id, owner));
    await expectFailure(await request(), 403);
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date(), isActive: false })
      .where(eq(usersTable.id, owner));
    await expectFailure(await request(), 403);
    const [pending, platform] = await db
      .insert(usersTable)
      .values([
        {
          id: `invite:${randomUUID()}`,
          organizationId: org,
          role: "owner" as const,
          emailVerifiedAt: new Date(),
        },
        {
          organizationId: null,
          isPlatformAdmin: true,
          role: "owner" as const,
          emailVerifiedAt: new Date(),
        },
      ])
      .returning();
    detachedUsers.push(platform.id);
    await expectFailure(
      await request(endpoint(), {}, await sessionFor(pending.id)),
      403,
    );
    await expectFailure(
      await request(endpoint(), {}, await sessionFor(platform.id)),
      403,
    );
  });

  it("rejects every API-key header presence even alongside a valid owner session", async () => {
    for (const key of ["", "PRIVATE_SYNTHETIC_API_KEY"])
      await expectFailure(
        await request(endpoint(), { headers: { "x-api-key": key } }),
        403,
      );
  });

  it("rejects foreign/empty origins and cross-site fetch metadata", async () => {
    for (const headers of [
      { origin: "https://attacker.invalid" },
      { origin: "" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: currentOrigin, "sec-fetch-site": "cross-site" },
    ])
      await expectFailure(await request(endpoint(), { headers }), 403);
    expect(
      (await request(endpoint(), { headers: { "sec-fetch-site": "none" } }))
        .status,
    ).toBe(200);
  });

  it("passes effective membership and rechecks a role revoked after the route guard", async () => {
    const read = staffPush.getStaffLeadAlertCoverage;
    const spy = vi
      .spyOn(staffPush, "getStaffLeadAlertCoverage")
      .mockImplementationOnce(
        async (organizationId, actorId, leadId, context) => {
          expect({ organizationId, actorId, leadId, context }).toEqual({
            organizationId: org,
            actorId: owner,
            leadId: lead,
            context: { sessionId: sid, effectiveRole: "owner" },
          });
          await db
            .update(usersTable)
            .set({ role: "viewer" })
            .where(eq(usersTable.id, owner));
          return read(organizationId, actorId, leadId, context);
        },
      );
    await expectFailure(await request(), 403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("redacts unexpected read errors instead of returning provider or database details", async () => {
    vi.spyOn(staffPush, "getStaffLeadAlertCoverage").mockRejectedValueOnce(
      new Error("PRIVATE_PROVIDER_AND_DATABASE_SECRET"),
    );
    expect(await expectFailure(await request(), 503)).toEqual({
      error: "staff_notifications_temporarily_unavailable",
    });
  });

  it("rejects a session identity changed after authentication", async () => {
    const read = staffPush.getStaffLeadAlertCoverage;
    vi.spyOn(staffPush, "getStaffLeadAlertCoverage").mockImplementationOnce(
      async (organizationId, actorId, leadId, context) => {
        await db
          .update(sessionsTable)
          .set({
            sess: {
              user: { id: otherOwner },
              access_token: "PRIVATE_REPLACEMENT_SESSION_TOKEN",
            },
          })
          .where(eq(sessionsTable.sid, sid));
        return read(organizationId, actorId, leadId, context);
      },
    );
    await expectFailure(await request(), 403);
  });

  it("fails closed on corrupt saved recipient evidence without returning its private fields", async () => {
    await snapshot([
      { userId: owner, outcome: "no_eligible_device", deliveryIds: [] },
    ]);
    await db
      .update(coverage)
      .set({
        recipients: [
          {
            userId: owner,
            outcome: "no_eligible_device",
            deliveryIds: [],
            endpoint: "PRIVATE_CORRUPT_ENDPOINT",
            keys: { auth: "PRIVATE_CORRUPT_AUTH_KEY" },
          },
        ] as unknown as StaffLeadAlertRecipient[],
      })
      .where(eq(coverage.organizationId, org));
    expect(await expectFailure(await request(), 503)).toEqual({
      error: "staff_notifications_temporarily_unavailable",
    });
  });

  it("redacts membership-store errors before the service handler", async () => {
    const select = db.select.bind(db);
    vi.spyOn(db, "select")
      .mockImplementationOnce(select)
      .mockImplementationOnce(() => {
        throw new Error("PRIVATE_MEMBERSHIP_DATABASE_SECRET");
      });
    expect(await expectFailure(await request(), 503)).toEqual({
      error: "staff_notifications_temporarily_unavailable",
    });
  });
});
