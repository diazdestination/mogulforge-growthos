import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  appointmentsTable,
  auditEventsTable,
  db,
  organizationsTable,
  scheduledActionsTable,
  usersTable,
  projectsTable,
  crmTasksTable,
  pool,
  orgSettingsTable,
  customerLifecycleTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  canonicalSchedulingEnvelope,
  manualSchedulingAckSchema,
} from "@workspace/scheduling-core";
import { z } from "zod/v4";
import { ManualSchedulingErrorSchema } from "@workspace/api-zod";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import * as automation from "./automation";
import * as crm from "./crm";
import { ScheduleError } from "./contractor-scheduling";
import { saveSchedulingPolicy } from "./scheduling-policy";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getSchedulingReviewContext } from "./scheduling-policy";
import {
  createManualScheduledAppointment,
  createManualScheduledProject,
} from "./manual-scheduling";
const orgs: string[] = [];
const nativeResponse = z.object({
  id: z.string(),
  schedulingOperation: manualSchedulingAckSchema,
});
const sessions: string[] = [];
const transport = globalThis.fetch;
let server: Server, base: string;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-native-scheduling-test-secret");
  vi.stubEnv("APP_ORIGIN", "https://native-scheduling.example");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  vi.spyOn(automation, "emitAutomationEvent").mockImplementation(() => {});
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture(configured = false) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic native route",
      slug: randomUUID(),
      timezone: "UTC",
    })
    .returning();
  orgs.push(org.id);
  const [user] = await db
    .insert(usersTable)
    .values({ organizationId: org.id, role: "owner" })
    .returning();
  const actor = { organizationId: org.id, userId: user.id };
  if (configured)
    await saveSchedulingPolicy(actor, {
      expectedRevision: 0,
      expectedCompanyTimeZone: "UTC",
      enabled: true,
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: null,
      durationPresets: [],
    });
  const context = await getSchedulingReviewContext(actor, {
    sourceKind: "unlinked_manual",
    reservationKind: "appointment",
    appointmentType: "production",
  });
  const command = {
    operationId: randomUUID(),
    kind: "appointment_create" as const,
    body: {
      type: "production" as const,
      scheduledStart: "2035-01-01T05:00:00-05:00",
      scheduledEnd: "2035-01-01T06:00:00-05:00",
    },
    review: {
      context,
      duration: { kind: "explicit" as const, preset: null },
      startWallTime: null,
      endWallTime: null,
    },
  };
  const sid = await createSession({
    user: {
      id: user.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic",
  });
  sessions.push(sid);
  const post = (
    body: unknown,
    path = "/appointments",
    extra: Record<string, string> = {},
  ) =>
    transport(base + path, {
      method: "POST",
      headers: {
        origin: "https://native-scheduling.example",
        cookie: `sid=${sid}`,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  return { org: org.id, actor, command, post };
}
it("native manual original and replay share one target, receipt, reminder and exact wire identity", async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic manual native",
      slug: randomUUID(),
      timezone: "UTC",
    })
    .returning();
  orgs.push(org.id);
  const [user] = await db
    .insert(usersTable)
    .values({ organizationId: org.id, role: "owner" })
    .returning();
  const actor = { organizationId: org.id, userId: user.id };
  const context = await getSchedulingReviewContext(actor, {
    sourceKind: "unlinked_manual",
    reservationKind: "appointment",
    appointmentType: "production",
  });
  const command = {
    operationId: randomUUID(),
    kind: "appointment_create" as const,
    body: {
      type: "production" as const,
      scheduledStart: "2035-01-01T05:00:00-05:00",
      scheduledEnd: "2035-01-01T06:00:00-05:00",
    },
    review: {
      context,
      duration: { kind: "explicit" as const, preset: null },
      startWallTime: null,
      endWallTime: null,
    },
  };
  const first = await createManualScheduledAppointment(actor, command),
    second = await createManualScheduledAppointment(actor, command);
  expect(first.newlyCreated).toBe(true);
  expect(second.newlyCreated).toBe(false);
  expect(second.ack).toEqual(first.ack);
  expect(second.record?.id).toBe(first.record?.id);
  expect(
    await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, org.id)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, org.id)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, command.operationId)),
  ).toHaveLength(1);
});
it("native HTTP hashes original offset spelling before Date coercion and emits booked only once", async () => {
  const f = await fixture(true),
    wire = {
      ...f.command.body,
      operationId: f.command.operationId,
      schedulingReview: f.command.review,
    },
    spy = vi.mocked(automation.emitAutomationEvent);
  spy.mockClear();
  const first = await f.post(wire);
  expect(first.status).toBe(201);
  const body = nativeResponse.parse(await first.json());
  const hash = createHash("sha256")
    .update(
      canonicalSchedulingEnvelope({
        organizationId: f.org,
        actorUserId: f.actor.userId,
        kind: f.command.kind,
        body: f.command.body,
        review: f.command.review,
      }),
    )
    .digest("hex");
  expect(body.schedulingOperation.payloadSha256).toBe(hash);
  const second = await f.post(wire);
  expect(second.status).toBe(200);
  expect(nativeResponse.parse(await second.json()).id).toBe(body.id);
  expect(spy).toHaveBeenCalledTimes(1);
  await db
    .update(orgSettingsTable)
    .set({
      schedulingPolicy: sql`${orgSettingsTable.schedulingPolicy} || '{"digest":"0000000000000000000000000000000000000000000000000000000000000000"}'::jsonb`,
    })
    .where(eq(orgSettingsTable.organizationId, f.org));
  expect((await f.post(wire)).status).toBe(200);
  await db.delete(appointmentsTable).where(eq(appointmentsTable.id, body.id));
  const missing = await f.post(wire);
  expect(missing.status).toBe(409);
  const unavailable = ManualSchedulingErrorSchema.parse(await missing.json());
  expect(unavailable).toMatchObject({
    code: "manual_scheduling_target_unavailable",
    schedulingOperation: {
      outcome: "committed",
      target: { id: body.id, available: false },
    },
  });
  expect(spy).toHaveBeenCalledTimes(1);
});
it("native deterministic refusal is a retained typed409 and never retries the operation", async () => {
  const f = await fixture(true),
    original = {
      ...f.command,
      body: {
        ...f.command.body,
        scheduledStart: "2000-01-01T10:00:00Z",
        scheduledEnd: "2000-01-01T11:00:00Z",
      },
    },
    wire = {
      ...original.body,
      operationId: original.operationId,
      schedulingReview: original.review,
    };
  const response = await f.post(wire);
  expect(response.status).toBe(409);
  const refused = ManualSchedulingErrorSchema.parse(await response.json());
  expect(refused).toMatchObject({
    code: "manual_scheduling_refused",
    schedulingOperation: {
      outcome: "no_commit_refused",
      refusalCode: "past_start",
      target: null,
    },
  });
  expect(
    ManualSchedulingErrorSchema.parse(await (await f.post(wire)).json())
      .schedulingOperation,
  ).toEqual(refused.schedulingOperation);
  expect(
    await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org)),
  ).toHaveLength(0);
});
it("rolls back actual native reminder and target before retaining a deliberately adapted domain refusal", async () => {
  const f = await fixture(true),
    real = automation.scheduleAppointmentReminder;
  const spy = vi
    .spyOn(automation, "scheduleAppointmentReminder")
    .mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new ScheduleError("resource_conflict");
    });
  try {
    expect(
      (await createManualScheduledAppointment(f.actor, f.command)).ack
        .refusalCode,
    ).toBe("resource_conflict");
    expect(
      await db
        .select()
        .from(appointmentsTable)
        .where(eq(appointmentsTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(scheduledActionsTable)
        .where(eq(scheduledActionsTable.organizationId, f.org)),
    ).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});
it.each(["lookalike", "sql"] as const)(
  "keeps actual native %s failure unknown with no receipt",
  async (mode) => {
    const f = await fixture(true),
      real = automation.scheduleAppointmentReminder;
    const spy = vi
      .spyOn(automation, "scheduleAppointmentReminder")
      .mockImplementationOnce(async (...args) => {
        await real(...args);
        if (mode === "sql") await args[3]!.execute(sql`select 1/0`);
        throw Object.assign(new Error("synthetic unknown"), {
          code: "travel_conflict",
          status: 409,
        });
      });
    try {
      await expect(
        createManualScheduledAppointment(f.actor, f.command),
      ).rejects.toBeTruthy();
      expect(
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, f.command.operationId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(appointmentsTable)
          .where(eq(appointmentsTable.organizationId, f.org)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(scheduledActionsTable)
          .where(eq(scheduledActionsTable.organizationId, f.org)),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  },
);
it("contains a postcommit lead observer error without changing the committed acknowledgement", async () => {
  const f = await fixture(),
    contact = await crm.createContact(f.org, { firstName: "Synthetic" }),
    lead = (await crm.createLead(f.org, { contactId: contact.id }))!;
  const context = await getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: lead.id,
    reservationKind: "appointment",
    appointmentType: "production",
  });
  const spy = vi
    .spyOn(crm, "getLead")
    .mockRejectedValueOnce(Error("synthetic observer failure"));
  try {
    const response = await f.post({
      ...f.command.body,
      leadId: lead.id,
      operationId: f.command.operationId,
      schedulingReview: { ...f.command.review, context },
    });
    expect(response.status).toBe(201);
    expect(
      nativeResponse.parse(await response.json()).schedulingOperation.outcome,
    ).toBe("committed");
  } finally {
    spy.mockRestore();
  }
});
it("commits project.created, native invoice task and receipt together, and SQL audit failure rolls all back", async () => {
  const f = await fixture(),
    contact = await crm.createContact(f.org, { firstName: "Synthetic" }),
    lead = (await crm.createLead(f.org, { contactId: contact.id }))!;
  const context = await getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: lead.id,
    reservationKind: "project",
  });
  const command = {
    operationId: randomUUID(),
    kind: "project_create" as const,
    body: {
      leadId: lead.id,
      name: "Completed synthetic",
      status: "completed" as const,
    },
    review: { ...f.command.review, context },
  };
  const hook = `qa_native_audit_${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid AND NEW.action='project.created' THEN PERFORM 1/0; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
  );
  try {
    await expect(
      createManualScheduledProject(f.actor, command),
    ).rejects.toBeTruthy();
    expect(
      await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(crmTasksTable)
        .where(eq(crmTasksTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, command.operationId)),
    ).toHaveLength(0);
  } finally {
    await pool.query(`DROP TRIGGER ${hook} ON audit_events`);
    await pool.query(`DROP FUNCTION ${hook}()`);
  }
  const first = await createManualScheduledProject(f.actor, command),
    second = await createManualScheduledProject(f.actor, command);
  expect(second.ack).toEqual(first.ack);
  expect(
    await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.organizationId, f.org)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "project.created"),
        ),
      ),
  ).toHaveLength(1);
});
it("projects expose original HTTP committed/refused/unavailable acknowledgements and roll status audit failures back", async () => {
  const f = await fixture(true),
    contact = await crm.createContact(f.org, { firstName: "Synthetic" }),
    lead = (await crm.createLead(f.org, { contactId: contact.id }))!;
  const context = await getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: lead.id,
    reservationKind: "project",
  });
  const wire = {
    operationId: randomUUID(),
    leadId: lead.id,
    name: "Original HTTP project",
    scheduledStart: "2035-01-01T10:00:00Z",
    scheduledEnd: "2035-01-01T11:00:00Z",
    schedulingReview: { ...f.command.review, context },
  };
  const first = await f.post(wire, "/projects");
  expect(first.status).toBe(201);
  const original = nativeResponse.parse(await first.json());
  await saveSchedulingPolicy(f.actor, {
    expectedRevision: 1,
    expectedCompanyTimeZone: "UTC",
    enabled: true,
    minimumTravelGapMinutes: 0,
    maxConcurrentReservations: null,
    durationPresets: [],
  });
  const replay = await f.post(wire, "/projects");
  expect(replay.status).toBe(200);
  expect(nativeResponse.parse(await replay.json())).toEqual(original);
  const refused = await f.post(
    { ...wire, operationId: randomUUID() },
    "/projects",
  );
  expect(refused.status).toBe(409);
  expect(ManualSchedulingErrorSchema.parse(await refused.json())).toMatchObject(
    {
      code: "manual_scheduling_refused",
      schedulingOperation: {
        outcome: "no_commit_refused",
        refusalCode: "stale_scheduling_review",
      },
    },
  );
  const hook = `qa_native_status_${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.org}'::uuid AND NEW.action='project.status_changed' THEN PERFORM 1/0; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
  );
  try {
    await expect(
      crm.updateProject(f.org, original.id, { status: "completed" }, f.actor),
    ).rejects.toBeTruthy();
    expect(
      (
        await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, original.id))
      )[0].status,
    ).toBe("scheduled");
    expect(
      await db
        .select()
        .from(crmTasksTable)
        .where(eq(crmTasksTable.organizationId, f.org)),
    ).toHaveLength(0);
  } finally {
    await pool.query(`DROP TRIGGER ${hook} ON audit_events`);
    await pool.query(`DROP FUNCTION ${hook}()`);
  }
  await db.delete(projectsTable).where(eq(projectsTable.id, original.id));
  const gone = await f.post(wire, "/projects");
  expect(gone.status).toBe(409);
  expect(ManualSchedulingErrorSchema.parse(await gone.json())).toMatchObject({
    code: "manual_scheduling_target_unavailable",
    schedulingOperation: {
      outcome: "committed",
      target: { id: original.id, available: false },
    },
  });
});
it("preserves native origin/closed input, active actor and lifecycle response boundaries", async () => {
  const f = await fixture(true),
    wire = {
      ...f.command.body,
      operationId: f.command.operationId,
      schedulingReview: f.command.review,
    };
  expect((await f.post({ ...wire, schedulingReservation: {} })).status).toBe(
    400,
  );
  expect(
    (await f.post(wire, "/appointments", { origin: "https://foreign.example" }))
      .status,
  ).toBe(403);
  await db.insert(customerLifecycleTable).values({
    organizationId: f.org,
    state: "paused",
    reason: "Synthetic lifecycle hold",
  });
  const held = await f.post(wire);
  expect(held.status).toBe(423);
  expect(await held.json()).toMatchObject({
    code: "customer_lifecycle_paused",
  });
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, f.command.operationId)),
  ).toHaveLength(0);
});
it("requires original operation identity for reviewed HTTP CREATE without breaking legacy unconfigured CREATE", async () => {
  const f = await fixture();
  const refused = await f.post({
    ...f.command.body,
    schedulingReview: f.command.review,
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    code: "scheduling_operation_required",
  });
  const contact = await crm.createContact(f.org, { firstName: "Synthetic" }),
    lead = (await crm.createLead(f.org, { contactId: contact.id }))!;
  const context = await getSchedulingReviewContext(f.actor, {
    sourceKind: "lead",
    sourceId: lead.id,
    reservationKind: "project",
  });
  expect(
    (
      await f.post(
        {
          leadId: lead.id,
          name: "Reviewed without identity",
          schedulingReview: { ...f.command.review, context },
        },
        "/projects",
      )
    ).status,
  ).toBe(400);
  expect((await f.post(f.command.body)).status).toBe(201);
  expect(
    await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, f.org)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.organizationId, f.org)),
  ).toHaveLength(0);
});
