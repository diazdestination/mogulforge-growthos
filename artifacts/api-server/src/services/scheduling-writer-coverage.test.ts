/** Runtime writer matrix: original native rows and source receipts, no static call-site claims. */
import { createHash, randomUUID } from "node:crypto";
import * as generated from "@workspace/api-zod";
import {
  createCustomerWorkProjectSchema,
  updateCustomerWorkProjectSchema,
} from "./returning-customer-contract";
import { customerWorkHash } from "./customer-work-lineage";
import {
  careFingerprint,
  serviceCareBookingSchema,
} from "./service-care-policy";
import {
  callieBookingSchema,
  canonicalCallieBookingInput,
} from "./callie-office-contract";
import { afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  conversationsTable,
  db,
  leadsTable,
  orgSettingsTable,
  projectsTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  returningCustomerFixture,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import { callieOfficeFixture } from "../test-helpers/callie-office-fixture";
import { getContractorToday } from "./contractor-today";
import { updateOrgSettings } from "./settings";
import {
  readSchedulingPolicy,
  saveSchedulingPolicy,
  getSchedulingReviewContext,
} from "./scheduling-policy";
import {
  createManualScheduledAppointment,
  createManualScheduledProject,
} from "./manual-scheduling";
import { createCustomerWorkProject } from "./returning-customer";
import { createServiceObligation } from "./service-obligations";
import {
  bookServiceCareVisit,
  getServiceCare,
  recordServiceCareResponse,
} from "./service-care";
import { bookCallieVisit, getCallieSchedulingContext } from "./callie-office";
import { bookInspectionSlot, generateInspectionSlots } from "./concierge";
const orgs: string[] = [];
afterAll(() => deleteTestOrgs(...orgs));
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
async function configure(org: string, userId: string, gap = 60) {
  const actor = { organizationId: org, userId },
    current = await readSchedulingPolicy(actor);
  return saveSchedulingPolicy(actor, {
    expectedRevision: current.context.policyRevision,
    expectedCompanyTimeZone: current.context.companyTimeZone,
    enabled: true,
    minimumTravelGapMinutes: gap,
    maxConcurrentReservations: 2,
    durationPresets: [],
  });
}
async function evidence(
  org: string,
  targetId: string,
  origin: string,
  sourceId: string | null,
  actor: string | null,
  kind = "appointment",
  reader = actor,
) {
  const rows =
    kind === "project"
      ? await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.organizationId, org))
      : await db
          .select()
          .from(appointmentsTable)
          .where(eq(appointmentsTable.organizationId, org));
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(targetId);
  expect(rows[0].schedulingReservation).toMatchObject({
    formatVersion: 1,
    target: { kind, id: targetId },
    admittedByUserId: actor,
    minimumTravelGapMinutes: 60,
  });
  const events = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, org),
        eq(auditEventsTable.action, "scheduling.reservation_transition.v1"),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorUserId: actor,
    metadata: { origin, sourceId },
  });
  const today = await getContractorToday(org, reader!, {
    date: rows[0].scheduledStart!.toISOString().slice(0, 10),
    scope: "company",
  });
  const projected = (
    kind === "project" ? today.projects.items : today.appointments.items
  ).find((row) => row.id === targetId);
  expect(projected).toMatchObject({
    schedulingEvidence: "versioned",
    schedulingReservation: rows[0].schedulingReservation,
  });
}
it.each(["appointment", "project"] as const)(
  "native %s receipt replays after policy change without a second admission",
  async (kind) => {
    const f = await returningCustomerFixture();
    orgs.push(f.org);
    await configure(f.org, f.owner.id);
    const [lead] = await db
      .insert(leadsTable)
      .values({
        organizationId: f.org,
        contactId: f.contact.id,
        propertyId: f.firstProperty.id,
      })
      .returning();
    const actor = { organizationId: f.org, userId: f.owner.id },
      context = await getSchedulingReviewContext(actor, {
        sourceKind: "lead",
        sourceId: lead.id,
        propertyId: f.firstProperty.id,
        reservationKind: kind,
        ...(kind === "appointment"
          ? { appointmentType: "other" as const }
          : {}),
      });
    const operationId = randomUUID();
    const run = () =>
      kind === "appointment"
        ? createManualScheduledAppointment(actor, {
            operationId,
            kind: "appointment_create",
            body: {
              ...interval,
              leadId: lead.id,
              contactId: f.contact.id,
              propertyId: f.firstProperty.id,
              type: "other",
              assignedUserId: f.owner.id,
            },
            review: reviewed(context),
          })
        : createManualScheduledProject(actor, {
            operationId,
            kind: "project_create",
            body: {
              ...interval,
              leadId: lead.id,
              name: "Synthetic native project",
              crewUserIds: [f.owner.id],
            },
            review: reviewed(context),
          });
    const first = await run();
    expect(first.ack.outcome).toBe("committed");
    const id = first.ack.target!.id;
    await configure(f.org, f.owner.id, 90);
    expect((await run()).ack).toEqual(first.ack);
    await evidence(f.org, id, "manual", null, f.owner.id, kind);
  },
);
it("returning-customer project retains its actual source command and original snapshot", async () => {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await configure(f.org, f.owner.id);
  const context = await getSchedulingReviewContext(
    { organizationId: f.org, userId: f.owner.id },
    {
      sourceKind: "direct_customer",
      sourceId: f.contact.id,
      propertyId: f.secondProperty.id,
      reservationKind: "project",
    },
  );
  const input = {
      ...returningProjectDraft(f),
      ...interval,
      crewUserIds: [f.owner.id],
      schedulingReview: reviewed(context),
    },
    first = await createCustomerWorkProject(f.org, f.actor, input);
  await configure(f.org, f.owner.id, 90);
  expect(
    (await createCustomerWorkProject(f.org, f.actor, input)).commandOutcome,
  ).toEqual(first.commandOutcome);
  await evidence(
    f.org,
    first.project.id,
    "returning_command",
    input.requestId,
    f.owner.id,
    "project",
  );
  expect(first.project.leadId).toBeNull();
});
it("service-care booking retains its actual response and original booking proof", async () => {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await configure(f.org, f.owner.id);
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
      note: "Synthetic customer agreed to the reviewed service window.",
      staffAttested: true,
    },
  );
  const care = await getServiceCare(f.org, service.id, "email", {
    actorUserId: f.owner.id,
    appointmentType: "other",
  });
  if (care.scheduling.review.state !== "ready")
    throw Error("Expected source review");
  const input = {
      requestId: randomUUID(),
      expectedUpdatedAt: care.expectedUpdatedAt,
      responseId: response.responseId,
      assignedUserId: f.owner.id,
      ...interval,
      type: "other",
      customerConfirmed: true,
      schedulingReview: reviewed(care.scheduling.review.context),
    },
    first = await bookServiceCareVisit(f.org, f.owner.id, service.id, input);
  await configure(f.org, f.owner.id, 90);
  expect(
    await bookServiceCareVisit(f.org, f.owner.id, service.id, input),
  ).toEqual({ ...first, replayed: true });
  await evidence(
    f.org,
    first.appointmentId,
    "service_care",
    service.id,
    f.owner.id,
  );
});
it("CALLIE booking retains its reviewed intake and nullable-detail original proof", async () => {
  const f = await callieOfficeFixture(true);
  orgs.push(f.org);
  await configure(f.org, f.owner.id);
  const read = await getCallieSchedulingContext(
    f.org,
    f.owner.id,
    f.intake.id,
    { appointmentType: "other", propertyId: f.property.id },
  );
  if (read.review.state !== "ready") throw Error("Expected source review");
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
      confirmationNote: "Synthetic customer agreed to the reviewed window.",
      customerConfirmed: true,
      schedulingReview: reviewed(read.review.context),
    },
    first = await bookCallieVisit(f.org, f.owner.id, f.intake.id, input);
  await configure(f.org, f.owner.id, 90);
  expect(
    await bookCallieVisit(f.org, f.owner.id, f.intake.id, input),
  ).toMatchObject({
    detail: null,
    replayed: true,
    bookingOutcome: first.bookingOutcome,
  });
  await evidence(
    f.org,
    first.bookingOutcome.appointmentId,
    "callie",
    f.intake.id,
    f.owner.id,
  );
});
it("concierge is the actual stored conversation source with an unassigned null-actor reservation", async () => {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await configure(f.org, f.owner.id);
  await updateOrgSettings(
    f.org,
    {
      inspectionAvailability: {
        timezone: "UTC",
        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        windows: [{ startHour: 9, endHour: 11 }],
        blackoutDates: [],
        maxBookingsPerWindow: 2,
      },
    },
    { organizationId: f.org, userId: f.owner.id },
  );
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: f.firstProperty.id,
    })
    .returning();
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      organizationId: f.org,
      leadId: lead.id,
      contactId: f.contact.id,
      state: {
        step: "scheduling",
        urgency: "normal",
        consentGranted: true,
        leadId: lead.id,
        contactId: f.contact.id,
        propertyId: f.firstProperty.id,
      },
    })
    .returning();
  const [slot] = await generateInspectionSlots(f.org, {
      conversationId: conversation.id,
    }),
    input = { organizationId: f.org, conversationId: conversation.id, slot };
  const first = await bookInspectionSlot(input);
  expect(first).not.toBeNull();
  await configure(f.org, f.owner.id, 90);
  expect(await bookInspectionSlot(input)).toEqual({
    id: first!.id,
    replayed: true,
  });
  await evidence(
    f.org,
    first!.id,
    "concierge",
    conversation.id,
    null,
    "appointment",
    f.owner.id,
  );
});

it("preserves each actual historical source hash through generated parsing and wire JSON", () => {
  const id = "ABCDEF12-1111-4111-8111-111111111111",
    other = "11111111-1111-4111-8111-111111111111";
  const a = createCustomerWorkProjectSchema.parse({
    requestId: id,
    confirmed: true,
    source: { kind: "existing_customer", contactId: other, propertyId: null },
    name: "  Synthetic source hash  ",
    status: "scheduled",
    scheduledStart: "2035-01-01T10:00:00.123456Z",
    scheduledEnd: "2035-01-01T11:00:00Z",
    crewUserIds: [" tech-b ", "tech-a"],
    crewNotes: null,
  });
  const wireA = JSON.parse(
      JSON.stringify(generated.CreateCustomerWorkProjectBody.parse(a)),
    ),
    envelope = (input: unknown) => ({
      action: "project_created",
      targetId: null,
      input,
      actorUserId: "synthetic",
    });
  expect(customerWorkHash(envelope(wireA))).toBe(customerWorkHash(envelope(a)));
  expect(wireA).toEqual(a);
  const { source, ...rest } = a,
    update = updateCustomerWorkProjectSchema.parse({
      ...rest,
      expectedWorkVersion: 1,
    }),
    wireUpdate = JSON.parse(
      JSON.stringify(generated.UpdateCustomerWorkProjectBody.parse(update)),
    );
  expect(
    customerWorkHash({
      action: "project_updated",
      targetId: other,
      input: wireUpdate,
      actorUserId: "synthetic",
    }),
  ).toBe(
    customerWorkHash({
      action: "project_updated",
      targetId: other,
      input: update,
      actorUserId: "synthetic",
    }),
  );
  const b = serviceCareBookingSchema.parse({
      requestId: id,
      expectedUpdatedAt: "2035-01-01T00:00:00.123456Z",
      responseId: other,
      assignedUserId: "synthetic",
      scheduledStart: "2035-01-02T09:00:00Z",
      scheduledEnd: "2035-01-02T10:00:00.000Z",
      type: "other",
      customerConfirmed: true,
    }),
    wireB = JSON.parse(
      JSON.stringify(generated.BookServiceCareVisitBody.parse(b)),
    );
  expect(careFingerprint(wireB)).toBe(careFingerprint(b));
  expect(wireB).toEqual(b);
  const c = callieBookingSchema.parse({
      requestId: id,
      expectedVersion: 1,
      expectedFingerprint: "a".repeat(64),
      contactId: other,
      leadId: null,
      propertyId: null,
      assignedUserId: "synthetic",
      type: "other",
      scheduledStart: "2035-01-02T09:00:00Z",
      scheduledEnd: "2035-01-02T10:00:00.123456Z",
      confirmationNote: "  Synthetic exact customer confirmation.  ",
      customerConfirmed: true,
    }),
    wireC = JSON.parse(JSON.stringify(generated.BookCallieVisitBody.parse(c)));
  expect(
    createHash("sha256")
      .update(canonicalCallieBookingInput(wireC))
      .digest("hex"),
  ).toBe(careFingerprint(c));
  expect(wireC).toEqual(c);
});
