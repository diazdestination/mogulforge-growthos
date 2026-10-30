import { randomUUID } from "node:crypto";
import {
  appointmentsTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  serviceObligationsTable,
  zapierActionExecutionsTable,
  zapierCapabilityBindingsTable,
  zapierSpecialistPoliciesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  buildAppointmentReminderTextInput,
  buildServiceReminderTextInput,
  maintainRequestServiceText,
  OPT_OUT_LINE,
  rebuildZapierRequestInput,
  withOptOut,
  zapierCustomerSmsRoute,
} from "./zapier-specialist-flows";

const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

const DAY = 86_400_000;
type Execution = Parameters<typeof rebuildZapierRequestInput>[0];

async function fixture(options: { smsConsent?: boolean } = {}) {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic Texting Co", slug: `test-zap-text-${randomUUID()}`, timezone: "America/New_York" })
    .returning();
  orgs.push(org!.id);
  // Keep service-reminder tests independent of the hour they run at.
  await db.insert(orgSettingsTable).values({ organizationId: org!.id, sendingHours: { quietHoursEnabled: false } });
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org!.id, firstName: "Dana", phone: "+14045550142", email: "dana@example.test" })
    .returning();
  if (options.smsConsent !== false) {
    await db.insert(consentRecordsTable).values({ organizationId: org!.id, contactId: contact!.id, channel: "sms", granted: true, disclosureVersion: "test" });
  }
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id }).returning();
  const appointment = async (startsInMs: number, overrides: Partial<typeof appointmentsTable.$inferInsert> = {}) =>
    (
      await db
        .insert(appointmentsTable)
        .values({
          organizationId: org!.id,
          leadId: lead!.id,
          contactId: contact!.id,
          status: "scheduled",
          scheduledStart: new Date(Date.now() + startsInMs),
          ...overrides,
        })
        .returning()
    )[0]!;
  const service = async (dueInMs: number, noticeDays = 30) => {
    const [task] = await db.insert(crmTasksTable).values({ organizationId: org!.id, title: "Service due" }).returning();
    return (
      await db
        .insert(serviceObligationsTable)
        .values({
          organizationId: org!.id,
          contactId: contact!.id,
          taskId: task!.id,
          kind: "maintenance",
          equipmentLabel: "Synthetic heat pump",
          dueAt: new Date(Date.now() + dueInMs),
          noticeDays,
        })
        .returning()
    )[0]!;
  };
  return { orgId: org!.id, contact: contact!, lead: lead!, appointment, service };
}

describe("own-number customer texts", () => {
  it("adds one opt-out line and never doubles it", () => {
    expect(withOptOut("Hello.")).toBe(`Hello. ${OPT_OUT_LINE}`);
    expect(withOptOut(withOptOut("Hello."))).toBe(`Hello. ${OPT_OUT_LINE}`);
  });

  it("builds an APPT reminder text with consent and rebuilds it for approval", async () => {
    const f = await fixture();
    const visit = await f.appointment(2 * DAY);
    const built = await buildAppointmentReminderTextInput(f.orgId, visit.id);
    expect(built.input.toPhone).toBe("+14045550142");
    expect(built.input.body).toContain(OPT_OUT_LINE);
    expect(built.idempotencyKey).toBe(`appt-reminder-text:${visit.id}:${visit.scheduledStart.toISOString()}`);
    const rebuilt = await rebuildZapierRequestInput({
      capability: "appt.sms.send",
      organizationId: f.orgId,
      idempotencyKey: built.idempotencyKey,
      linkedEntityId: visit.id,
    } as Execution);
    expect(rebuilt).toEqual(built.input);
  });

  it("refuses an APPT text without consent, after a reschedule, or for another company", async () => {
    const noConsent = await fixture({ smsConsent: false });
    const visit = await noConsent.appointment(2 * DAY);
    await expect(buildAppointmentReminderTextInput(noConsent.orgId, visit.id)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/not agreed to receive texts/),
    });

    const f = await fixture();
    const booked = await f.appointment(2 * DAY);
    const built = await buildAppointmentReminderTextInput(f.orgId, booked.id);
    await db.update(appointmentsTable).set({ scheduledStart: new Date(Date.now() + 3 * DAY) }).where(eq(appointmentsTable.id, booked.id));
    await expect(
      rebuildZapierRequestInput({ capability: "appt.sms.send", organizationId: f.orgId, idempotencyKey: built.idempotencyKey, linkedEntityId: booked.id } as Execution),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/rescheduled/) });

    await expect(buildAppointmentReminderTextInput(noConsent.orgId, booked.id)).rejects.toMatchObject({ code: "not_found" });

    const cancelled = await f.appointment(2 * DAY, { status: "cancelled" });
    await expect(buildAppointmentReminderTextInput(f.orgId, cancelled.id)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("builds one MAINTAIN reminder once the notice window opens", async () => {
    const f = await fixture();
    const early = await f.service(90 * DAY, 30);
    await expect(buildServiceReminderTextInput(f.orgId, early.id)).rejects.toMatchObject({ message: expect.stringMatching(/can be sent from/) });

    const due = await f.service(10 * DAY, 30);
    const built = await buildServiceReminderTextInput(f.orgId, due.id);
    expect(built.input.body).toContain("Synthetic heat pump");
    expect(built.input.body).toContain(OPT_OUT_LINE);
    const execution = { capability: "maintain.sms.send", organizationId: f.orgId, idempotencyKey: built.idempotencyKey, linkedEntityId: due.id } as Execution;
    expect(await rebuildZapierRequestInput(execution)).toEqual(built.input);

    // Any change to the service after the request makes the approval stale.
    await db.update(serviceObligationsTable).set({ equipmentLabel: "Changed unit" }).where(eq(serviceObligationsTable.id, due.id));
    await expect(rebuildZapierRequestInput(execution)).rejects.toMatchObject({ message: expect.stringMatching(/changed/) });
  });

  it("does not text a service that already has a GrowthOS reminder or an open own-number text", async () => {
    const f = await fixture();
    const reminded = await f.service(5 * DAY);
    await db.insert(auditEventsTable).values({
      organizationId: f.orgId,
      action: "service.care_reminder_approved",
      entityType: "service_obligation",
      entityId: reminded.id,
      metadata: {},
    });
    await expect(buildServiceReminderTextInput(f.orgId, reminded.id)).rejects.toMatchObject({ message: expect.stringMatching(/already has a reminder/) });

    const texted = await f.service(5 * DAY);
    await db.insert(zapierActionExecutionsTable).values({
      organizationId: f.orgId,
      specialistId: "maintain",
      capability: "maintain.sms.send",
      direction: "write",
      zapierApp: "OpenPhoneCLIAPI",
      zapierAction: "send_message",
      idempotencyKey: `maintain-reminder-text:${texted.id}:1`,
      requestDigest: "a".repeat(64),
      requestSummary: {},
      state: "succeeded",
      detail: "Sent.",
      linkedEntityType: "service_obligation",
      linkedEntityId: texted.id,
    });
    await expect(maintainRequestServiceText({ organizationId: f.orgId, obligationId: texted.id, actorUserId: null })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("routes automated texts through Zapier only when bound, switched on and built-in texting is off", async () => {
    const f = await fixture();
    expect(await zapierCustomerSmsRoute(f.orgId, "appt.sms.send")).toBe(false);
    await db.insert(zapierCapabilityBindingsTable).values({
      organizationId: f.orgId,
      capability: "appt.sms.send",
      specialistId: "appt",
      direction: "write",
      zapierApp: "OpenPhoneCLIAPI",
      zapierAppName: "Quo",
      zapierAction: "send_message",
      zapierActionName: "Send Message",
      bindingConfig: { from: "+14045550100" },
    });
    // A bound capability with no saved policy is off by default.
    expect(await zapierCustomerSmsRoute(f.orgId, "appt.sms.send")).toBe(false);
    await db.insert(zapierSpecialistPoliciesTable).values({ organizationId: f.orgId, capability: "appt.sms.send", specialistId: "appt", mode: "approve", dailyBudget: 20 });
    expect(await zapierCustomerSmsRoute(f.orgId, "appt.sms.send")).toBe(true);
    expect(await zapierCustomerSmsRoute(f.orgId, "maintain.sms.send")).toBe(false);
  });
});
