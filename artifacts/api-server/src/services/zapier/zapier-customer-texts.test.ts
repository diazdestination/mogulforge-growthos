import { randomUUID } from "node:crypto";
import {
  appointmentsTable,
  automationsTable,
  revenueExecutionsTable,
  scheduledActionsTable,
  usersTable,
  twilioDispatchesTable,
  zapierMcpConnectionsTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  orgSettingsTable,
  serviceObligationsTable,
  zapierActionExecutionsTable,
  zapierCapabilityBindingsTable,
  zapierSpecialistPoliciesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  apptRequestReminderText,
  buildAppointmentReminderTextInput,
  buildServiceReminderTextInput,
  maintainRequestServiceText,
  OPT_OUT_LINE,
  rebuildZapierRequestInput,
  withOptOut,
  zapierCustomerSmsRoute,
} from "./zapier-specialist-flows";

import { encryptSecret } from "../../lib/token-encryption";
import { sha256Hex, ZapierMcpError } from "./zapier-mcp-client";
import { approveZapierAction, rejectZapierAction } from "./zapier-executions";
import { createAutomation, runEvent, processDueScheduledActions } from "../automation";
import { providers } from "../providers";
import * as audits from "../audit";
import * as twilio from "../twilio-controls";
import * as ownership from "../source-outreach-ownership";

const fake = vi.hoisted(() => ({ calls: 0, unknown: false, toolError: false, owners: {} as Record<string, string>, sessionReady: undefined as undefined | (() => Promise<void>) }));
vi.mock("./zapier-mcp-client", async (original) => ({
  ...await original<typeof import("./zapier-mcp-client")>(),
  withZapierMcpSession: async (_url: string, fn: (session: unknown) => Promise<unknown>) => { await fake.sessionReady?.(); return fn({ callTool: async () => {
    fake.calls++; if (fake.unknown) throw new ZapierMcpError("Synthetic interruption", "tool_failed", true);
    return { value: { id: "synthetic" }, digest: "b".repeat(64), isError: fake.toolError };
  } }); },
}));
vi.mock("../customer-email", async original => ({
  ...await original<typeof import("../customer-email")>(),
  resolveCustomerEmailSender: async ({ organizationId }: { organizationId: string }) => ({ userId: fake.owners[organizationId], source: "company_default", provider: "gmail", senderEmail: "office@example.test" }),
}));
beforeEach(() => { vi.restoreAllMocks(); fake.calls = 0; fake.unknown = false; fake.toolError = false; fake.sessionReady = undefined; vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 42).toString("base64")); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"); });
async function connected(org: string, capability: "appt.sms.send" | "maintain.sms.send", mode: "auto" | "approve" = "auto") {
  const url = "https://mcp.zapier.com/api/mcp/s/synthetic-customer-texts/mcp";
  await db.insert(zapierMcpConnectionsTable).values({ organizationId: org, encryptedServerUrl: encryptSecret(url, `${org}:zapier-mcp`), serverUrlFingerprint: sha256Hex(url), serverHost: "mcp.zapier.com", serverMode: "managed" });
  await db.insert(zapierCapabilityBindingsTable).values({ organizationId: org, capability, specialistId: capability.startsWith("appt") ? "appt" : "maintain", direction: "write", zapierApp: "OpenPhoneCLIAPI", zapierAppName: "Quo", zapierAction: "send_message", zapierActionName: "Send Message", bindingConfig: { from: "+14045550100" } });
  await db.insert(zapierSpecialistPoliciesTable).values({ organizationId: org, capability, specialistId: capability.startsWith("appt") ? "appt" : "maintain", mode, dailyBudget: 20 });
}
async function remind(f: Awaited<ReturnType<typeof fixture>>, appointmentId: string) {
  const rule = await createAutomation(f.orgId, { name: "Synthetic appointment reminder", event: "appointment.booked", actions: [{ type: "appointment_reminder", params: {} }] });
  return runEvent(f.orgId, "appointment.booked", { appointmentId, leadId: f.lead.id, contactId: f.contact.id });
}
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
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  fake.owners[org!.id] = owner!.id;
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
    const [task] = await db.insert(crmTasksTable).values({ organizationId: org!.id, contactId: contact!.id, assignedUserId: owner!.id, title: "Service due" }).returning();
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
  return { orgId: org!.id, owner: owner!, contact: contact!, lead: lead!, appointment, service };
}

describe("own-number customer texts", () => {
  it("adds one opt-out line and never doubles it", () => {
    expect(withOptOut("STOP by the office.")).toBe(`STOP by the office. ${OPT_OUT_LINE}`);
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

describe("customer text dispatch ownership regressions", () => {
  it.each([false, true])("holds changed-copy replay after a prior attempted text (unknown=%s), without fallback email", async unknown => {
    const f = await fixture(); const visit = await f.appointment(2 * DAY); await connected(f.orgId, "appt.sms.send");
    const email = vi.spyOn(providers.email, "send").mockResolvedValue({ id: "synthetic-email", provider: "mock-email" });
    fake.unknown = unknown;
    await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
    await db.update(organizationsTable).set({ name: "Changed synthetic company" }).where(eq(organizationsTable.id, f.orgId));
    await remind(f, visit.id);
    expect(email).not.toHaveBeenCalled(); expect(fake.calls).toBe(1);
  });
  it("holds a post-provider audit exception without fallback email", async () => {
    const f = await fixture(); const visit = await f.appointment(2 * DAY); await connected(f.orgId, "appt.sms.send");
    const email = vi.spyOn(providers.email, "send").mockResolvedValue({ id: "synthetic-email", provider: "mock-email" });
    const original = audits.recordAudit;
    vi.spyOn(audits, "recordAudit").mockImplementation(async input => { if (input.action === "zapier.action_succeeded") throw new Error("Synthetic post-provider audit failure"); return original(input); });
    await remind(f, visit.id);
    expect(fake.calls).toBe(1); expect(email).not.toHaveBeenCalled();
  });
  it.each([false, true])("shares the daily contact allowance across two service obligations (concurrent=%s)", async concurrent => {
    const f = await fixture(); await connected(f.orgId, "maintain.sms.send");
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
    const a = await f.service(5 * DAY), b = await f.service(6 * DAY);
    const send = (id: string) => maintainRequestServiceText({ organizationId: f.orgId, obligationId: id, actorUserId: null });
    if (concurrent) await Promise.allSettled([send(a.id), send(b.id)]); else { await send(a.id); await Promise.allSettled([send(b.id)]); }
    expect(fake.calls).toBe(1);
  });
  it("refuses manual APPT and approval after built-in texting becomes active", async () => {
    const f = await fixture(); const visit = await f.appointment(2 * DAY); await connected(f.orgId, "appt.sms.send", "approve");
    const pending = await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
    vi.spyOn(twilio, "twilioForOrganization").mockResolvedValue({ smsEnabled: true } as never);
    await expect(apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null })).rejects.toBeDefined();
    await expect(approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id })).rejects.toBeDefined();
    expect(fake.calls).toBe(0);
  });
});


describe("original ownership across approval and provider switches", () => {
  it("approves a pending service text against its own one-touch allowance", async () => {
    const f = await fixture(); await connected(f.orgId, "maintain.sms.send", "approve");
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
    const due = await f.service(5 * DAY);
    const pending = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: due.id, actorUserId: f.owner.id });
    const done = await approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    expect(done.state).toBe("succeeded"); expect(fake.calls).toBe(1);
  });
  it("retains an unknown service touch and prevents another obligation from consuming its allowance", async () => {
    const f = await fixture(); await connected(f.orgId, "maintain.sms.send");
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
    const a = await f.service(5 * DAY), b = await f.service(6 * DAY); fake.unknown = true;
    const unknown = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: a.id, actorUserId: null });
    expect(unknown.execution.state).toBe("indeterminate");
    await Promise.allSettled([maintainRequestServiceText({ organizationId: f.orgId, obligationId: b.id, actorUserId: null })]);
    expect(fake.calls).toBe(1);
  });
  it("releases a rejected undispatched service allowance while preserving its original ledger receipt", async () => {
    const f = await fixture(); await connected(f.orgId, "maintain.sms.send", "approve");
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
    const a = await f.service(5 * DAY), b = await f.service(6 * DAY);
    const pending = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: a.id, actorUserId: null });
    await rejectZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    const next = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: b.id, actorUserId: null });
    expect(next.execution.state).toBe("pending_approval");
    const [original] = await db.select().from(zapierActionExecutionsTable).where(eq(zapierActionExecutionsTable.id, pending.execution.id));
    expect(original.state).toBe("rejected"); expect(fake.calls).toBe(0);
  });
  it("keeps the exact scheduled APPT invocation and later approval usable", async () => {
    const f = await fixture(); await connected(f.orgId, "appt.sms.send", "approve"); const visit = await f.appointment(2 * DAY);
    const [scheduled] = await db.insert(scheduledActionsTable).values({ organizationId: f.orgId, action: { type: "appointment_reminder", params: {} }, context: { event: "appointment.reminder", appointmentId: visit.id, leadId: f.lead.id, contactId: f.contact.id, fields: { "appointment.scheduledStart": visit.scheduledStart.toISOString() } }, runAt: new Date(Date.now() - 1000) }).returning();
    await processDueScheduledActions(f.orgId);
    const [pending] = await db.select().from(zapierActionExecutionsTable).where(eq(zapierActionExecutionsTable.organizationId, f.orgId));
    expect(pending.state).toBe("pending_approval"); expect(pending.requestSummary.appointmentReminderScheduledActionId).toBe(scheduled.id);
    const approved = await approveZapierAction({ organizationId: f.orgId, executionId: pending.id, userId: f.owner.id });
    expect(approved.state).toBe("succeeded"); expect(fake.calls).toBe(1);
  });
  it("serializes manual and automatic own-number APPT sends", async () => {
    const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
    await Promise.allSettled([apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null }), remind(f, visit.id)]);
    expect(fake.calls).toBe(1);
  });
  it("holds built-in APPT after an own-number send despite a provider switch", async () => {
    const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
    await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
    vi.spyOn(twilio, "twilioForOrganization").mockResolvedValue({ smsEnabled: true } as never);
    const builtin = vi.spyOn(providers.sms, "send").mockResolvedValue({ id: "synthetic-builtin", provider: "mock-sms" });
    await remind(f, visit.id); expect(builtin).not.toHaveBeenCalled(); expect(fake.calls).toBe(1);
  });
  it("holds own-number APPT after an unknown original built-in dispatch", async () => {
    const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
    await db.insert(twilioDispatchesTable).values({ organizationId: f.orgId, contactId: f.contact.id, idempotencyKey: `appointment:${visit.id}:reminder:${visit.scheduledStart.toISOString()}`, payloadHash: "c".repeat(64), phone: f.contact.phone!, purpose: "appointments", accountSid: "synthetic-account", status: "dispatching" });
    await expect(apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null })).rejects.toMatchObject({ code: "conflict" }); expect(fake.calls).toBe(0);
  });
});

it("serializes built-in individual approval and own-number service admission in both directions", async () => {
  const { getServiceCare, approveServiceCare } = await import("../service-care");
  for (const order of ["builtin", "own-number", "concurrent"] as const) {
    const f = await fixture(); await connected(f.orgId, "maintain.sms.send"); const due = await f.service(5 * DAY);
    const view = await getServiceCare(f.orgId, due.id, "email");
    const input = { requestId: randomUUID(), expectedUpdatedAt: view.expectedUpdatedAt, channel: "email", previewFingerprint: view.preview!.fingerprint, agreementNote: "Reviewed synthetic service agreement and current recipient expectation.", expectedServiceConfirmed: true };
    const builtin = () => approveServiceCare(f.orgId, f.owner.id, due.id, input);
    const own = () => maintainRequestServiceText({ organizationId: f.orgId, obligationId: due.id, actorUserId: f.owner.id });
    if (order === "concurrent") await Promise.allSettled([builtin(), own()]);
    else if (order === "builtin") { await builtin(); await expect(own()).rejects.toBeDefined(); }
    else { await own(); await expect(builtin()).rejects.toBeDefined(); }
    const builtinRows = (await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.orgId))).filter(row => row.action === "service.care_reminder_approved");
    const ownRows = (await db.select().from(zapierActionExecutionsTable).where(eq(zapierActionExecutionsTable.organizationId, f.orgId))).filter(row => row.state === "succeeded");
    expect(builtinRows.length + ownRows.length).toBe(1);
  }
});

it("allows a new appointment start after a successful own-number reminder while preserving the old receipt", async () => {
  const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
  const first = await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  await db.update(appointmentsTable).set({ scheduledStart: new Date(visit.scheduledStart.getTime() + DAY) }).where(eq(appointmentsTable.id, visit.id));
  const second = await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  expect(first.execution.state).toBe("succeeded"); expect(second.execution.state).toBe("succeeded"); expect(first.execution.id).not.toBe(second.execution.id); expect(fake.calls).toBe(2);
});
it("allows a new appointment start after a successful built-in reminder", async () => {
  const f = await fixture(); const visit = await f.appointment(2 * DAY);
  vi.spyOn(providers.sms, "send").mockResolvedValue({ id: "synthetic-first", provider: "mock-sms" });
  await remind(f, visit.id);
  await db.update(appointmentsTable).set({ scheduledStart: new Date(visit.scheduledStart.getTime() + DAY) }).where(eq(appointmentsTable.id, visit.id));
  await connected(f.orgId, "appt.sms.send");
  const next = await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  expect(next.execution.state).toBe("succeeded"); expect(fake.calls).toBe(1);
});

it("returns the original service text receipt under a one-touch cap without attempting again", async () => {
  const f = await fixture(); await connected(f.orgId, "maintain.sms.send");
  await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
  const due = await f.service(5 * DAY);
  const first = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: due.id, actorUserId: null });
  const replay = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: due.id, actorUserId: null });
  expect(replay.execution.id).toBe(first.execution.id); expect(replay.execution.state).toBe("succeeded"); expect(fake.calls).toBe(1);
});
it("releases an explicitly held predispatch service allowance without deleting its blocked receipt", async () => {
  const f = await fixture(); await connected(f.orgId, "maintain.sms.send");
  await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
  const a = await f.service(5 * DAY), b = await f.service(6 * DAY);
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
  const blocked = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: a.id, actorUserId: null });
  expect(blocked.execution.state).toBe("blocked"); expect(fake.calls).toBe(0);
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  const done = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: b.id, actorUserId: null });
  expect(done.execution.state).toBe("succeeded"); expect(fake.calls).toBe(1);
});

it.each([false, true])("holds email fallback after an original own-number text when SMS is later opted out (unknown=%s)", async unknown => {
  const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
  fake.unknown = unknown;
  await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  await db.update(contactsTable).set({ doNotContactSms: true }).where(eq(contactsTable.id, f.contact.id));
  const email = vi.spyOn(providers.email, "send").mockResolvedValue({ id: "synthetic-email", provider: "mock-email" });
  await remind(f, visit.id); expect(email).not.toHaveBeenCalled(); expect(fake.calls).toBe(1);
});
it.each([false, true])("holds email after an original own-number text when preference changes to email (unknown=%s)", async unknown => {
  const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
  fake.unknown = unknown;
  await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  await db.update(contactsTable).set({ preferredContactMethod: "email" }).where(eq(contactsTable.id, f.contact.id));
  const email = vi.spyOn(providers.email, "send").mockResolvedValue({ id: "synthetic-email", provider: "mock-email" });
  await remind(f, visit.id); expect(email).not.toHaveBeenCalled(); expect(fake.calls).toBe(1);
});

describe("new customer text canonical parents", () => {
  it.each(["foreign_lead", "different_customer"] as const)("refuses APPT with a nonnull incoherent lead: %s", async kind => {
    const f = await fixture(), foreign = await fixture(); const visit = await f.appointment(2 * DAY);
    const [otherContact] = await db.insert(contactsTable).values({ organizationId: f.orgId, firstName: "Another synthetic customer" }).returning();
    const [otherLead] = await db.insert(leadsTable).values({ organizationId: f.orgId, contactId: otherContact.id }).returning();
    await db.update(appointmentsTable).set({ leadId: kind === "foreign_lead" ? foreign.lead.id : otherLead.id }).where(eq(appointmentsTable.id, visit.id));
    await expect(buildAppointmentReminderTextInput(f.orgId, visit.id)).rejects.toMatchObject({ code: "invalid_input" }); expect(fake.calls).toBe(0);
  });
  it("refuses MAINTAIN when its nonnull task belongs to another company", async () => {
    const f = await fixture(), foreign = await fixture(); const due = await f.service(5 * DAY);
    const [task] = await db.insert(crmTasksTable).values({ organizationId: foreign.orgId, contactId: foreign.contact.id, title: "Foreign synthetic service" }).returning();
    await db.update(serviceObligationsTable).set({ taskId: task.id }).where(eq(serviceObligationsTable.id, due.id));
    await expect(buildServiceReminderTextInput(f.orgId, due.id)).rejects.toBeDefined(); expect(fake.calls).toBe(0);
  });
  it("refuses MAINTAIN with a nonnull property owned by another customer", async () => {
    const f = await fixture(), foreign = await fixture(); const due = await f.service(5 * DAY);
    const [property] = await db.insert(propertiesTable).values({ organizationId: foreign.orgId, contactId: foreign.contact.id, addressLine1: "1 Synthetic Street", city: "Example", state: "CA", postalCode: "00000" }).returning();
    await db.update(serviceObligationsTable).set({ propertyId: property.id }).where(eq(serviceObligationsTable.id, due.id));
    await expect(buildServiceReminderTextInput(f.orgId, due.id)).rejects.toBeDefined(); expect(fake.calls).toBe(0);
  });
  it("refuses MAINTAIN with a foreign linked cancelled visit rather than treating it as no visit", async () => {
    const f = await fixture(), foreign = await fixture(); const due = await f.service(5 * DAY); const visit = await foreign.appointment(2 * DAY, { status: "cancelled" });
    await db.update(serviceObligationsTable).set({ appointmentId: visit.id }).where(eq(serviceObligationsTable.id, due.id));
    await expect(buildServiceReminderTextInput(f.orgId, due.id)).rejects.toBeDefined(); expect(fake.calls).toBe(0);
  });
});

it.each(["policy", "approval", "outbound_hold"] as const)("holds customer dispatch when %s changes during MCP session initialization", async change => {
  const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
  fake.sessionReady = async () => { if (change !== "outbound_hold") await db.update(zapierSpecialistPoliciesTable).set({ mode: change === "approval" ? "approve" : "off" }).where(eq(zapierSpecialistPoliciesTable.organizationId, f.orgId)); else vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true"); };
  await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  expect(fake.calls).toBe(0);
});
it.each(["appt.sms.send", "maintain.sms.send"] as const)("serializes a one-action specialist budget across distinct contacts for %s", async capability => {
  const f = await fixture(); await connected(f.orgId, capability);
  await db.update(zapierSpecialistPoliciesTable).set({ dailyBudget: 1 }).where(eq(zapierSpecialistPoliciesTable.organizationId, f.orgId));
  const [other] = await db.insert(contactsTable).values({ organizationId: f.orgId, firstName: "Other synthetic customer", phone: "+14045550143" }).returning();
  await db.insert(consentRecordsTable).values({ organizationId: f.orgId, contactId: other.id, channel: "sms", granted: true, disclosureVersion: "test" });
  if (capability === "appt.sms.send") {
    const a = await f.appointment(2 * DAY), b = await f.appointment(3 * DAY, { contactId: other.id, leadId: null });
    await Promise.allSettled([a, b].map(visit => apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null })));
  } else {
    const a = await f.service(5 * DAY), b = await f.service(6 * DAY);
    await db.update(serviceObligationsTable).set({ contactId: other.id }).where(eq(serviceObligationsTable.id, b.id));
    await db.update(crmTasksTable).set({ contactId: other.id }).where(eq(crmTasksTable.id, b.taskId));
    await Promise.allSettled([a, b].map(service => maintainRequestServiceText({ organizationId: f.orgId, obligationId: service.id, actorUserId: null })));
  }
  expect(fake.calls).toBe(1);
});
it.each(["phone", "sender", "unbound"] as const)("releases a proven undispatched stale service approval after %s changes and preserves the receipt for safe review", async change => {
  const f = await fixture(); await connected(f.orgId, "maintain.sms.send", "approve"); const service = await f.service(5 * DAY);
  await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
  const first = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: service.id, actorUserId: null });
  const [binding] = await db.select().from(zapierCapabilityBindingsTable).where(eq(zapierCapabilityBindingsTable.organizationId, f.orgId));
  if (change === "phone") await db.update(contactsTable).set({ phone: "+14045550144" }).where(eq(contactsTable.id, f.contact.id));
  if (change === "sender") await db.update(zapierCapabilityBindingsTable).set({ bindingConfig: { from: "+14045550105" } }).where(eq(zapierCapabilityBindingsTable.id, binding.id));
  if (change === "unbound") await db.delete(zapierCapabilityBindingsTable).where(eq(zapierCapabilityBindingsTable.id, binding.id));
  const blocked = await approveZapierAction({ organizationId: f.orgId, executionId: first.execution.id, userId: f.owner.id });
  expect(blocked.state).toBe("blocked"); expect(fake.calls).toBe(0);
  if (change === "unbound") await db.insert(zapierCapabilityBindingsTable).values(binding);
  const fresh = await maintainRequestServiceText({ organizationId: f.orgId, obligationId: service.id, actorUserId: null });
  expect(fresh.execution.id).toBe(first.execution.id); expect(fresh.execution.state).toBe("pending_approval");
  const sent = await approveZapierAction({ organizationId: f.orgId, executionId: fresh.execution.id, userId: f.owner.id });
  expect(sent.state).toBe("succeeded"); expect(fake.calls).toBe(1);
});

it("retains a provider-reported customer-text failure in the specialist daily budget", async () => {
  const f = await fixture(); await connected(f.orgId, "appt.sms.send");
  await db.update(zapierSpecialistPoliciesTable).set({ dailyBudget: 1 }).where(eq(zapierSpecialistPoliciesTable.organizationId, f.orgId));
  const a = await f.appointment(2 * DAY), b = await f.appointment(3 * DAY); fake.toolError = true;
  const first = await apptRequestReminderText({ organizationId: f.orgId, appointmentId: a.id, actorUserId: null });
  expect(first.execution.state).toBe("failed");
  const second = await apptRequestReminderText({ organizationId: f.orgId, appointmentId: b.id, actorUserId: null });
  expect(second.execution.state).toBe("blocked"); expect(fake.calls).toBe(1);
});
it("holds APPT when its recipient changes before the final shared claim", async () => {
  const f = await fixture(); await connected(f.orgId, "appt.sms.send"); const visit = await f.appointment(2 * DAY);
  const original = ownership.acquireNurtureLocks; let locks = 0;
  vi.spyOn(ownership, "acquireNurtureLocks").mockImplementation(async (...args) => {
    if (args[1] === f.orgId && ++locks === 2) await db.update(contactsTable).set({ phone: "+14045550149" }).where(eq(contactsTable.id, f.contact.id));
    return original(...args);
  });
  await apptRequestReminderText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: null });
  expect(fake.calls).toBe(0);
});
it("holds MAINTAIN when its linked cancelled visit becomes booked before the final claim", async () => {
  const f = await fixture(); await connected(f.orgId, "maintain.sms.send"); const visit = await f.appointment(2 * DAY, { status: "cancelled" }); const due = await f.service(5 * DAY);
  await db.update(serviceObligationsTable).set({ appointmentId: visit.id }).where(eq(serviceObligationsTable.id, due.id));
  const original = ownership.acquireNurtureLocks; let locks = 0;
  vi.spyOn(ownership, "acquireNurtureLocks").mockImplementation(async (...args) => {
    if (args[1] === f.orgId && ++locks === 3) await db.update(appointmentsTable).set({ status: "scheduled" }).where(eq(appointmentsTable.id, visit.id));
    return original(...args);
  });
  await maintainRequestServiceText({ organizationId: f.orgId, obligationId: due.id, actorUserId: null });
  expect(fake.calls).toBe(0);
});
