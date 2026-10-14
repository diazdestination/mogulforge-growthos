import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEventsTable,
  customerWorkCommandsTable,
  customerWorkRootsTable,
  db,
  orgSettingsTable,
  organizationsTable,
  projectsTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  acceptedReturningEstimate,
  returningCustomerFixture,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import {
  createCustomerWorkProject,
  updateCustomerWorkProject,
} from "./returning-customer";
import {
  createCustomerWorkProjectSchema,
  customerWorkProjectMutationSchema,
  CustomerWorkError,
} from "./returning-customer-contract";
import { customerWorkHash } from "./customer-work-lineage";
import * as lineage from "./customer-work-lineage";
import {
  getSchedulingReviewContext,
  readSchedulingPolicy,
  saveSchedulingPolicy,
} from "./scheduling-policy";
import { transitionCustomerLifecycle } from "./customer-lifecycle";

const orgs: string[] = [];
afterAll(async () => {
  vi.restoreAllMocks();
  await deleteTestOrgs(...orgs);
});
async function fixture() {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  return f;
}
type F = Awaited<ReturnType<typeof fixture>>;
const interval = {
  scheduledStart: "2037-06-15T14:00:00.000Z",
  scheduledEnd: "2037-06-15T15:00:00.000Z",
};
async function configure(f: F, gap = 60, cap: number | null = 2) {
  const actor = { organizationId: f.org, userId: f.owner.id },
    current = await readSchedulingPolicy(actor);
  return saveSchedulingPolicy(actor, {
    expectedRevision: current.context.policyRevision,
    expectedCompanyTimeZone: current.context.companyTimeZone,
    enabled: true,
    minimumTravelGapMinutes: gap,
    maxConcurrentReservations: cap,
    durationPresets: [],
  });
}
async function review(f: F, targetId?: string, estimateId?: string) {
  return {
    context: await getSchedulingReviewContext(
      { organizationId: f.org, userId: f.owner.id },
      {
        sourceKind: "direct_customer",
        sourceId: f.contact.id,
        propertyId: f.secondProperty.id,
        reservationKind: "project",
        ...(estimateId ? { estimateId } : {}),
        ...(targetId ? { targetKind: "project" as const, targetId } : {}),
      },
    ),
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  };
}
async function booked(f: F) {
  const input = {
    ...returningProjectDraft(f),
    ...interval,
    crewUserIds: [f.office.id, f.owner.id],
    schedulingReview: await review(f),
  };
  return {
    input,
    result: await createCustomerWorkProject(f.org, f.actor, input),
  };
}
async function events(f: F) {
  return db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.action, "scheduling.reservation_transition.v1"),
      ),
    );
}
function edit(
  input: ReturnType<typeof createCustomerWorkProjectSchema.parse>,
  expectedWorkVersion: number,
) {
  const { source: _source, ...body } = input;
  return { ...body, requestId: randomUUID(), expectedWorkVersion };
}

it("requires reviewed fresh material staff admission at revision zero and rolls back its source root", async () => {
  const f = await fixture();
  await expect(
    createCustomerWorkProject(f.org, f.actor, {
      ...returningProjectDraft(f),
      ...interval,
    }),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  expect(
    await db
      .select()
      .from(customerWorkRootsTable)
      .where(eq(customerWorkRootsTable.organizationId, f.org)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(customerWorkCommandsTable)
      .where(eq(customerWorkCommandsTable.organizationId, f.org)),
  ).toHaveLength(0);
  const saved = await booked(f);
  expect(saved.result.project).toMatchObject({
    schedulingReservation: null,
    schedulingEvidence: "legacy",
  });
});

it("pins original parsed source-command hash vectors and never defaults an omitted review", () => {
  const input = createCustomerWorkProjectSchema.parse({
    requestId: "10000000-0000-4000-8000-000000000001",
    confirmed: true,
    source: {
      kind: "existing_customer",
      contactId: "20000000-0000-4000-8000-000000000002",
      propertyId: null,
    },
    name: "  Repair  ",
    status: "scheduled",
    scheduledStart: null,
    scheduledEnd: null,
    crewUserIds: ["tech-b", "tech-a"],
    crewNotes: null,
  });
  expect(input.name).toBe("Repair");
  expect(Object.hasOwn(input, "schedulingReview")).toBe(false);
  const envelope = {
    action: "project_created",
    targetId: null,
    input,
    actorUserId: "staff-original",
  };
  expect(customerWorkHash(envelope)).toBe(
    "33ee6a9b1cda35c6228ddf59d68fbaa62e38d1278743dcfdcb2c1b0306bef4a9",
  );
  expect(
    customerWorkHash({ ...envelope, actorUserId: "staff-different" }),
  ).toBe("7bc815326342e308b9a30e40cfa47368dddb76f368e567bee9fac41dcf55f17b");
  expect(
    customerWorkHash({
      ...envelope,
      input: { ...input, crewUserIds: [...input.crewUserIds].reverse() },
    }),
  ).not.toBe(customerWorkHash(envelope));
  expect(
    createCustomerWorkProjectSchema.safeParse({
      ...input,
      schedulingReview: null,
    }).success,
  ).toBe(false);
});

it("atomically records reviewed returning reservations, real source transition and original command outcome", async () => {
  const f = await fixture();
  await configure(f);
  const { input, result } = await booked(f);
  expect(customerWorkProjectMutationSchema.parse(result)).toEqual(result);
  expect(result.project).toMatchObject({
    leadId: null,
    contactId: f.contact.id,
    propertyId: f.secondProperty.id,
    schedulingEvidence: "versioned",
    schedulingReservation: {
      target: { kind: "project", id: result.project.id },
      minimumTravelGapMinutes: 60,
      admittedByUserId: f.owner.id,
    },
  });
  expect(result).toMatchObject({
    commandOutcome: {
      formatVersion: 1,
      organizationId: f.org,
      actorUserId: f.owner.id,
      requestId: input.requestId,
      action: "project_created",
      payloadSha256: customerWorkHash({
        action: "project_created",
        targetId: null,
        input: createCustomerWorkProjectSchema.parse(input),
        actorUserId: f.owner.id,
      }),
      customerWorkId: result.project.customerWorkId,
      target: { kind: "project", id: result.project.id, available: true },
      resultWorkVersion: 1,
      outcome: "committed",
    },
  });
  expect(await events(f)).toMatchObject([
    {
      actorUserId: f.owner.id,
      entityId: result.project.id,
      metadata: {
        transition: "admission",
        origin: "returning_command",
        sourceId: input.requestId,
        source: {
          sourceKind: "direct_customer",
          contactId: f.contact.id,
          propertyId: f.secondProperty.id,
          estimateId: null,
        },
        invalidHistoricalEvidenceRetained: false,
      },
    },
  ]);
});

it("replays the original project before corrupt current policy, changed zone and paused lifecycle without new effects", async () => {
  const f = await fixture();
  const policy = await configure(f);
  const { input, result } = await booked(f);
  await db
    .update(orgSettingsTable)
    .set({ schedulingPolicy: { ...policy.policy!, digest: "0".repeat(64) } })
    .where(eq(orgSettingsTable.organizationId, f.org));
  await db
    .update(organizationsTable)
    .set({ timezone: "America/Los_Angeles" })
    .where(eq(organizationsTable.id, f.org));
  await transitionCustomerLifecycle(f.org, f.owner.id, {
    action: "pause",
    expectedVersion: 0,
    reason: "Synthetic source hold",
  });
  const replay = await createCustomerWorkProject(f.org, f.actor, input);
  expect(replay.command).toEqual({ ...result.command, duplicate: true });
  expect(replay).toMatchObject({
    commandOutcome: (result as unknown as { commandOutcome: unknown })
      .commandOutcome,
  });
  expect(replay.project.schedulingReservation).toEqual(
    result.project.schedulingReservation,
  );
  expect(await events(f)).toHaveLength(1);
  expect(
    await db
      .select()
      .from(customerWorkCommandsTable)
      .where(eq(customerWorkCommandsTable.organizationId, f.org)),
  ).toHaveLength(1);
});

it("keeps old omitted-review hashes unchanged and permits historical replay after policy is configured", async () => {
  const f = await fixture(),
    input = returningProjectDraft(f),
    parsed = createCustomerWorkProjectSchema.parse(input);
  expect(parsed).toEqual(input);
  expect(Object.hasOwn(parsed, "schedulingReview")).toBe(false);
  const saved = await createCustomerWorkProject(f.org, f.actor, input);
  const [command] = await db
    .select()
    .from(customerWorkCommandsTable)
    .where(eq(customerWorkCommandsTable.requestId, input.requestId));
  expect(command.payloadSha256).toBe(
    customerWorkHash({
      action: "project_created",
      targetId: null,
      input,
      actorUserId: f.owner.id,
    }),
  );
  await configure(f);
  const replay = await createCustomerWorkProject(f.org, f.actor, input);
  expect(replay.command).toMatchObject({
    targetId: saved.project.id,
    version: 1,
    duplicate: true,
  });
  expect(await events(f)).toHaveLength(1);
});

it("keeps original result version and acknowledgement after a later legitimate project edit", async () => {
  const f = await fixture();
  await configure(f);
  const { input, result } = await booked(f);
  const changed = await updateCustomerWorkProject(
    f.org,
    f.actor,
    result.project.id,
    { ...edit(input, 1), crewNotes: "Later office note" },
  );
  const replay = await createCustomerWorkProject(f.org, f.actor, input);
  expect(replay.project.workVersion).toBe(changed.project.workVersion);
  expect(replay.command).toMatchObject({
    targetId: result.project.id,
    version: 1,
    duplicate: true,
  });
  expect(replay).toMatchObject({
    commandOutcome: (result as unknown as { commandOutcome: unknown })
      .commandOutcome,
  });
  expect(await events(f)).toHaveLength(1);
});

it("refuses stale review, replaced source, actor and raw authority fields before admission", async () => {
  const f = await fixture();
  await configure(f);
  const input = {
    ...returningProjectDraft(f),
    ...interval,
    schedulingReview: await review(f),
  };
  await configure(f, 90);
  await expect(
    createCustomerWorkProject(f.org, f.actor, input),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  const fresh = { ...input, schedulingReview: await review(f) },
    saved = await createCustomerWorkProject(f.org, f.actor, fresh);
  await expect(
    createCustomerWorkProject(f.org, { userId: f.office.id }, fresh),
  ).rejects.toMatchObject({ code: "customer_work_request_conflict" });
  await expect(
    createCustomerWorkProject(f.org, f.actor, {
      ...fresh,
      schedulingReview: {
        ...fresh.schedulingReview,
        context: { ...fresh.schedulingReview.context, companyTimeZone: "UTC" },
      },
    }),
  ).rejects.toMatchObject({ code: "customer_work_request_conflict" });
  await expect(
    createCustomerWorkProject(f.org, f.actor, {
      ...fresh,
      requestId: randomUUID(),
      source: { ...fresh.source, propertyId: f.firstProperty.id },
    }),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  for (const field of [
    "operationId",
    "actorUserId",
    "schedulingReservation",
    "reviewMode",
  ])
    expect(
      createCustomerWorkProjectSchema.safeParse({
        ...fresh,
        [field]: saved.project.id,
      }).success,
    ).toBe(false);
  expect(await events(f)).toHaveLength(1);
});

it("retains exact quote ancestry when converting an accepted returning estimate", async () => {
  const f = await fixture();
  await configure(f);
  const accepted = await acceptedReturningEstimate(f);
  const input = {
    ...returningProjectDraft(f),
    ...interval,
    source: {
      kind: "estimate" as const,
      estimateId: accepted.estimate.id,
      expectedWorkVersion: accepted.estimate.workVersion!,
    },
    schedulingReview: await review(f, undefined, accepted.estimate.id),
  };
  const created = await createCustomerWorkProject(f.org, f.actor, input);
  expect(created.project).toMatchObject({
    customerWorkId: accepted.estimate.customerWorkId,
    estimateId: accepted.estimate.id,
    contactId: accepted.estimate.contactId,
    propertyId: accepted.estimate.propertyId,
  });
  expect((await events(f))[0].metadata.source).toMatchObject({
    estimateId: accepted.estimate.id,
  });
  await expect(
    createCustomerWorkProject(f.org, f.actor, {
      ...input,
      requestId: randomUUID(),
      source: { ...input.source, expectedWorkVersion: 1 },
    }),
  ).rejects.toMatchObject({ code: "customer_work_stale_version" });
  await expect(
    createCustomerWorkProject(f.org, f.actor, {
      ...input,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "customer_work_project_exists" });
});

it("preserves historical protection on pure removal and closure even with corrupt current policy", async () => {
  const f = await fixture(),
    policy = await configure(f);
  const { input, result } = await booked(f),
    before = result.project.schedulingReservation!;
  await db
    .update(orgSettingsTable)
    .set({ schedulingPolicy: { ...policy.policy!, digest: "0".repeat(64) } })
    .where(eq(orgSettingsTable.organizationId, f.org));
  const notes = await updateCustomerWorkProject(
    f.org,
    f.actor,
    result.project.id,
    { ...edit(input, 1), crewNotes: "Preserve this authored instruction" },
  );
  expect(notes.project.schedulingReservation).toEqual(before);
  await expect(
    updateCustomerWorkProject(f.org, f.actor, result.project.id, {
      ...edit(input, 2),
      crewUserIds: [f.office.id],
    }),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  const released = await updateCustomerWorkProject(
    f.org,
    f.actor,
    result.project.id,
    {
      ...edit(input, 2),
      expectedTargetFingerprint: notes.project.schedulingTargetFingerprint,
      crewUserIds: [f.office.id],
    },
  );
  expect(released.project.schedulingReservation).toMatchObject({
    ...before,
    reservationRevision: 2,
    resourceUserIds: [f.office.id],
    lastTransition: { kind: "release", actorUserId: f.owner.id },
  });
  await db
    .update(usersTable)
    .set({ isActive: false })
    .where(eq(usersTable.id, f.office.id));
  const closed = await updateCustomerWorkProject(
    f.org,
    f.actor,
    result.project.id,
    { ...edit(input, 3), crewUserIds: [f.office.id], status: "completed" },
  );
  expect(closed.project.schedulingReservation).toEqual(
    released.project.schedulingReservation,
  );
  expect((await events(f)).map((e) => e.metadata.transition)).toEqual([
    "admission",
    "release",
    "release",
  ]);
});

it("rejects same-version resource drift and protected active end clearing while preserving raw invalid closure", async () => {
  const f = await fixture();
  await configure(f);
  const { input, result } = await booked(f);
  const oldFingerprint = result.project.schedulingTargetFingerprint;
  await db
    .update(projectsTable)
    .set({
      crewUserIds: [f.owner.id],
      updatedAt: new Date(result.project.updatedAt),
    })
    .where(eq(projectsTable.id, result.project.id));
  await expect(
    updateCustomerWorkProject(f.org, f.actor, result.project.id, {
      ...edit(input, 1),
      expectedTargetFingerprint: oldFingerprint,
      crewUserIds: [],
    }),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
  const malformed = {
    ...result.project.schedulingReservation!,
    privateCorruptMarker: "never emit this historical payload",
  };
  await db
    .update(projectsTable)
    .set({ schedulingReservation: malformed })
    .where(eq(projectsTable.id, result.project.id));
  const closed = await updateCustomerWorkProject(
    f.org,
    f.actor,
    result.project.id,
    { ...edit(input, 1), status: "completed" },
  );
  expect(closed.project).toMatchObject({
    schedulingReservation: null,
    schedulingEvidence: "invalid",
  });
  expect(JSON.stringify(closed)).not.toContain("privateCorruptMarker");
  expect(
    (
      await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, result.project.id))
    )[0].schedulingReservation,
  ).toEqual(malformed);
  expect((await events(f)).at(-1)?.metadata).toMatchObject({
    before: null,
    after: null,
    invalidHistoricalEvidenceRetained: true,
    transition: "release",
  });
});

it("retains original committed proof when the current source projection becomes incoherent", async () => {
  const f = await fixture();
  await configure(f);
  const { input, result } = await booked(f);
  await db
    .update(propertiesTable)
    .set({ contactId: f.otherContact.id })
    .where(eq(propertiesTable.id, f.secondProperty.id));
  await expect(
    createCustomerWorkProject(f.org, f.actor, input),
  ).rejects.toMatchObject({
    status: 409,
    code: "customer_work_result_unavailable",
    commandOutcome: {
      requestId: input.requestId,
      actorUserId: f.owner.id,
      customerWorkId: result.project.customerWorkId,
      outcome: "committed",
      target: { kind: "project", id: result.project.id, available: false },
      resultWorkVersion: 1,
    },
  });
  expect(await events(f)).toHaveLength(1);
});

it("never converts SQL, code-shaped errors or a rolled-back fresh projection failure into committed proof", async () => {
  const f = await fixture(),
    input = returningProjectDraft(f);
  const saved = await createCustomerWorkProject(f.org, f.actor, input);
  for (const error of [
    Object.assign(new Error("Synthetic database failure"), { code: "23505" }),
    Object.assign(new Error("Not a real source error"), {
      code: "customer_work_parent_mismatch",
      status: 409,
    }),
  ]) {
    const spy = vi
      .spyOn(lineage, "readNativeWorkLineage")
      .mockRejectedValueOnce(error);
    try {
      await expect(
        createCustomerWorkProject(f.org, f.actor, input),
      ).rejects.toBe(error);
    } finally {
      spy.mockRestore();
    }
  }
  const error = new CustomerWorkError(
      409,
      "customer_work_parent_mismatch",
      "Synthetic post-insert source projection failure",
    ),
    spy = vi
      .spyOn(lineage, "readNativeWorkLineage")
      .mockRejectedValueOnce(error);
  try {
    await expect(
      createCustomerWorkProject(f.org, f.actor, returningProjectDraft(f)),
    ).rejects.toBe(error);
  } finally {
    spy.mockRestore();
  }
  expect(
    await db
      .select()
      .from(customerWorkCommandsTable)
      .where(eq(customerWorkCommandsTable.organizationId, f.org)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.organizationId, f.org)),
  ).toMatchObject([{ id: saved.project.id }]);
  expect(
    await db
      .select()
      .from(customerWorkRootsTable)
      .where(eq(customerWorkRootsTable.organizationId, f.org)),
  ).toHaveLength(1);
});

it("holds protected active end clearing and fresh protected admission without a real end", async () => {
  const f = await fixture();
  await configure(f);
  const { input, result } = await booked(f);
  const currentReview = await review(f, result.project.id);
  await expect(
    updateCustomerWorkProject(f.org, f.actor, result.project.id, {
      ...edit(input, 1),
      crewUserIds: [],
      scheduledEnd: null,
      expectedTargetFingerprint: result.project.schedulingTargetFingerprint,
      schedulingReview: currentReview,
    }),
  ).rejects.toMatchObject({ code: "invalid_reservation_snapshot" });
  await expect(
    createCustomerWorkProject(f.org, f.actor, {
      ...returningProjectDraft(f),
      ...interval,
      scheduledEnd: null,
      schedulingReview: await review(f),
    }),
  ).rejects.toMatchObject({ code: "customer_work_invalid_interval" });
  expect(
    await db
      .select()
      .from(customerWorkCommandsTable)
      .where(eq(customerWorkCommandsTable.organizationId, f.org)),
  ).toHaveLength(1);
});

it.each([false, true])(
  "preserves and closes retained incomplete historical work without inventing an end (invalid evidence: %s)",
  async (invalid) => {
    const f = await fixture();
    if (invalid) await configure(f);
    const { input, result } = await booked(f);
    const retained = invalid
      ? {
          ...result.project.schedulingReservation!,
          privateCorruptMarker: "retained only",
        }
      : null;
    await db
      .update(projectsTable)
      .set({ scheduledEnd: null, schedulingReservation: retained })
      .where(eq(projectsTable.id, result.project.id));
    const policy = await configure(f);
    await db
      .update(orgSettingsTable)
      .set({ schedulingPolicy: { ...policy.policy!, digest: "0".repeat(64) } })
      .where(eq(orgSettingsTable.organizationId, f.org));
    const { schedulingReview: _oldReview, ...original } = input;
    const notes = await updateCustomerWorkProject(
      f.org,
      f.actor,
      result.project.id,
      {
        ...edit(original, 1),
        scheduledEnd: null,
        crewNotes: "Retain historical window",
      },
    );
    expect(notes.project).toMatchObject({
      scheduledEnd: null,
      schedulingReservation: null,
      schedulingEvidence: invalid ? "invalid" : "legacy",
    });
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, f.office.id));
    const closed = await updateCustomerWorkProject(
      f.org,
      f.actor,
      result.project.id,
      { ...edit(original, 2), scheduledEnd: null, status: "completed" },
    );
    expect(closed.project.scheduledEnd).toBeNull();
    expect(
      (
        await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, result.project.id))
      )[0].schedulingReservation,
    ).toEqual(retained);
    expect(JSON.stringify(closed)).not.toContain("privateCorruptMarker");
  },
);
