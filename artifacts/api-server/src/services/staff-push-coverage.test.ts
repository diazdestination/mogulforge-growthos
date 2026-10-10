import { createECDH, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  pool,
  sessionsTable,
  staffLeadAlertCoverageTable as coverage,
  staffPushDeliveriesTable as deliveries,
  staffPushPoliciesTable as policies,
  staffPushSubscriptionsTable as subscriptions,
  usersTable,
  type StaffPushDeliveryState,
} from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { enqueueStaffLeadPush, getStaffLeadAlertCoverage } from "./staff-push";

const key = createECDH("prime256v1");
key.generateKeys();
const organizations: string[] = [],
  sessionIds: string[] = [];
beforeEach(() => {
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await deleteTestOrgs(...organizations.splice(0));
  for (const sid of sessionIds.splice(0))
    await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
  vi.unstubAllEnvs();
});

async function session(userId: string) {
  const sid = randomUUID();
  sessionIds.push(sid);
  const [row] = await db
    .insert(sessionsTable)
    .values({
      sid,
      sess: {
        user: { id: userId },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      expire: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return row;
}
async function fixture() {
  const [org, other] = await db
    .insert(organizationsTable)
    .values(
      ["A", "B"].map((name) => ({
        name: `Synthetic coverage ${name}`,
        slug: `coverage-${randomUUID()}`,
      })),
    )
    .returning();
  organizations.push(org.id, other.id);
  const [owner, a, b, foreign] = await db
    .insert(usersTable)
    .values([
      {
        organizationId: org.id,
        role: "owner" as const,
        firstName: "Synthetic owner",
      },
      {
        organizationId: org.id,
        role: "office" as const,
        firstName: "Synthetic A",
      },
      {
        organizationId: org.id,
        role: "sales_rep" as const,
        firstName: "Synthetic B",
      },
      {
        organizationId: other.id,
        role: "owner" as const,
        firstName: "FOREIGN_PRIVATE_NAME",
      },
    ])
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "PRIVATE_CUSTOMER",
      email: "private@example.invalid",
    })
    .returning();
  const ownerSession = await session(owner.id),
    aSession = await session(a.id),
    bSession = await session(b.id),
    foreignSession = await session(foreign.id);
  return {
    org,
    other,
    owner,
    a,
    b,
    foreign,
    contact,
    ownerSession,
    aSession,
    bSession,
    foreignSession,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const policy = (f: Fixture, ids = [f.a.id, f.b.id]) => ({
  enabled: true,
  serviceAlertsEnabled: false,
  timezone: "UTC",
  days: [1, 2, 3, 4, 5, 6, 7],
  opensAt: "00:00",
  closesAt: "23:59",
  businessHoursUserIds: ids,
  afterHoursUserIds: ids,
});
async function setPolicy(f: Fixture, value = policy(f)) {
  await db
    .insert(policies)
    .values({ organizationId: f.org.id, policy: value })
    .onConflictDoUpdate({
      target: policies.organizationId,
      set: { policy: value },
    });
}
async function device(
  f: Fixture,
  userId = f.a.id,
  sid: string | null = f.aSession.sid,
  extra: Partial<typeof subscriptions.$inferInsert> = {},
) {
  const payload = {
    endpoint: `https://web.push.apple.com/${randomUUID().replaceAll("-", "")}`,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
  const [row] = await db
    .insert(subscriptions)
    .values({
      organizationId: f.org.id,
      userId,
      sessionId: sid,
      endpointHash: randomUUID(),
      encryptedSubscription: encryptSecret(
        JSON.stringify(payload),
        `staff-push:${f.org.id}:${userId}`,
      ),
      expiresAt: new Date(Date.now() + 3_600_000),
      ...extra,
    })
    .returning();
  return row;
}
async function lead(
  f: Fixture,
  options: { admit?: boolean; createdAt?: Date } = {},
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(leadsTable)
      .values({
        organizationId: f.org.id,
        contactId: f.contact.id,
        createdAt: options.createdAt,
      })
      .returning();
    if (options.admit !== false) await enqueueStaffLeadPush(tx, f.org.id, row);
    return row;
  });
}
const read = (f: Fixture, id: string) =>
  getStaffLeadAlertCoverage(f.org.id, f.owner.id, id, {
    sessionId: f.ownerSession.sid,
    effectiveRole: "owner",
  });
const snapshot = async (f: Fixture, id: string) =>
  (
    await db
      .select()
      .from(coverage)
      .where(
        and(eq(coverage.organizationId, f.org.id), eq(coverage.leadId, id)),
      )
  )[0];
const effects = (f: Fixture, id: string) =>
  db
    .select()
    .from(deliveries)
    .where(
      and(eq(deliveries.organizationId, f.org.id), eq(deliveries.leadId, id)),
    );
const repeat = (f: Fixture, row: { id: string; createdAt: Date }) =>
  db.transaction((tx) => enqueueStaffLeadPush(tx, f.org.id, row));

describe("immutable lead alert admission", () => {
  it("retains both selected recipients when only one has a device, with a closed safe projection", async () => {
    const f = await fixture();
    await setPolicy(f);
    const d = await device(f);
    const row = await lead(f);
    const saved = await snapshot(f, row.id),
      receipts = await effects(f, row.id),
      result = await read(f, row.id);
    expect(saved).toMatchObject({
      version: 1,
      status: "evaluated",
      occurredAt: row.createdAt,
      recipients: [
        { userId: f.a.id, outcome: "queued", deliveryIds: [receipts[0].id] },
        { userId: f.b.id, outcome: "no_eligible_device", deliveryIds: [] },
      ],
    });
    expect(saved.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts).toHaveLength(1);
    expect(result.recipients).toMatchObject([
      {
        userId: f.a.id,
        displayName: "Synthetic A",
        outcome: "queued",
        queuedDeviceCount: 1,
        deliveryStateCounts: { pending: 1, unavailable: 0 },
      },
      {
        userId: f.b.id,
        displayName: "Synthetic B",
        outcome: "no_eligible_device",
        queuedDeviceCount: 0,
      },
    ]);
    expect(Object.keys(result).sort()).toEqual(
      [
        "organizationId",
        "leadId",
        "status",
        "version",
        "occurredAt",
        "recordedAt",
        "serverNow",
        "receiptMeaning",
        "recipients",
      ].sort(),
    );
    expect(Object.keys(result.recipients[0]).sort()).toEqual(
      [
        "userId",
        "displayName",
        "outcome",
        "queuedDeviceCount",
        "deliveryStateCounts",
      ].sort(),
    );
    for (const privateValue of [
      d.encryptedSubscription!,
      d.endpointHash,
      d.sessionId!,
      d.id,
      receipts[0].id,
      saved.policyFingerprint!,
      "PRIVATE_CUSTOMER",
      "private@example.invalid",
    ])
      expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it.each(["missing", "invalid", "disabled"] as const)(
    "seals %s policy admission before later enablement or registration",
    async (kind) => {
      const f = await fixture();
      if (kind === "disabled")
        await setPolicy(f, { ...policy(f), enabled: false });
      if (kind === "invalid")
        await db
          .insert(policies)
          .values({
            organizationId: f.org.id,
            policy: sql`'{"enabled":true}'::jsonb`,
          });
      const row = await lead(f),
        saved = await snapshot(f, row.id);
      expect(saved).toMatchObject({
        status: kind === "disabled" ? "policy_disabled" : "policy_unavailable",
        recipients: [],
      });
      await setPolicy(f);
      await device(f);
      await repeat(f, row);
      expect(await snapshot(f, row.id)).toEqual(saved);
      expect(await effects(f, row.id)).toHaveLength(0);
    },
  );

  it.each([
    "absent",
    "revoked",
    "expired_device",
    "missing_cipher",
    "missing_session",
    "expired_session",
    "expired_identity",
    "wrong_identity",
    "inactive",
    "unverified",
    "read_only",
    "foreign_member",
  ] as const)(
    "records %s recipient eligibility without a hidden omission",
    async (kind) => {
      const f = await fixture();
      await setPolicy(f);
      if (kind !== "absent") {
        await device(
          f,
          f.a.id,
          kind === "missing_session" ? null : f.aSession.sid,
          {
            ...(kind === "revoked" ? { revokedAt: new Date() } : {}),
            ...(kind === "expired_device" ? { expiresAt: new Date(1) } : {}),
            ...(kind === "missing_cipher"
              ? { encryptedSubscription: null }
              : {}),
          },
        );
      }
      if (kind === "expired_session")
        await db
          .update(sessionsTable)
          .set({ expire: new Date(1) })
          .where(eq(sessionsTable.sid, f.aSession.sid));
      if (kind === "expired_identity")
        await db
          .update(sessionsTable)
          .set({ sess: { user: { id: f.a.id }, expires_at: 1 } })
          .where(eq(sessionsTable.sid, f.aSession.sid));
      if (kind === "wrong_identity")
        await db
          .update(sessionsTable)
          .set({ sess: { user: { id: f.b.id } } })
          .where(eq(sessionsTable.sid, f.aSession.sid));
      if (kind === "inactive")
        await db
          .update(usersTable)
          .set({ isActive: false })
          .where(eq(usersTable.id, f.a.id));
      if (kind === "unverified")
        await db
          .update(usersTable)
          .set({ emailVerifiedAt: null })
          .where(eq(usersTable.id, f.a.id));
      if (kind === "read_only")
        await db
          .update(usersTable)
          .set({ role: "viewer" })
          .where(eq(usersTable.id, f.a.id));
      if (kind === "foreign_member")
        await db
          .update(usersTable)
          .set({ organizationId: f.other.id })
          .where(eq(usersTable.id, f.a.id));
      const row = await lead(f),
        saved = await snapshot(f, row.id);
      expect(saved.recipients).toHaveLength(2);
      expect(saved.recipients[0]).toEqual({
        userId: f.a.id,
        outcome: [
          "inactive",
          "unverified",
          "read_only",
          "foreign_member",
        ].includes(kind)
          ? "recipient_unavailable"
          : "no_eligible_device",
        deliveryIds: [],
      });
      expect(await effects(f, row.id)).toHaveLength(0);
    },
  );

  it("uses the canonical instant and records elapsed windows without inserting expired effects", async () => {
    const f = await fixture();
    await setPolicy(f);
    await device(f);
    const row = await lead(f, {
      admit: false,
      createdAt: new Date(Date.now() - 16 * 60_000),
    });
    await repeat(f, { id: row.id, createdAt: new Date() });
    expect(await snapshot(f, row.id)).toMatchObject({
      occurredAt: row.createdAt,
      recipients: [
        { userId: f.a.id, outcome: "notification_expired", deliveryIds: [] },
        { userId: f.b.id, outcome: "notification_expired", deliveryIds: [] },
      ],
    });
    expect(await effects(f, row.id)).toHaveLength(0);
  });

  it("cannot add recipients or devices after policy edits, registration or deleted effect evidence", async () => {
    const f = await fixture();
    await setPolicy(f);
    const d = await device(f);
    const row = await lead(f),
      saved = await snapshot(f, row.id);
    await db.delete(subscriptions).where(eq(subscriptions.id, d.id));
    await device(f);
    await device(f, f.b.id, f.bSession.sid);
    await setPolicy(f, policy(f, [f.b.id]));
    await repeat(f, row);
    await repeat(f, row);
    expect(await snapshot(f, row.id)).toEqual(saved);
    expect(await effects(f, row.id)).toHaveLength(0);
    expect(
      (await read(f, row.id)).recipients[0].deliveryStateCounts,
    ).toMatchObject({ unavailable: 1, accepted: 0 });
  });

  it("evaluates all twenty recipients with deterministic five-device caps and no global starvation", async () => {
    const f = await fixture();
    const people = await db
      .insert(usersTable)
      .values(
        Array.from({ length: 20 }, () => ({
          organizationId: f.org.id,
          role: "office" as const,
        })),
      )
      .returning();
    await setPolicy(
      f,
      policy(
        f,
        people.map((p) => p.id),
      ),
    );
    const allDevices: Array<typeof subscriptions.$inferSelect> = [];
    for (const person of people) {
      const s = await session(person.id);
      for (let i = 0; i < 6; i++)
        allDevices.push(
          await device(f, person.id, s.sid, { createdAt: new Date(1000 + i) }),
        );
    }
    const row = await lead(f),
      saved = await snapshot(f, row.id),
      receipts = await effects(f, row.id);
    expect(saved.recipients).toHaveLength(20);
    expect(receipts).toHaveLength(100);
    for (const recipient of saved.recipients) {
      expect(recipient.outcome).toBe("queued");
      expect(recipient.deliveryIds).toHaveLength(5);
      expect(
        recipient.deliveryIds.map(
          (id) => receipts.find((r) => r.id === id)!.subscriptionId,
        ),
      ).toEqual(
        allDevices
          .filter((d) => d.userId === recipient.userId)
          .slice(0, 5)
          .map((d) => d.id),
      );
    }
  });

  it("fences legacy device receipts without inventing their selected cohort", async () => {
    const f = await fixture();
    await setPolicy(f);
    const d = await device(f);
    const row = await lead(f, { admit: false });
    const [legacy] = await db
      .insert(deliveries)
      .values({
        organizationId: f.org.id,
        leadId: row.id,
        subscriptionId: d.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    await device(f, f.b.id, f.bSession.sid);
    await repeat(f, row);
    expect(await snapshot(f, row.id)).toMatchObject({
      status: "historical_unknown",
      policyFingerprint: null,
      recipients: [],
    });
    expect((await effects(f, row.id)).map((r) => r.id)).toEqual([legacy.id]);
  });

  it("rolls back lead, effects and snapshot together on a later transaction failure", async () => {
    const f = await fixture();
    await setPolicy(f);
    await device(f);
    const id = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(leadsTable)
          .values({ id, organizationId: f.org.id, contactId: f.contact.id })
          .returning();
        await enqueueStaffLeadPush(tx, f.org.id, row);
        throw new Error("Synthetic final transaction failure");
      }),
    ).rejects.toThrow("Synthetic final transaction failure");
    expect(await snapshot(f, id)).toBeUndefined();
    expect(await effects(f, id)).toHaveLength(0);
    expect(
      await db.select().from(leadsTable).where(eq(leadsTable.id, id)),
    ).toHaveLength(0);
  });
});

describe("exact lead coverage evidence", () => {
  it("leaves historical missing coverage unknown and does not evaluate current routing", async () => {
    const f = await fixture(),
      row = await lead(f, { admit: false });
    await setPolicy(f);
    await device(f);
    expect(await read(f, row.id)).toMatchObject({
      status: "coverage_not_recorded",
      version: null,
      occurredAt: row.createdAt,
      recordedAt: null,
      recipients: [],
    });
    expect(await snapshot(f, row.id)).toBeUndefined();
    expect(await effects(f, row.id)).toHaveLength(0);
  });

  it("projects all exact original effect states and unavailable IDs independently of the last 100 list", async () => {
    const f = await fixture();
    await setPolicy(f);
    for (let i = 0; i < 5; i++) {
      await device(f);
      await device(f, f.b.id, f.bSession.sid);
    }
    const row = await lead(f),
      saved = await snapshot(f, row.id);
    const states: StaffPushDeliveryState[] = [
      "pending",
      "dispatching",
      "accepted",
      "rejected",
      "expired",
      "cancelled",
      "indeterminate",
    ];
    const ids = saved.recipients.flatMap((r) => r.deliveryIds);
    for (let i = 0; i < ids.length; i++)
      await db
        .update(deliveries)
        .set({ state: states[i % states.length] })
        .where(eq(deliveries.id, ids[i]));
    await db.delete(deliveries).where(eq(deliveries.id, ids[0]));
    const d = (
      await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, f.org.id))
    )[0];
    const noise = await db
      .insert(leadsTable)
      .values(
        Array.from({ length: 101 }, () => ({
          organizationId: f.org.id,
          contactId: f.contact.id,
        })),
      )
      .returning();
    await db
      .insert(deliveries)
      .values(
        noise.map((n) => ({
          organizationId: f.org.id,
          leadId: n.id,
          subscriptionId: d.id,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );
    const result = await read(f, row.id);
    expect(result.recipients[0].deliveryStateCounts).toEqual({
      pending: 0,
      dispatching: 1,
      accepted: 1,
      rejected: 1,
      expired: 1,
      cancelled: 0,
      indeterminate: 0,
      unavailable: 1,
    });
    expect(result.recipients[1].deliveryStateCounts).toEqual({
      pending: 1,
      dispatching: 1,
      accepted: 1,
      rejected: 0,
      expired: 0,
      cancelled: 1,
      indeterminate: 1,
      unavailable: 0,
    });
    expect(await snapshot(f, row.id)).toEqual(saved);
  });

  it("never projects foreign receipt state or staff names", async () => {
    const f = await fixture();
    await setPolicy(f);
    await device(f);
    const row = await lead(f),
      otherLead = await lead(f, { admit: false });
    const saved = await snapshot(f, row.id),
      id = saved.recipients[0].deliveryIds[0];
    await db
      .update(deliveries)
      .set({ leadId: otherLead.id, state: "accepted" })
      .where(eq(deliveries.id, id));
    await db
      .update(usersTable)
      .set({ organizationId: f.other.id, firstName: "FOREIGN_PRIVATE_NAME" })
      .where(eq(usersTable.id, f.a.id));
    const result = await read(f, row.id);
    expect(result.recipients[0]).toMatchObject({
      displayName: null,
      deliveryStateCounts: { accepted: 0, unavailable: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("FOREIGN_PRIVATE_NAME");
    await expect(
      getStaffLeadAlertCoverage(f.other.id, f.foreign.id, row.id, {
        sessionId: f.foreignSession.sid,
        effectiveRole: "owner",
      }),
    ).rejects.toMatchObject({ code: "lead_not_found", status: 404 });
  });

  it.each([
    "inactive",
    "unverified",
    "role",
    "effective_role",
    "foreign",
    "missing_session",
    "wrong_session",
    "expired_session",
    "expired_identity",
  ] as const)("refuses %s exact-read authority", async (kind) => {
    const f = await fixture(),
      row = await lead(f);
    if (kind === "inactive")
      await db
        .update(usersTable)
        .set({ isActive: false })
        .where(eq(usersTable.id, f.owner.id));
    if (kind === "unverified")
      await db
        .update(usersTable)
        .set({ emailVerifiedAt: null })
        .where(eq(usersTable.id, f.owner.id));
    if (kind === "role")
      await db
        .update(usersTable)
        .set({ role: "office" })
        .where(eq(usersTable.id, f.owner.id));
    if (kind === "foreign")
      await db
        .update(usersTable)
        .set({ organizationId: f.other.id })
        .where(eq(usersTable.id, f.owner.id));
    if (kind === "expired_session")
      await db
        .update(sessionsTable)
        .set({ expire: new Date(1) })
        .where(eq(sessionsTable.sid, f.ownerSession.sid));
    if (kind === "expired_identity")
      await db
        .update(sessionsTable)
        .set({ sess: { user: { id: f.owner.id }, expires_at: 1 } })
        .where(eq(sessionsTable.sid, f.ownerSession.sid));
    await expect(
      getStaffLeadAlertCoverage(f.org.id, f.owner.id, row.id, {
        sessionId:
          kind === "missing_session"
            ? randomUUID()
            : kind === "wrong_session"
              ? f.aSession.sid
              : f.ownerSession.sid,
        effectiveRole: kind === "effective_role" ? "viewer" : "owner",
      }),
    ).rejects.toMatchObject({
      code: "active_member_session_required",
      status: 403,
    });
  });

  it("rejects malformed inner evidence and unknown states with a fixed unavailable error", async () => {
    const f = await fixture();
    await setPolicy(f);
    await device(f);
    const row = await lead(f),
      saved = await snapshot(f, row.id),
      first = saved.recipients[0];
    const corrupt = [
      [{ ...first, secret: "DO_NOT_RETURN" }],
      [first, first],
      [{ ...first, deliveryIds: [] }],
      [{ ...first, outcome: "made_up" }],
      [{ ...first, deliveryIds: [first.deliveryIds[0], first.deliveryIds[0]] }],
      [{ ...first, outcome: "no_eligible_device" }],
      [
        {
          ...first,
          deliveryIds: Array.from({ length: 6 }, () => randomUUID()),
        },
      ],
    ];
    for (const recipients of corrupt) {
      await db
        .update(coverage)
        .set({ recipients: sql`${JSON.stringify(recipients)}::jsonb` })
        .where(eq(coverage.leadId, row.id));
      await expect(read(f, row.id)).rejects.toMatchObject({
        code: "staff_notifications_temporarily_unavailable",
        status: 503,
      });
    }
    await db
      .update(coverage)
      .set({
        recipients: saved.recipients,
        recordedAt: sql`'infinity'::timestamptz`,
      })
      .where(eq(coverage.leadId, row.id));
    await expect(read(f, row.id)).rejects.toMatchObject({
      code: "staff_notifications_temporarily_unavailable",
      status: 503,
    });
    await db
      .update(coverage)
      .set({ recordedAt: saved.recordedAt })
      .where(eq(coverage.leadId, row.id));
    await db
      .update(deliveries)
      .set({ state: sql`'invalid_state'` })
      .where(eq(deliveries.id, first.deliveryIds[0]));
    await expect(read(f, row.id)).rejects.toMatchObject({
      code: "staff_notifications_temporarily_unavailable",
      status: 503,
    });
  });
});

async function blockedBy(pid: number, pattern: string) {
  let blocked: number | undefined;
  await vi.waitFor(
    async () => {
      blocked = (
        await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",
          [pid, pattern],
        )
      ).rows[0]?.pid;
      expect(blocked).toBeDefined();
    },
    { timeout: 3000, interval: 20 },
  );
  return blocked!;
}
// PGlite's single backend cannot attest multi-session waits or recovery after a trigger abort.
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "PostgreSQL coverage transaction barriers",
  () => {
    it("serializes concurrent admission before either can create an extra cohort", async () => {
      const f = await fixture();
      await setPolicy(f);
      await device(f);
      const row = await lead(f, { admit: false });
      const blocker = await pool.connect();
      let one: Promise<unknown> | undefined, two: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [
          row.id,
        ]);
        const pid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid;
        one = repeat(f, row);
        const firstWaiter = await blockedBy(pid, '%from "leads"%for update%');
        two = repeat(f, row);
        await vi.waitFor(
          async () => {
            const waiting = await pool.query<{ total: number }>(
              "SELECT count(*)::int AS total FROM pg_stat_activity WHERE ($1::int=ANY(pg_blocking_pids(pid)) OR $2::int=ANY(pg_blocking_pids(pid))) AND query ILIKE $3",
              [pid, firstWaiter, '%from "leads"%for update%'],
            );
            expect(waiting.rows[0].total).toBe(2);
          },
          { timeout: 3000, interval: 20 },
        );
        await blocker.query("COMMIT");
        await Promise.all([one, two]);
        expect(await effects(f, row.id)).toHaveLength(1);
        expect((await snapshot(f, row.id)).recipients).toHaveLength(2);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled([one, two]);
      }
    });

    it.each(["member", "session"] as const)(
      "rechecks changed %s after a lead lock wait",
      async (change) => {
        const f = await fixture(),
          row = await lead(f),
          blocker = await pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [
            row.id,
          ]);
          const pid = (
            await blocker.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0].pid;
          pending = read(f, row.id).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await blockedBy(pid, '%from "leads"%for share%');
          if (change === "member")
            await blocker.query("UPDATE users SET role='viewer' WHERE id=$1", [
              f.owner.id,
            ]);
          else
            await blocker.query("DELETE FROM sessions WHERE sid=$1", [
              f.ownerSession.sid,
            ]);
          await blocker.query("COMMIT");
          expect(await pending).toMatchObject({
            error: { code: "active_member_session_required", status: 403 },
          });
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await pending;
        }
      },
    );

    it.each(["member", "session"] as const)(
      "records missing %s coverage after an admission lock wait",
      async (change) => {
        const f = await fixture();
        await setPolicy(f);
        await device(f);
        const row = await lead(f, { admit: false }),
          blocker = await pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [
            row.id,
          ]);
          const pid = (
            await blocker.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0].pid;
          pending = repeat(f, row);
          await blockedBy(pid, '%from "leads"%for update%');
          if (change === "member")
            await blocker.query(
              "UPDATE users SET email_verified_at=NULL WHERE id=$1",
              [f.a.id],
            );
          else
            await blocker.query("DELETE FROM sessions WHERE sid=$1", [
              f.aSession.sid,
            ]);
          await blocker.query("COMMIT");
          await pending;
          expect((await snapshot(f, row.id)).recipients[0]).toMatchObject({
            userId: f.a.id,
            outcome:
              change === "member"
                ? "recipient_unavailable"
                : "no_eligible_device",
            deliveryIds: [],
          });
          expect(await effects(f, row.id)).toHaveLength(0);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await Promise.allSettled([pending]);
        }
      },
    );

    it.each([false, true])(
      "rechecks session expiry after a blocked evidence read (snapshot=%s)",
      async (admit) => {
        const f = await fixture(),
          row = await lead(f, { admit }),
          blocker = await pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "LOCK TABLE staff_lead_alert_coverage IN ACCESS EXCLUSIVE MODE",
          );
          const pid = (
            await blocker.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0].pid;
          pending = read(f, row.id).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await blockedBy(pid, '%from "staff_lead_alert_coverage"%');
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date(Date.now() + 7_200_000));
          await blocker.query("COMMIT");
          expect(await pending).toMatchObject({
            error: { code: "active_member_session_required", status: 403 },
          });
        } finally {
          vi.useRealTimers();
          await blocker.query("ROLLBACK");
          blocker.release();
          await pending;
        }
      },
    );

    it("bounds an authority lock wait and releases its earlier lead lock after timeout", async () => {
      const f = await fixture(),
        row = await lead(f),
        blocker = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          f.owner.id,
        ]);
        const pid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid;
        const startedAt = Date.now();
        pending = read(f, row.id).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await blockedBy(pid, '%from "users"%for share%');
        expect(await pending).toMatchObject({
          error: {
            code: "staff_notifications_temporarily_unavailable",
            status: 503,
          },
        });
        expect(Date.now() - startedAt).toBeLessThan(6000);
        // The failed getter had already locked this lead; rollback must release it.
        await blocker.query(
          "SELECT id FROM leads WHERE id=$1 FOR UPDATE NOWAIT",
          [row.id],
        );
        await blocker.query("COMMIT");
        expect(await read(f, row.id)).toMatchObject({
          status: "policy_unavailable",
        });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
    }, 10000);

    it("rolls original effects and lead back if the coverage insert fails", async () => {
      const f = await fixture();
      await setPolicy(f);
      await device(f);
      const id = randomUUID(),
        hook = `coverage_fail_${randomUUID().replaceAll("-", "")}`;
      await pool.query(
        `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic coverage failure'; END $$`,
      );
      try {
        await pool.query(
          `CREATE TRIGGER ${hook} BEFORE INSERT ON staff_lead_alert_coverage FOR EACH ROW WHEN (NEW.organization_id='${f.org.id}'::uuid) EXECUTE FUNCTION ${hook}()`,
        );
        await expect(
          db.transaction(async (tx) => {
            const [row] = await tx
              .insert(leadsTable)
              .values({ id, organizationId: f.org.id, contactId: f.contact.id })
              .returning();
            await enqueueStaffLeadPush(tx, f.org.id, row);
          }),
        ).rejects.toThrow();
        expect(await snapshot(f, id)).toBeUndefined();
        expect(await effects(f, id)).toHaveLength(0);
        expect(
          await db.select().from(leadsTable).where(eq(leadsTable.id, id)),
        ).toHaveLength(0);
      } finally {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${hook} ON staff_lead_alert_coverage`,
        );
        await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
      }
    });
  },
);
