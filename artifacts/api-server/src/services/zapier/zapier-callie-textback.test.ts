import { randomUUID } from "node:crypto";
import {
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  crmTasksTable,
  db,
  organizationsTable,
  orgSettingsTable,
  suppressionsTable,
  usersTable,
  zapierActionExecutionsTable,
  zapierCapabilityBindingsTable,
  zapierMcpConnectionsTable,
  zapierSpecialistPoliciesTable,
  appointmentsTable,
  leadsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { encryptSecret } from "../../lib/token-encryption";
import {
  callerCannotText,
  checkTextBackEligibility,
  recordMissedCallBasis,
  describeCallieTextBackSettings,
  saveCallieTextBackSettings,
  usMobileCapableE164,
  withinTextingHours,
} from "../callie-text-back";
import { checkSendEligibility, hasChannelConsent } from "../send-gate";
import { sha256Hex } from "./zapier-mcp-client";
import { approveZapierAction } from "./zapier-executions";
import { listZapierCapabilities, setZapierPolicy } from "./zapier-connection";
import {
  buildAppointmentReminderTextInput,
  callieRequestTextBack,
  callieSyncCalls,
  OPT_OUT_LINE,
  textBackBody,
} from "./zapier-specialist-flows";

const fake = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[], calls: [] as Record<string, unknown>[] }));
vi.mock("./zapier-mcp-client", async (original) => ({
  ...(await original<typeof import("./zapier-mcp-client")>()),
  withZapierMcpSession: async (_url: string, fn: (session: unknown) => Promise<unknown>) =>
    fn({
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === "send_message") {
          fake.sent.push(args);
          return { value: { id: "synthetic-sms" }, digest: "c".repeat(64), isError: false };
        }
        return { value: { results: fake.calls }, digest: "d".repeat(64), isError: false };
      },
    }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  fake.sent = [];
  fake.calls = [];
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 42).toString("base64"));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
});

const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

const CALLER = "+14045550177";
const BUSINESS = "+14045550100";
const HOUR = 3_600_000;

/** A fixed-offset zone whose current local hour satisfies `test`. */
function zoneWhere(test: (hour: number) => boolean): string {
  for (let offset = -12; offset <= 14; offset++) {
    const zone = offset === 0 ? "Etc/GMT" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
    if (test(hour)) return zone;
  }
  throw new Error("no matching zone");
}
const daytime = () => zoneWhere((hour) => hour >= 10 && hour <= 18);
const night = () => zoneWhere((hour) => hour >= 0 && hour <= 5);

async function fixture(options: { mode?: "approve" | "auto"; registered?: boolean; timezone?: string; windowHours?: number; bound?: boolean } = {}) {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic Callback Co", slug: `test-callie-tb-${randomUUID()}`, timezone: options.timezone ?? daytime() })
    .returning();
  orgs.push(org!.id);
  await db.insert(orgSettingsTable).values({ organizationId: org!.id });
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  if (options.registered !== false) {
    await saveCallieTextBackSettings({ organizationId: org!.id, userId: owner!.id, messagingRegistered: true, windowHours: options.windowHours });
  }
  const url = `https://mcp.zapier.com/api/mcp/s/synthetic-callie-${randomUUID()}/mcp`;
  await db.insert(zapierMcpConnectionsTable).values({ organizationId: org!.id, encryptedServerUrl: encryptSecret(url, `${org!.id}:zapier-mcp`), serverUrlFingerprint: sha256Hex(url), serverHost: "mcp.zapier.com", serverMode: "managed" });
  if (options.bound !== false) {
    await db.insert(zapierCapabilityBindingsTable).values({ organizationId: org!.id, capability: "callie.sms.send", specialistId: "callie", direction: "write", zapierApp: "OpenPhoneCLIAPI", zapierAppName: "Quo", zapierAction: "send_message", zapierActionName: "Send Message", bindingConfig: { from: BUSINESS } });
    await db.insert(zapierSpecialistPoliciesTable).values({ organizationId: org!.id, capability: "callie.sms.send", specialistId: "callie", mode: options.mode ?? "approve", dailyBudget: 40 });
  }
  const missedCall = async (phone = CALLER, calledAt = new Date()) => {
    const [task] = await db.insert(crmTasksTable).values({ organizationId: org!.id, title: `Return missed call: Caller (${phone})`, priority: "high", sourceEvent: `zapier.call:test:${randomUUID()}` }).returning();
    await recordMissedCallBasis(org!.id, task!.id, { phone, calledAt: calledAt.toISOString(), businessNumber: BUSINESS, callRef: "synthetic" });
    return task!;
  };
  return { orgId: org!.id, owner: owner!, missedCall };
}

const request = (f: Awaited<ReturnType<typeof fixture>>, taskId: string) => callieRequestTextBack({ organizationId: f.orgId, taskId, actorUserId: null });
const auditFor = (orgId: string, action: string) => db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, orgId), eq(auditEventsTable.action, action)));

describe("CALLIE missed-call text-back: content and numbers", () => {
  it("locks the template to the business name, informational wording and the opt-out line", () => {
    const body = textBackBody("Synthetic Roofing\nBUY NOW");
    expect(body).toBe(`Hi, this is Synthetic Roofing BUY NOW. Sorry we missed your call. Reply here with a good time and we will call you back. ${OPT_OUT_LINE}`);
    expect(body).not.toMatch(/https?:|www\.|%|discount|offer|sale/i);
    expect(textBackBody("x".repeat(200)).length).toBeLessThan(200);
  });

  it("accepts only US mobile-capable E.164 numbers and honors landline hints from the call data", () => {
    expect(usMobileCapableE164("(404) 555-0177")).toBe(CALLER);
    expect(usMobileCapableE164("+18005550123")).toBeNull(); // toll-free
    expect(usMobileCapableE164("+19005550123")).toBeNull(); // premium
    expect(usMobileCapableE164("+14049110123")).toBeNull(); // N11 exchange
    expect(usMobileCapableE164("+442071234567")).toBeNull(); // not US
    expect(usMobileCapableE164("12345")).toBeNull();
    expect(callerCannotText({ line_type: "landline" })).toBe(true);
    expect(callerCannotText({ sms_capable: false })).toBe(true);
    expect(callerCannotText({ smsCapable: "false" })).toBe(true);
    expect(callerCannotText({ line_type: "mobile" })).toBe(false);
  });

  it("evaluates quiet hours as 8am to 9pm in the company zone", () => {
    expect(withinTextingHours(new Date("2026-11-11T12:59:00Z"), "America/New_York")).toBe(false); // 7:59
    expect(withinTextingHours(new Date("2026-11-11T13:00:00Z"), "America/New_York")).toBe(true); // 8:00
    expect(withinTextingHours(new Date("2026-11-12T01:59:00Z"), "America/New_York")).toBe(true); // 20:59
    expect(withinTextingHours(new Date("2026-11-12T02:00:00Z"), "America/New_York")).toBe(false); // 21:00
  });
});

describe("CALLIE missed-call text-back: every skip reason", () => {
  it("sends one compliant text in automatic mode through the mocked Zapier client and audits it", async () => {
    const f = await fixture({ mode: "auto" });
    const task = await f.missedCall();
    const outcome = await request(f, task.id);
    expect(outcome.execution).toMatchObject({ state: "succeeded", capability: "callie.sms.send", linkedEntityId: task.id, requestSummary: { toPhone: CALLER } });
    expect(fake.sent).toEqual([{ from: BUSINESS, to_number: CALLER, body: textBackBody("Synthetic Callback Co") }]);
    const [basis] = await auditFor(f.orgId, "consent.missed_call_basis");
    expect(basis!.metadata).toMatchObject({ source: "missed_call", scope: "callie.sms.send", phone: CALLER, businessNumber: BUSINESS, calledAt: expect.any(String) });
    expect((await auditFor(f.orgId, "callie.textback_sent"))[0]!.metadata).toMatchObject({ reason: "missed_call_basis", executionId: outcome.execution.id });
    // A second missed call from the same number inside the window is skipped.
    const again = await request(f, (await f.missedCall()).id);
    expect(again.execution).toMatchObject({ state: "blocked", errorCode: "over_cap" });
    expect(fake.sent).toHaveLength(1);
  });

  it.each([
    ["opted_out (STOP suppression)", async (orgId: string) => { await db.insert(suppressionsTable).values({ organizationId: orgId, channel: "sms", value: "4045550177", reason: "stop_keyword", source: "synthetic" }); }, "opted_out"],
    ["opted_out (contact marked do not text)", async (orgId: string) => { await db.insert(contactsTable).values({ organizationId: orgId, firstName: "Pat", phone: "404-555-0177", doNotContactSms: true }); }, "opted_out"],
    ["opted_out (revoked SMS consent)", async (orgId: string) => {
      const [contact] = await db.insert(contactsTable).values({ organizationId: orgId, firstName: "Pat", phone: "(404) 555-0177" }).returning();
      await db.insert(consentRecordsTable).values({ organizationId: orgId, contactId: contact!.id, channel: "sms", granted: false, disclosureVersion: "stop" });
    }, "opted_out"],
    ["suppressed (company suppression list)", async (orgId: string) => { await db.insert(suppressionsTable).values({ organizationId: orgId, channel: "sms", value: "4045550177", reason: "manual", source: "synthetic" }); }, "suppressed"],
    ["suppressed (do not contact)", async (orgId: string) => { await db.insert(contactsTable).values({ organizationId: orgId, firstName: "Pat", phone: CALLER, doNotContact: true }); }, "suppressed"],
  ] as const)("skips %s, records why and sends nothing", async (_label, arrange, reason) => {
    const f = await fixture({ mode: "auto" });
    await arrange(f.orgId);
    const task = await f.missedCall();
    const outcome = await request(f, task.id);
    expect(outcome.execution).toMatchObject({ state: "blocked", errorCode: reason, linkedEntityId: task.id });
    expect(outcome.execution.detail).toMatch(/^Not sent:/);
    expect(fake.sent).toHaveLength(0);
    const [audit] = await auditFor(f.orgId, "callie.textback_skipped");
    expect(audit).toMatchObject({ entityType: "crm_task", entityId: task.id, metadata: { reason } });
  });

  it("skips outside 8am-9pm in the company time zone (skip, never queued)", async () => {
    const f = await fixture({ mode: "auto", timezone: night() });
    const outcome = await request(f, (await f.missedCall()).id);
    expect(outcome.execution).toMatchObject({ state: "blocked", errorCode: "quiet_hours" });
    expect(fake.sent).toHaveLength(0);
  });

  it("skips when the texting registration is not confirmed, and the policy cannot be switched on", async () => {
    const f = await fixture({ mode: "auto", registered: false });
    const outcome = await request(f, (await f.missedCall()).id);
    expect(outcome.execution).toMatchObject({ state: "blocked", errorCode: "not_registered" });
    await expect(setZapierPolicy({ organizationId: f.orgId, userId: f.owner.id, capability: "callie.sms.send", mode: "approve" })).rejects.toThrow(/registered/);
    await expect(setZapierPolicy({ organizationId: f.orgId, userId: f.owner.id, capability: "callie.sms.send", mode: "off" })).resolves.toMatchObject({ mode: "off" });
    expect(fake.sent).toHaveLength(0);
  });

  it("records who confirmed registration and when, shown by name in Settings and never as another company's user", async () => {
    const f = await fixture({ registered: false });
    await db.update(usersTable).set({ firstName: "Rae", lastName: "Owner" }).where(eq(usersTable.id, f.owner.id));
    await saveCallieTextBackSettings({ organizationId: f.orgId, userId: f.owner.id, messagingRegistered: true });
    const view = await describeCallieTextBackSettings(f.orgId);
    expect(view).toMatchObject({ messagingRegistered: true, registeredByUserId: f.owner.id, registeredByName: "Rae Owner", windowHours: 24, windowChoices: [12, 24, 48, 72] });
    expect(Date.now() - new Date(view.registeredAt!).getTime()).toBeLessThan(60_000);
    expect((await auditFor(f.orgId, "callie.textback_settings_changed")).length).toBeGreaterThan(0);
    const listed = (await listZapierCapabilities(f.orgId)).find((capability) => capability.key === "callie.sms.send");
    expect(listed?.textBack).toMatchObject({ registeredByName: "Rae Owner" });
    // A confirmer id that is not a member of this company never resolves to a name from elsewhere.
    const other = await fixture();
    await db.update(orgSettingsTable).set({ callieTextBack: { messagingRegistered: true, registeredByUserId: other.owner.id, registeredAt: new Date().toISOString(), windowHours: 24 } }).where(eq(orgSettingsTable.organizationId, f.orgId));
    expect((await describeCallieTextBackSettings(f.orgId)).registeredByName).toBe("A former team member");
    await expect(saveCallieTextBackSettings({ organizationId: f.orgId, userId: f.owner.id, messagingRegistered: true, windowHours: 0 })).rejects.toThrow(/between 1 and 168/);
  });
  it("caps at one text-back per caller per configurable window, across companies independently", async () => {
    const f = await fixture({ mode: "auto", windowHours: 12 });
    const prior = { organizationId: f.orgId, specialistId: "callie" as const, capability: "callie.sms.send", direction: "write" as const, zapierApp: "OpenPhoneCLIAPI", zapierAction: "send_message", requestDigest: "e".repeat(64), requestSummary: { toPhone: CALLER }, state: "succeeded" as const };
    await db.insert(zapierActionExecutionsTable).values({ ...prior, idempotencyKey: `old-${randomUUID()}`, createdAt: new Date(Date.now() - 13 * HOUR) });
    expect((await request(f, (await f.missedCall()).id)).execution.state).toBe("succeeded"); // 13h ago is outside a 12h window
    const blocked = await request(f, (await f.missedCall()).id);
    expect(blocked.execution).toMatchObject({ state: "blocked", errorCode: "over_cap" });
    // Another company's text-back to the same number never counts here.
    const other = await fixture({ mode: "auto" });
    expect((await request(other, (await other.missedCall()).id)).execution.state).toBe("succeeded");
    await expect(request(other, (await f.missedCall()).id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("serializes concurrent text-backs to one caller so only one can go", async () => {
    const f = await fixture({ mode: "approve" });
    const [a, b] = [await f.missedCall(), await f.missedCall()];
    const results = await Promise.all([request(f, a.id), request(f, b.id)]);
    expect(results.map((row) => row.execution.state).sort()).toEqual(["blocked", "pending_approval"]);
    expect(results.find((row) => row.execution.state === "blocked")!.execution.errorCode).toBe("over_cap");
  });

  it("skips invalid, landline and incomplete call records from the phone system without recording a basis", async () => {
    const f = await fixture({ mode: "auto" });
    await db.insert(zapierCapabilityBindingsTable).values({ organizationId: f.orgId, capability: "callie.calls.list", specialistId: "callie", direction: "read", zapierApp: "OpenPhoneCLIAPI", zapierAppName: "Quo", zapierAction: "call_completed", zapierActionName: "Call Completed", bindingConfig: {} });
    await db.insert(zapierSpecialistPoliciesTable).values({ organizationId: f.orgId, capability: "callie.calls.list", specialistId: "callie", mode: "auto", dailyBudget: 96 });
    const now = new Date().toISOString();
    fake.calls = [
      { id: "c1", from: "+18005550123", to: BUSINESS, createdAt: now, status: "missed" },
      { id: "c2", from: "+14045550181", to: BUSINESS, createdAt: now, status: "missed", line_type: "landline" },
      { id: "c3", from: "+14045550182", createdAt: now, status: "missed" },
      { id: "c4", from: "+14045550183", to: BUSINESS, status: "missed" },
      { id: "c5", from: BUSINESS, to: "+14045550184", createdAt: now, status: "no-answer", direction: "outgoing" },
      { id: "c6", from: "+14045550185", to: BUSINESS, createdAt: new Date(Date.now() - 30 * HOUR).toISOString(), status: "missed" },
      { id: "c7", from: CALLER, to: BUSINESS, createdAt: now, status: "missed" },
    ];
    const summary = await callieSyncCalls({ organizationId: f.orgId, actorUserId: null });
    expect(summary).toMatchObject({ received: 7, created: 7, textbacksRequested: 1, textbacksSkipped: 5 });
    const rows = await db.select().from(zapierActionExecutionsTable).where(and(eq(zapierActionExecutionsTable.organizationId, f.orgId), eq(zapierActionExecutionsTable.capability, "callie.sms.send")));
    expect(rows.map((row) => row.errorCode).sort()).toEqual(["call_too_old", "invalid_number", "landline", "missing_call_details", "missing_call_details", null]);
    expect(fake.sent).toEqual([expect.objectContaining({ to_number: CALLER })]);
    // An unanswered outbound call is logged, not treated as a missed call.
    const [outbound] = await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.orgId), eq(crmTasksTable.title, `Call logged: Unknown caller (+14045550184)`)));
    expect(outbound).toBeTruthy();
    expect(await auditFor(f.orgId, "consent.missed_call_basis")).toHaveLength(2); // c6 (too old) and c7 only
  });

  it("checks the order of reasons directly, including a too-old call", async () => {
    const f = await fixture();
    const base = { organizationId: f.orgId, phone: CALLER, exceptKey: "x" };
    expect(await checkTextBackEligibility(db, { ...base, phone: "4045550177", calledAt: new Date() })).toMatchObject({ ok: false, reason: "invalid_number" });
    expect(await checkTextBackEligibility(db, { ...base, calledAt: new Date(Date.now() - 25 * HOUR) })).toMatchObject({ ok: false, reason: "call_too_old" });
    expect(await checkTextBackEligibility(db, { ...base, calledAt: new Date() })).toMatchObject({ ok: true });
  });
});

describe("CALLIE missed-call text-back: re-check at approval", () => {
  it("skips a pending text-back at approval when the caller texted STOP after the request", async () => {
    const f = await fixture({ mode: "approve" });
    const task = await f.missedCall();
    const pending = await request(f, task.id);
    expect(pending.execution.state).toBe("pending_approval");
    await db.insert(suppressionsTable).values({ organizationId: f.orgId, channel: "sms", value: "4045550177", reason: "stop_keyword", source: "zapier_inbox" });
    const approved = await approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    expect(approved).toMatchObject({ state: "blocked", errorCode: "opted_out" });
    expect(fake.sent).toHaveLength(0);
    expect((await auditFor(f.orgId, "zapier.action_skipped"))[0]!.metadata).toMatchObject({ reason: "opted_out", capability: "callie.sms.send" });
  });

  it("skips at approval when registration was withdrawn or the approval falls in quiet hours", async () => {
    const f = await fixture({ mode: "approve" });
    const first = await request(f, (await f.missedCall()).id);
    await saveCallieTextBackSettings({ organizationId: f.orgId, userId: f.owner.id, messagingRegistered: false });
    const [policy] = await db.select().from(zapierSpecialistPoliciesTable).where(and(eq(zapierSpecialistPoliciesTable.organizationId, f.orgId), eq(zapierSpecialistPoliciesTable.capability, "callie.sms.send")));
    expect(policy!.mode).toBe("off");
    expect(await approveZapierAction({ organizationId: f.orgId, executionId: first.execution.id, userId: f.owner.id })).toMatchObject({ state: "blocked", errorCode: "not_registered" });

    const g = await fixture({ mode: "approve" });
    const second = await request(g, (await g.missedCall("+14045550190")).id);
    await db.update(organizationsTable).set({ timezone: night() }).where(eq(organizationsTable.id, g.orgId));
    expect(await approveZapierAction({ organizationId: g.orgId, executionId: second.execution.id, userId: g.owner.id })).toMatchObject({ state: "blocked", errorCode: "quiet_hours" });
    expect(fake.sent).toHaveLength(0);
  });

  it("sends the identical approved text when nothing changed", async () => {
    const f = await fixture({ mode: "approve" });
    const pending = await request(f, (await f.missedCall()).id);
    const approved = await approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    expect(approved.state).toBe("succeeded");
    expect(fake.sent).toEqual([{ from: BUSINESS, to_number: CALLER, body: textBackBody("Synthetic Callback Co") }]);
  });
});

describe("CALLIE missed-call basis is not consent for anything else", () => {
  it("never satisfies the send gate, SMS consent or other customer texts for the same number", async () => {
    const f = await fixture({ mode: "auto" });
    const [contact] = await db.insert(contactsTable).values({ organizationId: f.orgId, firstName: "Pat", phone: CALLER }).returning();
    const [lead] = await db.insert(leadsTable).values({ organizationId: f.orgId, contactId: contact!.id }).returning();
    const task = await f.missedCall();
    expect((await request(f, task.id)).execution.state).toBe("succeeded");
    // No consent record was written, and every other text still needs real SMS consent.
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.contactId, contact!.id))).toHaveLength(0);
    expect(await hasChannelConsent(f.orgId, contact!.id, "sms")).toBe(false);
    for (const kind of ["transactional", "outreach"] as const) {
      expect(await checkSendEligibility({ organizationId: f.orgId, contact: contact!, channel: "sms", kind })).toMatchObject({ ok: false, reason: "no_sms_consent" });
    }
    const [visit] = await db.insert(appointmentsTable).values({ organizationId: f.orgId, leadId: lead!.id, contactId: contact!.id, status: "scheduled", scheduledStart: new Date(Date.now() + 48 * HOUR) }).returning();
    await expect(buildAppointmentReminderTextInput(f.orgId, visit!.id)).rejects.toMatchObject({ message: expect.stringMatching(/not agreed to receive texts/) });
  });

  it("is not a basis for a task without a recorded missed call", async () => {
    const f = await fixture({ mode: "auto" });
    const [task] = await db.insert(crmTasksTable).values({ organizationId: f.orgId, title: `Return missed call: Someone (${CALLER})` }).returning();
    expect((await request(f, task!.id)).execution).toMatchObject({ state: "blocked", errorCode: "no_basis" });
    expect(fake.sent).toHaveLength(0);
  });
});
