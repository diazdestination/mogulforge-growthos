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
  usersTable,
} from "@workspace/db";
import { schedulingReviewContextSchema } from "@workspace/scheduling-core";
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
        schedulingReservation: {
          ...snapshot,
          target: { kind: "appointment", id: visit.id },
        },
      }),
    ).toMatchObject({ schedulingEvidence: "versioned" });
  });
});

describe("authorized scheduling routes", () => {
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
