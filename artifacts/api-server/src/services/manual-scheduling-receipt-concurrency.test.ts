import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  db,
  organizationsTable,
  pool,
  scheduledActionsTable,
  usersTable,
} from "@workspace/db";
import type { ManualSchedulingCommand } from "@workspace/scheduling-core";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  assertSchedulingActor,
  lockSchedulingConfiguration,
} from "./scheduling-policy";
import type { ScheduleTransaction } from "./contractor-scheduling";
import {
  reconcileManualScheduling,
  runManualSchedulingCreate,
} from "./manual-scheduling-receipt";

const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic receipt race",
      slug: `receipt-race-${randomUUID()}`,
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
  return { org: org.id, actor, command };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function blockedBy(pid: number) {
  for (let i = 0; i < 180; i++) {
    const { rows } = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if (rows.length) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Independent PostgreSQL waiter was not observed");
}
async function native(tx: ScheduleTransaction, f: Fixture) {
  const [row] = await tx
    .insert(appointmentsTable)
    .values({
      organizationId: f.org,
      scheduledStart: new Date("2035-01-02T10:00:00Z"),
      type: "other",
    })
    .returning();
  await tx
    .insert(scheduledActionsTable)
    .values({
      organizationId: f.org,
      action: {
        type: "appointment_reminder",
        params: { appointmentId: row.id },
      },
      runAt: new Date("2035-01-01T10:00:00Z"),
    });
  await tx
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      action: "appointment.created",
      entityType: "appointment",
      entityId: row.id,
    });
  return { kind: "appointment" as const, id: row.id };
}
async function create(
  f: Fixture,
  callback: (tx: ScheduleTransaction) => ReturnType<typeof native>,
) {
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, f.org);
    await assertSchedulingActor(tx, f.actor, "crm.write");
    return runManualSchedulingCreate(tx, f.actor, f.command, callback);
  });
}
async function count(f: Fixture) {
  return {
    targets: (
      await db
        .select()
        .from(appointmentsTable)
        .where(eq(appointmentsTable.organizationId, f.org))
    ).length,
    reminders: (
      await db
        .select()
        .from(scheduledActionsTable)
        .where(eq(scheduledActionsTable.organizationId, f.org))
    ).length,
    events: (
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.organizationId, f.org))
    )
      .map((row) => row.action)
      .sort(),
  };
}
it.each(["reconcile", "duplicate-create", "other-tenant"] as const)(
  "CREATE first blocks independent %s and retains one original",
  async (contender) => {
    const f = await fixture(),
      entered = latch(),
      finish = latch();
    let pid = 0,
      calls = 0;
    const first = create(f, async (tx) => {
      calls++;
      pid = Number(
        (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid,
      );
      const target = await native(tx, f);
      entered.release();
      await finish.promise;
      return target;
    });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first]);
      if (contender === "duplicate-create")
        second = create(f, async (tx) => {
          calls++;
          return native(tx, f);
        });
      else if (contender === "other-tenant") {
        const other = await fixture();
        other.command.operationId = f.command.operationId;
        second = reconcileManualScheduling(other.actor, other.command);
      } else second = reconcileManualScheduling(f.actor, f.command);
      void second.catch(() => {});
      const otherPid = await blockedBy(pid);
      expect(otherPid).not.toBe(pid);
      finish.release();
      const result = await first;
      if (contender === "other-tenant")
        await expect(second).rejects.toMatchObject({
          code: "operation_identity_conflict",
        });
      else
        expect(await second).toEqual(
          contender === "duplicate-create"
            ? { ack: result.ack, newlyCreated: false }
            : result.ack,
        );
      expect(calls).toBe(1);
      expect(await count(f)).toEqual({
        targets: 1,
        reminders: 1,
        events: ["appointment.created", "scheduling.manual_operation.v1"],
      });
    } finally {
      finish.release();
      await Promise.allSettled([first, second]);
    }
  },
);
it("reconciliation first fences delayed CREATE on separate observed PostgreSQL sessions", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  let reconciliation: ReturnType<typeof reconcileManualScheduling> | undefined,
    delayed: ReturnType<typeof create> | undefined,
    calls = 0;
  try {
    await blocker.query("BEGIN");
    const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.actor.userId,
    ]);
    reconciliation = reconcileManualScheduling(f.actor, f.command);
    void reconciliation.catch(() => {});
    const reconciliationPid = await blockedBy(Number(rows[0].pid));
    delayed = create(f, async (tx) => {
      calls++;
      return native(tx, f);
    });
    void delayed.catch(() => {});
    const delayedPid = await blockedBy(reconciliationPid);
    expect(
      new Set([Number(rows[0].pid), reconciliationPid, delayedPid]).size,
    ).toBe(3);
    await blocker.query("COMMIT");
    const ack = await reconciliation;
    expect(ack).toMatchObject({
      outcome: "no_commit_refused",
      refusalCode: "original_create_fenced",
    });
    expect(await delayed).toEqual({ ack, newlyCreated: false });
    expect(calls).toBe(0);
    expect(await count(f)).toEqual({
      targets: 0,
      reminders: 0,
      events: [
        "scheduling.manual_operation.v1",
        "scheduling.operation_refused.v1",
      ],
    });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.allSettled([reconciliation, delayed]);
  }
});
it("global operation lock timeout produces no terminal proof and does not steal the pending operation", async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  let pending: ReturnType<typeof reconcileManualScheduling> | undefined;
  try {
    await blocker.query("BEGIN");
    const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`manual-scheduling:${f.command.operationId}`],
    );
    pending = reconcileManualScheduling(f.actor, f.command);
    void pending.catch(() => {});
    expect(await blockedBy(Number(rows[0].pid))).not.toBe(Number(rows[0].pid));
    const error = await pending.catch((error) => error);
    expect(error.code ?? error.cause?.code).toBe("55P03");
    expect(await count(f)).toEqual({ targets: 0, reminders: 0, events: [] });
    await blocker.query("COMMIT");
    const result = await create(f, (tx) => native(tx, f));
    expect(result.ack.outcome).toBe("committed");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.allSettled([pending]);
  }
});
it("CREATE rollback releases its pending lock; waiting reconciliation commits only a no-create fence", async () => {
  const f = await fixture(),
    entered = latch(),
    finish = latch();
  let pid = 0;
  const first = create(f, async (tx) => {
    pid = Number(
      (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid,
    );
    await native(tx, f);
    entered.release();
    await finish.promise;
    throw Error("Synthetic transaction failure, not refusal");
  });
  void first.catch(() => {});
  let second: ReturnType<typeof reconcileManualScheduling> | undefined;
  try {
    await Promise.race([entered.promise, first]);
    second = reconcileManualScheduling(f.actor, f.command);
    void second.catch(() => {});
    expect(await blockedBy(pid)).not.toBe(pid);
    finish.release();
    await expect(first).rejects.toThrow("Synthetic transaction failure");
    expect(await second).toMatchObject({
      outcome: "no_commit_refused",
      refusalCode: "original_create_fenced",
    });
    expect(await count(f)).toEqual({
      targets: 0,
      reminders: 0,
      events: [
        "scheduling.manual_operation.v1",
        "scheduling.operation_refused.v1",
      ],
    });
  } finally {
    finish.release();
    await Promise.allSettled([first, second]);
  }
});
