import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  customerLifecycleTable,
  db,
  DEFAULT_INSPECTION_AVAILABILITY,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  propertiesTable,
  projectsTable,
  usersTable,
} from "@workspace/db";
import {
  effectiveReservation,
  schedulingReviewContextSchema,
  type ReservationSnapshot,
} from "@workspace/scheduling-core";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getOrgSettings, updateOrgSettings } from "./settings";
import { getContractorToday } from "./contractor-today";
import * as policy from "./scheduling-policy";

const orgs: string[] = [],
  sessions: string[] = [];
let server: Server, base: string;
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
});
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic scheduling",
      slug: `sched-${randomUUID()}`,
      timezone: "America/Los_Angeles",
    })
    .returning();
  orgs.push(org.id);
  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      role: "owner",
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning();
  return {
    org: org.id,
    user: user.id,
    actor: { organizationId: org.id, userId: user.id },
  };
}
const input = (expectedRevision = 0) => ({
  expectedRevision,
  expectedCompanyTimeZone: "America/Los_Angeles",
  enabled: true,
  minimumTravelGapMinutes: 60,
  maxConcurrentReservations: 3,
  durationPresets: [{ id: null, label: "Visit", elapsedMinutes: 90 }],
});
async function cookie(user: string) {
  const sid = await createSession({
    user: {
      id: user,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-scheduling",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  sessions.push(sid);
  return `sid=${sid}`;
}

function reservationSnapshot(
  kind: "appointment" | "project",
  id: string,
  resources: string[],
): ReservationSnapshot {
  return {
    formatVersion: 1,
    reservationRevision: 1,
    sourcePolicyRevision: 1,
    sourcePolicyDigest: "a".repeat(64),
    approvedTimeZone: "UTC",
    inspection: null,
    startAt: "2035-01-01T12:00:00.000Z",
    endAt: "2035-01-01T14:00:00.000Z",
    resourceUserIds: resources,
    minimumTravelGapMinutes: 60,
    duration: { kind: "explicit", preset: null },
    admittedAt: "2035-01-01T00:00:00.000Z",
    admittedByUserId: null,
    target: { kind, id },
    lastTransition: {
      kind: "admission",
      actorUserId: null,
      at: "2035-01-01T00:00:00.000Z",
    },
  };
}
async function protectedFixture(kind: "appointment" | "project") {
  const f = await fixture();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: f.org, firstName: "Synthetic" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: f.org, contactId: contact.id })
    .returning();
  const common = {
    organizationId: f.org,
    leadId: lead.id,
    scheduledStart: new Date("2035-01-01T12:00:00Z"),
    scheduledEnd: new Date("2035-01-01T14:00:00Z"),
  };
  const row =
    kind === "appointment"
      ? (
          await db
            .insert(appointmentsTable)
            .values({
              ...common,
              contactId: contact.id,
              assignedUserId: f.user,
            })
            .returning()
        )[0]
      : (
          await db
            .insert(projectsTable)
            .values({
              ...common,
              name: "Synthetic",
              status: "scheduled",
              crewUserIds: [f.user, "synthetic-second-resource"],
            })
            .returning()
        )[0];
  const resources =
    kind === "appointment" ? [f.user] : [f.user, "synthetic-second-resource"];
  const snapshot = reservationSnapshot(kind, row.id, resources);
  const query = `/scheduling/review-context?sourceKind=lead&sourceId=${lead.id}&reservationKind=${kind}&targetKind=${kind}&targetId=${row.id}`;
  return {
    ...f,
    row: { ...row, schedulingReservation: snapshot },
    snapshot,
    query,
  };
}

describe("active reservation projection agreement", () => {
  it.each(["appointment", "project"] as const)(
    "rejects changed active %s interval/resources and absent actual end",
    async (kind) => {
      const f = await protectedFixture(kind);
      expect(
        policy.projectSchedulingEvidence(kind, f.row).schedulingEvidence,
      ).toBe("versioned");
      const changes = [
        { scheduledStart: new Date("2035-01-01T12:30:00Z") },
        { scheduledEnd: new Date("2035-01-01T15:00:00Z") },
        { scheduledEnd: null },
        kind === "appointment"
          ? { assignedUserId: "changed-resource" }
          : { crewUserIds: [f.user] },
      ];
      for (const change of changes)
        expect(
          policy.projectSchedulingEvidence(kind, { ...f.row, ...change }),
        ).toMatchObject({
          schedulingEvidence: "invalid",
          schedulingReservation: null,
        });
      const normalized = {
        ...f.snapshot,
        startAt: "2035-01-01T07:00:00-05:00",
        endAt: "2035-01-01T09:00:00-05:00",
        resourceUserIds: [...f.snapshot.resourceUserIds]
          .reverse()
          .concat(f.user),
      };
      expect(
        policy.projectSchedulingEvidence(kind, {
          ...f.row,
          schedulingReservation: normalized,
        }),
      ).toMatchObject({
        schedulingEvidence: "versioned",
        schedulingReservation: normalized,
      });
    },
  );
  it.each(["appointment", "project"] as const)(
    "holds GET review for mismatched protected active %s",
    async (kind) => {
      const f = await protectedFixture(kind);
      const values = {
        schedulingReservation: f.snapshot,
        scheduledEnd: new Date("2035-01-01T15:00:00Z"),
      };
      if (kind === "appointment")
        await db
          .update(appointmentsTable)
          .set(values)
          .where(eq(appointmentsTable.id, f.row.id));
      else
        await db
          .update(projectsTable)
          .set(values)
          .where(eq(projectsTable.id, f.row.id));
      const response = await fetch(base + f.query, {
        headers: { Cookie: await cookie(f.user) },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "invalid_reservation_snapshot",
      });
    },
  );
  it.each(["appointment", "project"] as const)(
    "retains %s terminal history and legacy null-snapshot fixed-end compatibility",
    async (kind) => {
      const f = await protectedFixture(kind);
      expect(
        policy.projectSchedulingEvidence(kind, {
          ...f.row,
          status: "completed",
          scheduledEnd: null,
        }),
      ).toMatchObject({
        schedulingEvidence: "versioned",
        schedulingReservation: f.snapshot,
      });
      if (kind === "project")
        expect(
          policy.projectSchedulingEvidence(kind, {
            ...(f.row as typeof projectsTable.$inferSelect),
            scheduledStart: null,
            scheduledEnd: null,
            schedulingReservation: {
              ...f.snapshot,
              lastTransition: { ...f.snapshot.lastTransition, kind: "release" },
            },
          }),
        ).toMatchObject({ schedulingEvidence: "versioned" });
      expect(
        policy.projectSchedulingEvidence(kind, {
          ...f.row,
          scheduledEnd: null,
          schedulingReservation: null,
        }),
      ).toMatchObject({
        schedulingEvidence: "legacy",
        schedulingReservation: null,
      });
      const legacy = effectiveReservation({
        kind,
        id: f.row.id,
        startAt: f.row.scheduledStart!.toISOString(),
        endAt: null,
        type: kind === "appointment" ? "inspection" : "project",
        status: "scheduled",
        resourceUserIds: f.snapshot.resourceUserIds,
        reservation: null,
        source: {
          sourceKind: "lead",
          leadId: f.row.leadId!,
          contactId: null,
          propertyId: null,
          estimateId: null,
        },
      });
      expect(legacy?.endAt).toBe(
        kind === "appointment"
          ? "2035-01-01T14:00:00.000Z"
          : "2035-01-02T12:00:00.000Z",
      );
      expect(legacy?.savedGapMinutes).toBe(0);
    },
  );
});

describe("serialized scheduling configuration", () => {
  it("labels normalized legacy inspection evidence without rewriting the stored rules", async () => {
    const f = await fixture();
    const raw = {
      timezone: "Invalid/Legacy",
      days: [],
      windows: [],
      maxBookingsPerWindow: 2.9,
      blackoutDates: ["bad"],
    };
    await db.execute(
      sql`INSERT INTO org_settings (organization_id,inspection_availability) VALUES (${f.org},${JSON.stringify(raw)}::jsonb)`,
    );
    const read = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org, undefined, {
        reservationKind: "appointment",
      }),
    );
    expect(read.context.inspection).toMatchObject({
      sourceState: "legacy_normalized",
      ruleTimeZone: DEFAULT_INSPECTION_AVAILABILITY.timezone,
    });
    expect(read.context.applicableRules.inspectionCeiling).toBe(2);
    const [stored] = await db
      .select()
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.organizationId, f.org));
    expect(stored.inspectionAvailability).toEqual(raw);
    expect(stored.schedulingPolicy).toBeNull();
  });
  it("reads unconfigured policy without creating settings and exposes legacy inspection provenance only when applicable", async () => {
    const f = await fixture();
    const before = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org));
    const result = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org),
    );
    expect(result.policy).toBeNull();
    expect(result.context).toMatchObject({
      policyRevision: 0,
      policyDigest: null,
      companyTimeZone: "America/Los_Angeles",
      inspection: null,
      applicableRules: {
        newTravelGapMinutes: 0,
        companyCeiling: null,
        inspectionCeiling: null,
      },
    });
    const inspection = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org, undefined, {
        reservationKind: "appointment",
      }),
    );
    expect(inspection.context.inspection).toMatchObject({
      ruleTimeZone: "America/New_York",
      sourceState: "legacy_default",
    });
    expect(inspection.context.applicableRules.inspectionCeiling).toBe(1);
    expect(
      await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, f.org)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.organizationId, f.org)),
    ).toEqual(before);
  });
  it("first save assigns IDs and revision1; disabling and re-enabling retain IDs and advance revision", async () => {
    const f = await fixture(),
      first = await policy.saveSchedulingPolicy(f.actor, input());
    expect(first.policy).toMatchObject({
      revision: 1,
      enabled: true,
      timeZone: "America/Los_Angeles",
      updatedByUserId: f.user,
    });
    expect(first.policy!.durationPresets[0].id).toMatch(/^[a-f0-9-]{36}$/);
    const disabled = await policy.saveSchedulingPolicy(f.actor, {
      ...input(1),
      enabled: false,
      durationPresets: first.policy!.durationPresets,
    });
    expect(disabled.policy).toMatchObject({
      revision: 2,
      enabled: false,
      durationPresets: first.policy!.durationPresets,
    });
    expect(disabled.context.applicableRules).toEqual({
      newTravelGapMinutes: 0,
      companyCeiling: null,
      inspectionCeiling: null,
    });
    const again = await policy.saveSchedulingPolicy(f.actor, {
      ...input(2),
      durationPresets: disabled.policy!.durationPresets,
    });
    expect(again.policy!.revision).toBe(3);
    expect(again.policy!.digest).not.toBe(first.policy!.digest);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, f.org),
            eq(auditEventsTable.action, "scheduling.policy_saved"),
          ),
        ),
    ).toHaveLength(3);
  });
  it("rejects stale revision/zone, fabricated preset IDs and server-owned save metadata", async () => {
    const f = await fixture();
    await policy.saveSchedulingPolicy(f.actor, input());
    await expect(
      policy.saveSchedulingPolicy(f.actor, input()),
    ).rejects.toMatchObject({ code: "stale_scheduling_review" });
    await expect(
      policy.saveSchedulingPolicy(f.actor, {
        ...input(1),
        expectedCompanyTimeZone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "stale_scheduling_review" });
    await expect(
      policy.saveSchedulingPolicy(f.actor, {
        ...input(1),
        durationPresets: [
          { id: randomUUID(), label: "Forged", elapsedMinutes: 30 },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_scheduling_policy" });
    for (const extra of [
      { revision: 10 },
      { timeZone: "UTC" },
      { digest: "a".repeat(64) },
      { updatedByUserId: f.user },
    ]) {
      await expect(
        policy.saveSchedulingPolicy(f.actor, { ...input(1), ...extra }),
      ).rejects.toMatchObject({ code: "invalid_scheduling_policy" });
    }
  });
  it.each([
    { role: "office" as const },
    { isActive: false },
    { emailVerifiedAt: null },
    { id: "invite:pending" },
  ])("requires accepted active settings authority: %j", async (patch) => {
    const f = await fixture();
    const [user] = await db
      .insert(usersTable)
      .values({
        organizationId: f.org,
        role: "owner",
        isActive: true,
        emailVerifiedAt: new Date(),
        ...patch,
      })
      .returning();
    await expect(
      policy.saveSchedulingPolicy(
        { organizationId: f.org, userId: user.id },
        input(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, f.org)),
    ).toHaveLength(0);
  });
  it("refuses corrupt digest and mismatched company zone without overwriting evidence", async () => {
    const f = await fixture(),
      saved = await policy.saveSchedulingPolicy(f.actor, input());
    await db
      .update(orgSettingsTable)
      .set({ schedulingPolicy: { ...saved.policy!, digest: "0".repeat(64) } })
      .where(eq(orgSettingsTable.organizationId, f.org));
    await expect(
      db.transaction((tx) => policy.readSchedulingContext(tx, f.org)),
    ).rejects.toMatchObject({ code: "invalid_scheduling_policy" });
    await expect(
      policy.saveSchedulingPolicy(f.actor, input(1)),
    ).rejects.toMatchObject({ code: "invalid_scheduling_policy" });
    await db
      .update(orgSettingsTable)
      .set({ schedulingPolicy: saved.policy })
      .where(eq(orgSettingsTable.organizationId, f.org));
    await db
      .update(organizationsTable)
      .set({ timezone: "UTC" })
      .where(eq(organizationsTable.id, f.org));
    await expect(
      db.transaction((tx) => policy.readSchedulingContext(tx, f.org)),
    ).rejects.toMatchObject({ code: "invalid_scheduling_policy" });
  });
  it("serializes legacy default-only initialization and holds a paused organization", async () => {
    const f = await fixture();
    const rows = await Promise.all([
      getOrgSettings(f.org),
      getOrgSettings(f.org),
    ]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(rows[0].schedulingPolicy).toBeNull();
    const held = await fixture();
    await db.insert(customerLifecycleTable).values({
      organizationId: held.org,
      state: "paused",
      reason: "Synthetic scheduling hold",
    });
    await expect(getOrgSettings(held.org)).rejects.toMatchObject({
      code: "customer_lifecycle_paused",
    });
    expect(
      await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, held.org)),
    ).toHaveLength(0);
  });
  it("inspection writes advance configured policy and preserve independent zones plus legacy101 limit", async () => {
    const f = await fixture();
    await policy.saveSchedulingPolicy(f.actor, input());
    await updateOrgSettings(
      f.org,
      {
        inspectionAvailability: {
          ...DEFAULT_INSPECTION_AVAILABILITY,
          maxBookingsPerWindow: 101,
        },
      },
      f.actor,
    );
    const read = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org, undefined, {
        reservationKind: "appointment",
      }),
    );
    expect(read.policy!.revision).toBe(2);
    expect(read.context.applicableRules).toEqual({
      newTravelGapMinutes: 60,
      companyCeiling: 3,
      inspectionCeiling: 101,
    });
    expect(schedulingReviewContextSchema.safeParse(read.context).success).toBe(
      true,
    );
    expect(read.context.inspection).toMatchObject({
      sourceState: "recorded",
      ruleTimeZone: "America/New_York",
    });
    await db
      .update(usersTable)
      .set({ isPlatformAdmin: true })
      .where(eq(usersTable.id, f.user));
    await policy.setSchedulingCompanyTimeZone(
      f.actor,
      f.org,
      "Europe/London",
      "America/Los_Angeles",
    );
    const after = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org, undefined, {
        reservationKind: "appointment",
      }),
    );
    expect(after.policy).toMatchObject({
      revision: 3,
      timeZone: "Europe/London",
    });
    expect(after.effectiveInspection).toEqual(read.effectiveInspection);
    expect(after.context.inspection!.availabilityDigest).not.toBe(
      read.context.inspection!.availabilityDigest,
    );
    await expect(
      db.transaction((tx) =>
        policy.revalidateSchedulingContext(tx, f.org, read.context, undefined, {
          reservationKind: "appointment",
        }),
      ),
    ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  });
  it("requires platform authority and exact expected zone for company changes", async () => {
    const f = await fixture();
    await expect(
      policy.setSchedulingCompanyTimeZone(
        f.actor,
        f.org,
        "UTC",
        "America/Los_Angeles",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .update(usersTable)
      .set({ isPlatformAdmin: true })
      .where(eq(usersTable.id, f.user));
    await expect(
      policy.setSchedulingCompanyTimeZone(
        f.actor,
        f.org,
        "UTC",
        "Europe/London",
      ),
    ).rejects.toMatchObject({ code: "stale_scheduling_review" });
    await expect(
      policy.setSchedulingCompanyTimeZone(
        f.actor,
        f.org,
        "No/Such_Zone",
        "America/Los_Angeles",
      ),
    ).rejects.toMatchObject({ code: "invalid_scheduling_policy" });
  });
  it("Today uses canonical company day bounds and holds invalid company zone", async () => {
    const f = await fixture();
    await db.insert(orgSettingsTable).values({
      organizationId: f.org,
      inspectionAvailability: DEFAULT_INSPECTION_AVAILABILITY,
    });
    expect(
      await getContractorToday(f.org, f.user, { date: "2026-03-08" }),
    ).toMatchObject({
      timeZone: "America/Los_Angeles",
      timeZoneSource: "configured",
      startAt: "2026-03-08T08:00:00.000Z",
      endAt: "2026-03-09T07:00:00.000Z",
    });
    await db
      .update(organizationsTable)
      .set({ timezone: "No/Such_Zone" })
      .where(eq(organizationsTable.id, f.org));
    await expect(getContractorToday(f.org, f.user)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("lets a platform administrator repair an invalid unconfigured company zone without creating policy", async () => {
    const f = await fixture();
    await db
      .update(usersTable)
      .set({ isPlatformAdmin: true })
      .where(eq(usersTable.id, f.user));
    await db
      .update(organizationsTable)
      .set({ timezone: "Invalid/Legacy" })
      .where(eq(organizationsTable.id, f.org));
    await policy.setSchedulingCompanyTimeZone(
      f.actor,
      f.org,
      "UTC",
      "Invalid/Legacy",
    );
    expect(
      (await policy.readSchedulingPolicy(f.actor)).context.companyTimeZone,
    ).toBe("UTC");
    expect(
      await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, f.org)),
    ).toEqual([]);
  });
  it("refuses forged rules, digest and source against a fresh transaction context", async () => {
    const f = await fixture();
    await policy.saveSchedulingPolicy(f.actor, input());
    const current = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org),
    );
    for (const context of [
      {
        ...current.context,
        applicableRules: {
          ...current.context.applicableRules,
          newTravelGapMinutes: 0,
        },
      },
      { ...current.context, policyDigest: "f".repeat(64) },
      {
        ...current.context,
        source: {
          sourceKind: "unlinked_manual" as const,
          leadId: null,
          contactId: null,
          propertyId: null,
          estimateId: null,
        },
      },
    ])
      await expect(
        db.transaction((tx) =>
          policy.revalidateSchedulingContext(tx, f.org, context),
        ),
      ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  });
  it("does not project a valid-shaped reservation belonging to another target", async () => {
    const f = await fixture();
    const [visit] = await db
      .insert(appointmentsTable)
      .values({
        organizationId: f.org,
        scheduledStart: new Date("2035-01-01T12:00:00Z"),
      })
      .returning();
    const snapshot = {
      formatVersion: 1 as const,
      reservationRevision: 1,
      sourcePolicyRevision: 1,
      sourcePolicyDigest: "a".repeat(64),
      approvedTimeZone: "UTC",
      inspection: null,
      startAt: "2035-01-01T12:00:00.000Z",
      endAt: "2035-01-01T14:00:00.000Z",
      resourceUserIds: [],
      minimumTravelGapMinutes: 60,
      duration: { kind: "explicit" as const, preset: null },
      admittedAt: "2035-01-01T00:00:00.000Z",
      admittedByUserId: f.user,
      target: { kind: "appointment" as const, id: randomUUID() },
      lastTransition: {
        kind: "admission" as const,
        actorUserId: f.user,
        at: "2035-01-01T00:00:00.000Z",
      },
    };
    expect(
      policy.projectSchedulingEvidence("appointment", {
        ...visit,
        schedulingReservation: snapshot,
      }),
    ).toMatchObject({
      schedulingEvidence: "invalid",
      schedulingReservation: null,
    });
    expect(
      policy.projectSchedulingEvidence("appointment", {
        ...visit,
        scheduledEnd: new Date(snapshot.endAt),
        schedulingReservation: {
          ...snapshot,
          target: { kind: "appointment", id: visit.id },
        },
      }),
    ).toMatchObject({ schedulingEvidence: "versioned" });
  });
});

describe("authorized scheduling routes", () => {
  it("keeps truly unlinked target source exact while allowing original lead-linked NULL-contact fallback", async () => {
    const f = await fixture(),
      headers = { Cookie: await cookie(f.user) };
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: f.org, firstName: "Synthetic" })
      .returning();
    const [lead] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org, contactId: contact.id })
      .returning();
    const [unlinked, legacyLead] = await db
      .insert(appointmentsTable)
      .values([
        {
          organizationId: f.org,
          scheduledStart: new Date("2035-01-01T12:00:00Z"),
        },
        {
          organizationId: f.org,
          leadId: lead.id,
          contactId: null,
          scheduledStart: new Date("2035-01-01T12:00:00Z"),
        },
      ])
      .returning();
    const query = (id: string, source: string) =>
      base +
      `/scheduling/review-context?reservationKind=appointment&targetKind=appointment&targetId=${id}&${source}`;
    const proper = await fetch(
      query(unlinked.id, "sourceKind=unlinked_manual"),
      { headers },
    );
    expect(proper.status).toBe(200);
    expect(await proper.json()).toMatchObject({
      source: {
        sourceKind: "unlinked_manual",
        leadId: null,
        contactId: null,
        propertyId: null,
        estimateId: null,
      },
    });
    const fallback = await fetch(
      query(legacyLead.id, `sourceKind=lead&sourceId=${lead.id}`),
      { headers },
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({
      source: { sourceKind: "lead", leadId: lead.id, contactId: contact.id },
    });
    for (const source of [
      `sourceKind=direct_customer&sourceId=${contact.id}`,
      `sourceKind=lead&sourceId=${lead.id}`,
    ]) {
      const wrong = await fetch(query(unlinked.id, source), { headers });
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({
        code: "customer_reference_mismatch",
      });
    }
  });
  it("commits mixed name/timezone changes atomically and rolls back all scheduling evidence on an actual rename write failure", async () => {
    const f = await fixture();
    await policy.saveSchedulingPolicy(f.actor, input());
    await db
      .update(usersTable)
      .set({ isPlatformAdmin: true })
      .where(eq(usersTable.id, f.user));
    const headers = {
      Cookie: await cookie(f.user),
      "Content-Type": "application/json",
    };
    const send = (body: unknown) =>
      fetch(base + "/platform/orgs/" + f.org, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
    const success = await send({
      name: "Synthetic renamed",
      timezone: "UTC",
      expectedTimeZone: "America/Los_Angeles",
    });
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({
      organization: { name: "Synthetic renamed", timezone: "UTC" },
    });
    expect((await policy.readSchedulingPolicy(f.actor)).policy).toMatchObject({
      revision: 2,
      timeZone: "UTC",
    });
    const beforePolicy = (await policy.readSchedulingPolicy(f.actor)).policy;
    const beforeAudit = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org))
      .orderBy(auditEventsTable.id);
    const hook = `scheduling_rename_failure_${randomUUID().replaceAll("-", "")}`;
    try {
      await db.execute(
        sql.raw(
          `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic scheduling rename storage failure'; END $$`,
        ),
      );
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${hook} BEFORE UPDATE ON organizations FOR EACH ROW WHEN (NEW.id = '${f.org}'::uuid AND NEW.name = 'Synthetic rejected rename') EXECUTE FUNCTION ${hook}()`,
        ),
      );
      const failed = await send({
        name: "Synthetic rejected rename",
        timezone: "Europe/London",
        expectedTimeZone: "UTC",
      });
      expect(failed.status).toBe(500);
      const [org] = await db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, f.org));
      expect(org).toMatchObject({ name: "Synthetic renamed", timezone: "UTC" });
      expect((await policy.readSchedulingPolicy(f.actor)).policy).toEqual(
        beforePolicy,
      );
      expect(
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.organizationId, f.org))
          .orderBy(auditEventsTable.id),
      ).toEqual(beforeAudit);
    } finally {
      await db.execute(
        sql.raw(`DROP TRIGGER IF EXISTS ${hook} ON organizations`),
      );
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${hook}()`));
    }
  });
  it("serves policy saves through the closed dedicated endpoint and refuses generic policy injection", async () => {
    const f = await fixture(),
      headers = {
        Cookie: await cookie(f.user),
        "Content-Type": "application/json",
      };
    expect((await fetch(base + "/settings/scheduling-policy")).status).toBe(
      401,
    );
    expect(
      (await fetch(base + "/settings/scheduling-policy", { headers })).status,
    ).toBe(200);
    expect(
      await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, f.org)),
    ).toEqual([]);
    const save = await fetch(base + "/settings/scheduling-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify(input()),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ policy: { revision: 1 } });
    expect(
      (
        await fetch(base + "/settings/scheduling-policy", {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...input(1), digest: "forged" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + "/settings", {
          method: "PUT",
          headers,
          body: JSON.stringify({ schedulingPolicy: null }),
        })
      ).status,
    ).toBe(400);
    expect((await policy.readSchedulingPolicy(f.actor)).policy!.revision).toBe(
      1,
    );
  });
  it("requires reviewed platform timezone updates through the actual route", async () => {
    const f = await fixture();
    await db
      .update(usersTable)
      .set({ isPlatformAdmin: true })
      .where(eq(usersTable.id, f.user));
    const headers = {
      Cookie: await cookie(f.user),
      "Content-Type": "application/json",
    };
    const send = (body: unknown) =>
      fetch(base + "/platform/orgs/" + f.org, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
    expect((await send({ timezone: "UTC" })).status).toBe(400);
    expect(
      (await send({ timezone: "UTC", expectedTimeZone: "Europe/London" }))
        .status,
    ).toBe(409);
    expect(
      (await send({ timezone: "UTC", expectedTimeZone: "America/Los_Angeles" }))
        .status,
    ).toBe(200);
    expect(
      (await policy.readSchedulingPolicy(f.actor)).context.companyTimeZone,
    ).toBe("UTC");
  });
  it("publishes closed source-scoped context, native booking scope and explicit enabled/disabled rules", async () => {
    const f = await fixture(),
      headers = { Cookie: await cookie(f.user) };
    await policy.saveSchedulingPolicy(f.actor, input());
    const query =
      "/scheduling/review-context?sourceKind=unlinked_manual&reservationKind=";
    const project = await fetch(base + query + "project", { headers });
    expect(project.status).toBe(200);
    expect(
      schedulingReviewContextSchema.parse(await project.json()).applicableRules,
    ).toEqual({
      newTravelGapMinutes: 60,
      companyCeiling: 3,
      inspectionCeiling: null,
    });
    const appointment = await fetch(base + query + "appointment", { headers });
    expect(appointment.status).toBe(200);
    expect(
      schedulingReviewContextSchema.parse(await appointment.json())
        .applicableRules.inspectionCeiling,
    ).toBe(1);
    const other = await fetch(
      base + query + "appointment&appointmentType=other",
      { headers },
    );
    expect(
      schedulingReviewContextSchema.parse(await other.json()).inspection,
    ).toBeNull();
    for (const suffix of [
      "project&appointmentType=inspection",
      "project&targetKind=appointment&targetId=" + randomUUID(),
      "appointment&actorUserId=forged",
      "appointment&sourceId=" + randomUUID(),
    ])
      expect((await fetch(base + query + suffix, { headers })).status).toBe(
        400,
      );
    const saved = await db.transaction((tx) =>
      policy.readSchedulingContext(tx, f.org),
    );
    await policy.saveSchedulingPolicy(f.actor, {
      ...input(1),
      enabled: false,
      durationPresets: saved.policy!.durationPresets,
    });
    expect(
      schedulingReviewContextSchema.parse(
        await (await fetch(base + query + "appointment", { headers })).json(),
      ).applicableRules,
    ).toEqual({
      newTravelGapMinutes: 0,
      companyCeiling: null,
      inspectionCeiling: 1,
    });
    const generic = await fetch(base + "/settings", { headers });
    expect(await generic.json()).not.toHaveProperty("schedulingPolicy");
  });
  it("binds actual lead lineage and target fingerprint while proposed type controls inspection applicability", async () => {
    const f = await fixture(),
      headers = { Cookie: await cookie(f.user) };
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: f.org, firstName: "Synthetic" })
      .returning();
    const [property] = await db
      .insert(propertiesTable)
      .values({
        organizationId: f.org,
        contactId: contact.id,
        addressLine1: "Synthetic",
        city: "Test",
        state: "CA",
        postalCode: "00000",
      })
      .returning();
    const [lead] = await db
      .insert(leadsTable)
      .values({
        organizationId: f.org,
        contactId: contact.id,
        propertyId: property.id,
      })
      .returning();
    const [visit] = await db
      .insert(appointmentsTable)
      .values({
        organizationId: f.org,
        leadId: lead.id,
        contactId: contact.id,
        propertyId: property.id,
        type: "production",
        scheduledStart: new Date("2035-01-01T12:00:00Z"),
      })
      .returning();
    const query = `/scheduling/review-context?sourceKind=lead&sourceId=${lead.id}&propertyId=${property.id}&reservationKind=appointment&targetKind=appointment&targetId=${visit.id}`;
    const original = schedulingReviewContextSchema.parse(
      await (await fetch(base + query, { headers })).json(),
    );
    expect(original).toMatchObject({
      source: {
        sourceKind: "lead",
        leadId: lead.id,
        contactId: contact.id,
        propertyId: property.id,
        estimateId: null,
      },
      targetVersion: visit.updatedAt.toISOString(),
      inspection: null,
    });
    const proposed = schedulingReviewContextSchema.parse(
      await (
        await fetch(base + query + "&appointmentType=inspection", { headers })
      ).json(),
    );
    expect(proposed.inspection).not.toBeNull();
    expect(proposed.targetFingerprint).toBe(original.targetFingerprint);
    await db
      .update(appointmentsTable)
      .set({ type: "other", updatedAt: visit.updatedAt })
      .where(eq(appointmentsTable.id, visit.id));
    expect(
      schedulingReviewContextSchema.parse(
        await (await fetch(base + query, { headers })).json(),
      ).targetFingerprint,
    ).not.toBe(original.targetFingerprint);
    const foreign = await fixture();
    expect(
      (
        await fetch(base + query, {
          headers: { Cookie: await cookie(foreign.user) },
        })
      ).status,
    ).toBe(404);
  });
});
