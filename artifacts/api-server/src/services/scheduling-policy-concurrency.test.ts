import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  DEFAULT_INSPECTION_AVAILABILITY,
  organizationsTable,
  orgSettingsTable,
  usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { lockContractorSchedule } from "./contractor-scheduling";
import { updateOrgSettings } from "./settings";
import * as policy from "./scheduling-policy";

const orgs: string[] = [];
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture(configured: boolean) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic policy race",
      slug: `sched-race-${randomUUID()}`,
      timezone: "America/Los_Angeles",
    })
    .returning();
  orgs.push(org.id);
  const [user] = await db
    .insert(usersTable)
    .values({ organizationId: org.id, role: "owner", isPlatformAdmin: true })
    .returning();
  const actor = { organizationId: org.id, userId: user.id };
  if (configured)
    await policy.saveSchedulingPolicy(actor, {
      expectedRevision: 0,
      expectedCompanyTimeZone: org.timezone,
      enabled: true,
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: 3,
      durationPresets: [],
    });
  const review = (
    await db.transaction((tx) =>
      policy.readSchedulingContext(tx, org.id, undefined, {
        reservationKind: "appointment",
      }),
    )
  ).context;
  return { org: org.id, actor, review };
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
  throw Error("Expected independent PostgreSQL lock waiter was not observed");
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const change = (f: Fixture, kind: string) =>
  kind === "inspection"
    ? updateOrgSettings(
        f.org,
        {
          inspectionAvailability: {
            ...DEFAULT_INSPECTION_AVAILABILITY,
            timezone: "America/New_York",
            maxBookingsPerWindow: 2,
          },
        },
        f.actor,
      )
    : policy.setSchedulingCompanyTimeZone(
        f.actor,
        f.org,
        "Europe/London",
        "America/Los_Angeles",
      );
const admit = (f: Fixture) =>
  db
    .transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${f.org}`},0))`,
      );
      await lockContractorSchedule(tx, f.org);
      return policy.revalidateSchedulingContext(
        tx,
        f.org,
        f.review,
        undefined,
        { reservationKind: "appointment" },
      );
    })
    .then(
      () => "accepted",
      (error: { code: string }) => error.code,
    );

it.each(
  [false, true].flatMap((configured) =>
    ["inspection", "zone"].map((kind) => ({ configured, kind })),
  ),
)(
  "$kind writer first makes review stale under actual locks configured=$configured",
  async ({ configured, kind }) => {
    const f = await fixture(configured),
      blocker = await pool.connect();
    let writer: Promise<unknown> | undefined,
      reader: Promise<string> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [f.org],
      );
      writer = change(f, kind);
      const writerPid = await blockedBy(Number(rows[0].pid));
      reader = admit(f);
      expect(await blockedBy(writerPid)).not.toBe(writerPid);
      await blocker.query("COMMIT");
      await writer;
      expect(await reader).toBe("stale_scheduling_review");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([writer, reader]);
    }
  },
);
it.each(
  [false, true].flatMap((configured) =>
    ["inspection", "zone"].map((kind) => ({ configured, kind })),
  ),
)(
  "review first retains old context until commit; $kind writer then invalidates it configured=$configured",
  async ({ configured, kind }) => {
    const f = await fixture(configured),
      entered = latch(),
      finish = latch();
    let pid = 0;
    const reader = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${f.org}`},0))`,
      );
      await lockContractorSchedule(tx, f.org);
      pid = Number(
        (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid,
      );
      const value = await policy.revalidateSchedulingContext(
        tx,
        f.org,
        f.review,
        undefined,
        { reservationKind: "appointment" },
      );
      entered.release();
      await finish.promise;
      return value;
    });
    await entered.promise;
    let writer: Promise<unknown> | undefined;
    try {
      writer = change(f, kind);
      expect(await blockedBy(pid)).not.toBe(pid);
      finish.release();
      expect((await reader).context).toEqual(f.review);
      await writer;
      expect(await admit(f)).toBe("stale_scheduling_review");
      const [row] = await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, f.org));
      expect(row?.schedulingPolicy?.revision ?? 0).toBe(configured ? 2 : 0);
    } finally {
      finish.release();
      await Promise.allSettled([reader, writer]);
    }
  },
);
it("competing revision0 policy saves produce exactly one revision1 and one stale refusal", async () => {
  const f = await fixture(false),
    command = {
      expectedRevision: 0,
      expectedCompanyTimeZone: "America/Los_Angeles",
      enabled: true,
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: 3,
      durationPresets: [],
    };
  const results = await Promise.allSettled([
    policy.saveSchedulingPolicy(f.actor, command),
    policy.saveSchedulingPolicy(f.actor, command),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason.code),
  ).toEqual(["stale_scheduling_review"]);
});
