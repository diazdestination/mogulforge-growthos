import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activitiesTable,
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  conversationsTable,
  db,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  pool,
  propertiesTable,
  projectsTable,
  scheduledActionsTable,
  usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  bookInspectionSlot,
  conciergeInspectionOfferSchema,
  generateInspectionSlots,
  handleMessage,
} from "./concierge";
import {
  readSchedulingPolicy,
  saveSchedulingPolicy,
  setSchedulingCompanyTimeZone,
  getSchedulingReviewContext,
  lockSchedulingConfiguration,
} from "./scheduling-policy";
import { updateOrgSettings } from "./settings";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { createManualScheduledAppointment } from "./manual-scheduling";
import * as automation from "./automation";
import {
  insertInspectionIfAvailable,
  prepareInspectionInTransaction,
} from "./inspection-booking";
const orgs: string[] = [];
afterAll(async () => {
  vi.useRealTimers();
  await deleteTestOrgs(...orgs);
});
const availability = {
  timezone: "UTC",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  windows: [{ startHour: 9, endHour: 11 }],
  blackoutDates: [],
  maxBookingsPerWindow: 2,
};
async function fixture(configured = true, cap: number | null = 2) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic inspection",
      slug: `inspection-${randomUUID()}`,
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
      isPlatformAdmin: true,
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Synthetic",
      phone: "+15550001111",
    })
    .returning();
  const [property] = await db
    .insert(propertiesTable)
    .values({
      organizationId: org.id,
      contactId: contact.id,
      addressLine1: "1 Synthetic St",
      city: "Test",
      state: "CA",
      postalCode: "90001",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: contact.id,
      propertyId: property.id,
    })
    .returning();
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: org.id, inspectionAvailability: availability });
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      organizationId: org.id,
      leadId: lead.id,
      contactId: contact.id,
      state: {
        step: "scheduling",
        urgency: "normal",
        consentGranted: true,
        leadId: lead.id,
        contactId: contact.id,
        propertyId: property.id,
        contactMethod: "call",
      },
    })
    .returning();
  const actor = { organizationId: org.id, userId: owner.id };
  if (configured)
    await saveSchedulingPolicy(actor, {
      expectedRevision: 0,
      expectedCompanyTimeZone: "UTC",
      enabled: true,
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: cap,
      durationPresets: [],
    });
  const [offered] = await generateInspectionSlots(org.id, {
      conversationId: conversation.id,
    }),
    offer = conciergeInspectionOfferSchema.parse(offered);
  return {
    org: org.id,
    owner,
    actor,
    contact,
    property,
    lead,
    conversation,
    offer,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
const book = (f: F) =>
  bookInspectionSlot({
    organizationId: f.org,
    conversationId: f.conversation.id,
    slot: f.offer,
  });
const rows = (f: F) =>
  db
    .select()
    .from(appointmentsTable)
    .where(eq(appointmentsTable.organizationId, f.org));
it("binds the stored actual source, null actor, snapshot and original replay before current policy/lifecycle", async () => {
  const f = await fixture(),
    first = await book(f);
  expect(first).toEqual({ id: f.offer.appointmentId, replayed: false });
  const [row] = await rows(f);
  expect(row.schedulingReservation).toMatchObject({
    target: { id: row.id },
    admittedByUserId: null,
    minimumTravelGapMinutes: 60,
    resourceUserIds: [],
    duration: { kind: "inspection_interval" },
  });
  const events = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.organizationId, f.org));
  expect(
    events.find((e) => e.action === "scheduling.reservation_transition.v1"),
  ).toMatchObject({
    actorUserId: null,
    metadata: {
      origin: "concierge",
      sourceId: f.conversation.id,
      source: f.offer.source,
    },
  });
  expect(
    await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, f.org)),
  ).toHaveLength(1);
  await transitionCustomerLifecycle(f.org, f.owner.id, {
    action: "pause",
    expectedVersion: 0,
    reason: "Synthetic pause after committed booking",
  });
  await db
    .update(organizationsTable)
    .set({ timezone: "Invalid/Zone" })
    .where(eq(organizationsTable.id, f.org));
  expect(await book(f)).toEqual({ id: row.id, replayed: true });
  expect(await rows(f)).toHaveLength(1);
  expect(
    await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, f.org)),
  ).toHaveLength(1);
});
it.each(["inspection", "zone"])(
  "stales revision0 offers after %s change while preserving recorded windows",
  async (kind) => {
    const f = await fixture(false);
    if (kind === "inspection")
      await updateOrgSettings(
        f.org,
        {
          inspectionAvailability: { ...availability, maxBookingsPerWindow: 3 },
        },
        f.actor,
      );
    else
      await setSchedulingCompanyTimeZone(
        f.actor,
        f.org,
        "America/Los_Angeles",
        "UTC",
      );
    expect(await book(f)).toBeNull();
    expect(await rows(f)).toHaveLength(0);
    const [fresh] = await generateInspectionSlots(f.org, {
      conversationId: f.conversation.id,
    });
    expect(
      conciergeInspectionOfferSchema.parse(fresh).review.context.inspection
        ?.ruleTimeZone,
    ).toBe("UTC");
    expect(
      (
        await db
          .select()
          .from(orgSettingsTable)
          .where(eq(orgSettingsTable.organizationId, f.org))
      )[0].inspectionAvailability?.windows,
    ).toEqual(availability.windows);
  },
);
it("refuses detached, modified and historical bare offers without granting configured authority", async () => {
  const f = await fixture();
  for (const slot of [
    { start: f.offer.start, end: f.offer.end },
    { ...f.offer, appointmentId: randomUUID() },
    { ...f.offer, sourceFingerprint: "a".repeat(64) },
    { ...f.offer, extra: true },
  ])
    expect(
      await bookInspectionSlot({
        organizationId: f.org,
        conversationId: f.conversation.id,
        slot,
      }),
    ).toBeNull();
  expect(
    await bookInspectionSlot({ organizationId: f.org, slot: f.offer }),
  ).toBeNull();
  expect(await generateInspectionSlots(f.org)).toEqual([]);
  await db
    .update(propertiesTable)
    .set({ addressLine1: "2 Changed address" })
    .where(eq(propertiesTable.id, f.property.id));
  expect(await book(f)).toBeNull();
  expect(await rows(f)).toHaveLength(0);
});
it("applies company capacity to other visits and holds source offers without claiming technician availability", async () => {
  const f = await fixture(true, 1);
  await db
    .insert(appointmentsTable)
    .values({
      organizationId: f.org,
      type: "other",
      status: "scheduled",
      scheduledStart: new Date(f.offer.start),
      scheduledEnd: new Date(f.offer.end),
    });
  expect(await book(f)).toBeNull();
  expect(
    (
      await generateInspectionSlots(f.org, {
        conversationId: f.conversation.id,
      })
    ).map((x) => x.start),
  ).not.toContain(f.offer.start);
});
it.each([
  "appointments",
  "transition",
  "audit",
  "conversations",
  "scheduled_actions",
])(
  "rolls back all native/source/reminder evidence when %s fails",
  async (target) => {
    const f = await fixture(),
      hook = `qa_inspect_fail_${randomUUID().replaceAll("-", "")}`;
    const table =
      target === "transition" || target === "audit" ? "audit_events" : target;
    const extra =
      target === "transition"
        ? "AND NEW.action='scheduling.reservation_transition.v1'"
        : target === "audit"
          ? "AND NEW.action='appointment.booked_concierge'"
          : "";
    await pool.query(
      `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid ${extra} THEN RAISE EXCEPTION 'synthetic inspection rollback'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${hook} BEFORE ${table === "conversations" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
    );
    try {
      await expect(book(f)).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER ${hook} ON ${table}`);
      await pool.query(`DROP FUNCTION ${hook}()`);
    }
    expect(await rows(f)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(scheduledActionsTable)
        .where(eq(scheduledActionsTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(conversationsTable)
          .where(eq(conversationsTable.id, f.conversation.id))
      )[0].state.inspectionBooking,
    ).toBeUndefined();
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.organizationId, f.org))
      ).filter((x) =>
        [
          "appointment.booked_concierge",
          "scheduling.reservation_transition.v1",
        ].includes(x.action),
      ),
    ).toHaveLength(0);
  },
);
async function blockedBy(pid: number) {
  for (let i = 0; i < 200; i++) {
    const q = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if (q.rows[0]) return Number(q.rows[0].pid);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Independent inspection waiter not observed");
}
async function barrier(
  table: string,
  org: string,
  timing: string,
  column = "organization_id",
) {
  const hook = `qa_inspect_${randomUUID().replaceAll("-", "")}`,
    keeper = await pool.connect();
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${column}='${org}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtext('${hook}')); END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
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
it.each(
  ["policy", "inspection", "zone", "native", "lifecycle", "property"].flatMap(
    (kind) => [false, true].map((bookingFirst) => ({ kind, bookingFirst })),
  ),
)(
  "observes PostgreSQL $kind and concierge ordering bookingFirst=$bookingFirst",
  async ({ kind, bookingFirst }) => {
    const f = await fixture(true, kind === "native" ? 1 : 2),
      saved = await readSchedulingPolicy(f.actor);
    const context = await getSchedulingReviewContext(f.actor, {
      sourceKind: "lead",
      sourceId: f.lead.id,
      propertyId: f.property.id,
      reservationKind: "appointment",
      appointmentType: "other",
    });
    const mutate = () =>
      kind === "policy"
        ? saveSchedulingPolicy(f.actor, {
            expectedRevision: saved.policy!.revision,
            expectedCompanyTimeZone: "UTC",
            enabled: true,
            minimumTravelGapMinutes: 90,
            maxConcurrentReservations: 2,
            durationPresets: [],
          })
        : kind === "inspection"
          ? updateOrgSettings(
              f.org,
              {
                inspectionAvailability: {
                  ...availability,
                  maxBookingsPerWindow: 3,
                },
              },
              f.actor,
            )
          : kind === "zone"
            ? setSchedulingCompanyTimeZone(
                f.actor,
                f.org,
                "America/Los_Angeles",
                "UTC",
              )
            : kind === "lifecycle"
              ? transitionCustomerLifecycle(f.org, f.owner.id, {
                  action: "pause",
                  expectedVersion: 0,
                  reason: "Synthetic concurrent pause",
                })
              : kind === "property"
                ? db
                    .update(propertiesTable)
                    .set({ addressLine1: "Changed while booking" })
                    .where(eq(propertiesTable.id, f.property.id))
                : createManualScheduledAppointment(f.actor, {
                    kind: "appointment_create",
                    operationId: randomUUID(),
                    body: {
                      leadId: f.lead.id,
                      contactId: f.contact.id,
                      propertyId: f.property.id,
                      type: "other",
                      scheduledStart: f.offer.start,
                      scheduledEnd: f.offer.end,
                    },
                    review: {
                      context,
                      duration: { kind: "explicit", preset: null },
                      startWallTime: null,
                      endWallTime: null,
                    },
                  });
    const table =
      bookingFirst || kind === "native"
        ? "appointments"
        : kind === "policy" || kind === "inspection"
          ? "org_settings"
          : kind === "zone"
            ? "organizations"
            : kind === "lifecycle"
              ? "customer_lifecycle"
              : "properties";
    const hold = await barrier(
        table,
        f.org,
        table === "appointments" || table === "customer_lifecycle"
          ? "BEFORE INSERT"
          : "BEFORE UPDATE",
        table === "organizations" ? "id" : "organization_id",
      ),
      pending: Promise<unknown>[] = [];
    const run = (p: Promise<unknown>) => {
      const q = p.then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      pending.push(q);
      return q;
    };
    try {
      const first = run(Promise.resolve(bookingFirst ? book(f) : mutate())),
        firstPid = await blockedBy(hold.pid);
      const second = run(Promise.resolve(bookingFirst ? mutate() : book(f))),
        secondPid = await blockedBy(firstPid);
      expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
      console.info(
        "INSPECTION_PG_BARRIER",
        JSON.stringify({
          kind,
          bookingFirst,
          keeper: hold.pid,
          firstPid,
          secondPid,
        }),
      );
      await hold.release();
      const [a, b] = await Promise.all([first, second]),
        booking = bookingFirst ? a : b,
        change = bookingFirst ? b : a;
      if (bookingFirst) {
        expect(booking.error).toBeNull();
        expect(booking.value).toMatchObject({ id: f.offer.appointmentId });
        if (kind === "native")
          expect(change.value).toMatchObject({
            ack: {
              outcome: "no_commit_refused",
              refusalCode: "company_capacity_conflict",
            },
          });
        else expect(change.error).toBeNull();
      } else {
        expect(change.error).toBeNull();
        if (kind === "lifecycle")
          expect(booking.error).toMatchObject({
            code: "customer_lifecycle_paused",
          });
        else {
          expect(booking.error).toBeNull();
          expect(booking.value).toBeNull();
        }
      }
      const current = (
        await db
          .select()
          .from(conversationsTable)
          .where(eq(conversationsTable.id, f.conversation.id))
      )[0];
      expect(Boolean(current.state.inspectionBooking)).toBe(bookingFirst);
    } finally {
      await hold.cleanup(pending);
    }
  },
  30000,
);
it("rejects legacy actorless configured insertion instead of fabricating approved staff", async () => {
  const f = await fixture();
  await expect(
    insertInspectionIfAvailable({
      organizationId: f.org,
      type: "inspection",
      status: "scheduled",
      assignedUserId: f.owner.id,
      scheduledStart: new Date(f.offer.start),
      scheduledEnd: new Date(f.offer.end),
    }),
  ).rejects.toMatchObject({ code: "stale_scheduling_review" });
});

it("holds a changed source parent without replacing the original source", async () => {
  const f = await fixture(),
    [other] = await db
      .insert(contactsTable)
      .values({ organizationId: f.org, firstName: "Other synthetic" })
      .returning();
  await db
    .update(propertiesTable)
    .set({ contactId: other.id })
    .where(eq(propertiesTable.id, f.property.id));
  expect(await book(f)).toBeNull();
  expect(
    await generateInspectionSlots(f.org, { conversationId: f.conversation.id }),
  ).toEqual([]);
  expect(await rows(f)).toHaveLength(0);
});
it("preserves committed custody when an older outer message saves afterwards", async () => {
  const f = await fixture(),
    hold = await barrier("conversation_messages", f.org, "BEFORE INSERT"),
    pending: Promise<unknown>[] = [];
  try {
    const old = handleMessage({
      organizationId: f.org,
      conversationId: f.conversation.id,
      content: "unrecognized choice",
    });
    pending.push(old);
    await blockedBy(hold.pid);
    expect(await book(f)).toMatchObject({ replayed: false });
    const committed = (
      await db
        .select()
        .from(conversationsTable)
        .where(eq(conversationsTable.id, f.conversation.id))
    )[0];
    await hold.release();
    await old;
    const saved = (
      await db
        .select()
        .from(conversationsTable)
        .where(eq(conversationsTable.id, f.conversation.id))
    )[0];
    expect(saved).toMatchObject({
      status: "completed",
      state: {
        step: "done",
        inspectionBooking: committed.state.inspectionBooking,
        appointmentId: f.offer.appointmentId,
        leadId: f.lead.id,
      },
    });
    expect(await book(f)).toMatchObject({ replayed: true });
  } finally {
    await hold.cleanup(pending);
  }
}, 30000);
it("runs booking observers only for the winning chat message across simultaneous and postcommit replay", async () => {
  const f = await fixture(),
    observer = vi
      .spyOn(automation, "emitAutomationEvent")
      .mockImplementation(() => {}),
    hold = await barrier("appointments", f.org, "BEFORE INSERT"),
    pending: Promise<unknown>[] = [];
  try {
    const first = handleMessage({
      organizationId: f.org,
      conversationId: f.conversation.id,
      content: "1",
    });
    pending.push(first);
    const firstPid = await blockedBy(hold.pid);
    const second = handleMessage({
      organizationId: f.org,
      conversationId: f.conversation.id,
      content: "1",
    });
    pending.push(second);
    const secondPid = await blockedBy(firstPid);
    expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
    console.info(
      "INSPECTION_OBSERVER_BARRIER",
      JSON.stringify({ keeper: hold.pid, firstPid, secondPid }),
    );
    await hold.release();
    expect(
      (await Promise.all([first, second])).every((value) => value?.done),
    ).toBe(true);
    await handleMessage({
      organizationId: f.org,
      conversationId: f.conversation.id,
      content: "1",
    });
    expect(
      observer.mock.calls.filter((call) => call[1] === "appointment.booked"),
    ).toHaveLength(1);
    expect(await rows(f)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(scheduledActionsTable)
        .where(eq(scheduledActionsTable.organizationId, f.org)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(activitiesTable)
          .where(eq(activitiesTable.organizationId, f.org))
      ).filter((x) => x.type === "appointment_scheduled"),
    ).toHaveLength(1);
  } finally {
    observer.mockRestore();
    await hold.cleanup(pending);
  }
}, 30000);

async function assignedPreparation(
  f: F,
  savedContext?: Awaited<ReturnType<typeof getSchedulingReviewContext>>,
) {
  const context =
    savedContext ??
    (await getSchedulingReviewContext(f.actor, {
      sourceKind: "lead",
      sourceId: f.lead.id,
      propertyId: f.property.id,
      reservationKind: "appointment",
      appointmentType: "inspection",
    }));
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, f.org);
    return prepareInspectionInTransaction(tx, {
      organizationId: f.org,
      candidate: {
        kind: "appointment",
        id: randomUUID(),
        type: "inspection",
        status: "scheduled",
        startAt: f.offer.start,
        endAt: f.offer.end,
        resourceUserIds: [f.owner.id],
        source: f.offer.source,
        reservation: null,
      },
      authority: {
        organizationId: f.org,
        actorUserId: f.owner.id,
        origin: "manual",
        sourceId: null,
        reviewMode: "reviewed",
      },
      review: {
        context,
        duration: { kind: "explicit", preset: null },
        startWallTime: null,
        endWallTime: null,
      },
    });
  });
}
it("shares saved travel horizon, raw claimed-member validation and accepted member checks", async () => {
  const f = await fixture(true, null);
  f.offer = conciergeInspectionOfferSchema.parse(
    (
      await generateInspectionSlots(f.org, {
        conversationId: f.conversation.id,
      })
    )[2],
  );
  await saveSchedulingPolicy(f.actor, {
    expectedRevision: 1,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 1440,
    maxConcurrentReservations: null,
    durationPresets: [],
  });
  const context = await getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: f.lead.id,
    propertyId: f.property.id,
    reservationKind: "appointment",
    appointmentType: "other",
  });
  const first = await createManualScheduledAppointment(f.actor, {
    operationId: randomUUID(),
    kind: "appointment_create",
    body: {
      leadId: f.lead.id,
      contactId: f.contact.id,
      propertyId: f.property.id,
      type: "other",
      assignedUserId: f.owner.id,
      scheduledStart: new Date(
        Date.parse(f.offer.start) - 24 * 3600000,
      ).toISOString(),
      scheduledEnd: new Date(
        Date.parse(f.offer.start) - 23 * 3600000,
      ).toISOString(),
    },
    review: {
      context,
      duration: { kind: "explicit", preset: null },
      startWallTime: null,
      endWallTime: null,
    },
  });
  expect(first.ack.outcome).toBe("committed");
  await saveSchedulingPolicy(f.actor, {
    expectedRevision: 2,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 0,
    maxConcurrentReservations: null,
    durationPresets: [],
  });
  await expect(assignedPreparation(f)).rejects.toMatchObject({
    code: "travel_conflict",
  });
  // Corrupt only actual assignment/time, retaining the raw claimed member: the
  // resource query must validate this far-away evidence before horizon pruning.
  await db
    .update(appointmentsTable)
    .set({
      assignedUserId: null,
      scheduledStart: new Date("2045-01-01T09:00:00Z"),
      scheduledEnd: new Date("2045-01-01T10:00:00Z"),
    })
    .where(eq(appointmentsTable.id, first.ack.target!.id));
  await expect(assignedPreparation(f)).rejects.toMatchObject({
    code: "invalid_reservation_snapshot",
  });
  const acceptedContext = await getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: f.lead.id,
    propertyId: f.property.id,
    reservationKind: "appointment",
    appointmentType: "inspection",
  });
  await db
    .update(usersTable)
    .set({ emailVerifiedAt: null })
    .where(eq(usersTable.id, f.owner.id));
  await expect(assignedPreparation(f, acceptedContext)).rejects.toMatchObject({
    code: "invalid_assignee",
  });
});
it("holds the combined 10001st relevant reservation instead of truncating offer/admission evidence", async () => {
  const f = await fixture(true, null);
  await db.execute(
    sql`insert into appointments(organization_id,type,status,assigned_user_id,scheduled_start,scheduled_end) select ${f.org}::uuid,'other','scheduled',${f.owner.id},'2040-01-01 10:00:00Z'::timestamptz,'2040-01-01 11:00:00Z'::timestamptz from generate_series(1,5000)`,
  );
  await db.execute(
    sql`insert into projects(organization_id,lead_id,name,status,crew_user_ids,scheduled_start,scheduled_end) select ${f.org}::uuid,${f.lead.id}::uuid,'Synthetic coverage','scheduled',${JSON.stringify([f.owner.id])}::jsonb,'2040-01-01 10:00:00Z'::timestamptz,'2040-01-01 11:00:00Z'::timestamptz from generate_series(1,5000)`,
  );
  expect((await assignedPreparation(f)).snapshot?.resourceUserIds).toEqual([
    f.owner.id,
  ]);
  await db
    .insert(projectsTable)
    .values({
      organizationId: f.org,
      leadId: f.lead.id,
      name: "Synthetic 10001st",
      crewUserIds: [f.owner.id],
      scheduledStart: new Date("2040-01-01T10:00:00Z"),
      scheduledEnd: new Date("2040-01-01T11:00:00Z"),
    });
  await expect(assignedPreparation(f)).rejects.toMatchObject({
    code: "scheduling_coverage_limit",
  });
  // Anonymous company offers make no claim about this technician's free time.
  expect(
    await generateInspectionSlots(f.org, { conversationId: f.conversation.id }),
  ).toHaveLength(3);
}, 30000);
