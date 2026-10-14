import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  organizationsTable,
  orgSettingsTable,
  usersTable,
  contactsTable,
  leadsTable,
  appointmentsTable,
  projectsTable,
  auditEventsTable,
  scheduledActionsTable,
  crmTasksTable,
  customerLifecycleTable,
  DEFAULT_INSPECTION_AVAILABILITY,
  DEFAULT_APPOINTMENT_REMINDER,
} from "@workspace/db";
import {
  canonicalSchedulingEnvelope,
  reservationSnapshotSchema,
  type ManualSchedulingCommand,
  type ManualSchedulingAck,
} from "@workspace/scheduling-core";
import {
  CreateAppointmentBody,
  CreateAppointmentResponse,
  CreateProjectBody,
  CreateProjectResponse,
  ManualSchedulingErrorSchema,
  ReconcileSchedulingOperationBody,
  ReconcileSchedulingOperationResponse,
  UpdateProjectBody,
  UpdateProjectResponse,
} from "@workspace/api-zod";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as automation from "./automation";
import * as policy from "./scheduling-policy";
import { updateOrgSettings } from "./settings";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { deleteContact } from "./crm";
import {
  SCHEDULING_TRANSITION_ACTION,
  schedulingTransitionSchema,
} from "./scheduling-admission";
import {
  MANUAL_SCHEDULING_RECEIPT_ACTION,
  MANUAL_SCHEDULING_REFUSAL_ACTION,
  manualSchedulingReceiptSchema,
  manualSchedulingBusinessRefusalSchema,
} from "./scheduling-history";

// This file must run through local-dev's owned PostgreSQL16 harness. There is
// deliberately no PGlite fallback, race skip, replacement server or provider.
const orgs: string[] = [],
  sessions: string[] = [];
const transport = globalThis.fetch;
let server: Server, base: string;
beforeAll(async () => {
  expect(
    Number(
      (await pool.query("SHOW server_version_num")).rows[0].server_version_num,
    ),
  ).toBeGreaterThanOrEqual(160000);
  vi.stubEnv("SESSION_SECRET", "synthetic-scheduling-acceptance-secret");
  vi.stubEnv("APP_ORIGIN", "https://scheduling-acceptance.example");
  vi.spyOn(automation, "emitAutomationEvent").mockImplementation(() => {});
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(configured = true) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic saved-scheduling acceptance",
      slug: randomUUID(),
      timezone: "UTC",
    })
    .returning();
  orgs.push(org.id);
  const [owner, survivor] = await db
    .insert(usersTable)
    .values([
      {
        organizationId: org.id,
        role: "owner",
        isPlatformAdmin: true,
        emailVerifiedAt: new Date(),
      },
      { organizationId: org.id, role: "office", emailVerifiedAt: new Date() },
    ])
    .returning();
  const actor = { organizationId: org.id, userId: owner.id };
  // Intentionally independent rule and company zones, including revision zero.
  await updateOrgSettings(
    org.id,
    {
      inspectionAvailability: {
        ...DEFAULT_INSPECTION_AVAILABILITY,
        timezone: "America/New_York",
      },
    },
    actor,
  );
  const saved = configured
    ? await policy.saveSchedulingPolicy(actor, {
        expectedRevision: 0,
        expectedCompanyTimeZone: "UTC",
        enabled: true,
        minimumTravelGapMinutes: 60,
        maxConcurrentReservations: null,
        durationPresets: [
          { id: null, label: "Synthetic hour", elapsedMinutes: 60 },
        ],
      })
    : null;
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Synthetic acceptance" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  await db.insert(crmTasksTable).values({
    organizationId: org.id,
    contactId: contact.id,
    leadId: lead.id,
    assignedUserId: survivor.id,
    title: "Synthetic existing office task",
    description: "Retain the original staff notes and open task identity.",
    status: "open",
    sourceEvent: "synthetic.acceptance.existing_task",
  });
  const client = async (userId: string) => {
    const sid = await createSession({
      user: {
        id: userId,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "synthetic",
    });
    sessions.push(sid);
    return (path: string, body: unknown, method = "POST") =>
      transport(base + path, {
        method,
        headers: {
          origin: "https://scheduling-acceptance.example",
          cookie: `sid=${sid}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
  };
  const request = await client(owner.id);
  return {
    org: org.id,
    actor,
    owner: owner.id,
    survivor: survivor.id,
    contact: contact.id,
    lead: lead.id,
    saved,
    request,
    client,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
function command(
  f: F,
  kind?: "appointment",
  inspection?: boolean,
): Promise<Extract<ManualSchedulingCommand, { kind: "appointment_create" }>>;
function command(
  f: F,
  kind: "project",
): Promise<Extract<ManualSchedulingCommand, { kind: "project_create" }>>;
async function command(
  f: F,
  kind: "appointment" | "project" = "appointment",
  inspection = false,
): Promise<ManualSchedulingCommand> {
  const context = await policy.getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: f.lead,
    reservationKind: kind,
    ...(kind === "appointment"
      ? {
          appointmentType: inspection
            ? ("inspection" as const)
            : ("production" as const),
        }
      : {}),
  });
  const review = {
    context,
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  };
  // Keep original offset spelling in the command, receipt hash and reconciliation.
  const interval = {
    scheduledStart: "2035-01-01T09:00:00-05:00",
    scheduledEnd: "2035-01-01T10:00:00-05:00",
  };
  return kind === "appointment"
    ? {
        operationId: randomUUID(),
        kind: "appointment_create",
        review,
        body: {
          ...interval,
          type: inspection ? "inspection" : "production",
          leadId: f.lead,
          assignedUserId: f.owner,
        },
      }
    : {
        operationId: randomUUID(),
        kind: "project_create",
        review: {
          ...review,
          duration: {
            kind: "preset",
            preset: f.saved!.policy!.durationPresets[0],
          },
        },
        body: {
          ...interval,
          name: "Synthetic protected crew",
          status: "scheduled",
          leadId: f.lead,
          crewUserIds: [f.owner, f.survivor],
        },
      };
}
function wire(c: ManualSchedulingCommand) {
  return { ...c.body, operationId: c.operationId, schedulingReview: c.review };
}
async function create(f: F, c: ManualSchedulingCommand) {
  const input = wire(c);
  // Validate through the real generated consumer, but submit original JSON.
  (c.kind === "appointment_create"
    ? CreateAppointmentBody
    : CreateProjectBody
  ).parse(input);
  const response = await f.request(
    c.kind === "appointment_create" ? "/appointments" : "/projects",
    input,
  );
  const json = await response.json();
  if (response.status === 201 || response.status === 200) {
    const value =
      c.kind === "appointment_create"
        ? CreateAppointmentResponse.parse(json)
        : CreateProjectResponse.parse(json);
    const table =
      c.kind === "appointment_create" ? appointmentsTable : projectsTable;
    const [persisted] = await db
      .select({ schedulingReservation: table.schedulingReservation })
      .from(table)
      .where(eq(table.id, value.id));
    expect(value.schedulingReservation).toEqual(
      persisted.schedulingReservation,
    );
    return {
      status: response.status,
      json,
      ack: ReconcileSchedulingOperationResponse.parse(
        value.schedulingOperation,
      ),
    };
  }
  return {
    status: response.status,
    json,
    ack:
      response.status === 409 &&
      json !== null &&
      typeof json === "object" &&
      "schedulingOperation" in json
        ? ManualSchedulingErrorSchema.parse(json).schedulingOperation
        : null,
  };
}
async function reconcile(f: F, c: ManualSchedulingCommand) {
  ReconcileSchedulingOperationBody.parse(c);
  const response = await f.request("/scheduling/operations/reconcile", c);
  expect(response.status).toBe(200);
  return ReconcileSchedulingOperationResponse.parse(await response.json());
}
async function effects(f: F) {
  const [
    appointments,
    projects,
    audits,
    reminders,
    tasks,
    contacts,
    leads,
    lifecycle,
    settings,
    organizations,
  ] = await Promise.all([
    db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org))
      .orderBy(appointmentsTable.id),
    db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.organizationId, f.org))
      .orderBy(projectsTable.id),
    db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org))
      .orderBy(auditEventsTable.id),
    db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, f.org))
      .orderBy(scheduledActionsTable.id),
    db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.organizationId, f.org))
      .orderBy(crmTasksTable.id),
    db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.organizationId, f.org))
      .orderBy(contactsTable.id),
    db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.organizationId, f.org))
      .orderBy(leadsTable.id),
    db
      .select()
      .from(customerLifecycleTable)
      .where(eq(customerLifecycleTable.organizationId, f.org)),
    db
      .select()
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.organizationId, f.org)),
    db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, f.org)),
  ]);
  return {
    appointments,
    projects,
    audits,
    reminders,
    tasks,
    contacts,
    leads,
    lifecycle,
    settings,
    organizations,
  };
}
type Effects = Awaited<ReturnType<typeof effects>>;
function added<T extends { id: string }>(before: T[], after: T[]) {
  const ids = new Set(before.map((row) => row.id));
  expect(after.filter((row) => ids.has(row.id))).toEqual(before);
  return after.filter((row) => !ids.has(row.id));
}
function eventCalls(f: F) {
  return vi
    .mocked(automation.emitAutomationEvent)
    .mock.calls.filter((call) => call[0] === f.org);
}
function receipt(
  f: F,
  c: ManualSchedulingCommand,
  ack: ManualSchedulingAck,
  after: Effects,
) {
  const hash = createHash("sha256")
    .update(
      canonicalSchedulingEnvelope({
        organizationId: f.org,
        actorUserId: f.actor.userId,
        kind: c.kind,
        body: c.body,
        review: c.review,
      }),
    )
    .digest("hex");
  expect(ack).toEqual({
    operationId: c.operationId,
    organizationId: f.org,
    actorUserId: f.actor.userId,
    kind: c.kind,
    source: c.review.context.source,
    payloadSha256: hash,
    outcome: ack.target ? "committed" : "no_commit_refused",
    target: ack.target,
    refusalCode: ack.refusalCode,
  });
  const rows = after.audits.filter((row) => row.id === c.operationId);
  expect(rows).toHaveLength(1);
  const row = rows[0],
    metadata = manualSchedulingReceiptSchema.parse(row.metadata);
  expect(row).toMatchObject({
    organizationId: f.org,
    actorUserId: f.actor.userId,
    action: MANUAL_SCHEDULING_RECEIPT_ACTION,
    entityType: c.kind === "appointment_create" ? "appointment" : "project",
    entityId: ack.target?.id ?? null,
  });
  expect(metadata).toEqual({
    formatVersion: 1,
    kind: c.kind,
    source: c.review.context.source,
    payloadSha256: hash,
    outcome: ack.outcome,
    target: ack.target ? { kind: ack.target.kind, id: ack.target.id } : null,
    refusalCode: ack.refusalCode,
    recordedAt: metadata.recordedAt,
  });
  return metadata;
}
function nativeEffects(
  f: F,
  c: ManualSchedulingCommand,
  ack: ManualSchedulingAck,
  before: Effects,
  after: Effects,
) {
  expect(after.contacts).toEqual(before.contacts);
  expect(after.leads).toEqual(before.leads);
  expect(after.tasks).toEqual(before.tasks);
  const appointments = added(before.appointments, after.appointments),
    projects = added(before.projects, after.projects);
  const reminders = added(before.reminders, after.reminders),
    audits = added(before.audits, after.audits);
  const meta = receipt(f, c, ack, after);
  if (!ack.target) {
    expect(appointments).toEqual([]);
    expect(projects).toEqual([]);
    expect(reminders).toEqual([]);
    expect(eventCalls(f)).toEqual([]);
    const refusals = audits.filter(
      (row) => row.action === MANUAL_SCHEDULING_REFUSAL_ACTION,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      actorUserId: f.actor.userId,
      entityType: c.kind === "appointment_create" ? "appointment" : "project",
      entityId: null,
    });
    expect(
      manualSchedulingBusinessRefusalSchema.parse(refusals[0].metadata),
    ).toEqual({
      formatVersion: 1,
      source: c.review.context.source,
      target: null,
      reason: ack.refusalCode,
      recordedAt: meta.recordedAt,
    });
    return;
  }
  const kind = ack.target.kind,
    rows = kind === "appointment" ? appointments : projects;
  expect(rows).toHaveLength(1);
  expect(kind === "appointment" ? projects : appointments).toEqual([]);
  const row = rows[0];
  expect(row.id).toBe(ack.target.id);
  expect(row.scheduledStart?.toISOString()).toBe(
    new Date(c.body.scheduledStart!).toISOString(),
  );
  expect(row.scheduledEnd?.toISOString()).toBe(
    new Date(c.body.scheduledEnd!).toISOString(),
  );
  let snapshot = null;
  if (c.review.context.policyRevision > 0) {
    snapshot = reservationSnapshotSchema.parse(row.schedulingReservation);
    expect(snapshot).toEqual({
      formatVersion: 1,
      reservationRevision: 1,
      sourcePolicyRevision: c.review.context.policyRevision,
      sourcePolicyDigest: c.review.context.policyDigest,
      approvedTimeZone: c.review.context.companyTimeZone,
      inspection: c.review.context.inspection,
      startAt: new Date(c.body.scheduledStart!).toISOString(),
      endAt: new Date(c.body.scheduledEnd!).toISOString(),
      resourceUserIds: (c.kind === "appointment_create"
        ? [c.body.assignedUserId!]
        : c.body.crewUserIds!
      )
        .slice()
        .sort(),
      minimumTravelGapMinutes:
        c.review.context.applicableRules.newTravelGapMinutes,
      duration: c.review.duration,
      admittedAt: snapshot.admittedAt,
      admittedByUserId: f.actor.userId,
      target: { kind, id: row.id },
      lastTransition: {
        kind: "admission",
        actorUserId: f.actor.userId,
        at: snapshot.admittedAt,
      },
    });
  } else expect(row.schedulingReservation).toBeNull();
  const transitions = audits.filter(
    (a) => a.action === SCHEDULING_TRANSITION_ACTION && a.entityId === row.id,
  );
  expect(transitions).toHaveLength(1);
  const transition = schedulingTransitionSchema.parse(transitions[0].metadata);
  expect(transitions[0].actorUserId).toBe(f.actor.userId);
  expect(transition).toEqual({
    formatVersion: 1,
    transition: "admission",
    origin: "manual",
    sourceId: null,
    source: c.review.context.source,
    before: null,
    after: snapshot,
    target: { kind, id: row.id },
    invalidHistoricalEvidenceRetained: false,
    recordedAt: transition.recordedAt,
  });
  if (kind === "appointment") {
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      organizationId: f.org,
      automationId: null,
      status: "pending",
      action: { type: "appointment_reminder", params: { contactMethod: null } },
      context: {
        event: automation.APPOINTMENT_REMINDER_EVENT,
        appointmentId: row.id,
        leadId: f.lead,
        fields: {
          "appointment.scheduledStart": row.scheduledStart!.toISOString(),
        },
      },
    });
    expect(reminders[0].context).toEqual({
      event: automation.APPOINTMENT_REMINDER_EVENT,
      appointmentId: row.id,
      leadId: f.lead,
      contactId: f.contact,
      fields: {
        "appointment.scheduledStart": row.scheduledStart!.toISOString(),
      },
    });
    expect(reminders[0].runAt).toEqual(
      new Date(
        row.scheduledStart!.getTime() -
          DEFAULT_APPOINTMENT_REMINDER.leadTimeHours * 3_600_000,
      ),
    );
    expect(eventCalls(f)).toEqual([
      [
        f.org,
        "appointment.booked",
        {
          appointmentId: row.id,
          leadId: f.lead,
          contactId: appointments[0].contactId ?? undefined,
          actorUserId: f.actor.userId,
          fields: {
            "appointment.type": appointments[0].type,
            "appointment.source": "crm",
            "lead.urgency": "normal",
          },
        },
      ],
    ]);
  } else expect(reminders).toEqual([]);
}
function exactAudits(before: Effects, after: Effects, actions: string[]) {
  expect(
    added(before.audits, after.audits)
      .map((a) => a.action)
      .sort(),
  ).toEqual(actions.slice().sort());
}
const admitted = [
  MANUAL_SCHEDULING_RECEIPT_ACTION,
  SCHEDULING_TRANSITION_ACTION,
];
const refused = [
  MANUAL_SCHEDULING_RECEIPT_ACTION,
  MANUAL_SCHEDULING_REFUSAL_ACTION,
];
async function replayUnchanged(
  f: F,
  c: ManualSchedulingCommand,
  ack: ManualSchedulingAck,
) {
  const before = await effects(f),
    events = eventCalls(f);
  const replay = await create(f, c);
  expect(replay.status).toBe(ack.outcome === "committed" ? 200 : 409);
  expect(replay.ack).toEqual(ack);
  expect(await reconcile(f, c)).toEqual(ack);
  expect(await effects(f)).toEqual(before);
  expect(eventCalls(f)).toEqual(events);
}

type OrganizationLock = {
  database: string;
  classid: string;
  objid: string;
  objsubid: number;
  mode: string;
};
async function organizationLocks(f: F): Promise<OrganizationLock[]> {
  // Observe actual production lock identities in a short transaction. Do not
  // duplicate PostgreSQL's advisory-key bit layout or infer scope from SQL text.
  return db.transaction(async (tx) => {
    await policy.lockSchedulingConfiguration(tx, f.org, false);
    const result = await tx.execute<OrganizationLock>(sql`
      SELECT database::text, classid::text, objid::text, objsubid, mode
      FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
      ORDER BY classid, objid, objsubid
    `);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((lock) => lock.mode === "ExclusiveLock")).toBe(
      true,
    );
    return result.rows;
  });
}
async function blockedBy(
  pid: number,
  locks: OrganizationLock[],
  granted: boolean,
  attempts = 200,
) {
  for (let i = 0; i < attempts; i++) {
    const result = await pool.query(
      `SELECT DISTINCT activity.pid
       FROM pg_stat_activity activity JOIN pg_locks scoped ON scoped.pid=activity.pid
       WHERE activity.datname=current_database()
         AND $1::int=ANY(pg_blocking_pids(activity.pid))
         AND scoped.locktype='advisory' AND scoped.granted=$2::boolean
         AND $3::jsonb @> jsonb_build_array(jsonb_build_object(
           'database',scoped.database::text,'classid',scoped.classid::text,
           'objid',scoped.objid::text,'objsubid',scoped.objsubid,'mode',scoped.mode))
         AND ($2::boolean OR EXISTS (
           SELECT 1 FROM pg_locks holder WHERE holder.pid=$1::int
             AND holder.locktype='advisory' AND holder.granted
             AND holder.database=scoped.database AND holder.classid=scoped.classid
             AND holder.objid=scoped.objid AND holder.objsubid=scoped.objsubid
             AND holder.mode=scoped.mode))`,
      [pid, granted, JSON.stringify(locks)],
    );
    if (result.rows.length > 1)
      throw Error(
        "Ambiguous organization-scoped PostgreSQL acceptance barrier",
      );
    if (result.rows[0]) return Number(result.rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Independent PostgreSQL acceptance barrier was not observed");
}
async function barrier(
  table: string,
  f: F,
  operation = "INSERT",
  condition = "true",
) {
  const locks = await organizationLocks(f);
  const hook = `qa_acceptance_${randomUUID().replaceAll("-", "")}`,
    keeper = await pool.connect();
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${table === "organizations" ? "id" : "organization_id"}='${f.org}'::uuid AND (${condition}) THEN PERFORM pg_advisory_xact_lock(hashtext('${hook}')); END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
  );
  await keeper.query("BEGIN");
  await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hook]);
  return {
    keeper,
    organizationLocks: locks,
    pid: Number(
      (await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    ),
    drop: async () => {
      await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`);
      await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
    },
  };
}
async function contactBarrier(f: F) {
  const locks = await organizationLocks(f);
  const keeper = await pool.connect();
  await keeper.query("BEGIN");
  await keeper.query(
    "SELECT id FROM contacts WHERE organization_id=$1 AND id=$2 FOR UPDATE",
    [f.org, f.contact],
  );
  return {
    keeper,
    organizationLocks: locks,
    pid: Number(
      (await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    ),
    drop: async () => {},
  };
}
async function race<A, B>(
  label: string,
  hold: Awaited<ReturnType<typeof barrier>>,
  first: () => Promise<A>,
  second: () => Promise<B>,
) {
  const pending: Promise<unknown>[] = [];
  const observe = <T>(promise: Promise<T>) => {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  try {
    const a = observe(first()),
      firstPid = await blockedBy(hold.pid, hold.organizationLocks, true);
    const b = observe(second()),
      secondPid = await blockedBy(firstPid, hold.organizationLocks, false);
    expect(new Set([hold.pid, firstPid, secondPid]).size).toBe(3);
    console.info(
      "SAVED_SCHEDULING_ACCEPTANCE_PG_BARRIER",
      JSON.stringify({
        label,
        keeper: hold.pid,
        first: firstPid,
        second: secondPid,
        organizationLocks: hold.organizationLocks,
      }),
    );
    await hold.keeper.query("COMMIT");
    return await Promise.all([a, b]);
  } finally {
    await hold.keeper.query("ROLLBACK");
    hold.keeper.release();
    await Promise.allSettled(pending);
    await hold.drop();
  }
}

const configurationCases = (["policy", "inspection", "zone"] as const).flatMap(
  (kind) =>
    (kind === "inspection" ? [false, true] : [true]).flatMap((configured) =>
      [false, true].map((changeFirst) => ({ kind, configured, changeFirst })),
    ),
);
it("does not mistake an unrelated contact-row waiter for the second native operation", async () => {
  const f = await fixture(),
    c = await command(f),
    before = await effects(f);
  const hold = await barrier("appointments", f),
    challenger = await pool.connect();
  const pending: Promise<unknown>[] = [];
  const observe = <T>(promise: Promise<T>) => {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  try {
    const original = observe(create(f, c)),
      firstPid = await blockedBy(hold.pid, hold.organizationLocks, true);
    await challenger.query("BEGIN");
    const challengerPid = Number(
      (await challenger.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    );
    // Native admission holds this contact FOR SHARE. This unrelated row-lock
    // waiter is a real independent session but is not the second native request.
    const unrelated = observe(
      challenger.query(
        "SELECT id FROM contacts WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [f.org, f.contact],
      ),
    );
    let seen = false;
    for (let i = 0; i < 200; i++) {
      const result = await pool.query(
        "SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked",
        [firstPid, challengerPid],
      );
      if (result.rows[0].blocked) {
        seen = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(seen).toBe(true);
    // Before the real second operation starts, the only waiter is unrelated.
    await expect(
      blockedBy(firstPid, hold.organizationLocks, false, 10),
    ).rejects.toThrow(
      "Independent PostgreSQL acceptance barrier was not observed",
    );
    const duplicate = observe(create(f, c)),
      secondPid = await blockedBy(firstPid, hold.organizationLocks, false);
    expect(new Set([hold.pid, firstPid, secondPid, challengerPid]).size).toBe(
      4,
    );
    console.info(
      "SAVED_SCHEDULING_ACCEPTANCE_PG_BARRIER",
      JSON.stringify({
        label: "reject-unrelated-row-waiter",
        keeper: hold.pid,
        first: firstPid,
        second: secondPid,
        rejectedChallenger: challengerPid,
        organizationLocks: hold.organizationLocks,
      }),
    );
    await hold.keeper.query("COMMIT");
    const [first, second] = await Promise.all([original, duplicate]);
    await unrelated;
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.ack).toEqual(first.ack);
    const after = await effects(f);
    nativeEffects(f, c, first.ack!, before, after);
    exactAudits(before, after, admitted);
  } finally {
    await hold.keeper.query("ROLLBACK");
    hold.keeper.release();
    await Promise.allSettled(pending);
    await challenger.query("ROLLBACK");
    challenger.release();
    await hold.drop();
  }
}, 30000);
it.each(configurationCases)(
  "native HTTP $kind configured=$configured changeFirst=$changeFirst retains exact effects",
  async ({ kind, configured, changeFirst }) => {
    const f = await fixture(configured),
      c = await command(f, "appointment", true),
      before = await effects(f);
    expect(c.review.context.companyTimeZone).toBe("UTC");
    expect(c.review.context.inspection?.ruleTimeZone).toBe("America/New_York");
    const change = async () => {
      await (kind === "policy"
        ? policy.saveSchedulingPolicy(f.actor, {
            expectedRevision: 1,
            expectedCompanyTimeZone: "UTC",
            enabled: false,
            minimumTravelGapMinutes: 0,
            maxConcurrentReservations: null,
            durationPresets: f.saved!.policy!.durationPresets,
          })
        : kind === "inspection"
          ? updateOrgSettings(
              f.org,
              {
                inspectionAvailability: {
                  ...DEFAULT_INSPECTION_AVAILABILITY,
                  timezone: "America/Chicago",
                  maxBookingsPerWindow: 2,
                },
              },
              f.actor,
            )
          : policy.setSchedulingCompanyTimeZone(
              f.actor,
              f.org,
              "Europe/London",
              "UTC",
            ));
    };
    let response: Awaited<ReturnType<typeof create>>;
    if (changeFirst) {
      [, response] = await race(
        `${kind}/${configured}/change-first`,
        await barrier(
          kind === "zone" ? "organizations" : "org_settings",
          f,
          "UPDATE",
        ),
        change,
        () => create(f, c),
      );
    } else {
      [response] = await race(
        `${kind}/${configured}/booking-first`,
        await barrier("appointments", f),
        () => create(f, c),
        change,
      );
    }
    expect(response.status).toBe(changeFirst ? 409 : 201);
    expect(response.ack!.refusalCode).toBe(
      changeFirst ? "stale_scheduling_review" : null,
    );
    const after = await effects(f);
    nativeEffects(f, c, response.ack!, before, after);
    const configActions =
      kind === "policy"
        ? ["scheduling.policy_saved"]
        : kind === "zone"
          ? [
              "scheduling.company_timezone_changed",
              "organization.timezone_updated",
            ]
          : [
              ...(configured ? ["scheduling.inspection_changed"] : []),
              "settings.updated",
            ];
    exactAudits(before, after, [
      ...configActions,
      ...(changeFirst ? refused : admitted),
    ]);
    const nextPolicy = after.settings[0].schedulingPolicy;
    if (configured) {
      expect(nextPolicy).toMatchObject({
        formatVersion: 1,
        revision: 2,
        enabled: kind !== "policy",
        minimumTravelGapMinutes: kind === "policy" ? 0 : 60,
        maxConcurrentReservations: null,
        durationPresets: f.saved!.policy!.durationPresets,
        timeZone: kind === "zone" ? "Europe/London" : "UTC",
        updatedByUserId: f.owner,
      });
    } else expect(nextPolicy).toBeNull();
    expect(after.organizations).toEqual(
      before.organizations.map((row) => ({
        ...row,
        timezone: kind === "zone" ? "Europe/London" : row.timezone,
        updatedAt:
          kind === "zone" ? after.organizations[0].updatedAt : row.updatedAt,
      })),
    );
    if (kind === "zone")
      expect(after.organizations[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.organizations[0].updatedAt.getTime(),
      );
    expect(after.settings[0].inspectionAvailability).toEqual(
      kind === "inspection"
        ? {
            ...DEFAULT_INSPECTION_AVAILABILITY,
            timezone: "America/Chicago",
            maxBookingsPerWindow: 2,
          }
        : before.settings[0].inspectionAvailability,
    );
    for (const audit of added(before.audits, after.audits).filter((a) =>
      configActions.includes(a.action),
    )) {
      expect(audit.actorUserId).toBe(f.actor.userId);
      if (audit.action.startsWith("scheduling."))
        expect(audit.metadata).toEqual({
          previousPolicy: before.settings[0].schedulingPolicy,
          policy: nextPolicy,
        });
      else if (audit.action === "settings.updated")
        expect(audit.metadata).toEqual({ fields: ["inspectionAvailability"] });
      else
        expect(audit.metadata).toEqual({
          previousTimeZone: "UTC",
          timeZone: "Europe/London",
          policyRevision: 2,
        });
    }
    expect(after.lifecycle).toEqual(before.lifecycle);
    if (changeFirst) expect(eventCalls(f)).toEqual([]);
    await replayUnchanged(f, c, response.ack!);
  },
  30000,
);

it.each([false, true])(
  "native HTTP lifecycle ordering pauseFirst=%s keeps held work distinct from terminal refusal",
  async (pauseFirst) => {
    const f = await fixture(),
      c = await command(f),
      before = await effects(f);
    const pause = () =>
      transitionCustomerLifecycle(f.org, f.owner, {
        action: "pause",
        expectedVersion: 0,
        reason: "Synthetic native lifecycle ordering",
      });
    let response: Awaited<ReturnType<typeof create>>;
    if (pauseFirst)
      [, response] = await race(
        "lifecycle/pause-first",
        await barrier("customer_lifecycle", f),
        pause,
        () => create(f, c),
      );
    else
      [response] = await race(
        "lifecycle/booking-first",
        await barrier("appointments", f),
        () => create(f, c),
        pause,
      );
    const after = await effects(f);
    expect(after.lifecycle).toHaveLength(1);
    expect(after.lifecycle[0]).toMatchObject({
      state: "paused",
      version: 1,
      updatedByUserId: f.owner,
      reason: "Synthetic native lifecycle ordering",
    });
    const audit = added(before.audits, after.audits).find(
      (a) => a.action === "customer_lifecycle.pause",
    )!;
    expect(audit).toMatchObject({
      actorUserId: f.owner,
      entityType: "organization",
      entityId: f.org,
    });
    expect(audit.metadata).toEqual({
      from: "active",
      to: "paused",
      version: 1,
      requestId: null,
      reason: "Synthetic native lifecycle ordering",
      resumeQueuedWork: false,
      deletionPerformed: false,
      billingChanged: false,
    });
    if (pauseFirst) {
      expect(response.status).toBe(423);
      expect(response.json).toMatchObject({
        code: "customer_lifecycle_paused",
      });
      expect(response.ack).toBeNull();
      expect(after.appointments).toEqual(before.appointments);
      expect(after.reminders).toEqual(before.reminders);
      expect(after.projects).toEqual(before.projects);
      expect(after.tasks).toEqual(before.tasks);
      expect(eventCalls(f)).toEqual([]);
    } else {
      expect(response.status).toBe(201);
      nativeEffects(f, c, response.ack!, before, after);
    }
    expect(after.settings).toEqual(before.settings);
    expect(after.organizations).toEqual(before.organizations);
    expect(after.contacts).toEqual(before.contacts);
    expect(after.leads).toEqual(before.leads);
    exactAudits(before, after, [
      "customer_lifecycle.pause",
      ...(pauseFirst ? [] : admitted),
    ]);
    // Current lifecycle authority also gates receipt reads/replays. Neither a
    // held request nor absence of a target is terminal no-commit proof.
    const events = eventCalls(f),
      heldReplay = await create(f, c);
    expect(heldReplay.status).toBe(423);
    expect(heldReplay.json).toMatchObject({
      code: "customer_lifecycle_paused",
    });
    expect(heldReplay.ack).toBeNull();
    const heldReconcile = await f.request(
      "/scheduling/operations/reconcile",
      c,
    );
    expect(heldReconcile.status).toBe(423);
    expect(await heldReconcile.json()).toMatchObject({
      code: "customer_lifecycle_paused",
    });
    expect(await effects(f)).toEqual(after);
    expect(eventCalls(f)).toEqual(events);
    await transitionCustomerLifecycle(f.org, f.owner, {
      action: "resume",
      expectedVersion: 1,
      reason: "Synthetic native lifecycle resume",
      resumeQueuedWork: true,
    });
    const resumed = await effects(f);
    exactAudits(after, resumed, ["customer_lifecycle.resume"]);
    expect(added(after.audits, resumed.audits)[0]).toMatchObject({
      actorUserId: f.owner,
      entityType: "organization",
      entityId: f.org,
      metadata: {
        from: "paused",
        to: "active",
        version: 2,
        requestId: null,
        reason: "Synthetic native lifecycle resume",
        resumeQueuedWork: true,
        deletionPerformed: false,
        billingChanged: false,
      },
    });
    expect(resumed.lifecycle[0]).toMatchObject({
      state: "active",
      version: 2,
      updatedByUserId: f.owner,
    });
    expect(resumed.appointments).toEqual(after.appointments);
    expect(resumed.projects).toEqual(after.projects);
    expect(resumed.reminders).toEqual(after.reminders);
    expect(resumed.tasks).toEqual(after.tasks);
    if (pauseFirst) {
      const ack = await reconcile(f, c),
        fenced = await effects(f);
      expect(ack.refusalCode).toBe("original_create_fenced");
      nativeEffects(f, c, ack, resumed, fenced);
      exactAudits(resumed, fenced, refused);
      await replayUnchanged(f, c, ack);
    } else await replayUnchanged(f, c, response.ack!);
  },
  30000,
);

it.each(["duplicate", "reconcile", "reconcile-first"] as const)(
  "native domain refusal and %s preserve one terminal effect set",
  async (mode) => {
    const f = await fixture(),
      original = await command(f);
    const c: ManualSchedulingCommand = {
      ...original,
      body: {
        ...original.body,
        scheduledStart: "2000-01-01T09:00:00-05:00",
        scheduledEnd: "2000-01-01T10:00:00-05:00",
      },
    };
    const before = await effects(f),
      hold = await barrier(
        "audit_events",
        f,
        "INSERT",
        `NEW.id='${c.operationId}'::uuid`,
      );
    let ack: ManualSchedulingAck;
    if (mode === "reconcile-first") {
      const [fence, response] = await race(
        mode,
        hold,
        () => reconcile(f, c),
        () => create(f, c),
      );
      expect(response.status).toBe(409);
      expect(response.ack).toEqual(fence);
      ack = fence;
      expect(ack.refusalCode).toBe("original_create_fenced");
    } else {
      const [response, waiting] = await race(
        mode,
        hold,
        () => create(f, c),
        async () =>
          mode === "duplicate" ? (await create(f, c)).ack : reconcile(f, c),
      );
      expect(response.status).toBe(409);
      expect(waiting).toEqual(response.ack);
      ack = response.ack!;
      expect(ack.refusalCode).toBe("past_start");
    }
    const after = await effects(f);
    nativeEffects(f, c, ack, before, after);
    exactAudits(before, after, refused);
    expect(after.settings).toEqual(before.settings);
    expect(after.organizations).toEqual(before.organizations);
    expect(after.lifecycle).toEqual(before.lifecycle);
    expect(eventCalls(f)).toEqual([]);
    await replayUnchanged(f, c, ack);
    // Same operation cannot cross original source, actor or tenant boundaries.
    const foreign = await fixture(),
      foreignCommand = {
        ...(await command(foreign)),
        operationId: c.operationId,
      };
    const ownBefore = await effects(f),
      foreignBefore = await effects(foreign);
    const crossTenant = await create(foreign, foreignCommand);
    expect(crossTenant.status).toBe(409);
    expect(crossTenant.json).toEqual({
      error: "This operation identity cannot be used for this command.",
      code: "operation_identity_conflict",
    });
    expect(crossTenant.ack).toBeNull();
    expect(await effects(foreign)).toEqual(foreignBefore);
    expect(await effects(f)).toEqual(ownBefore);
    const otherActor = { ...f, request: await f.client(f.survivor) };
    const actorResult = await create(otherActor, c);
    expect(actorResult.status).toBe(409);
    expect(actorResult.json).toEqual(crossTenant.json);
    expect(actorResult.ack).toBeNull();
    expect(await effects(f)).toEqual(ownBefore);
    const [otherLead] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org, contactId: f.contact })
      .returning();
    const otherSource = {
      ...(await command({ ...f, lead: otherLead.id })),
      operationId: c.operationId,
    };
    const sourceBefore = await effects(f),
      sourceResult = await create(f, otherSource);
    expect(sourceResult.status).toBe(409);
    expect(sourceResult.json).toEqual(crossTenant.json);
    expect(sourceResult.ack).toBeNull();
    expect(await effects(f)).toEqual(sourceBefore);
    expect(eventCalls(f)).toEqual([]);
  },
  30000,
);

async function protectedProject(f: F) {
  const c = await command(f, "project"),
    before = await effects(f),
    response = await create(f, c);
  expect(response.status).toBe(201);
  const after = await effects(f);
  nativeEffects(f, c, response.ack!, before, after);
  exactAudits(before, after, [...admitted, "project.created"]);
  expect(
    added(before.audits, after.audits).find(
      (row) => row.action === "project.created",
    ),
  ).toMatchObject({
    organizationId: f.org,
    actorUserId: f.owner,
    entityType: "project",
    entityId: response.ack!.target!.id,
  });
  expect(eventCalls(f)).toEqual([]);
  await policy.saveSchedulingPolicy(f.actor, {
    expectedRevision: 1,
    expectedCompanyTimeZone: "UTC",
    enabled: false,
    minimumTravelGapMinutes: 0,
    maxConcurrentReservations: null,
    durationPresets: f.saved!.policy!.durationPresets,
  });
  const row = after.projects[0];
  const patch = {
    crewUserIds: [f.survivor],
    expectedUpdatedAt: row.updatedAt.toISOString(),
    expectedTargetFingerprint: policy.schedulingTargetFingerprint(
      "project",
      row,
    ),
  };
  UpdateProjectBody.parse(patch);
  const release = async () => {
    const result = await f.request(`/projects/${row.id}`, patch, "PATCH");
    expect(result.status).toBe(200);
    return UpdateProjectResponse.parse(await result.json());
  };
  return { c, ack: response.ack!, row, release };
}
function releasedEffects(f: F, before: Effects, after: Effects) {
  expect(after.projects).toHaveLength(1);
  const old = before.projects[0],
    current = after.projects[0];
  const snapshot = reservationSnapshotSchema.parse(old.schedulingReservation),
    released = reservationSnapshotSchema.parse(current.schedulingReservation);
  expect(released).toEqual({
    ...snapshot,
    reservationRevision: 2,
    resourceUserIds: [f.survivor],
    lastTransition: {
      kind: "release",
      actorUserId: f.owner,
      at: released.lastTransition.at,
    },
  });
  expect(current).toEqual({
    ...old,
    crewUserIds: [f.survivor],
    schedulingReservation: released,
    updatedAt: current.updatedAt,
  });
  const transitions = added(before.audits, after.audits).filter(
    (a) => a.action === SCHEDULING_TRANSITION_ACTION && a.entityId === old.id,
  );
  expect(transitions).toHaveLength(1);
  const transition = schedulingTransitionSchema.parse(transitions[0].metadata);
  expect(transitions[0].actorUserId).toBe(f.owner);
  expect(transition).toEqual({
    formatVersion: 1,
    transition: "release",
    origin: "manual",
    sourceId: null,
    source: {
      sourceKind: "lead",
      leadId: f.lead,
      contactId: f.contact,
      propertyId: null,
      estimateId: null,
    },
    before: snapshot,
    after: released,
    target: { kind: "project", id: old.id },
    invalidHistoricalEvidenceRetained: false,
    recordedAt: transition.recordedAt,
  });
  expect(after.tasks).toEqual(before.tasks);
  expect(after.contacts).toEqual(before.contacts);
  expect(after.leads).toEqual(before.leads);
  expect(after.settings).toEqual(before.settings);
  expect(after.organizations).toEqual(before.organizations);
  expect(after.lifecycle).toEqual(before.lifecycle);
}
it.each(["removed", "surviving"] as const)(
  "partial crew release vs %s staff admission retains both observed orders",
  async (resource) => {
    for (const releaseFirst of [false, true]) {
      const f = await fixture(),
        project = await protectedProject(f),
        baseCommand = await command(f);
      const c: ManualSchedulingCommand = {
        ...baseCommand,
        body: {
          ...baseCommand.body,
          assignedUserId: resource === "removed" ? f.owner : f.survivor,
          scheduledStart: "2035-01-01T10:30:00-05:00",
          scheduledEnd: "2035-01-01T11:30:00-05:00",
        },
      };
      const before = await effects(f);
      let response: Awaited<ReturnType<typeof create>>;
      if (releaseFirst)
        [, response] = await race(
          `release/${resource}/release-first`,
          await barrier("projects", f, "UPDATE"),
          project.release,
          () => create(f, c),
        );
      else
        [response] = await race(
          `release/${resource}/admission-first`,
          await barrier(
            "audit_events",
            f,
            "INSERT",
            `NEW.id='${c.operationId}'::uuid`,
          ),
          () => create(f, c),
          project.release,
        );
      const commits = releaseFirst && resource === "removed";
      expect(response.status).toBe(commits ? 201 : 409);
      expect(response.ack!.refusalCode).toBe(
        commits ? null : "travel_conflict",
      );
      const after = await effects(f);
      releasedEffects(f, before, after);
      nativeEffects(
        f,
        c,
        response.ack!,
        { ...before, projects: after.projects },
        after,
      );
      exactAudits(before, after, [
        SCHEDULING_TRANSITION_ACTION,
        ...(commits ? admitted : refused),
      ]);
      await replayUnchanged(f, c, response.ack!);
      await replayUnchanged(f, project.c, project.ack);
    }
  },
  60000,
);
it.each([false, true])(
  "partial crew release and cleanup preserve participant and custody cleanupFirst=%s",
  async (cleanupFirst) => {
    const f = await fixture(),
      project = await protectedProject(f),
      before = await effects(f);
    const cleanup = () =>
      deleteContact(f.org, f.contact).then(
        () => "unexpected deletion",
        (error: { code: string }) => error.code,
      );
    let cleanupResult: string;
    if (cleanupFirst)
      [cleanupResult] = await race(
        "release/cleanup-first",
        await contactBarrier(f),
        cleanup,
        project.release,
      );
    else
      [, cleanupResult] = await race(
        "release/release-first",
        await barrier("projects", f, "UPDATE"),
        project.release,
        cleanup,
      );
    expect(cleanupResult).toBe("scheduling_history_retained");
    const after = await effects(f);
    releasedEffects(f, before, after);
    expect(after.appointments).toEqual(before.appointments);
    expect(after.reminders).toEqual(before.reminders);
    exactAudits(before, after, [SCHEDULING_TRANSITION_ACTION]);
    expect(eventCalls(f)).toEqual([]);
    await replayUnchanged(f, project.c, project.ack);
  },
  30000,
);
