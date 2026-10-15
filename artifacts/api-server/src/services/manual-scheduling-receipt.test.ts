import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  customerLifecycleTable,
  db,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  projectsTable,
  scheduledActionsTable,
  usersTable,
} from "@workspace/db";
import {
  canonicalSchedulingEnvelope,
  manualSchedulingAckSchema,
  type ManualSchedulingCommand,
} from "@workspace/scheduling-core";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  ScheduleError,
  type ScheduleTransaction,
} from "./contractor-scheduling";
import {
  assertSchedulingActor,
  lockSchedulingConfiguration,
  SchedulingPolicyError,
} from "./scheduling-policy";
import {
  ManualSchedulingRefusal,
  reconcileManualScheduling,
  runManualSchedulingCreate,
  validateManualSchedulingCommand,
} from "./manual-scheduling-receipt";
import {
  manualSchedulingReceiptSchema,
  projectManualSchedulingReceipt,
} from "./scheduling-history";

const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic receipt",
      slug: `receipt-${randomUUID()}`,
      timezone: "UTC",
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
  const actor = { organizationId: org.id, userId: user.id };
  const command: ManualSchedulingCommand = {
    operationId: randomUUID(),
    kind: "appointment_create",
    body: { scheduledStart: "2035-01-02T10:00:00+00:00", type: "other" },
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
  return { org: org.id, user, actor, command };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function native(tx: ScheduleTransaction, f: Fixture) {
  const [row] = await tx
    .insert(appointmentsTable)
    .values({
      organizationId: f.org,
      scheduledStart: new Date("2035-01-02T10:00:00Z"),
      type: "other",
    })
    .returning();
  await tx.insert(scheduledActionsTable).values({
    organizationId: f.org,
    action: {
      type: "appointment_reminder",
      params: { appointmentId: row.id },
    },
    runAt: new Date("2035-01-01T10:00:00Z"),
  });
  await tx
    .insert(crmTasksTable)
    .values({ organizationId: f.org, title: "Synthetic callback task" });
  await tx.insert(auditEventsTable).values({
    organizationId: f.org,
    actorUserId: f.actor.userId,
    action: "appointment.created",
    entityType: "appointment",
    entityId: row.id,
    metadata: { synthetic: true },
  });
  return { kind: "appointment" as const, id: row.id };
}
async function create(
  f: Fixture,
  callback: (tx: ScheduleTransaction) => ReturnType<typeof native> = (tx) =>
    native(tx, f),
  command = f.command,
) {
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, f.org);
    await assertSchedulingActor(tx, f.actor, "crm.write");
    return runManualSchedulingCreate(tx, f.actor, command, callback);
  });
}
async function rows(f: Fixture) {
  return {
    targets: await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org)),
    reminders: await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, f.org)),
    tasks: await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.organizationId, f.org)),
    events: await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org)),
  };
}
it("commits callback writes and exact wire receipt once, with no response-loss replay side effects", async () => {
  const f = await fixture(),
    bodyBefore = JSON.stringify(f.command);
  const first = await create(f),
    again = await create(f),
    ack = await reconcileManualScheduling(f.actor, f.command);
  expect(first.newlyCreated).toBe(true);
  expect(again).toEqual({ ack, newlyCreated: false });
  expect(ack).toEqual(first.ack);
  expect(manualSchedulingAckSchema.parse(ack)).toEqual(ack);
  const { operationId: _operation, ...command } = f.command;
  expect(ack.payloadSha256).toBe(
    createHash("sha256")
      .update(
        canonicalSchedulingEnvelope({
          organizationId: f.org,
          actorUserId: f.actor.userId,
          ...command,
        }),
        "utf8",
      )
      .digest("hex"),
  );
  expect(JSON.stringify(f.command)).toBe(bodyBefore);
  const saved = await rows(f);
  expect([
    saved.targets.length,
    saved.reminders.length,
    saved.tasks.length,
    saved.events.length,
  ]).toEqual([1, 1, 1, 2]);
  const receipt = saved.events.find((row) => row.id === f.command.operationId)!;
  expect(manualSchedulingReceiptSchema.parse(receipt.metadata).target).toEqual({
    kind: "appointment",
    id: ack.target!.id,
  });
  expect(receipt).toMatchObject({
    action: "scheduling.manual_operation.v1",
    entityType: "appointment",
    entityId: ack.target!.id,
  });
  expect(projectManualSchedulingReceipt(receipt, true)).toEqual(ack);
});
it("fences an absent original permanently without creating anything; callback never runs", async () => {
  const f = await fixture(),
    callback = vi.fn((tx) => native(tx, f));
  const ack = await reconcileManualScheduling(f.actor, f.command);
  expect(ack).toMatchObject({
    outcome: "no_commit_refused",
    refusalCode: "original_create_fenced",
    target: null,
  });
  expect(await create(f, callback)).toEqual({ ack, newlyCreated: false });
  expect(callback).not.toHaveBeenCalled();
  const saved = await rows(f);
  expect([
    saved.targets.length,
    saved.reminders.length,
    saved.tasks.length,
  ]).toEqual([0, 0, 0]);
  expect(saved.events).toHaveLength(2);
  const business = saved.events.find(
    (row) => row.action === "scheduling.operation_refused.v1",
  )!;
  expect(business.id).not.toBe(f.command.operationId);
  expect(business.metadata).toEqual({
    formatVersion: 1,
    source: f.command.review.context.source,
    target: null,
    reason: "original_create_fenced",
    recordedAt: expect.any(String),
  });
  expect(JSON.stringify(business)).not.toContain(f.command.operationId);
  expect(JSON.stringify(business)).not.toContain(ack.payloadSha256);
});
it("rolls back partial target/reminder/task/history writes on deliberate domain refusal, retaining only terminal evidence", async () => {
  const f = await fixture();
  const result = await create(f, async (tx) => {
    await native(tx, f);
    throw new ManualSchedulingRefusal("travel_conflict");
  });
  expect(result).toMatchObject({
    newlyCreated: false,
    ack: {
      outcome: "no_commit_refused",
      refusalCode: "travel_conflict",
      target: null,
    },
  });
  const saved = await rows(f);
  expect([
    saved.targets.length,
    saved.reminders.length,
    saved.tasks.length,
  ]).toEqual([0, 0, 0]);
  expect(saved.events.map((row) => row.action).sort()).toEqual([
    "scheduling.manual_operation.v1",
    "scheduling.operation_refused.v1",
  ]);
  expect(await reconcileManualScheduling(f.actor, f.command)).toEqual(
    result.ack,
  );
});
it.each([
  () => new Error("Synthetic lost transport"),
  () => ({ code: "travel_conflict", status: 409 }),
  () => new ScheduleError("resource_conflict"),
  () =>
    new SchedulingPolicyError(
      "stale_scheduling_review",
      "Synthetic changed policy",
    ),
])(
  "does not convert unknown/lookalike/native errors to terminal proof %#",
  async (error) => {
    const f = await fixture();
    await expect(
      create(f, async (tx) => {
        await native(tx, f);
        throw error();
      }),
    ).rejects.toBeDefined();
    expect(await rows(f)).toEqual({
      targets: [],
      reminders: [],
      tasks: [],
      events: [],
    });
  },
);
it("raw SQL failure after partial writes rolls back outer transaction", async () => {
  const f = await fixture();
  await expect(
    create(f, async (tx) => {
      const target = await native(tx, f);
      await tx.execute(sql`select 1/0`);
      return target;
    }),
  ).rejects.toBeDefined();
  expect(await rows(f)).toEqual({
    targets: [],
    reminders: [],
    tasks: [],
    events: [],
  });
});
it("receipt insert failure rolls back callback and its intervening audit collision", async () => {
  const f = await fixture();
  await expect(
    create(f, async (tx) => {
      const target = await native(tx, f);
      await tx.insert(auditEventsTable).values({
        id: f.command.operationId,
        organizationId: f.org,
        action: "synthetic.collision",
        entityType: "appointment",
      });
      return target;
    }),
  ).rejects.toBeDefined();
  expect(await rows(f)).toEqual({
    targets: [],
    reminders: [],
    tasks: [],
    events: [],
  });
});
it("edited then deleted target preserves original committed identity and metadata forever", async () => {
  const f = await fixture(),
    result = await create(f);
  await db
    .update(appointmentsTable)
    .set({
      notes: "Changed later",
      scheduledStart: new Date("2038-04-01T00:00:00Z"),
    })
    .where(eq(appointmentsTable.id, result.ack.target!.id));
  expect(await reconcileManualScheduling(f.actor, f.command)).toEqual(
    result.ack,
  );
  await db
    .update(auditEventsTable)
    .set({ createdAt: new Date("1990-01-01T00:00:00Z") })
    .where(eq(auditEventsTable.id, f.command.operationId));
  const [before] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.id, f.command.operationId));
  await db
    .delete(appointmentsTable)
    .where(eq(appointmentsTable.id, result.ack.target!.id));
  const ack = await reconcileManualScheduling(f.actor, f.command);
  expect(ack).toEqual({
    ...result.ack,
    target: { ...result.ack.target!, available: false },
  });
  expect((await create(f)).ack).toEqual(ack);
  const [after] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.id, f.command.operationId));
  expect(after).toEqual(before);
});
it("replays original deleted source and corrupt current policy/company zone without a live reader", async () => {
  const f = await fixture();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: f.org, firstName: "Synthetic" })
    .returning();
  f.command.body.contactId = contact.id;
  f.command.review.context.source = {
    sourceKind: "direct_customer",
    contactId: contact.id,
    leadId: null,
    propertyId: null,
    estimateId: null,
  };
  const result = await create(f);
  await db.delete(contactsTable).where(eq(contactsTable.id, contact.id));
  await db
    .update(organizationsTable)
    .set({ timezone: "invalid-synthetic-zone" })
    .where(eq(organizationsTable.id, f.org));
  await db.insert(orgSettingsTable).values({ organizationId: f.org });
  // Structurally DB-valid but semantically corrupt policy digest; no constraints disabled.
  await db.execute(
    sql`UPDATE org_settings SET scheduling_policy = ${JSON.stringify({ formatVersion: 1, revision: 1, enabled: true, timeZone: "UTC", minimumTravelGapMinutes: 0, maxConcurrentReservations: null, durationPresets: [], digest: "bad", updatedAt: "2030-01-01T00:00:00.000Z", updatedByUserId: f.actor.userId })}::jsonb WHERE organization_id=${f.org}`,
  );
  expect(await reconcileManualScheduling(f.actor, f.command)).toEqual(
    result.ack,
  );
});
it.each(["actor", "tenant", "kind", "body", "review", "omitted-null"] as const)(
  "holds %s collision without exposing the prior receipt",
  async (kind) => {
    const f = await fixture(),
      first = await create(f),
      original = structuredClone(f.command);
    let actor = f.actor;
    if (kind === "actor") {
      const [user] = await db
        .insert(usersTable)
        .values({
          organizationId: f.org,
          role: "owner",
          emailVerifiedAt: new Date(),
        })
        .returning();
      actor = { ...actor, userId: user.id };
    } else if (kind === "tenant") {
      const other = await fixture();
      actor = other.actor;
      original.review.context.organizationId = other.org;
    } else if (kind === "kind") {
      const leadId = randomUUID();
      Object.assign(original, {
        kind: "project_create",
        body: { leadId, name: "Synthetic project" },
      });
      original.review.context.source = {
        sourceKind: "lead",
        leadId,
        contactId: randomUUID(),
        propertyId: null,
        estimateId: null,
      };
    } else if (kind === "body") original.body.notes = "Changed";
    else if (kind === "review")
      original.review.context.companyTimeZone = "Europe/London";
    else original.body.propertyId = null;
    const error = await reconcileManualScheduling(actor, original).catch(
      (error) => error,
    );
    expect(error).toMatchObject({
      code: "operation_identity_conflict",
      status: 409,
    });
    expect(JSON.stringify(error)).not.toContain(first.ack.target!.id);
    expect(JSON.stringify(error)).not.toContain(first.ack.payloadSha256);
  },
);
it("ordinary audit UUID and malformed receipt collide without leaked details or replacement", async () => {
  const f = await fixture();
  await db.insert(auditEventsTable).values({
    id: f.command.operationId,
    organizationId: f.org,
    action: "ordinary.private",
    entityType: "secret-synthetic",
    metadata: { confidential: "synthetic-private" },
  });
  await expect(
    reconcileManualScheduling(f.actor, f.command),
  ).rejects.toMatchObject({ code: "operation_identity_conflict" });
  await db
    .update(auditEventsTable)
    .set({ action: "scheduling.manual_operation.v1" })
    .where(eq(auditEventsTable.id, f.command.operationId));
  await expect(
    reconcileManualScheduling(f.actor, f.command),
  ).rejects.toMatchObject({ code: "operation_identity_conflict" });
  const saved = await rows(f);
  expect(saved.events).toHaveLength(1);
  expect(saved.targets).toHaveLength(0);
});
it.each(["extra", "target", "entity", "source", "hash"] as const)(
  "closed receipt projection rejects corrupt %s binding",
  async (corruption) => {
    const f = await fixture();
    await create(f);
    const [row] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, f.command.operationId));
    if (corruption === "entity") row.entityId = randomUUID();
    else if (corruption === "extra")
      row.metadata.operationId = f.command.operationId;
    else if (corruption === "target")
      row.metadata.target = { kind: "project", id: randomUUID() };
    else if (corruption === "hash") row.metadata.payloadSha256 = "invalid";
    else
      row.metadata.source = {
        ...f.command.review.context.source!,
        unknown: true,
      };
    expect(projectManualSchedulingReceipt(row, true)).toBeNull();
  },
);
it("pure validator retains lead-derived contact, project property, and appointment estimate evidence without live reads", async () => {
  const f = await fixture(),
    leadId = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID(),
    estimateId = randomUUID();
  const appointment = structuredClone(f.command);
  appointment.body = { ...appointment.body, leadId, propertyId };
  appointment.review.context.source = {
    sourceKind: "lead",
    leadId,
    contactId,
    propertyId,
    estimateId,
  };
  expect(validateManualSchedulingCommand(f.actor, appointment)).toEqual(
    appointment,
  );
  const project: ManualSchedulingCommand = {
    ...appointment,
    kind: "project_create",
    body: { leadId, estimateId, name: "Original project" },
  };
  expect(validateManualSchedulingCommand(f.actor, project)).toEqual(project);
  expect((await reconcileManualScheduling(f.actor, project)).source).toEqual(
    project.review.context.source,
  );
});
it.each([
  "org",
  "lead",
  "contact",
  "property",
  "unlinked",
  "project-estimate",
  "authority",
] as const)(
  "rejects malformed original %s binding without committing a refusal",
  async (kind) => {
    const f = await fixture(),
      original: any = structuredClone(f.command);
    if (kind === "org") original.review.context.organizationId = randomUUID();
    if (kind === "lead") original.body.leadId = randomUUID();
    if (kind === "contact") original.body.contactId = randomUUID();
    if (kind === "property") original.body.propertyId = randomUUID();
    if (kind === "unlinked")
      original.review.context.source = {
        sourceKind: "direct_customer",
        leadId: null,
        contactId: randomUUID(),
        propertyId: null,
        estimateId: null,
      };
    if (kind === "project-estimate") {
      const leadId = randomUUID();
      original.kind = "project_create";
      original.body = { leadId, name: "Bad binding" };
      original.review.context.source = {
        sourceKind: "lead",
        leadId,
        contactId: randomUUID(),
        propertyId: null,
        estimateId: randomUUID(),
      };
    }
    if (kind === "authority") original.body.actorUserId = f.actor.userId;
    await expect(
      reconcileManualScheduling(f.actor, original),
    ).rejects.toBeDefined();
    expect((await rows(f)).events).toEqual([]);
  },
);
it.each(["inactive", "unverified", "viewer", "invite"] as const)(
  "requires currently accepted active actor: %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "invite") {
      const [user] = await db
        .insert(usersTable)
        .values({
          id: `invite:${randomUUID()}`,
          organizationId: f.org,
          role: "owner",
          emailVerifiedAt: new Date(),
        })
        .returning();
      f.actor.userId = user.id;
    } else
      await db
        .update(usersTable)
        .set(
          kind === "inactive"
            ? { isActive: false }
            : kind === "unverified"
              ? { emailVerifiedAt: null }
              : { role: "viewer" },
        )
        .where(eq(usersTable.id, f.actor.userId));
    await expect(
      reconcileManualScheduling(f.actor, f.command),
    ).rejects.toMatchObject({ code: "scheduling_access_denied" });
    expect((await rows(f)).events).toEqual([]);
  },
);
it("validates bounded machine refusal reasons and rejects global transaction misuse", async () => {
  for (const code of ["", "contains spaces", "x".repeat(81), "SQL: private"])
    expect(() => new ManualSchedulingRefusal(code)).toThrow();
  const f = await fixture();
  await expect(
    runManualSchedulingCreate(
      db as unknown as ScheduleTransaction,
      f.actor,
      f.command,
      (tx) => native(tx, f),
    ),
  ).rejects.toMatchObject({ code: "scheduling_transaction_required" });
  expect((await rows(f)).events).toEqual([]);
});
it("project receipt retains original source/target through later edits and deletion", async () => {
  const f = await fixture();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: f.org, firstName: "Synthetic project" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: f.org, contactId: contact.id })
    .returning();
  const command: ManualSchedulingCommand = {
    ...f.command,
    kind: "project_create",
    body: { leadId: lead.id, name: "Original project", crewUserIds: [] },
    review: {
      ...f.command.review,
      context: {
        ...f.command.review.context,
        source: {
          sourceKind: "lead",
          leadId: lead.id,
          contactId: contact.id,
          propertyId: null,
          estimateId: null,
        },
      },
    },
  };
  const first = await db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, f.org);
    await assertSchedulingActor(tx, f.actor, "crm.write");
    return runManualSchedulingCreate(tx, f.actor, command, async (tx) => {
      const [target] = await tx
        .insert(projectsTable)
        .values({
          organizationId: f.org,
          leadId: lead.id,
          name: command.body.name,
        })
        .returning();
      return { kind: "project", id: target.id };
    });
  });
  expect(first.ack).toMatchObject({
    kind: "project_create",
    outcome: "committed",
    target: { kind: "project", available: true },
  });
  await db
    .update(projectsTable)
    .set({ name: "Later name", status: "cancelled" })
    .where(eq(projectsTable.id, first.ack.target!.id));
  expect(await reconcileManualScheduling(f.actor, command)).toEqual(first.ack);
  await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, first.ack.target!.id));
  await db.delete(leadsTable).where(eq(leadsTable.id, lead.id));
  await db.delete(contactsTable).where(eq(contactsTable.id, contact.id));
  expect(await reconcileManualScheduling(f.actor, command)).toEqual({
    ...first.ack,
    target: { ...first.ack.target!, available: false },
  });
});
it("does not turn a held lifecycle or revoked actor into committed refusal, even for a prior receipt", async () => {
  const f = await fixture();
  const { ack } = await create(f);
  await db
    .insert(customerLifecycleTable)
    .values({
      organizationId: f.org,
      state: "paused",
      reason: "Synthetic lifecycle hold",
    });
  await expect(
    reconcileManualScheduling(f.actor, f.command),
  ).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  await db
    .delete(customerLifecycleTable)
    .where(eq(customerLifecycleTable.organizationId, f.org));
  await db
    .update(usersTable)
    .set({ isActive: false })
    .where(eq(usersTable.id, f.actor.userId));
  await expect(
    reconcileManualScheduling(f.actor, f.command),
  ).rejects.toMatchObject({ code: "scheduling_access_denied" });
  const saved = await rows(f);
  expect(saved.events).toHaveLength(2);
  expect(
    saved.events.find((row) => row.id === f.command.operationId)!.metadata
      .outcome,
  ).toBe(ack.outcome);
});
it("rejects invalid or cross-tenant callback targets with outer rollback, never terminal refusal", async () => {
  const f = await fixture(),
    other = await fixture();
  const [foreign] = await db
    .insert(appointmentsTable)
    .values({
      organizationId: other.org,
      scheduledStart: new Date("2035-01-02T10:00:00Z"),
    })
    .returning();
  await expect(
    create(f, async (tx) => {
      await native(tx, f);
      return { kind: "appointment", id: foreign.id };
    }),
  ).rejects.toThrow("unavailable target");
  expect(await rows(f)).toEqual({
    targets: [],
    reminders: [],
    tasks: [],
    events: [],
  });
});

it("recovers the original committed target when delivery of the CREATE result is lost after COMMIT", async () => {
  const f = await fixture();
  await expect(
    create(f).then(() => {
      throw Error("Synthetic lost CREATE response after COMMIT");
    }),
  ).rejects.toThrow("lost CREATE response");
  const saved = await rows(f);
  expect(saved.targets).toHaveLength(1);
  const callback = vi.fn((tx) => native(tx, f));
  const ack = await reconcileManualScheduling(f.actor, f.command);
  expect(ack).toMatchObject({
    outcome: "committed",
    target: { id: saved.targets[0].id, available: true },
  });
  expect(await create(f, callback)).toEqual({ ack, newlyCreated: false });
  expect(callback).not.toHaveBeenCalled();
  expect(await rows(f)).toEqual(saved);
});

it("a structurally valid altered stored source still conflicts with original source custody", async () => {
  const f = await fixture();
  await create(f);
  const [row] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.id, f.command.operationId));
  await db
    .update(auditEventsTable)
    .set({
      metadata: {
        ...row.metadata,
        source: {
          sourceKind: "direct_customer",
          leadId: null,
          contactId: randomUUID(),
          propertyId: null,
          estimateId: null,
        },
      },
    })
    .where(eq(auditEventsTable.id, row.id));
  await expect(
    reconcileManualScheduling(f.actor, f.command),
  ).rejects.toMatchObject({ code: "operation_identity_conflict" });
  expect((await rows(f)).events).toHaveLength(2);
});
