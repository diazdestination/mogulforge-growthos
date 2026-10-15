import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  auditEventsTable,
  contactsTable,
  db,
  organizationsTable,
  usersTable,
  appointmentsTable,
  projectsTable,
  leadsTable,
  orgSettingsTable,
  crmTasksTable,
  invoicesTable,
  customerWorkCommandsTable,
  pool,
  type AuditEvent,
} from "@workspace/db";
import type {
  ReservationSnapshot,
  SchedulingMutationReview,
} from "@workspace/scheduling-core";
import pg from "pg";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as history from "./scheduling-history";
import { deleteContact, deleteProject, listAuditEvents } from "./crm";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";
import { clearDemoData } from "./demo-data";
import { deleteTestLeads } from "./onboarding";
import {
  getSchedulingReviewContext,
  saveSchedulingPolicy,
} from "./scheduling-policy";
import {
  returningCustomerFixture,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import { createCustomerWorkProject } from "./returning-customer";
import { customerWorkHash } from "./customer-work-lineage";
import {
  careFingerprint,
  serviceCareBookingSchema,
} from "./service-care-policy";
import {
  callieBookingSchema,
  canonicalCallieBookingInput,
} from "./callie-office-contract";
import { reconcileManualScheduling } from "./manual-scheduling-receipt";
import type { ManualSchedulingCommand } from "@workspace/scheduling-core";

const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
const stamp = "2035-01-01T10:00:00.000Z";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic retained schedule",
      slug: `schedule-history-${randomUUID()}`,
      timezone: "UTC",
    })
    .returning();
  orgs.push(org.id);
  const [owner] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      role: "owner",
      emailVerifiedAt: new Date(),
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Synthetic history customer" })
    .returning();
  return { org: org.id, owner: owner.id, contact: contact.id };
}
function source(contact: string) {
  return {
    sourceKind: "direct_customer" as const,
    contactId: contact,
    leadId: null,
    propertyId: null,
    estimateId: null,
  };
}
function receipt(
  f: { org: string; owner: string; contact: string },
  target = randomUUID(),
): typeof auditEventsTable.$inferInsert {
  return {
    id: randomUUID(),
    organizationId: f.org,
    actorUserId: f.owner,
    action: history.MANUAL_SCHEDULING_RECEIPT_ACTION,
    entityType: "project",
    entityId: target,
    metadata: {
      formatVersion: 1,
      kind: "project_create",
      source: source(f.contact),
      payloadSha256: "a".repeat(64),
      outcome: "committed",
      target: { kind: "project", id: target },
      refusalCode: null,
      recordedAt: stamp,
    },
  };
}

it("projects a closed committed receipt with deleted target and no operation capability", async () => {
  const f = await fixture(),
    [event] = await db.insert(auditEventsTable).values(receipt(f)).returning();
  const projected = history.projectSchedulingAudit(event, {
    organizationId: f.org,
    authorizedHistoricalLinks: new Set([
      `contact:${f.contact}`,
      `project:${event.entityId}`,
    ]),
    availableTargets: new Set(),
  });
  expect(projected).toEqual({
    event: "operation_committed",
    occurredAt: stamp,
    target: { kind: "project", id: event.entityId, available: false },
    source: source(f.contact),
    before: null,
    after: null,
    reasonCode: null,
  });
  expect(JSON.stringify(projected)).not.toContain(event.id);
  expect(JSON.stringify(projected)).not.toContain(f.owner);
  expect(JSON.stringify(projected)).not.toContain("a".repeat(64));
  expect(
    history.closedBusinessSchedulingSummarySchema.parse(
      JSON.parse(JSON.stringify(projected)),
    ),
  ).toEqual(projected);
});

it.each(["committed", "refused", "malformed", "foreign"])(
  "retains selected contact for %s scheduling evidence",
  async (kind) => {
    const f = await fixture(),
      other = kind === "foreign" ? await fixture() : f;
    const row = receipt(f);
    if (kind === "refused") {
      row.entityId = null;
      Object.assign(row.metadata!, {
        outcome: "no_commit_refused",
        target: null,
        refusalCode: "original_create_fenced",
      });
    }
    if (kind === "malformed")
      row.metadata = {
        source: { contactId: f.contact },
        privateEvidence: "retained-invalid",
      };
    row.organizationId = other.org;
    const [event] = await db.insert(auditEventsTable).values(row).returning();
    await expect(deleteContact(f.org, f.contact)).rejects.toMatchObject({
      code: "scheduling_history_retained",
    });
    expect(
      (
        await db
          .select()
          .from(contactsTable)
          .where(eq(contactsTable.id, f.contact))
      )[0]?.id,
    ).toBe(f.contact);
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, event.id))
      )[0]?.metadata,
    ).toEqual(event.metadata);
  },
);

it("closes policy metadata in ordinary audit without leaking saved actor or digest", async () => {
  const f = await fixture();
  const policy = {
    formatVersion: 1,
    revision: 1,
    enabled: false,
    timeZone: "UTC",
    minimumTravelGapMinutes: 60,
    maxConcurrentReservations: 2,
    durationPresets: [],
    digest: "b".repeat(64),
    updatedAt: stamp,
    updatedByUserId: f.owner,
  };
  await db.insert(auditEventsTable).values({
    organizationId: f.org,
    actorUserId: f.owner,
    action: "scheduling.policy_saved",
    entityType: "org_settings",
    entityId: f.org,
    metadata: { previousPolicy: null, policy },
  });
  const rows = await listAuditEvents(f.org);
  expect(rows[0].metadata).toMatchObject({
    event: "policy_updated",
    after: { enabled: false, minimumTravelGapMinutes: 60 },
  });
  expect(rows[0].actorUserId).toBeNull();
  expect(JSON.stringify(rows)).not.toContain("b".repeat(64));
  expect(JSON.stringify(rows)).not.toContain(f.owner);
});

it("exports the retained deleted-target business result in organization metadata and keeps exactly 28 datasets", async () => {
  const f = await fixture(),
    [event] = await db.insert(auditEventsTable).values(receipt(f)).returning();
  const out = await createCustomerLifecycleExporter()(f.org, f.owner);
  expect(Object.keys(out.data)).toHaveLength(28);
  expect(out.organization.schedulingPolicy).toBeNull();
  expect(out.organization.schedulingHistory).toEqual([
    expect.objectContaining({
      event: "operation_committed",
      target: { kind: "project", id: event.entityId, available: false },
    }),
  ]);
  expect(out.manifest.schedulingHistory).toEqual({
    count: 1,
    withheldInvalidLinks: 0,
    withheldInvalidRecords: 0,
  });
  expect(out.manifest.schedulingPolicySha256).toBe(digest(null));
  expect(out.manifest.schedulingHistorySha256).toBe(
    digest(out.organization.schedulingHistory),
  );
  expect(out.manifest.dataSha256).toBe(digest(out.data));
  expect(JSON.stringify(out)).not.toContain(event.id);
  expect(
    (
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, event.id))
    )[0].metadata,
  ).toEqual(event.metadata);
});

function saved(
  target: { kind: "appointment" | "project"; id: string },
  resourceUserIds: string[] = [],
): ReservationSnapshot {
  return {
    formatVersion: 1,
    reservationRevision: 3,
    sourcePolicyRevision: 1,
    sourcePolicyDigest: "c".repeat(64),
    approvedTimeZone: "America/Los_Angeles",
    inspection: {
      ruleTimeZone: "America/New_York",
      availabilityDigest: "d".repeat(64),
      sourceState: "recorded",
    },
    startAt: stamp,
    endAt: "2035-01-01T11:00:00.000Z",
    resourceUserIds,
    minimumTravelGapMinutes: 90,
    duration: {
      kind: "preset",
      preset: {
        id: randomUUID(),
        label: "Original one hour",
        elapsedMinutes: 60,
      },
    },
    admittedAt: stamp,
    admittedByUserId: "PRIVATE_ADMISSION_ACTOR",
    target,
    lastTransition: {
      kind: "release",
      actorUserId: "PRIVATE_RELEASE_ACTOR",
      at: stamp,
    },
  };
}
function event(
  org: string,
  actor: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>,
): AuditEvent {
  return {
    id: randomUUID(),
    organizationId: org,
    actorUserId: actor,
    action,
    entityType,
    entityId,
    metadata,
    createdAt: new Date(stamp),
  };
}
function review(org: string, contact: string): SchedulingMutationReview {
  return {
    context: {
      organizationId: org,
      policyRevision: 0,
      policyDigest: null,
      companyTimeZone: "UTC",
      inspection: null,
      applicableRules: {
        newTravelGapMinutes: 0,
        companyCeiling: null,
        inspectionCeiling: null,
      },
      source: source(contact),
      targetVersion: null,
      targetFingerprint: null,
    },
    duration: { kind: "explicit", preset: null },
    startWallTime: null,
    endWallTime: null,
  };
}

it("projects exact protected service fields and withholds the whole reservation when any resource or target is untrusted", () => {
  const target = { kind: "project" as const, id: randomUUID() },
    s = saved(target, ["inactive-same-company"]),
    links = new Set([`project:${target.id}`, "user:inactive-same-company"]);
  const out = history.projectReservationExport(s, links)!;
  expect(Object.keys(out).sort()).toEqual(
    [
      "reservationRevision",
      "approvedTimeZone",
      "inspection",
      "startAt",
      "endAt",
      "resourceUserIds",
      "minimumTravelGapMinutes",
      "duration",
      "target",
    ].sort(),
  );
  expect(out.inspection).toEqual({ ruleTimeZone: "America/New_York" });
  expect(out.minimumTravelGapMinutes).toBe(90);
  expect(out.duration).toEqual(s.duration);
  expect(
    history.closedReservationExportSchema.parse(
      JSON.parse(JSON.stringify(out)),
    ),
  ).toEqual(out);
  for (const privateValue of [
    s.sourcePolicyDigest,
    "PRIVATE_ADMISSION_ACTOR",
    "PRIVATE_RELEASE_ACTOR",
    s.inspection!.availabilityDigest,
  ])
    expect(JSON.stringify(out)).not.toContain(privateValue);
  expect(
    history.projectReservationExport(s, new Set([`project:${target.id}`])),
  ).toBeNull();
  expect(
    history.projectReservationExport(
      s,
      new Set(["user:inactive-same-company"]),
    ),
  ).toBeNull();
  expect(
    history.projectReservationExport(
      { ...s, privateProvider: { token: "SECRET" } } as ReservationSnapshot,
      links,
    ),
  ).toBeNull();
});

it.each(["service", "callie", "concierge", "returning"])(
  "positively projects original %s booking with an exact original transition, never current snapshots",
  async (kind) => {
    const f = await fixture(),
      target = {
        kind:
          kind === "returning"
            ? ("project" as const)
            : ("appointment" as const),
        id: randomUUID(),
      },
      s = saved(target, [f.owner]),
      r = review(f.org, f.contact),
      sourceId = randomUUID(),
      requestId = randomUUID();
    let original: AuditEvent;
    let commands: Record<string, unknown>[] = [];
    if (kind === "service") {
      const input = serviceCareBookingSchema.parse({
        requestId,
        responseId: randomUUID(),
        expectedUpdatedAt: stamp,
        assignedUserId: f.owner,
        scheduledStart: s.startAt,
        scheduledEnd: s.endAt,
        type: "other",
        customerConfirmed: true,
        schedulingReview: r,
      });
      original = event(
        f.org,
        f.owner,
        "service.care_visit_booked",
        "service_obligation",
        sourceId,
        {
          ...input,
          requestFingerprint: careFingerprint(input),
          appointmentId: target.id,
          evidence: "staff_attested_customer_confirmation",
        },
      );
    } else if (kind === "callie") {
      const input = callieBookingSchema.parse({
        requestId,
        expectedVersion: 1,
        expectedFingerprint: "e".repeat(64),
        contactId: f.contact,
        leadId: null,
        propertyId: null,
        assignedUserId: f.owner,
        scheduledStart: s.startAt,
        scheduledEnd: s.endAt,
        type: "other",
        customerConfirmed: true,
        confirmationNote: "Synthetic exact customer confirmation",
        schedulingReview: r,
      });
      original = event(
        f.org,
        f.owner,
        "voice.callie.visit_booked",
        "callie_intake",
        sourceId,
        {
          ...input,
          requestFingerprint: createHash("sha256")
            .update(canonicalCallieBookingInput(input))
            .digest("hex"),
          appointmentId: target.id,
          evidence: "staff_attested_exact_customer_confirmation",
          noAutomaticResend: true,
        },
      );
    } else if (kind === "concierge")
      original = event(
        f.org,
        null,
        "appointment.booked_concierge",
        "appointment",
        target.id,
        {
          conversationId: sourceId,
          leadId: null,
          offer: {
            formatVersion: 1,
            organizationId: f.org,
            conversationId: sourceId,
            appointmentId: target.id,
            label: "Synthetic exact offer",
            start: s.startAt,
            end: s.endAt,
            source: source(f.contact),
            sourceFingerprint: "f".repeat(64),
            review: r,
          },
        },
      );
    else {
      const root = randomUUID();
      original = event(
        f.org,
        f.owner,
        "customer_work.project_created",
        "project",
        target.id,
        {
          requestId: sourceId,
          customerWorkId: root,
          workVersion: 1,
          staffRecorded: true,
          providerEffect: false,
        },
      );
      commands = [
        {
          organizationId: f.org,
          actorUserId: f.owner,
          requestId: sourceId,
          action: "project_created",
          payloadSha256: "e".repeat(64),
          customerWorkId: root,
          projectId: target.id,
          estimateId: null,
          resultVersion: 1,
        },
      ];
    }
    const transition = event(
      f.org,
      original.actorUserId,
      "scheduling.reservation_transition.v1",
      target.kind,
      target.id,
      {
        formatVersion: 1,
        transition: "admission",
        origin:
          kind === "service"
            ? "service_care"
            : kind === "returning"
              ? "returning_command"
              : kind,
        sourceId,
        before: null,
        after: s,
        target,
        source: source(f.contact),
        invalidHistoricalEvidenceRetained: false,
        recordedAt: stamp,
      },
    );
    const context = {
      organizationId: f.org,
      authorizedHistoricalLinks: new Set([
        `contact:${f.contact}`,
        `${target.kind}:${target.id}`,
        `user:${f.owner}`,
      ]),
      availableTargets: new Set<string>(),
    };
    const proof = { context, events: [original, transition], commands };
    const projected = history.projectSchedulingHistory(proof).summaries[0];
    expect(projected).toMatchObject({
      event: "operation_committed",
      target: { ...target, available: false },
      source: source(f.contact),
      after: { minimumTravelGapMinutes: 90, duration: s.duration },
    });
    expect(
      history.closedBusinessSchedulingSummarySchema.parse(
        JSON.parse(JSON.stringify(projected)),
      ),
    ).toEqual(projected);
    expect(
      history.projectSchedulingHistory({
        ...proof,
        events: [{ ...original, entityType: "wrong_original_binding" }],
      }).coverage.withheldInvalidRecords,
    ).toBe(1);
    if (kind === "concierge") {
      await db.insert(auditEventsTable).values([original, transition]);
      const ordinary = await listAuditEvents(f.org, {
        action: original.action,
      });
      expect(ordinary[0].metadata).toMatchObject({
        event: "operation_committed",
        target: { ...target, available: false },
        after: { minimumTravelGapMinutes: 90 },
      });
      const out = await createCustomerLifecycleExporter()(f.org, f.owner);
      expect(
        out.organization.schedulingHistory.find(
          (row) => row.event === "operation_committed",
        ),
      ).toEqual(projected);
      for (const secret of [
        sourceId,
        "sourceFingerprint",
        "schedulingReview",
        "PRIVATE_ADMISSION_ACTOR",
      ])
        expect(
          JSON.stringify(out.organization.schedulingHistory),
        ).not.toContain(secret);
      expect(
        (
          await db
            .select()
            .from(auditEventsTable)
            .where(eq(auditEventsTable.id, original.id))
        )[0],
      ).toEqual(original);
    }
    const text = JSON.stringify(projected);
    for (const secret of [
      requestId,
      sourceId,
      original.id,
      "PRIVATE_ADMISSION_ACTOR",
      "sourceFingerprint",
      "requestFingerprint",
      "payloadSha256",
      "schedulingReview",
      "providerEffect",
    ])
      expect(text).not.toContain(secret);
    expect(
      history.projectSchedulingHistory({
        ...proof,
        events: [{ ...original, metadata: null as never }],
      }),
    ).toEqual({
      summaries: [],
      coverage: {
        count: 0,
        withheldInvalidLinks: 0,
        withheldInvalidRecords: 1,
      },
    });
    const bad = structuredClone(original);
    if (kind === "returning") commands[0].payloadSha256 = "bad";
    else if (kind === "concierge")
      (bad.metadata.offer as Record<string, unknown>).conversationId =
        randomUUID();
    else bad.metadata.requestFingerprint = "0".repeat(64);
    expect(
      history.projectSchedulingHistory({ ...proof, events: [bad], commands })
        .coverage.withheldInvalidRecords,
    ).toBe(1);
    if (kind === "returning") commands[0].payloadSha256 = "e".repeat(64);
    const unrelated = structuredClone(transition);
    unrelated.metadata.sourceId = randomUUID();
    expect(
      history.projectSchedulingHistory({
        ...proof,
        events: [original, unrelated],
        commands,
      }).summaries[0].after,
    ).toBeNull();
  },
);

it.each([
  "ABCDEFAB-1234-4ABC-8ABC-ABCDEFABCDEF",
  "AbCdEfAb-1234-4aBc-8aBc-AbCdEfAbCdEf",
])(
  "projects a retained mixed-case returning request %s through actual source replay without rewriting evidence",
  async (requestId) => {
    const f = await returningCustomerFixture();
    orgs.push(f.org);
    await saveSchedulingPolicy(
      { organizationId: f.org, userId: f.owner.id },
      {
        expectedRevision: 0,
        expectedCompanyTimeZone: f.company.timezone,
        enabled: true,
        minimumTravelGapMinutes: 60,
        maxConcurrentReservations: 2,
        durationPresets: [],
      },
    );
    const original = {
      ...returningProjectDraft(f),
      requestId,
      scheduledStart: stamp,
      scheduledEnd: "2035-01-01T11:00:00.000Z",
      crewUserIds: [f.owner.id],
      schedulingReview: {
        context: await getSchedulingReviewContext(
          { organizationId: f.org, userId: f.owner.id },
          {
            sourceKind: "direct_customer",
            sourceId: f.contact.id,
            propertyId: f.secondProperty.id,
            reservationKind: "project",
          },
        ),
        duration: { kind: "explicit" as const, preset: null },
        startWallTime: null,
        endWallTime: null,
      },
    };
    // Current new-write transition admission requires lowercase. Seed retained original
    // source evidence, as a historical writer could, then exercise its real replay path.
    const canonical = { ...original, requestId: requestId.toLowerCase() };
    const originalHash = customerWorkHash({
      action: "project_created",
      targetId: null,
      input: original,
      actorUserId: f.owner.id,
    });
    const canonicalHash = customerWorkHash({
      action: "project_created",
      targetId: null,
      input: canonical,
      actorUserId: f.owner.id,
    });
    const created = await createCustomerWorkProject(f.org, f.actor, canonical);
    const [audit] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "customer_work.project_created"),
        ),
      );
    await db
      .update(customerWorkCommandsTable)
      .set({ payloadSha256: originalHash })
      .where(
        and(
          eq(customerWorkCommandsTable.organizationId, f.org),
          eq(customerWorkCommandsTable.requestId, requestId),
        ),
      );
    await db
      .update(auditEventsTable)
      .set({ metadata: { ...audit.metadata, requestId } })
      .where(eq(auditEventsTable.id, audit.id));
    const privateEvidence = async () => ({
      commands: (
        await pool.query(
          "SELECT to_jsonb(c)::text AS original FROM customer_work_commands c WHERE organization_id=$1 ORDER BY id",
          [f.org],
        )
      ).rows,
      audits: (
        await pool.query(
          "SELECT id, metadata::text AS original FROM audit_events WHERE organization_id=$1 AND action IN ('customer_work.project_created','scheduling.reservation_transition.v1') ORDER BY id",
          [f.org],
        )
      ).rows,
      snapshot: (
        await pool.query(
          "SELECT scheduling_reservation::text AS original FROM projects WHERE id=$1",
          [created.project.id],
        )
      ).rows,
    });
    const before = await privateEvidence(),
      body = JSON.stringify(original);
    const [command] = await db
      .select()
      .from(customerWorkCommandsTable)
      .where(eq(customerWorkCommandsTable.organizationId, f.org));
    expect(command.requestId).toBe(requestId.toLowerCase());
    expect(command.payloadSha256).toBe(originalHash);
    expect(command.payloadSha256).not.toBe(canonicalHash);
    const replay = await createCustomerWorkProject(f.org, f.actor, original);
    expect(replay.command.duplicate).toBe(true);
    expect(replay.project.id).toBe(created.project.id);
    const ordinary = await listAuditEvents(f.org, {
      action: "customer_work.project_created",
    });
    expect.soft(ordinary).toHaveLength(1);
    expect.soft(ordinary[0]?.metadata).toMatchObject({
      event: "operation_committed",
      target: { kind: "project", id: created.project.id, available: true },
      source: { contactId: f.contact.id },
      after: { target: { kind: "project", id: created.project.id } },
    });
    const out = await createCustomerLifecycleExporter()(f.org, f.owner.id);
    expect
      .soft(
        out.organization.schedulingHistory.find(
          (row) => row.event === "operation_committed",
        ),
      )
      .toMatchObject({
        target: { kind: "project", id: created.project.id, available: true },
        source: { contactId: f.contact.id },
        after: { target: { kind: "project", id: created.project.id } },
      });
    expect.soft(out.manifest.schedulingHistory).toEqual({
      count: 3,
      withheldInvalidLinks: 0,
      withheldInvalidRecords: 0,
    });
    for (const output of [ordinary, out.organization.schedulingHistory]) {
      expect(JSON.stringify(output)).not.toContain(requestId);
      expect(JSON.stringify(output)).not.toContain(requestId.toLowerCase());
      expect(JSON.stringify(output)).not.toContain(command.payloadSha256);
    }
    const originalEvents = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "customer_work.project_created"),
        ),
      );
    const evidence = await db.transaction((tx) =>
      history.readSchedulingAuditEvidence(tx, f.org, originalEvents),
    );
    const wrongActor = {
      ...originalEvents[0],
      actorUserId: f.owner.id.toUpperCase(),
    };
    expect(wrongActor.actorUserId).not.toBe(f.owner.id);
    expect(
      history.projectSchedulingHistory({ ...evidence, events: [wrongActor] })
        .coverage.withheldInvalidRecords,
    ).toBe(1);
    expect(await privateEvidence()).toEqual(before);
    expect(JSON.stringify(original)).toBe(body);
    expect(
      await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.organizationId, f.org)),
    ).toHaveLength(1);
  },
);

it("distinguishes malformed proofs, foreign links, source absence and historical inactive resources in exact coverage", async () => {
  const f = await fixture(),
    foreign = await fixture();
  await db
    .update(usersTable)
    .set({ isActive: false })
    .where(eq(usersTable.id, f.owner));
  const [target] = await db
    .insert(appointmentsTable)
    .values({
      organizationId: foreign.org,
      type: "other",
      scheduledStart: new Date(stamp),
    })
    .returning();
  const foreignTarget = event(
    f.org,
    f.owner,
    history.MANUAL_SCHEDULING_RECEIPT_ACTION,
    "appointment",
    target.id,
    {
      ...receipt(f).metadata!,
      kind: "appointment_create",
      target: { kind: "appointment", id: target.id },
    },
  );
  const foreignSource = {
    ...foreignTarget,
    id: randomUUID(),
    metadata: { ...foreignTarget.metadata, source: source(foreign.contact) },
  };
  const malformed = {
    ...foreignTarget,
    id: randomUUID(),
    metadata: {
      ...foreignTarget.metadata,
      privateProviderToken: "MUST_STAY_PRIVATE",
    },
  };
  const absent = { ...foreignTarget, id: randomUUID(), entityId: randomUUID() };
  absent.metadata = {
    ...foreignTarget.metadata,
    target: { kind: "appointment", id: absent.entityId },
    source: source(randomUUID()),
  };
  const all = [foreignTarget, foreignSource, malformed, absent];
  await db.insert(auditEventsTable).values(all);
  const loaded = await db.transaction((tx) =>
    history.readSchedulingAuditEvidence(tx, f.org, all),
  );
  const result = history.projectSchedulingHistory(loaded);
  expect(result.coverage).toEqual({
    count: 3,
    withheldInvalidLinks: 3,
    withheldInvalidRecords: 1,
  });
  expect(result.summaries[0].target).toBeNull();
  expect(result.summaries[1].source).toBeNull();
  expect(result.summaries[2].target).toEqual({
    kind: "appointment",
    id: absent.entityId,
    available: false,
  });
  expect(result.summaries[2].source).toBeNull();
  expect(JSON.stringify(result)).not.toContain(foreign.contact);
  expect(JSON.stringify(result)).not.toContain(target.id);
  expect(JSON.stringify(result)).not.toContain("MUST_STAY_PRIVATE");
  expect(history.projectSchedulingAudit(foreignTarget)).toMatchObject({
    target: null,
    source: null,
  });
  expect(
    history.projectSchedulingAudit(foreignTarget, {
      ...loaded.context,
      organizationId: foreign.org,
    }),
  ).toBeNull();
});

it.each(["demo", "test"])(
  "guards selected %s participants before every dependent deletion, including malformed original offer.source",
  async (kind) => {
    const f = await fixture();
    await db
      .update(contactsTable)
      .set({ email: "history@demo.mogulforge.dev" })
      .where(eq(contactsTable.id, f.contact));
    const [lead] = await db
      .insert(leadsTable)
      .values({
        organizationId: f.org,
        contactId: f.contact,
        source: "demo-data",
        sourceDetail: "onboarding-test-lead",
      })
      .returning();
    const [audit] = await db
      .insert(auditEventsTable)
      .values({
        organizationId: f.org,
        action: "appointment.booked_concierge",
        entityType: "appointment",
        entityId: randomUUID(),
        metadata: {
          offer: { source: { contactId: f.contact, leadId: lead.id } },
          privateProof: "MALFORMED_RETAINED",
        },
      })
      .returning();
    await expect(
      kind === "demo" ? clearDemoData(f.org) : deleteTestLeads(f.org),
    ).rejects.toMatchObject({ code: "scheduling_history_retained" });
    expect(
      (await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id)))
        .length,
    ).toBe(1);
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, audit.id))
      )[0].metadata,
    ).toEqual(audit.metadata);
  },
);

it.each([false, true])(
  "retains atomic project deletion with rawInvalid=%s and preserves its permanent receipt",
  async (invalid) => {
    const f = await fixture();
    const [lead] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org, contactId: f.contact })
      .returning();
    const id = randomUUID(),
      snapshot = saved({ kind: "project", id });
    const raw = invalid
      ? { ...snapshot, privateFuture: "PRIVATE_INVALID_SNAPSHOT" }
      : snapshot;
    await db.insert(projectsTable).values({
      id,
      organizationId: f.org,
      leadId: lead.id,
      name: "Synthetic deletion",
      schedulingReservation: raw,
    });
    const [original] = await db
      .insert(auditEventsTable)
      .values({
        ...receipt(f, id),
        metadata: {
          ...receipt(f, id).metadata,
          source: {
            sourceKind: "lead",
            leadId: lead.id,
            contactId: f.contact,
            propertyId: null,
            estimateId: null,
          },
        },
      })
      .returning();
    const [task] = await db
      .insert(crmTasksTable)
      .values({
        organizationId: f.org,
        title: "Preserved authored task",
        description: "Original authored plan",
        sourceEvent: `project.invoice_preparation:${id}`,
      })
      .returning();
    expect(await deleteProject(f.org, id)).toBe(true);
    expect(await deleteProject(f.org, id)).toBe(false);
    const [retained] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, history.SCHEDULING_DELETION_ACTION),
        ),
      );
    expect(retained.actorUserId).toBeNull();
    expect(retained.metadata.before).toEqual(invalid ? null : snapshot);
    expect(retained.metadata.rawInvalidEvidence).toEqual(invalid ? raw : null);
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, original.id))
      )[0].metadata,
    ).toEqual(original.metadata);
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.id, task.id))
      )[0],
    ).toMatchObject({
      status: "cancelled",
      description: "Original authored plan",
    });
    const out = await createCustomerLifecycleExporter()(f.org, f.owner);
    expect(
      out.organization.schedulingHistory.some(
        (e) =>
          e.event === "reservation_deleted" &&
          e.target?.id === id &&
          e.target.available === false,
      ),
    ).toBe(true);
    expect(JSON.stringify(out)).not.toContain("PRIVATE_INVALID_SNAPSHOT");
  },
);

it.each(["audit", "task"])(
  "rolls project deletion and retained evidence back on injected %s SQL failure",
  async (kind) => {
    const f = await fixture(),
      [lead] = await db
        .insert(leadsTable)
        .values({ organizationId: f.org, contactId: f.contact })
        .returning(),
      id = randomUUID();
    await db.insert(projectsTable).values({
      id,
      organizationId: f.org,
      leadId: lead.id,
      name: "Synthetic rollback",
    });
    await db.insert(crmTasksTable).values({
      organizationId: f.org,
      title: "Original task",
      sourceEvent: `project.invoice_preparation:${id}`,
    });
    const hook = `qa_schedule_delete_${randomUUID().replaceAll("-", "")}`,
      table = kind === "audit" ? "audit_events" : "crm_tasks",
      op = kind === "audit" ? "INSERT" : "UPDATE";
    await pool.query(
      `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid THEN RAISE EXCEPTION 'Synthetic retention failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${hook} BEFORE ${op} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
    );
    try {
      await expect(deleteProject(f.org, id)).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER ${hook} ON ${table}`);
      await pool.query(`DROP FUNCTION ${hook}()`);
    }
    expect(
      (await db.select().from(projectsTable).where(eq(projectsTable.id, id)))
        .length,
    ).toBe(1);
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(
            and(
              eq(auditEventsTable.organizationId, f.org),
              eq(auditEventsTable.action, history.SCHEDULING_DELETION_ACTION),
            ),
          )
      ).length,
    ).toBe(0);
  },
);

it("preserves the existing invoice hold without fabricating deletion history", async () => {
  const f = await fixture();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: f.org, contactId: f.contact })
    .returning();
  const id = randomUUID(),
    snapshot = saved({ kind: "project", id });
  await db
    .insert(projectsTable)
    .values({
      id,
      organizationId: f.org,
      leadId: lead.id,
      name: "Synthetic invoiced project",
      schedulingReservation: snapshot,
    });
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      organizationId: f.org,
      leadId: lead.id,
      projectId: id,
      createdByUserId: f.owner,
      draftDocument: {
        title: "Synthetic retained invoice",
        currency: "USD",
        issuerName: "Synthetic company",
        issuerAddress: null,
        customerName: "Synthetic customer",
        customerAddress: null,
        dueDate: null,
        notes: null,
        lineItems: [],
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    })
    .returning();
  expect(await deleteProject(f.org, id)).toBe("invoice_history_retained");
  expect(
    (await db.select().from(projectsTable).where(eq(projectsTable.id, id)))[0]
      .schedulingReservation,
  ).toEqual(snapshot);
  expect(
    (
      await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, invoice.id))
    )[0],
  ).toEqual(invoice);
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, history.SCHEDULING_DELETION_ACTION),
        ),
      ),
  ).toHaveLength(0);
});

it("reads current policy provenance, history and reservation fields in one repeatable snapshot", async () => {
  const f = await fixture(),
    actor = { organizationId: f.org, userId: f.owner };
  const input = {
    expectedRevision: 0,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 60,
    maxConcurrentReservations: 2,
    durationPresets: [],
  };
  await saveSchedulingPolicy(actor, input);
  const id = randomUUID(),
    snapshot = saved({ kind: "appointment", id }, [f.owner]);
  await db.insert(appointmentsTable).values({
    id,
    organizationId: f.org,
    contactId: f.contact,
    type: "other",
    scheduledStart: new Date(snapshot.startAt),
    scheduledEnd: new Date(snapshot.endAt),
    assignedUserId: f.owner,
    schedulingReservation: snapshot,
  });
  const foreign = await fixture();
  const [resource] = await db
    .insert(usersTable)
    .values({ organizationId: f.org, role: "office", isActive: false })
    .returning();
  const projectId = randomUUID(),
    projectSnapshot = saved({ kind: "project", id: projectId }, [resource.id]);
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: f.org, contactId: f.contact })
    .returning();
  await db.insert(projectsTable).values({
    id: projectId,
    organizationId: f.org,
    name: "Synthetic retained snapshot",
    leadId: lead.id,
    scheduledStart: new Date(projectSnapshot.startAt),
    scheduledEnd: new Date(projectSnapshot.endAt),
    crewUserIds: [resource.id],
    schedulingReservation: projectSnapshot,
  });
  const original = receipt(f);
  original.entityId = projectId;
  original.metadata = {
    ...original.metadata,
    target: { kind: "project", id: projectId },
  };
  await db.insert(auditEventsTable).values(original);
  let changed = false;
  const exporter = createCustomerLifecycleExporter({
    createClient: () => {
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      const query = client.query.bind(client);
      client.query = (async (config: any) => {
        const result = await query(config);
        if (
          !changed &&
          String(config.text).includes('FROM public."appointments"')
        ) {
          changed = true;
          await saveSchedulingPolicy(actor, {
            ...input,
            expectedRevision: 1,
            minimumTravelGapMinutes: 120,
          });
          await db
            .update(usersTable)
            .set({ isActive: false })
            .where(eq(usersTable.id, f.owner));
        }
        return result;
      }) as typeof client.query;
      return client;
    },
  });
  // Current-manager revocation outside the snapshot must still prevent disclosure.
  await expect(exporter(f.org, f.owner)).rejects.toMatchObject({
    code: "lifecycle_manager_required",
  });
  expect(changed).toBe(true);
  await db
    .update(usersTable)
    .set({ isActive: true })
    .where(eq(usersTable.id, f.owner));
  let changedAgain = false;
  const consistent = createCustomerLifecycleExporter({
    createClient: () => {
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      const query = client.query.bind(client);
      client.query = (async (config: any) => {
        const result = await query(config);
        if (
          !changedAgain &&
          String(config.text).includes('FROM public."appointments"')
        ) {
          changedAgain = true;
          await saveSchedulingPolicy(actor, {
            ...input,
            expectedRevision: 2,
            minimumTravelGapMinutes: 180,
          });
          await deleteProject(f.org, projectId);
          await db
            .update(usersTable)
            .set({ organizationId: foreign.org })
            .where(eq(usersTable.id, resource.id));
        }
        return result;
      }) as typeof client.query;
      return client;
    },
  });
  const out = await consistent(f.org, f.owner);
  expect(out.organization.schedulingPolicy?.revision).toBe(2);
  expect(out.organization.schedulingPolicy?.minimumTravelGapMinutes).toBe(120);
  expect(
    out.organization.schedulingHistory.filter(
      (e) => e.event === "policy_updated",
    ),
  ).toHaveLength(2);
  expect(out.data.appointments[0].scheduling_evidence).toBe("versioned");
  expect(out.data.appointments[0].scheduling_reservation).toMatchObject({
    minimumTravelGapMinutes: 90,
  });
  expect(out.data.projects[0].scheduling_reservation).toMatchObject({
    target: { kind: "project", id: projectId },
    resourceUserIds: [resource.id],
    minimumTravelGapMinutes: 90,
  });
  expect(
    out.organization.schedulingHistory.find(
      (row) => row.event === "operation_committed",
    )?.target,
  ).toEqual({ kind: "project", id: projectId, available: true });
  expect(
    out.organization.schedulingHistory.some(
      (row) => row.event === "reservation_deleted",
    ),
  ).toBe(false);
  const roundTrip = JSON.parse(JSON.stringify(out));
  expect(out.manifest.schedulingHistorySha256).toBe(
    digest(roundTrip.organization.schedulingHistory),
  );
  expect(out.manifest.schedulingPolicySha256).toBe(
    digest(roundTrip.organization.schedulingPolicy),
  );
  const next = await createCustomerLifecycleExporter()(f.org, f.owner);
  expect(next.organization.schedulingPolicy?.revision).toBe(3);
  expect(next.data.projects).toHaveLength(0);
  expect(
    next.organization.schedulingHistory.find(
      (row) => row.event === "operation_committed",
    )?.target,
  ).toEqual({ kind: "project", id: projectId, available: false });
  expect(
    next.organization.schedulingHistory.find(
      (row) => row.event === "reservation_deleted",
    ),
  ).toMatchObject({
    target: { kind: "project", id: projectId, available: false },
    before: null,
    after: null,
  });
  expect(next.manifest.schedulingHistory.withheldInvalidLinks).toBe(1);
  expect(
    (
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, original.id!))
    )[0].metadata,
  ).toEqual(original.metadata);
  const [settings] = await db
    .select()
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, f.org));
  await db
    .update(orgSettingsTable)
    .set({
      schedulingPolicy: {
        ...settings.schedulingPolicy!,
        digest: "0".repeat(64),
      },
    })
    .where(eq(orgSettingsTable.organizationId, f.org));
  const invalid = await createCustomerLifecycleExporter()(f.org, f.owner);
  expect(invalid.organization.schedulingPolicy).toBeNull();
  expect(invalid.manifest.schedulingPolicy).toEqual({ state: "invalid" });
});

it("enforces 2000+1 raw history rows before malformed-record filtering with no partial export audit", async () => {
  const f = await fixture();
  await db.insert(auditEventsTable).values(
    Array.from({ length: 2000 }, () => ({
      organizationId: f.org,
      action: "scheduling.reservation_transition.v1",
      entityType: "appointment",
      metadata: { invalid: true },
    })),
  );
  const accepted = await createCustomerLifecycleExporter()(f.org, f.owner);
  expect(accepted.manifest.schedulingHistory).toEqual({
    count: 0,
    withheldInvalidLinks: 0,
    withheldInvalidRecords: 2000,
  });
  await db.insert(auditEventsTable).values({
    organizationId: f.org,
    action: "scheduling.reservation_transition.v1",
    entityType: "appointment",
    metadata: { invalid: true },
  });
  await expect(
    createCustomerLifecycleExporter()(f.org, f.owner),
  ).rejects.toMatchObject({ status: 413, code: "customer_export_limit" });
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "customer_lifecycle.export_prepared"),
        ),
      ),
  ).toHaveLength(1);
});

it("applies the same row bound to private resource ownership evidence with no partial export", async () => {
  const f = await fixture(),
    id = randomUUID();
  const [resource] = await db
    .insert(usersTable)
    .values({ organizationId: f.org, role: "office", isActive: false })
    .returning();
  const snapshot = saved({ kind: "appointment", id }, [f.owner, resource.id]);
  await db
    .insert(appointmentsTable)
    .values({
      id,
      organizationId: f.org,
      contactId: f.contact,
      type: "other",
      scheduledStart: new Date(snapshot.startAt),
      scheduledEnd: new Date(snapshot.endAt),
      schedulingReservation: snapshot,
    });
  await expect(
    createCustomerLifecycleExporter({ maxRows: 1 })(f.org, f.owner),
  ).rejects.toMatchObject({ status: 413, code: "customer_export_limit" });
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "customer_lifecycle.export_prepared"),
        ),
      ),
  ).toHaveLength(0);
  expect(
    (
      await db
        .select()
        .from(appointmentsTable)
        .where(eq(appointmentsTable.id, id))
    )[0].schedulingReservation,
  ).toEqual(snapshot);
});

it("uses permanent manual refusal for export and the independent random business event for ordinary audit", async () => {
  const f = await fixture(),
    command: ManualSchedulingCommand = {
      operationId: randomUUID(),
      kind: "appointment_create",
      body: { contactId: f.contact, type: "other", scheduledStart: stamp },
      review: review(f.org, f.contact),
    };
  await reconcileManualScheduling(
    { organizationId: f.org, userId: f.owner },
    command,
  );
  const raw = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.organizationId, f.org));
  expect(
    raw.filter((e) => e.action === history.MANUAL_SCHEDULING_RECEIPT_ACTION),
  ).toHaveLength(1);
  expect(
    raw.filter((e) => e.action === history.MANUAL_SCHEDULING_REFUSAL_ACTION),
  ).toHaveLength(1);
  const audit = await listAuditEvents(f.org);
  expect(audit).toHaveLength(1);
  expect(audit[0].action).toBe(history.MANUAL_SCHEDULING_REFUSAL_ACTION);
  expect(audit[0].metadata).toMatchObject({
    event: "operation_refused",
    reasonCode: "original_create_fenced",
  });
  expect(JSON.stringify(audit)).not.toContain(command.operationId);
  const out = await createCustomerLifecycleExporter()(f.org, f.owner);
  expect(out.organization.schedulingHistory).toHaveLength(1);
  expect(out.organization.schedulingHistory[0].event).toBe("operation_refused");
  expect(JSON.stringify(out)).not.toContain(command.operationId);
  expect(
    (
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, command.operationId))
    )[0].metadata,
  ).toEqual(raw.find((e) => e.id === command.operationId)!.metadata);
});

it("refuses combined organization scheduling metadata plus business data above 10 MiB, without an export audit", async () => {
  const org = randomUUID(),
    owner = "synthetic-large-owner",
    contact = randomUUID();
  const policy = {
    formatVersion: 1 as const,
    revision: 1,
    enabled: true,
    timeZone: "UTC",
    minimumTravelGapMinutes: 10,
    maxConcurrentReservations: 2,
    durationPresets: Array.from({ length: 50 }, (_, i) => ({
      id: randomUUID(),
      label: `${i} ${"L".repeat(76)}`,
      elapsedMinutes: 60,
    })),
    digest: "a".repeat(64),
    updatedAt: stamp,
    updatedByUserId: owner,
  };
  const single = event(
    org,
    owner,
    "scheduling.policy_saved",
    "org_settings",
    org,
    { previousPolicy: null, policy },
  );
  const recordCount = Math.floor(
    (8 * 1024 * 1024) /
      Buffer.byteLength(JSON.stringify(history.projectSchedulingAudit(single))),
  );
  expect(recordCount).toBeLessThanOrEqual(2000);
  const events = Array.from({ length: recordCount }, () =>
    event(org, owner, "scheduling.policy_saved", "org_settings", org, {
      previousPolicy: null,
      policy,
    }),
  );
  const business = "B".repeat(3 * 1024 * 1024);
  const projected = events.map((e) => history.projectSchedulingAudit(e));
  const historyBytes = Buffer.byteLength(JSON.stringify(projected));
  expect(historyBytes).toBeLessThan(10 * 1024 * 1024);
  expect(historyBytes + Buffer.byteLength(business)).toBeGreaterThan(
    10 * 1024 * 1024,
  );
  const queries: string[] = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    on: () => {},
    query: async (config: { text: string; values: unknown[] }) => {
      const text = config.text;
      queries.push(text);
      if (text.startsWith("SELECT id FROM public.users"))
        return { rows: [{ id: owner }] };
      if (text.startsWith("SELECT id, name"))
        return {
          rows: [
            {
              id: org,
              name: "Synthetic size limit",
              slug: "synthetic",
              created_at: new Date(0),
              timezone: "UTC",
            },
          ],
        };
      if (text.includes('FROM public."contacts"'))
        return { rows: [{ id: contact, first_name: business }] };
      if (text.includes("action=ANY")) return { rows: events };
      return { rows: [] };
    },
  };
  await expect(
    createCustomerLifecycleExporter({ createClient: () => client as never })(
      org,
      owner,
    ),
  ).rejects.toMatchObject({ status: 413, code: "customer_export_limit" });
  expect(queries.some((q) => q.startsWith("INSERT"))).toBe(false);
});

it.each(['endpoint', 'resources'] as const)('withholds active %s-mismatched protection before export privacy projection', async (mismatch) => {
  const f = await fixture();
  const appointmentId = randomUUID(), projectId = randomUUID();
  const appointmentSnapshot = saved({ kind: 'appointment', id: appointmentId }, [f.owner]);
  const projectSnapshot = saved({ kind: 'project', id: projectId }, [f.owner]);
  const [lead] = await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contact }).returning();
  await db.insert(appointmentsTable).values({ id: appointmentId, organizationId: f.org, contactId: f.contact, type: 'other', status: 'scheduled', scheduledStart: new Date(appointmentSnapshot.startAt), scheduledEnd: new Date(Date.parse(appointmentSnapshot.endAt) + (mismatch === 'endpoint' ? 60000 : 0)), assignedUserId: mismatch === 'resources' ? null : f.owner, schedulingReservation: appointmentSnapshot });
  await db.insert(projectsTable).values({ id: projectId, organizationId: f.org, leadId: lead.id, name: 'Synthetic mismatch', status: 'scheduled', scheduledStart: new Date(projectSnapshot.startAt), scheduledEnd: new Date(Date.parse(projectSnapshot.endAt) + (mismatch === 'endpoint' ? 60000 : 0)), crewUserIds: mismatch === 'resources' ? [] : [f.owner], schedulingReservation: projectSnapshot });
  const out = await createCustomerLifecycleExporter()(f.org, f.owner);
  for (const table of ['appointments', 'projects'] as const) {
    expect(out.data[table][0]).toMatchObject({ scheduling_evidence: 'invalid', scheduling_reservation: null });
    expect(out.data[table][0]).not.toHaveProperty('_schedulingResources');
  }
  expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, appointmentId)))[0].schedulingReservation).toEqual(appointmentSnapshot);
  expect((await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)))[0].schedulingReservation).toEqual(projectSnapshot);
  // Terminal work retains legitimate historical snapshots even after dates/staff change.
  await db.update(appointmentsTable).set({ status: 'completed' }).where(eq(appointmentsTable.id, appointmentId));
  await db.update(projectsTable).set({ status: 'completed' }).where(eq(projectsTable.id, projectId));
  const terminal = await createCustomerLifecycleExporter()(f.org, f.owner);
  expect(terminal.data.appointments[0].scheduling_evidence).toBe('versioned');
  expect(terminal.data.projects[0].scheduling_evidence).toBe('versioned');
});
