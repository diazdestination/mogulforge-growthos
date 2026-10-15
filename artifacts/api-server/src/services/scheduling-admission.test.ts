import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import {
  appointmentsTable,
  db,
  organizationsTable,
  orgSettingsTable,
  projectsTable,
  usersTable,
  auditEventsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as crm from "./crm";
import * as policy from "./scheduling-policy";

const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture(gap = 60, cap: number | null = null) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic native admission",
      slug: randomUUID(),
      timezone: "UTC",
    })
    .returning();
  orgs.push(org.id);
  const [user, tech] = await db
    .insert(usersTable)
    .values([
      { organizationId: org.id, role: "owner" },
      { organizationId: org.id, role: "office" },
    ])
    .returning();
  const actor = { organizationId: org.id, userId: user.id };
  const saved = await policy.saveSchedulingPolicy(actor, {
    expectedRevision: 0,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: gap,
    maxConcurrentReservations: cap,
    durationPresets: [],
  });
  const contact = await crm.createContact(org.id, { firstName: "Synthetic" });
  const lead = (await crm.createLead(org.id, { contactId: contact.id }))!;
  return {
    org: org.id,
    user: user.id,
    tech: tech.id,
    actor,
    saved,
    contact: contact.id,
    lead: lead.id,
  };
}
const window = (hour: number) => ({
  scheduledStart: new Date(Date.UTC(2035, 0, 1, hour)),
  scheduledEnd: new Date(Date.UTC(2035, 0, 1, hour + 1)),
});
function row<T>(value: T | string | null): T {
  if (!value || typeof value === "string")
    throw Error("Missing native fixture");
  return value;
}
async function review(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "appointment" | "project",
  id?: string,
) {
  const context = await policy.getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: f.lead,
    reservationKind: kind,
    ...(kind === "appointment"
      ? { appointmentType: "production" as const }
      : {}),
    ...(id ? { targetKind: kind, targetId: id } : {}),
  });
  return {
    context,
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  };
}
it("refuses actorless configured native admission instead of silently creating an unprotected row", async () => {
  const f = await fixture();
  await expect(
    crm.createAppointment(f.org, {
      ...window(10),
      type: "production",
      leadId: f.lead,
    }),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  expect(
    await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org)),
  ).toHaveLength(0);
});
it("saves reviewed native reservation and preserves notes/confirmation after corrupt current policy", async () => {
  const f = await fixture();
  const r = await review(f, "appointment");
  const item = await crm.createAppointment(
    f.org,
    {
      ...window(10),
      type: "production",
      leadId: f.lead,
      assignedUserId: f.tech,
      schedulingReview: r,
    } as never,
    f.actor,
  );
  if (!item || typeof item === "string") throw Error("fixture");
  expect(item.schedulingReservation).toMatchObject({
    minimumTravelGapMinutes: 60,
    resourceUserIds: [f.tech],
  });
  await db
    .update(orgSettingsTable)
    .set({ schedulingPolicy: { ...f.saved.policy!, digest: "0".repeat(64) } })
    .where(eq(orgSettingsTable.organizationId, f.org));
  expect(
    await crm.updateAppointment(f.org, item.id, { notes: "Historical note" }),
  ).toMatchObject({ schedulingReservation: item.schedulingReservation });
  expect(
    await crm.updateAppointment(f.org, item.id, { status: "confirmed" }),
  ).toMatchObject({ schedulingReservation: item.schedulingReservation });
});
it("releases a protected crew subset without adopting current policy; date clearing retains history", async () => {
  const f = await fixture();
  const item = await crm.createProject(
    f.org,
    {
      ...window(10),
      leadId: f.lead,
      name: "Crew",
      crewUserIds: [f.user, f.tech],
      schedulingReview: await review(f, "project"),
    } as never,
    f.actor,
  );
  if (!item || item === crm.DUPLICATE_ESTIMATE) throw Error("fixture");
  await db
    .update(orgSettingsTable)
    .set({ schedulingPolicy: { ...f.saved.policy!, digest: "0".repeat(64) } })
    .where(eq(orgSettingsTable.organizationId, f.org));
  const released = await crm.updateProject(
    f.org,
    item.id,
    {
      crewUserIds: [f.tech],
      expectedUpdatedAt: item.updatedAt.toISOString(),
      expectedTargetFingerprint: policy.schedulingTargetFingerprint(
        "project",
        item,
      ),
    } as never,
    f.actor,
  );
  if (!released || typeof released === "string") throw Error("fixture");
  expect(released.schedulingReservation).toMatchObject({
    reservationRevision: 2,
    resourceUserIds: [f.tech],
    minimumTravelGapMinutes: 60,
    admittedByUserId: f.user,
  });
  const clear = await crm.updateProject(
    f.org,
    item.id,
    {
      scheduledStart: null,
      scheduledEnd: null,
      expectedUpdatedAt: released.updatedAt.toISOString(),
      expectedTargetFingerprint: policy.schedulingTargetFingerprint(
        "project",
        released,
      ),
    } as never,
    f.actor,
  );
  expect(clear).toMatchObject({
    scheduledStart: null,
    scheduledEnd: null,
    crewUserIds: [f.tech],
    schedulingReservation: released.schedulingReservation,
  });
});
it.each(["lower", "disabled"] as const)(
  "retains old saved travel after policy becomes %s, allowing exact equality",
  async (mode) => {
    const f = await fixture();
    const original = row(
      await crm.createAppointment(
        f.org,
        {
          ...window(10),
          type: "production",
          leadId: f.lead,
          assignedUserId: f.tech,
          schedulingReview: await review(f, "appointment"),
        },
        f.actor,
      ),
    );
    await policy.saveSchedulingPolicy(f.actor, {
      expectedRevision: 1,
      expectedCompanyTimeZone: "UTC",
      enabled: mode !== "disabled",
      minimumTravelGapMinutes: 0,
      maxConcurrentReservations: null,
      durationPresets: [],
    });
    const r = await review(f, "project");
    await expect(
      crm.createProject(
        f.org,
        {
          ...window(11),
          leadId: f.lead,
          name: "Too close",
          crewUserIds: [f.user, f.tech],
          schedulingReview: r,
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "travel_conflict" });
    expect(
      await crm.createProject(
        f.org,
        {
          ...window(12),
          leadId: f.lead,
          name: "Exactly saved gap",
          crewUserIds: [f.user, f.tech],
          schedulingReview: r,
        },
        f.actor,
      ),
    ).toMatchObject({ schedulingReservation: { minimumTravelGapMinutes: 0 } });
    expect(
      (
        await db
          .select()
          .from(appointmentsTable)
          .where(eq(appointmentsTable.id, original.id))
      )[0].schedulingReservation,
    ).toEqual(original.schedulingReservation);
  },
);
it("measures company true peak with a long candidate and counts multi-user work once", async () => {
  const f = await fixture(0, 2);
  for (const hour of [10, 12])
    row(
      await crm.createProject(
        f.org,
        {
          ...window(hour),
          leadId: f.lead,
          name: "One company reservation",
          crewUserIds: [f.user, f.tech],
          schedulingReview: await review(f, "project"),
        },
        f.actor,
      ),
    );
  expect(
    await crm.createAppointment(
      f.org,
      {
        ...window(10),
        scheduledEnd: window(14).scheduledEnd,
        type: "production",
        leadId: f.lead,
        schedulingReview: await review(f, "appointment"),
      },
      f.actor,
    ),
  ).toBeTruthy();
  await expect(
    crm.createAppointment(
      f.org,
      {
        ...window(10),
        type: "production",
        leadId: f.lead,
        schedulingReview: await review(f, "appointment"),
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "company_capacity_conflict" });
});
it("holds corrupt same-resource active evidence even outside the maximum current horizon", async () => {
  const f = await fixture(0);
  const item = row(
    await crm.createAppointment(
      f.org,
      {
        ...window(10),
        type: "production",
        leadId: f.lead,
        assignedUserId: f.tech,
        schedulingReview: await review(f, "appointment"),
      },
      f.actor,
    ),
  );
  const later = new Date("2040-01-01T10:00:00Z"),
    end = new Date("2040-01-01T11:00:00Z");
  await db
    .update(appointmentsTable)
    .set({
      scheduledStart: later,
      scheduledEnd: end,
      schedulingReservation: {
        ...item.schedulingReservation!,
        startAt: later.toISOString(),
        endAt: end.toISOString(),
        resourceUserIds: [],
      },
    })
    .where(eq(appointmentsTable.id, item.id));
  await expect(
    crm.createProject(
      f.org,
      {
        ...window(12),
        leadId: f.lead,
        name: "Must hold",
        crewUserIds: [f.tech],
        schedulingReview: await review(f, "project"),
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "invalid_reservation_snapshot" });
});
it.each(["appointment", "project"] as const)(
  "holds a corrupt active %s whose saved staff claim outlives its actual assignment",
  async (kind) => {
    const f = await fixture(0);
    if (kind === "appointment") {
      const saved = row(
        await crm.createAppointment(
          f.org,
          {
            ...window(10),
            type: "production",
            leadId: f.lead,
            assignedUserId: f.tech,
            schedulingReview: await review(f, "appointment"),
          },
          f.actor,
        ),
      );
      await db
        .update(appointmentsTable)
        .set({
          assignedUserId: f.user,
          scheduledStart: new Date("2040-01-01T10:00:00Z"),
          scheduledEnd: new Date("2040-01-01T11:00:00Z"),
        })
        .where(eq(appointmentsTable.id, saved.id));
    } else {
      const saved = row(
        await crm.createProject(
          f.org,
          {
            ...window(10),
            leadId: f.lead,
            name: "Uncertain saved staff claim",
            crewUserIds: [f.tech],
            schedulingReview: await review(f, "project"),
          },
          f.actor,
        ),
      );
      await db
        .update(projectsTable)
        .set({
          crewUserIds: [f.user],
          scheduledStart: new Date("2040-01-01T10:00:00Z"),
          scheduledEnd: new Date("2040-01-01T11:00:00Z"),
        })
        .where(eq(projectsTable.id, saved.id));
    }
    await expect(
      crm.createAppointment(
        f.org,
        {
          ...window(12),
          type: "production",
          leadId: f.lead,
          assignedUserId: f.tech,
          schedulingReview: await review(f, "appointment"),
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "invalid_reservation_snapshot" });
  },
);
it("preserves invalid historical JSON on notes/closure while refusing an active partial release", async () => {
  const f = await fixture();
  const item = row(
    await crm.createProject(
      f.org,
      {
        ...window(10),
        leadId: f.lead,
        name: "Historical corrupt crew",
        crewUserIds: [f.user, f.tech],
        schedulingReview: await review(f, "project"),
      },
      f.actor,
    ),
  );
  const raw = { ...item.schedulingReservation!, resourceUserIds: [f.user] };
  const [corrupt] = await db
    .update(projectsTable)
    .set({ schedulingReservation: raw })
    .where(eq(projectsTable.id, item.id))
    .returning();
  await expect(
    crm.updateProject(
      f.org,
      item.id,
      {
        crewUserIds: [f.user],
        expectedUpdatedAt: corrupt.updatedAt.toISOString(),
        expectedTargetFingerprint: policy.schedulingTargetFingerprint(
          "project",
          corrupt,
        ),
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "invalid_reservation_snapshot" });
  expect(
    await crm.updateProject(
      f.org,
      item.id,
      { crewNotes: "Retained raw history" },
      f.actor,
    ),
  ).toMatchObject({ schedulingReservation: raw });
  await db
    .update(usersTable)
    .set({ isActive: false, emailVerifiedAt: null })
    .where(eq(usersTable.id, f.tech));
  expect(
    await crm.updateProject(f.org, item.id, { status: "completed" }, f.actor),
  ).toMatchObject({ schedulingReservation: raw, status: "completed" });
  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.action, "scheduling.reservation_transition.v1"),
      ),
    );
  expect(audits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          transition: "release",
          before: null,
          after: null,
          invalidHistoricalEvidenceRetained: true,
        }),
      }),
    ]),
  );
});
it("rejects old fingerprints after a same-millisecond crew change", async () => {
  const f = await fixture();
  const item = row(
    await crm.createProject(
      f.org,
      {
        ...window(10),
        leadId: f.lead,
        name: "Versioned crew",
        crewUserIds: [f.user],
        schedulingReview: await review(f, "project"),
      },
      f.actor,
    ),
  );
  await db
    .update(projectsTable)
    .set({ crewUserIds: [f.user, f.tech], updatedAt: item.updatedAt })
    .where(eq(projectsTable.id, item.id));
  await expect(
    crm.updateProject(
      f.org,
      item.id,
      {
        crewUserIds: [],
        expectedUpdatedAt: item.updatedAt.toISOString(),
        expectedTargetFingerprint: policy.schedulingTargetFingerprint(
          "project",
          item,
        ),
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  expect(
    (
      await db.select().from(projectsTable).where(eq(projectsTable.id, item.id))
    )[0].crewUserIds,
  ).toEqual([f.user, f.tech]);
});
it("keeps appointment start-only duration and project start-only absolute end", async () => {
  const f = await fixture(0);
  const appointment = row(
    await crm.createAppointment(
      f.org,
      {
        ...window(10),
        scheduledEnd: window(12).scheduledEnd,
        type: "production",
        leadId: f.lead,
        schedulingReview: await review(f, "appointment"),
      },
      f.actor,
    ),
  );
  const moved = await crm.updateAppointment(
    f.org,
    appointment.id,
    {
      scheduledStart: window(11).scheduledStart,
      schedulingReview: await review(f, "appointment", appointment.id),
      expectedUpdatedAt: appointment.updatedAt.toISOString(),
      expectedTargetFingerprint: policy.schedulingTargetFingerprint(
        "appointment",
        appointment,
      ),
    },
    undefined,
    f.actor,
  );
  expect(moved).toMatchObject({ scheduledEnd: window(13).scheduledEnd });
  const project = row(
    await crm.createProject(
      f.org,
      {
        ...window(10),
        scheduledEnd: window(12).scheduledEnd,
        leadId: f.lead,
        name: "Absolute project end",
        schedulingReview: await review(f, "project"),
      },
      f.actor,
    ),
  );
  expect(
    await crm.updateProject(
      f.org,
      project.id,
      {
        scheduledStart: window(11).scheduledStart,
        schedulingReview: await review(f, "project", project.id),
        expectedUpdatedAt: project.updatedAt.toISOString(),
        expectedTargetFingerprint: policy.schedulingTargetFingerprint(
          "project",
          project,
        ),
      },
      f.actor,
    ),
  ).toMatchObject({ scheduledEnd: window(12).scheduledEnd });
});
it.each(["appointment", "project"] as const)(
  "refuses end-only clearing on a protected active unassigned %s",
  async (kind) => {
    const f = await fixture(0);
    const saved =
      kind === "appointment"
        ? row(
            await crm.createAppointment(
              f.org,
              {
                ...window(10),
                type: "production",
                leadId: f.lead,
                schedulingReview: await review(f, kind),
              },
              f.actor,
            ),
          )
        : row(
            await crm.createProject(
              f.org,
              {
                ...window(10),
                leadId: f.lead,
                name: "Protected unassigned",
                schedulingReview: await review(f, kind),
              },
              f.actor,
            ),
          );
    const patch = {
      scheduledEnd: null,
      schedulingReview: await review(f, kind, saved.id),
      expectedUpdatedAt: saved.updatedAt.toISOString(),
      expectedTargetFingerprint: policy.schedulingTargetFingerprint(
        kind,
        saved,
      ),
    };
    await expect(
      kind === "appointment"
        ? crm.updateAppointment(f.org, saved.id, patch, undefined, f.actor)
        : crm.updateProject(f.org, saved.id, patch, f.actor),
    ).rejects.toMatchObject({ code: "invalid_interval" });
    const persisted =
      kind === "appointment"
        ? (
            await db
              .select()
              .from(appointmentsTable)
              .where(eq(appointmentsTable.id, saved.id))
          )[0]
        : (
            await db
              .select()
              .from(projectsTable)
              .where(eq(projectsTable.id, saved.id))
          )[0];
    expect(persisted.scheduledEnd).toEqual(saved.scheduledEnd);
    expect(persisted.schedulingReservation).toEqual(
      saved.schedulingReservation,
    );
  },
);
it("resolves an explicit enabled preset once and retains its snapshot after disable/deletion", async () => {
  const f = await fixture(0);
  const configured = await policy.saveSchedulingPolicy(f.actor, {
    expectedRevision: 1,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 0,
    maxConcurrentReservations: null,
    durationPresets: [
      { id: null, label: "Ninety elapsed minutes", elapsedMinutes: 90 },
    ],
  });
  const preset = configured.policy!.durationPresets[0],
    duration = { kind: "preset" as const, preset },
    choice = { ...(await review(f, "appointment")), duration };
  await expect(
    crm.createAppointment(
      f.org,
      {
        ...window(10),
        type: "production",
        leadId: f.lead,
        schedulingReview: choice,
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  const saved = row(
    await crm.createAppointment(
      f.org,
      {
        ...window(10),
        scheduledEnd: new Date("2035-01-01T11:30:00Z"),
        type: "production",
        leadId: f.lead,
        schedulingReview: choice,
      },
      f.actor,
    ),
  );
  expect(saved.schedulingReservation?.duration).toEqual(duration);
  await policy.saveSchedulingPolicy(f.actor, {
    expectedRevision: 2,
    expectedCompanyTimeZone: "UTC",
    enabled: false,
    minimumTravelGapMinutes: 0,
    maxConcurrentReservations: null,
    durationPresets: [preset],
  });
  await expect(
    crm.createAppointment(
      f.org,
      {
        ...window(12),
        scheduledEnd: new Date("2035-01-01T13:30:00Z"),
        type: "production",
        leadId: f.lead,
        schedulingReview: { ...(await review(f, "appointment")), duration },
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  await policy.saveSchedulingPolicy(f.actor, {
    expectedRevision: 3,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 0,
    maxConcurrentReservations: null,
    durationPresets: [],
  });
  expect(
    await crm.updateAppointment(f.org, saved.id, {
      notes: "Original preset history remains",
    }),
  ).toMatchObject({
    scheduledEnd: saved.scheduledEnd,
    schedulingReservation: saved.schedulingReservation,
  });
});
it("bounds a combined mixed resource population at10000 and holds10001 without truncation", async () => {
  const f = await fixture(0);
  await db.execute(
    sql`insert into appointments(organization_id,lead_id,type,status,assigned_user_id,scheduled_start,scheduled_end) select ${f.org}::uuid,${f.lead}::uuid,'production','scheduled',${f.tech},'2040-01-01 10:00:00Z'::timestamptz,'2040-01-01 11:00:00Z'::timestamptz from generate_series(1,5000)`,
  );
  await db.execute(
    sql`insert into projects(organization_id,lead_id,name,status,crew_user_ids,scheduled_start,scheduled_end) select ${f.org}::uuid,${f.lead}::uuid,'Synthetic population','scheduled',${JSON.stringify([f.tech])}::jsonb,'2040-01-01 10:00:00Z'::timestamptz,'2040-01-01 11:00:00Z'::timestamptz from generate_series(1,5000)`,
  );
  const accepted = row(
    await crm.createAppointment(
      f.org,
      {
        ...window(10),
        type: "production",
        leadId: f.lead,
        assignedUserId: f.tech,
        schedulingReview: await review(f, "appointment"),
      },
      f.actor,
    ),
  );
  await crm.updateAppointment(f.org, accepted.id, { status: "cancelled" });
  await db.insert(projectsTable).values({
    organizationId: f.org,
    leadId: f.lead,
    name: "10001st active",
    crewUserIds: [f.tech],
    scheduledStart: new Date("2040-01-01T10:00:00Z"),
    scheduledEnd: new Date("2040-01-01T11:00:00Z"),
  });
  await expect(
    crm.createAppointment(
      f.org,
      {
        ...window(12),
        type: "production",
        leadId: f.lead,
        assignedUserId: f.tech,
        schedulingReview: await review(f, "appointment"),
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: "scheduling_coverage_limit" });
}, 30000);
