import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
  projectsTable,
  appointmentsTable,
  pool,
} from "@workspace/db";
import type { ManualSchedulingCommand } from "@workspace/scheduling-core";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  deleteContact,
  deleteProject,
  updateContact,
  updateProject,
  listAuditEvents,
} from "./crm";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";
import {
  returningCustomerFixture,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import { callieOfficeFixture } from "../test-helpers/callie-office-fixture";
import { createCustomerWorkProject } from "./returning-customer";
import { createServiceObligation } from "./service-obligations";
import {
  bookServiceCareVisit,
  getServiceCare,
  recordServiceCareResponse,
} from "./service-care";
import { bookCallieVisit, getCallieSchedulingContext } from "./callie-office";
import { clearDemoData } from "./demo-data";
import { deleteTestLeads } from "./onboarding";
import {
  createManualScheduledAppointment,
  createManualScheduledProject,
} from "./manual-scheduling";
import { reconcileManualScheduling } from "./manual-scheduling-receipt";
import {
  getSchedulingReviewContext,
  saveSchedulingPolicy,
  schedulingTargetFingerprint,
} from "./scheduling-policy";

const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
type Cleanup = "contact" | "demo" | "test";
async function fixture(kind: Cleanup = "contact", project = false) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic retention PG contention",
      slug: `history-race-${randomUUID()}`,
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
  const actor = { organizationId: org.id, userId: owner.id };
  await saveSchedulingPolicy(actor, {
    expectedRevision: 0,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 30,
    maxConcurrentReservations: null,
    durationPresets: [],
  });
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Synthetic retained participant",
      email: kind === "demo" ? "selected@demo.mogulforge.dev" : null,
    })
    .returning();
  const lead =
    kind === "test" || project
      ? (
          await db
            .insert(leadsTable)
            .values({
              organizationId: org.id,
              contactId: contact.id,
              sourceDetail: kind === "test" ? "onboarding-test-lead" : null,
            })
            .returning()
        )[0]
      : null;
  const context = await getSchedulingReviewContext(actor, {
    sourceKind: lead ? "lead" : "direct_customer",
    sourceId: lead?.id ?? contact.id,
    reservationKind: project ? "project" : "appointment",
    ...(project ? {} : { appointmentType: "other" as const }),
  });
  const interval = {
    scheduledStart: "2035-01-01T10:00:00.000Z",
    scheduledEnd: "2035-01-01T11:00:00.000Z",
  };
  const review = {
    context,
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  };
  const command: ManualSchedulingCommand = project
    ? {
        operationId: randomUUID(),
        kind: "project_create",
        review,
        body: {
          leadId: lead!.id,
          name: "Synthetic retained project",
          ...interval,
        },
      }
    : {
        operationId: randomUUID(),
        kind: "appointment_create",
        review,
        body: {
          ...(lead ? { leadId: lead.id } : { contactId: contact.id }),
          type: "other",
          ...interval,
        },
      };
  return { org: org.id, actor, contact: contact.id, lead: lead?.id, command };
}
type F = Awaited<ReturnType<typeof fixture>>;
const cleanup = (f: F, kind: Cleanup) =>
  kind === "contact"
    ? deleteContact(f.org, f.contact)
    : kind === "demo"
      ? clearDemoData(f.org)
      : deleteTestLeads(f.org);
async function blockedBy(pid: number) {
  for (let i = 0; i < 200; i++) {
    const r = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND datname=current_database()",
      [pid],
    );
    if (r.rows[0]) return Number(r.rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Independent PostgreSQL retention waiter not observed");
}
async function barrier(
  table: "audit_events" | "contacts" | "leads" | "projects",
  org: string,
  operation: "INSERT" | "UPDATE" | "DELETE",
  condition = "true",
) {
  const hook = `qa_history_${randomUUID().replaceAll("-", "")}`,
    keeper = await pool.connect(),
    record = operation === "DELETE" ? "OLD" : "NEW";
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${record}.organization_id='${org}'::uuid AND (${condition}) THEN PERFORM pg_advisory_xact_lock(hashtext('${hook}')); END IF; RETURN ${record}; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
  );
  await keeper.query("BEGIN");
  await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hook]);
  const pid = Number(
    (await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
  );
  return {
    pid,
    release: () => keeper.query("COMMIT"),
    cleanup: async (pending: Promise<unknown>[]) => {
      await keeper.query("ROLLBACK");
      keeper.release();
      await Promise.allSettled(pending);
      await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`);
      await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
    },
  };
}
function observed<T extends Promise<unknown>>(
  promise: T,
  pending: Promise<unknown>[],
): T {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}
function proof(label: string, pids: number[]) {
  expect(new Set(pids).size).toBe(3);
  console.info(
    "SCHEDULING_RETENTION_PG_BARRIER",
    JSON.stringify({ label, pids }),
  );
}

it.each(
  (["contact", "demo", "test"] as const).flatMap((kind) =>
    [false, true].map((cleanupFirst) => ({ kind, cleanupFirst })),
  ),
)(
  "serializes actual $kind cleanup and native CREATE cleanupFirst=$cleanupFirst",
  async ({ kind, cleanupFirst }) => {
    const f = await fixture(kind),
      pending: Promise<unknown>[] = [],
      gate = cleanupFirst
        ? await barrier(kind === "test" ? "leads" : "contacts", f.org, "DELETE")
        : await barrier(
            "audit_events",
            f.org,
            "INSERT",
            "NEW.action='scheduling.manual_operation.v1'",
          );
    try {
      const first = observed(
        cleanupFirst
          ? cleanup(f, kind)
          : createManualScheduledAppointment(f.actor, f.command),
        pending,
      );
      const firstPid = await blockedBy(gate.pid);
      const second = observed(
        cleanupFirst
          ? createManualScheduledAppointment(f.actor, f.command)
          : cleanup(f, kind),
        pending,
      );
      const secondPid = await blockedBy(firstPid);
      proof(`${kind}/create/cleanupFirst=${cleanupFirst}`, [
        gate.pid,
        firstPid,
        secondPid,
      ]);
      await gate.release();
      await first;
      if (cleanupFirst) {
        await Promise.allSettled([second]);
        expect(
          await db
            .select()
            .from(appointmentsTable)
            .where(eq(appointmentsTable.organizationId, f.org)),
        ).toHaveLength(0);
        const receipts = await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, f.command.operationId));
        expect(
          receipts.every((row) => row.metadata.outcome !== "committed"),
        ).toBe(true);
      } else {
        await expect(second).rejects.toMatchObject({
          code: "scheduling_history_retained",
        });
        expect(
          await db
            .select()
            .from(contactsTable)
            .where(eq(contactsTable.id, f.contact)),
        ).toHaveLength(1);
        expect(
          (
            await db
              .select()
              .from(auditEventsTable)
              .where(eq(auditEventsTable.id, f.command.operationId))
          )[0].metadata.outcome,
        ).toBe("committed");
      }
    } finally {
      await gate.cleanup(pending);
    }
  },
);

it.each(["contact", "demo", "test"] as const)(
  "retains terminal refusal before actual %s cleanup",
  async (kind) => {
    const f = await fixture(kind),
      pending: Promise<unknown>[] = [],
      gate = await barrier(
        "audit_events",
        f.org,
        "INSERT",
        "NEW.action='scheduling.manual_operation.v1'",
      );
    try {
      const refusing = observed(
          reconcileManualScheduling(f.actor, f.command),
          pending,
        ),
        first = await blockedBy(gate.pid);
      const cleaning = observed(cleanup(f, kind), pending),
        second = await blockedBy(first);
      proof(`${kind}/refusal-first`, [gate.pid, first, second]);
      await gate.release();
      expect((await refusing).outcome).toBe("no_commit_refused");
      await expect(cleaning).rejects.toMatchObject({
        code: "scheduling_history_retained",
      });
      expect(
        (
          await db
            .select()
            .from(auditEventsTable)
            .where(eq(auditEventsTable.id, f.command.operationId))
        )[0].metadata.refusalCode,
      ).toBe("original_create_fenced");
    } finally {
      await gate.cleanup(pending);
    }
  },
);

it.each(["contact", "demo", "test"] as const)(
  "retains a non-creating fence after actual %s cleanup wins",
  async (kind) => {
    const f = await fixture(kind),
      pending: Promise<unknown>[] = [],
      gate = await barrier(
        kind === "test" ? "leads" : "contacts",
        f.org,
        "DELETE",
      );
    try {
      const cleaning = observed(cleanup(f, kind), pending),
        first = await blockedBy(gate.pid);
      const refusing = observed(
          reconcileManualScheduling(f.actor, f.command),
          pending,
        ),
        second = await blockedBy(first);
      proof(`${kind}/cleanup-first/refusal`, [gate.pid, first, second]);
      await gate.release();
      await cleaning;
      const ack = await refusing;
      expect(ack).toMatchObject({
        outcome: "no_commit_refused",
        target: null,
        refusalCode: "original_create_fenced",
      });
      expect(
        await db
          .select()
          .from(contactsTable)
          .where(eq(contactsTable.id, f.contact)),
      ).toHaveLength(0);
      const receipts = await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, f.command.operationId));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].metadata.outcome).toBe("no_commit_refused");
      expect(
        await db
          .select()
          .from(appointmentsTable)
          .where(eq(appointmentsTable.organizationId, f.org)),
      ).toHaveLength(0);
      expect(await reconcileManualScheduling(f.actor, f.command)).toEqual(ack);
    } finally {
      await gate.cleanup(pending);
    }
  },
);

async function sourceFixture(kind: "returning" | "service" | "callie") {
  const f =
    kind === "callie"
      ? await callieOfficeFixture(true)
      : await returningCustomerFixture();
  orgs.push(f.org);
  const actor = { organizationId: f.org, userId: f.owner.id };
  const [org] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.id, f.org));
  await saveSchedulingPolicy(actor, {
    expectedRevision: 0,
    expectedCompanyTimeZone: org.timezone,
    enabled: true,
    minimumTravelGapMinutes: 60,
    maxConcurrentReservations: 2,
    durationPresets: [],
  });
  const interval = {
    scheduledStart: "2037-06-15T14:00:00.000Z",
    scheduledEnd: "2037-06-15T15:00:00.000Z",
  };
  const reviewed = (
    context: Awaited<ReturnType<typeof getSchedulingReviewContext>>,
  ) => ({
    context,
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  });
  if (kind === "callie" && "intake" in f) {
    const read = await getCallieSchedulingContext(
      f.org,
      f.owner.id,
      f.intake.id,
      { appointmentType: "other", propertyId: f.property.id },
    );
    if (read.review.state !== "ready")
      throw Error("Expected synthetic CALLIE review");
    const input = {
      requestId: randomUUID(),
      expectedVersion: read.expectedVersion,
      expectedFingerprint: read.expectedFingerprint,
      contactId: f.contact.id,
      leadId: read.source!.leadId,
      propertyId: f.property.id,
      assignedUserId: f.office.id,
      type: "other",
      ...interval,
      confirmationNote: "Synthetic confirmed customer interval.",
      customerConfirmed: true,
      schedulingReview: reviewed(read.review.context),
    };
    return {
      org: f.org,
      owner: f.owner.id,
      contact: f.contact.id,
      action: "voice.callie.visit_booked",
      requestId: input.requestId,
      book: () => bookCallieVisit(f.org, f.owner.id, f.intake.id, input),
    };
  }
  if (!("firstProperty" in f))
    throw Error("Expected synthetic customer fixture");
  if (kind === "returning") {
    const context = await getSchedulingReviewContext(actor, {
      sourceKind: "direct_customer",
      sourceId: f.contact.id,
      propertyId: f.secondProperty.id,
      reservationKind: "project",
    });
    const input = {
      ...returningProjectDraft(f),
      ...interval,
      crewUserIds: [f.owner.id],
      schedulingReview: reviewed(context),
    };
    return {
      org: f.org,
      owner: f.owner.id,
      contact: f.contact.id,
      action: "customer_work.project_created",
      requestId: input.requestId,
      book: () => createCustomerWorkProject(f.org, f.actor, input),
    };
  }
  const service = await createServiceObligation(f.org, f.owner.id, {
    contactId: f.contact.id,
    propertyId: f.firstProperty.id,
    kind: "maintenance",
    equipmentLabel: "Synthetic unit",
    dueDate: "2037-06-15",
    noticeDays: 14,
    assignedUserId: f.owner.id,
  });
  if ("error" in service) throw Error(service.error);
  const response = await recordServiceCareResponse(
    f.org,
    f.owner.id,
    service.id,
    {
      requestId: randomUUID(),
      expectedUpdatedAt: service.updatedAt.toISOString(),
      channel: "phone",
      outcome: "ready_to_book",
      respondedAt: new Date(Date.now() - 1000).toISOString(),
      note: "Synthetic customer confirmed the reviewed interval.",
      staffAttested: true,
    },
  );
  const care = await getServiceCare(f.org, service.id, "email", {
    actorUserId: f.owner.id,
    appointmentType: "other",
  });
  if (care.scheduling.review.state !== "ready")
    throw Error("Expected synthetic service review");
  const input = {
    requestId: randomUUID(),
    expectedUpdatedAt: care.expectedUpdatedAt,
    responseId: response.responseId,
    assignedUserId: f.owner.id,
    ...interval,
    type: "other",
    customerConfirmed: true,
    schedulingReview: reviewed(care.scheduling.review.context),
  };
  return {
    org: f.org,
    owner: f.owner.id,
    contact: f.contact.id,
    action: "service.care_visit_booked",
    requestId: input.requestId,
    book: () => bookServiceCareVisit(f.org, f.owner.id, service.id, input),
  };
}

it.each(
  (["returning", "service", "callie"] as const).flatMap((kind) =>
    [false, true].map((cleanupFirst) => ({ kind, cleanupFirst })),
  ),
)(
  "serializes actual $kind source writer and contact cleanup cleanupFirst=$cleanupFirst",
  async ({ kind, cleanupFirst }) => {
    const f = await sourceFixture(kind),
      pending: Promise<unknown>[] = [],
      gate = cleanupFirst
        ? await barrier("contacts", f.org, "DELETE")
        : await barrier(
            "audit_events",
            f.org,
            "INSERT",
            `NEW.action='${f.action}'`,
          );
    try {
      const first = observed(
          cleanupFirst ? deleteContact(f.org, f.contact) : f.book(),
          pending,
        ),
        firstPid = await blockedBy(gate.pid);
      const second = observed(
          cleanupFirst ? f.book() : deleteContact(f.org, f.contact),
          pending,
        ),
        secondPid = await blockedBy(firstPid);
      proof(`${kind}/source/cleanupFirst=${cleanupFirst}`, [
        gate.pid,
        firstPid,
        secondPid,
      ]);
      await gate.release();
      if (cleanupFirst) {
        // These source fixtures retain canonical properties. The earlier foreign-key
        // hold remains authoritative when cleanup obtains the lifecycle lock first.
        await expect(first).rejects.toMatchObject({
          cause: {
            code: "23503",
            constraint: "properties_contact_id_contacts_id_fk",
          },
        });
        await second;
      } else {
        await first;
        await expect(second).rejects.toMatchObject({
          code: "scheduling_history_retained",
        });
      }
      const [raw] = await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, f.org),
            eq(auditEventsTable.action, f.action),
          ),
        );
      const ordinary = await listAuditEvents(f.org, { action: f.action });
      expect(ordinary).toHaveLength(1);
      expect(ordinary[0].metadata).toMatchObject({
        event: "operation_committed",
        target: { available: true },
        after: { minimumTravelGapMinutes: 60 },
      });
      expect(JSON.stringify(ordinary)).not.toContain(f.requestId);
      expect(ordinary[0].actorUserId).toBeNull();
      const out = await createCustomerLifecycleExporter()(f.org, f.owner);
      const committed = out.organization.schedulingHistory.find(
        (row) => row.event === "operation_committed",
      );
      expect(committed).toMatchObject({
        target: { available: true },
        source: { contactId: f.contact },
        after: { minimumTravelGapMinutes: 60 },
      });
      expect(JSON.stringify(out.organization.schedulingHistory)).not.toContain(
        f.requestId,
      );
      const table = kind === "returning" ? "projects" : "appointments";
      expect(out.data[table][0].scheduling_evidence).toBe("versioned");
      expect(out.data[table][0].scheduling_reservation).toMatchObject({
        minimumTravelGapMinutes: 60,
      });
      expect(
        (
          await db
            .select()
            .from(auditEventsTable)
            .where(eq(auditEventsTable.id, raw.id))
        )[0],
      ).toEqual(raw);
      if (kind === "returning") {
        await expect(deleteProject(f.org, raw.entityId!)).rejects.toMatchObject(
          { code: "customer_work_history_retained" },
        );
        expect(
          await db
            .select()
            .from(auditEventsTable)
            .where(
              and(
                eq(auditEventsTable.organizationId, f.org),
                eq(
                  auditEventsTable.action,
                  "scheduling.reservation_deleted.v1",
                ),
              ),
            ),
        ).toHaveLength(0);
      }
      expect(
        await db
          .select()
          .from(contactsTable)
          .where(eq(contactsTable.id, f.contact)),
      ).toHaveLength(1);
    } finally {
      await gate.cleanup(pending);
    }
  },
);

it.each([false, true])(
  "serializes actual project update/delete deleteFirst=%s with original custody retained",
  async (deleteFirst) => {
    const f = await fixture("contact", true),
      created = await createManualScheduledProject(f.actor, f.command),
      id = created.ack.target!.id;
    const [row] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    const update = () =>
      updateProject(
        f.org,
        id,
        {
          crewNotes: "Preserved authored work note",
          expectedUpdatedAt: row.updatedAt,
          expectedTargetFingerprint: schedulingTargetFingerprint(
            "project",
            row,
          ),
        },
        f.actor,
      );
    const pending: Promise<unknown>[] = [],
      gate = deleteFirst
        ? await barrier(
            "audit_events",
            f.org,
            "INSERT",
            "NEW.action='scheduling.reservation_deleted.v1'",
          )
        : await barrier("projects", f.org, "UPDATE");
    try {
      const first = observed(
          deleteFirst ? deleteProject(f.org, id) : update(),
          pending,
        ),
        firstPid = await blockedBy(gate.pid);
      const second = observed(
          deleteFirst ? update() : deleteProject(f.org, id),
          pending,
        ),
        secondPid = await blockedBy(firstPid);
      proof(`project/update/deleteFirst=${deleteFirst}`, [
        gate.pid,
        firstPid,
        secondPid,
      ]);
      await gate.release();
      await first;
      await second;
      expect(
        await db.select().from(projectsTable).where(eq(projectsTable.id, id)),
      ).toHaveLength(0);
      const original = await reconcileManualScheduling(f.actor, f.command);
      expect(original.target).toEqual({
        kind: "project",
        id,
        available: false,
      });
      expect(original.outcome).toBe("committed");
      expect(
        await db
          .select()
          .from(auditEventsTable)
          .where(
            and(
              eq(auditEventsTable.organizationId, f.org),
              eq(auditEventsTable.action, "scheduling.reservation_deleted.v1"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await gate.cleanup(pending);
    }
  },
);

it("reconciliation waits for atomic deletion and returns original committed-unavailable", async () => {
  const f = await fixture("contact", true),
    created = await createManualScheduledProject(f.actor, f.command),
    id = created.ack.target!.id,
    pending: Promise<unknown>[] = [],
    gate = await barrier(
      "audit_events",
      f.org,
      "INSERT",
      "NEW.action='scheduling.reservation_deleted.v1'",
    );
  try {
    const deleting = observed(deleteProject(f.org, id), pending),
      first = await blockedBy(gate.pid);
    const reconciling = observed(
        reconcileManualScheduling(f.actor, f.command),
        pending,
      ),
      second = await blockedBy(first);
    proof("project/delete/reconcile", [gate.pid, first, second]);
    await gate.release();
    await deleting;
    expect(await reconciling).toMatchObject({
      operationId: f.command.operationId,
      outcome: "committed",
      target: { kind: "project", id, available: false },
    });
  } finally {
    await gate.cleanup(pending);
  }
});

it("deletes only checked demo IDs when a retained unselected contact enters the predicate during deletion", async () => {
  const f = await fixture("demo"),
    [other] = await db
      .insert(contactsTable)
      .values({
        organizationId: f.org,
        firstName: "Retained unselected",
        email: "private@example.test",
      })
      .returning();
  const [audit] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      action: "scheduling.manual_operation.v1",
      entityType: "appointment",
      metadata: { source: { contactId: other.id }, malformedOriginal: true },
    })
    .returning();
  const pending: Promise<unknown>[] = [],
    gate = await barrier("contacts", f.org, "DELETE");
  try {
    const cleaning = observed(clearDemoData(f.org), pending);
    await blockedBy(gate.pid);
    await updateContact(f.org, other.id, {
      email: "entered@demo.mogulforge.dev",
    });
    await gate.release();
    expect(await cleaning).toEqual({ contacts: 1, leads: 0 });
    expect(
      await db
        .select()
        .from(contactsTable)
        .where(eq(contactsTable.id, other.id)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, audit.id))
      )[0].metadata,
    ).toEqual(audit.metadata);
  } finally {
    await gate.cleanup(pending);
  }
});
