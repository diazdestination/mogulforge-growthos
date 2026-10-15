import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import {
  db,
  pool,
  organizationsTable,
  usersTable,
  appointmentsTable,
  projectsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as crm from "./crm";
import * as policy from "./scheduling-policy";
import {
  createManualScheduledAppointment,
  createManualScheduledProject,
} from "./manual-scheduling";
import type { ManualSchedulingCommand } from "@workspace/scheduling-core";
const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture(cap: number | null = null) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic native PG contenders",
      slug: randomUUID(),
      timezone: "UTC",
    })
    .returning();
  orgs.push(org.id);
  const [owner, tech] = await db
    .insert(usersTable)
    .values([
      { organizationId: org.id, role: "owner" },
      { organizationId: org.id, role: "office" },
    ])
    .returning();
  const actor = { organizationId: org.id, userId: owner.id };
  const input = {
    expectedRevision: 0,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 60,
    maxConcurrentReservations: cap,
    durationPresets: [],
  };
  await policy.saveSchedulingPolicy(actor, input);
  const contact = await crm.createContact(org.id, { firstName: "Synthetic" });
  const lead = (await crm.createLead(org.id, { contactId: contact.id }))!;
  return {
    org: org.id,
    actor,
    owner: owner.id,
    tech: tech.id,
    lead: lead.id,
    input,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
type Kind = "appointment" | "project";
async function command(
  f: F,
  kind: Kind,
  minute: number,
  staff: string[],
): Promise<ManualSchedulingCommand> {
  const context = await policy.getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: f.lead,
    reservationKind: kind,
    ...(kind === "appointment"
      ? { appointmentType: "production" as const }
      : {}),
  });
  const interval = {
    scheduledStart: new Date(Date.UTC(2035, 0, 1, 0, minute)).toISOString(),
    scheduledEnd: new Date(Date.UTC(2035, 0, 1, 0, minute + 60)).toISOString(),
  };
  const review = {
    context,
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  };
  return kind === "appointment"
    ? {
        kind: "appointment_create",
        operationId: randomUUID(),
        review,
        body: {
          ...interval,
          type: "production",
          leadId: f.lead,
          assignedUserId: staff[0],
        },
      }
    : {
        kind: "project_create",
        operationId: randomUUID(),
        review,
        body: {
          ...interval,
          name: "Synthetic crew",
          leadId: f.lead,
          crewUserIds: staff,
        },
      };
}
const create = async (f: F, c: ManualSchedulingCommand) =>
  c.kind === "appointment_create"
    ? createManualScheduledAppointment(f.actor, c)
    : createManualScheduledProject(f.actor, c);
async function blockedBy(pid: number, pattern = "%") {
  for (let i = 0; i < 200; i++) {
    const r = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",
      [pid, pattern],
    );
    if (r.rows[0]) return Number(r.rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Independent PostgreSQL writer barrier was not observed");
}
async function barrier(table: string, org: string, timing = "BEFORE INSERT") {
  const hook = `qa_admission_${randomUUID().replaceAll("-", "")}`,
    key = hook,
    keeper = await pool.connect();
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${org}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtext('${key}')); END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
  );
  await keeper.query("BEGIN");
  await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
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
function observe<T>(promise: Promise<T>, pending: Promise<unknown>[]) {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}
const pairs = (["appointment", "project"] as const).flatMap((a) =>
  (["appointment", "project"] as const).flatMap((b) =>
    [false, true].map((reverse) => ({ a, b, reverse })),
  ),
);
it.each(pairs)(
  "serializes real $a/$b travel contenders reverse=$reverse",
  async ({ a, b, reverse }) => {
    const f = await fixture(),
      staffA = a === "project" ? [f.owner, f.tech] : [f.tech],
      staffB = b === "project" ? [f.tech, f.owner] : [f.tech];
    const first = await command(f, a, reverse ? 690 : 600, staffA),
      second = await command(f, b, reverse ? 600 : 690, staffB),
      pending: Promise<unknown>[] = [],
      hold = await barrier(
        a === "appointment" ? "appointments" : "projects",
        f.org,
      );
    try {
      const original = observe(create(f, first), pending),
        firstPid = await blockedBy(hold.pid, "%insert into%");
      const contender = observe(create(f, second), pending),
        secondPid = await blockedBy(firstPid, "%pg_advisory_xact_lock%");
      expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
      await hold.release();
      expect((await original).ack.outcome).toBe("committed");
      expect((await contender).ack).toMatchObject({
        outcome: "no_commit_refused",
        refusalCode: "travel_conflict",
      });
    } finally {
      await hold.cleanup(pending);
    }
  },
  30000,
);
it.each(pairs)(
  "serializes real $a/$b company contenders reverse=$reverse",
  async ({ a, b, reverse }) => {
    const f = await fixture(1),
      first = await command(f, a, 600, [reverse ? f.tech : f.owner]),
      second = await command(f, b, 600, [reverse ? f.owner : f.tech]),
      pending: Promise<unknown>[] = [],
      hold = await barrier(
        a === "appointment" ? "appointments" : "projects",
        f.org,
      );
    try {
      const original = observe(create(f, first), pending),
        firstPid = await blockedBy(hold.pid, "%insert into%"),
        contender = observe(create(f, second), pending),
        secondPid = await blockedBy(firstPid, "%pg_advisory_xact_lock%");
      expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
      await hold.release();
      expect((await original).ack.outcome).toBe("committed");
      expect((await contender).ack.refusalCode).toBe(
        "company_capacity_conflict",
      );
    } finally {
      await hold.cleanup(pending);
    }
  },
  30000,
);
const changes = (["increase", "decrease", "disable"] as const).flatMap((mode) =>
  [true, false].map((policyFirst) => ({ mode, policyFirst })),
);
it.each(changes)(
  "policy $mode and native booking preserve serialization policyFirst=$policyFirst",
  async ({ mode, policyFirst }) => {
    const f = await fixture(),
      originalCommand = await command(f, "appointment", 600, [f.tech]),
      pending: Promise<unknown>[] = [],
      hold = await barrier(
        policyFirst ? "org_settings" : "appointments",
        f.org,
        policyFirst ? "BEFORE UPDATE" : "BEFORE INSERT",
      );
    const change = () =>
      policy.saveSchedulingPolicy(f.actor, {
        ...f.input,
        expectedRevision: 1,
        minimumTravelGapMinutes:
          mode === "increase" ? 90 : mode === "decrease" ? 0 : 60,
        maxConcurrentReservations: mode === "increase" ? 1 : null,
        enabled: mode !== "disable",
      });
    try {
      if (policyFirst) {
        const saving = observe(change(), pending),
          savingPid = await blockedBy(hold.pid, "%update%"),
          booking = observe(create(f, originalCommand), pending),
          bookingPid = await blockedBy(savingPid, "%pg_advisory_xact_lock%");
        expect(new Set([hold.pid, savingPid, bookingPid]).size).toBe(3);
        await hold.release();
        await saving;
        expect((await booking).ack.refusalCode).toBe("stale_scheduling_review");
      } else {
        const booking = observe(create(f, originalCommand), pending),
          bookingPid = await blockedBy(hold.pid, "%insert into%"),
          saving = observe(change(), pending),
          savingPid = await blockedBy(bookingPid, "%pg_advisory_xact_lock%");
        expect(new Set([hold.pid, bookingPid, savingPid]).size).toBe(3);
        await hold.release();
        expect((await booking).record?.schedulingReservation).toMatchObject({
          minimumTravelGapMinutes: 60,
        });
        await saving;
        const stale = { ...originalCommand, operationId: randomUUID() };
        expect((await create(f, stale)).ack.refusalCode).toBe(
          "stale_scheduling_review",
        );
      }
    } finally {
      await hold.cleanup(pending);
    }
  },
  30000,
);
it.each(
  pairs.flatMap((pair) =>
    (["travel", "company"] as const).map((gate) => ({ ...pair, gate })),
  ),
)(
  "serializes $a material update against $b CREATE for $gate, createFirst=$reverse",
  async ({ a, b, reverse, gate }) => {
    const f = await fixture(gate === "company" ? 1 : null),
      staff = a === "project" ? [f.owner, f.tech] : [f.tech];
    // Company contenders use disjoint staff; travel contenders share the second crew member.
    const movingStaff = gate === "company" ? [f.tech] : staff;
    const saved = (await create(f, await command(f, a, 1800, movingStaff)))
      .record!;
    const context = await policy.getSchedulingReviewContext(f.actor, {
      sourceKind: "lead",
      sourceId: f.lead,
      reservationKind: a,
      ...(a === "appointment"
        ? { appointmentType: "production" as const }
        : {}),
      targetKind: a,
      targetId: saved.id,
    });
    const patch = {
      scheduledStart: new Date(Date.UTC(2035, 0, 1, 10)),
      scheduledEnd: new Date(Date.UTC(2035, 0, 1, 11)),
      schedulingReview: {
        context,
        duration: { kind: "explicit" as const, preset: null },
        startWallTime: null,
        endWallTime: null,
      },
      expectedUpdatedAt: saved.updatedAt.toISOString(),
      expectedTargetFingerprint: policy.schedulingTargetFingerprint(a, saved),
    };
    const move = async () =>
      a === "appointment"
        ? crm.updateAppointment(f.org, saved.id, patch, undefined, f.actor)
        : crm.updateProject(f.org, saved.id, patch, f.actor);
    const fresh = await command(
      f,
      b,
      gate === "company" ? 600 : 690,
      gate === "company" ? [f.owner] : [f.tech],
    );
    const firstKind = reverse ? b : a,
      pending: Promise<unknown>[] = [],
      hold = await barrier(
        firstKind === "appointment" ? "appointments" : "projects",
        f.org,
        reverse ? "BEFORE INSERT" : "BEFORE UPDATE",
      );
    const code =
      gate === "company" ? "company_capacity_conflict" : "travel_conflict";
    try {
      if (reverse) {
        const booking = observe(create(f, fresh), pending),
          firstPid = await blockedBy(hold.pid, "%insert into%"),
          moving = observe(move(), pending),
          secondPid = await blockedBy(firstPid, "%pg_advisory_xact_lock%");
        expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
        await hold.release();
        expect((await booking).ack.outcome).toBe("committed");
        await expect(moving).rejects.toMatchObject({ code });
      } else {
        const moving = observe(move(), pending),
          firstPid = await blockedBy(hold.pid, "%update%"),
          booking = observe(create(f, fresh), pending),
          secondPid = await blockedBy(firstPid, "%pg_advisory_xact_lock%");
        expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
        await hold.release();
        expect(await moving).toMatchObject({
          scheduledStart: patch.scheduledStart,
        });
        expect((await booking).ack.refusalCode).toBe(code);
      }
      const persisted =
        a === "appointment"
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
      expect(persisted.scheduledStart).toEqual(
        reverse ? saved.scheduledStart : patch.scheduledStart,
      );
      expect(persisted.schedulingReservation?.reservationRevision).toBe(
        reverse ? 1 : 2,
      );
    } finally {
      await hold.cleanup(pending);
    }
  },
  30000,
);
