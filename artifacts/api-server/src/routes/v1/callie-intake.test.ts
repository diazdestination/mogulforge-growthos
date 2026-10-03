import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio";
import { and, eq, sql } from "drizzle-orm";
import {
  auditEventsTable, callieIntakesTable as intakes, calliePolicyRevisionsTable as policies,
  contactsTable, consentRecordsTable, crmTasksTable, db, leadsTable,
  missedCallHandoffsTable, organizationsTable, pool, suppressionsTable, twilioCallsTable,
  twilioClientBindingsTable, twilioConsentProofsTable, twilioInboundEventsTable, usersTable,
} from "@workspace/db";
import app from "../../app";
import { decryptSecret } from "../../lib/token-encryption";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { approveCalliePolicy, getCalliePolicy, previewCalliePolicy } from "../../services/callie-policy";
import { callieChallengeHash, callieTriggerHash, DEFAULT_CALLIE_POLICY } from "../../services/callie-contract";
import { transitionCustomerLifecycle } from "../../services/customer-lifecycle";
import { ensureMissedCallHandoff } from "../../services/missed-call-handoff";

let server: Server, base: string, serial = 0;
const orgs: string[] = [];
const realFetch = globalThis.fetch;
const token = "synthetic-callie-intake-webhook-token";
const key = "24".repeat(32);
type Fixture = { org: string; owner: string; account: string; sender: string; phone: string; service: string; bindingId: string };

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", key);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Provider traffic forbidden in intake tests"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(...orgs);
});

async function fixture(enabled = true): Promise<Fixture> {
  const n = ++serial;
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic CALLIE intake", slug: `callie-${randomUUID()}` }).returning();
  orgs.push(org.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, email: `${randomUUID()}@example.invalid`, role: "admin", isActive: true, emailVerifiedAt: new Date() }).returning();
  const ref = `TWILIO_CLIENT_CALLIE${n}_`;
  vi.stubEnv(`${ref}AUTH_TOKEN`, token); vi.stubEnv(`${ref}API_KEY_SECRET`, "synthetic-callie-key");
  const account = `AC${randomUUID().replaceAll("-", "")}`, service = `MG${randomUUID().replaceAll("-", "")}`;
  const sender = `+1500555${String(n + 1000).padStart(4, "0")}`, phone = `+1202555${String(n + 1000).padStart(4, "0")}`;
  const [binding] = await db.insert(twilioClientBindingsTable).values({ organizationId: org.id, accountSid: account, phoneNumber: sender,
    messagingServiceSid: service, apiKeySid: `SK${"1".repeat(32)}`, authTokenSecretRef: `${ref}AUTH_TOKEN`, apiKeySecretRef: `${ref}API_KEY_SECRET`,
    publicOrigin: "https://growth.example", businessName: "Synthetic Service Shop", staffPhone: "+12025550999", smsDisclosureVersion: "synthetic-callie.v1",
    dailyCallLimit: 100, dailySmsLimit: 100, launchApproved: true, voiceEnabled: true, voiceApproved: true, smsEnabled: true, registrationApproved: true, advancedOptOut: true, geoPermissionsReviewed: true,
  }).returning();
  const f = { org: org.id, owner: owner.id, account, sender, phone, service, bindingId: binding.id };
  if (enabled) await approve(f, true);
  return f;
}
async function approve(f: Fixture, enabled: boolean) {
  const current = await getCalliePolicy(f.org);
  const preview = await previewCalliePolicy(f.org, f.owner, { expectedVersion: current.version,
    policy: { ...DEFAULT_CALLIE_POLICY, enabled, timezone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59", businessHoursOwnerId: f.owner, afterHoursOwnerId: f.owner },
  });
  return approveCalliePolicy(f.org, f.owner, { expectedVersion: current.version, expectedSnapshot: preview.expectedSnapshot as unknown as Record<string, unknown>, previewHash: preview.previewHash, confirmed: true });
}
async function webhook(f: Fixture, path: string, fields: Record<string, string>, signed = true) {
  const params = { AccountSid: f.account, From: f.phone, To: f.sender, ...fields };
  return realFetch(`${base}/api/v1${path}`, { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": signed ? getExpectedTwilioSignature(token, `https://growth.example/api/v1${path}`, params) : "invalid",
  }, body: new URLSearchParams(params) });
}
async function incoming(f: Fixture) {
  const sid = `CA${randomUUID().replaceAll("-", "")}`;
  const response = await webhook(f, "/public/voice/inbound", { CallSid: sid });
  expect(response.status).toBe(200); expect(await response.text()).toContain("<Dial");
  const [call] = await db.select().from(twilioCallsTable).where(eq(twilioCallsTable.providerSid, sid));
  return call;
}
async function read(f: Fixture, callId: string) {
  const [row] = await db.select().from(intakes).where(and(eq(intakes.organizationId, f.org), eq(intakes.callId, callId)));
  return row;
}
async function missed(f: Fixture, status = "no-answer") {
  const call = await incoming(f);
  const response = await webhook(f, `/public/voice/complete?operation=${call.id}`, { CallSid: call.providerSid!, DialCallStatus: status });
  expect(response.status).toBe(200);
  return { call, xml: await response.text(), row: await read(f, call.id) };
}
async function step(f: Fixture, call: typeof twilioCallsTable.$inferSelect, digit: string, override?: { stage: string; version: number }) {
  const row = await read(f, call.id);
  const stage = override?.stage ?? row.stage, version = override?.version ?? row.version;
  const response = await webhook(f, `/public/voice/care-gather?operation=${call.id}&stage=${stage}&version=${version}`, { CallSid: call.providerSid!, Digits: digit });
  expect(response.status).toBe(200);
  return { xml: await response.text(), row: await read(f, call.id) };
}
async function qualified(f: Fixture) {
  const { call } = await missed(f);
  await step(f, call, "3"); await step(f, call, "2"); await step(f, call, "1");
  const { xml, row } = await step(f, call, "1");
  const code = decryptSecret(row.challengeEncrypted!, `callie:${f.org}:${row.id}:challenge`);
  return { call, row, code, xml };
}
async function sms(f: Fixture, body: string, fields: Record<string, string> = {}) {
  const messageSid = fields.MessageSid ?? `SM${randomUUID().replaceAll("-", "")}`;
  const response = await webhook(f, "/public/sms/inbound", { MessageSid: messageSid, MessagingServiceSid: f.service, Body: body, ...fields });
  return { response, messageSid };
}
async function callbackTask(f: Fixture, callId: string) {
  const [handoff] = await db.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, f.org), eq(missedCallHandoffsTable.callId, callId)));
  const [callback] = await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.id, handoff.taskId)));
  return callback;
}
async function staffChangesTask(f: Fixture, callId: string, change: "reassigned" | "unassigned" | "done" | "cancelled") {
  const callback = await callbackTask(f, callId);
  const [other] = change === "reassigned" ? await db.insert(usersTable).values({ organizationId: f.org, email: `${randomUUID()}@example.invalid`, role: "office", isActive: true, emailVerifiedAt: new Date() }).returning() : [];
  const [changed] = await db.update(crmTasksTable).set({
    assignedUserId: change === "unassigned" ? null : other?.id ?? callback.assignedUserId,
    status: change === "done" || change === "cancelled" ? change : "in_progress",
    completedAt: change === "done" ? new Date() : null,
    dueAt: new Date(Date.now() + 7200_000), priority: "low", description: "Staff explicitly changed the original callback. Preserve this work.",
  }).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.id, callback.id))).returning();
  return changed;
}

describe("signed, forward-only CALLIE intake", () => {
  it("keeps default-off calls manual and never adopts an existing call after policy activation", async () => {
    const f = await fixture(false), call = await incoming(f);
    expect(await read(f, call.id)).toBeUndefined(); await approve(f, true);
    await webhook(f, "/public/voice/inbound", { CallSid: call.providerSid! });
    const complete = await webhook(f, `/public/voice/complete?operation=${call.id}`, { CallSid: call.providerSid!, DialCallStatus: "no-answer" });
    expect(await complete.text()).not.toContain("<Gather"); expect(await read(f, call.id)).toBeUndefined();
  });
  it("does not admit without encrypted replay storage or after a policy changes during the call", async () => {
    const f = await fixture();
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "");
    const unadmitted = await incoming(f); expect(await read(f, unadmitted.id)).toBeUndefined();
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", key);
    const admitted = await incoming(f); expect((await read(f, admitted.id)).state).toBe("admitted");
    await approve(f, false);
    const complete = await webhook(f, `/public/voice/complete?operation=${admitted.id}`, { CallSid: admitted.providerSid!, DialCallStatus: "no-answer" });
    expect(await complete.text()).not.toContain("<Gather"); expect((await read(f, admitted.id)).state).toBe("blocked");
  });
  it.each(["busy", "no-answer", "failed", "canceled"])("admits %s once with one original task and immutable caller identity", async (status) => {
    const f = await fixture(), { call, row, xml } = await missed(f, status);
    expect(xml).toContain("<Gather"); expect(row).toMatchObject({ stage: "service", state: "collecting", version: 2, fromPhone: f.phone, accountSid: f.account, ownerUserId: f.owner });
    const again = await webhook(f, `/public/voice/complete?operation=${call.id}`, { CallSid: call.providerSid!, DialCallStatus: status });
    expect(await again.text()).toBe(xml);
    expect(await db.select().from(missedCallHandoffsTable).where(eq(missedCallHandoffsTable.callId, call.id))).toHaveLength(1);
    expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, f.org))).toHaveLength(1);
    expect(await db.select().from(contactsTable).where(eq(contactsTable.organizationId, f.org))).toHaveLength(0);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org))).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["unassigned", "same_owner", "different_owner", "done", "cancelled"] as const)("only claims an initial original %s callback task without taking over human work", async change => {
    const f = await fixture(), call = await incoming(f);
    // Represent the real handoff transaction committed before CALLIE begins;
    // the signed completion still executes the production admission hook.
    await db.update(twilioCallsTable).set({ dialStatus: "no-answer" }).where(eq(twilioCallsTable.id, call.id));
    await ensureMissedCallHandoff(f.org, call.id);
    expect((await callbackTask(f, call.id)).assignedUserId).toBeNull();
    let before = await callbackTask(f, call.id);
    if (change === "different_owner" || change === "done" || change === "cancelled") {
      before = await staffChangesTask(f, call.id, change === "different_owner" ? "reassigned" : change);
    } else {
      [before] = await db.update(crmTasksTable).set({ assignedUserId: change === "same_owner" ? f.owner : null, status: "in_progress" })
        .where(eq(crmTasksTable.id, before.id)).returning();
    }
    const path = `/public/voice/complete?operation=${call.id}`;
    const response = await webhook(f, path, { CallSid: call.providerSid!, DialCallStatus: "no-answer" });
    expect(response.status).toBe(200);
    const xml = await response.text(), after = await callbackTask(f, call.id);
    if (change === "unassigned" || change === "same_owner") {
      expect(xml).toContain("<Gather");
      expect(await read(f, call.id)).toMatchObject({ state: "collecting", stage: "service" });
      expect(after).toMatchObject({ assignedUserId: f.owner, status: "in_progress", completedAt: before.completedAt });
      expect(after.dueAt).toEqual((await read(f, call.id)).dueAt);
    } else {
      expect(xml).not.toContain("<Gather");
      expect(await read(f, call.id)).toMatchObject({ state: "blocked", reason: "office_callback_changed" });
      expect(after).toEqual(before);
    }
    const replay = await webhook(f, path, { CallSid: call.providerSid!, DialCallStatus: "no-answer" });
    expect(await replay.text()).toBe(xml);
    expect(await callbackTask(f, call.id)).toEqual(after);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["reassigned", "unassigned", "done", "cancelled"] as const)("signed Gather preserves a %s callback task instead of adopting it", async change => {
    const f = await fixture(), { call, row } = await missed(f);
    const before = await staffChangesTask(f, call.id, change);
    const result = await step(f, call, "1");
    expect(result.xml).not.toContain("<Gather");
    expect(result.row).toMatchObject({ state: "blocked", reason: "office_callback_changed", serviceIntent: null, triggerMessageSid: null });
    expect(await callbackTask(f, call.id)).toEqual(before);
    await step(f, call, "1", { stage: row.stage, version: row.version });
    expect(await callbackTask(f, call.id)).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("never gathers for an answered call and rejects changed duplicate dial outcomes both ways", async () => {
    const f = await fixture(), answered = await missed(f, "completed");
    expect(answered.xml).not.toContain("<Gather"); expect(answered.row.state).toBe("cancelled");
    const changed = await webhook(f, `/public/voice/complete?operation=${answered.call.id}`, { CallSid: answered.call.providerSid!, DialCallStatus: "no-answer" });
    expect(await changed.text()).not.toContain("<Gather");
    expect(await db.select().from(missedCallHandoffsTable).where(eq(missedCallHandoffsTable.callId, answered.call.id))).toHaveLength(0);
    const other = await missed(f);
    const reverse = await webhook(f, `/public/voice/complete?operation=${other.call.id}`, { CallSid: other.call.providerSid!, DialCallStatus: "completed" });
    expect(await reverse.text()).not.toContain("<Gather");
    expect((await read(f, other.call.id)).stage).toBe("service");
  });
  it("checks signature, exact call/account/from/to and signed stage query before effects", async () => {
    const f = await fixture(), { call, row } = await missed(f);
    const path = `/public/voice/care-gather?operation=${call.id}&stage=service&version=2`;
    const invalidIdentities: Record<string, string>[] = [{ From: "+12025550000" }, { To: "+15005550000" }, { AccountSid: `AC${"0".repeat(32)}` }, { CallSid: `CA${"0".repeat(32)}` }];
    for (const fields of invalidIdentities) {
      expect((await webhook(f, path, { CallSid: call.providerSid!, Digits: "1", ...fields })).status).toBe(403);
    }
    expect((await webhook(f, path, { CallSid: call.providerSid!, Digits: "1" }, false)).status).toBe(403);
    expect((await webhook(f, `${path}&stage=consent`, { CallSid: call.providerSid!, Digits: "1" })).status).toBe(403);
    expect((await read(f, call.id)).version).toBe(row.version);
  });
  it("replays identical stage responses but cannot change a prior answer or backtrack", async () => {
    const f = await fixture(), { call } = await missed(f);
    const first = await step(f, call, "1");
    expect((await step(f, call, "1", { stage: "service", version: 2 })).xml).toBe(first.xml);
    expect((await step(f, call, "2", { stage: "service", version: 2 })).xml).not.toContain("<Gather");
    expect((await step(f, call, "1", { stage: "consent", version: 5 })).xml).not.toContain("<Gather");
    expect(await read(f, call.id)).toMatchObject({ serviceIntent: "repair", stage: "request", version: 3 });
  });
  it.each(["", "9", "11", "speech instead"])("ends safely on invalid/empty digit %j without generating a challenge", async (digit) => {
    const f = await fixture(), { call } = await missed(f), result = await step(f, call, digit);
    expect(result.xml).not.toContain("<Gather"); expect(result.row).toMatchObject({ state: "blocked", stage: "complete", challengeHash: null, triggerMessageSid: null });
    expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, f.org))).toHaveLength(1);
  });
  it("reads complete optional disclosure before Gather and stores encrypted replay without sending", async () => {
    const f = await fixture(), { call } = await missed(f);
    await step(f, call, "3"); await step(f, call, "2"); const window = await step(f, call, "1");
    expect(window.xml.indexOf("This is optional")).toBeLessThan(window.xml.indexOf("<Gather"));
    const choice = await step(f, call, "1"), row = choice.row;
    expect(row).toMatchObject({ state: "awaiting_sms", stage: "complete", serviceIntent: "maintenance", requestIntent: "visit", callbackWindow: "morning", triggerMessageSid: null });
    const code = decryptSecret(row.challengeEncrypted!, `callie:${f.org}:${row.id}:challenge`);
    expect(row.challengeHash).toBe(callieChallengeHash(code));
    expect(JSON.stringify(row.stepReceipts)).not.toContain(code); expect(row.challengeEncrypted).not.toContain(code);
    expect((await step(f, call, "1", { stage: "consent", version: 5 })).xml).toBe(choice.xml);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("does not invent consent when caller declines the optional acknowledgment", async () => {
    const f = await fixture(), { call } = await missed(f);
    await step(f, call, "1"); await step(f, call, "1"); await step(f, call, "3");
    const { row } = await step(f, call, "0");
    expect(row).toMatchObject({ state: "blocked", reason: "caller_declined_text", challengeHash: null });
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.organizationId, f.org))).toHaveLength(0);
  });
  it("consumes exact caller-originated SMS after ordinary hangup, retaining deadline and no reusable consent", async () => {
    const f = await fixture(), { call, row, code } = await qualified(f);
    await webhook(f, `/public/voice/status?operation=${call.id}`, { CallSid: call.providerSid!, CallStatus: "completed" });
    const { response, messageSid } = await sms(f, `CALLIE ${code}`);
    expect(response.status).toBe(200); expect(await response.text()).not.toContain("<Message");
    const confirmed = await read(f, call.id);
    expect(confirmed).toMatchObject({ state: "confirmed", triggerMessageSid: messageSid, triggerAccountSid: f.account, triggerFrom: f.phone, triggerTo: f.sender });
    expect(confirmed.dueAt).toEqual(row.dueAt); expect(confirmed.ackDueAt).not.toBeNull();
    expect(confirmed.triggerPayloadHash).toBe(callieTriggerHash({ accountSid: f.account, from: f.phone, to: f.sender, messageSid, bodyHash: row.challengeHash! }));
    const [event] = await db.select().from(twilioInboundEventsTable).where(eq(twilioInboundEventsTable.messageSid, messageSid));
    expect(event).toMatchObject({ eventType: "CALLIE", body: null, contactId: null });
    for (const table of [consentRecordsTable, twilioConsentProofsTable, contactsTable, leadsTable]) expect(await db.select().from(table).where(eq(table.organizationId, f.org))).toHaveLength(0);
    const [handoff] = await db.select().from(missedCallHandoffsTable).where(eq(missedCallHandoffsTable.callId, call.id));
    expect(handoff).toMatchObject({ reviewedAt: null, reviewedByUserId: null, contactId: null, leadId: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects wrong, malformed, other-phone, expired and foreign-tenant confirmations", async () => {
    const f = await fixture(), { call, code } = await qualified(f), other = await fixture();
    for (const body of ["CALLIE", "CALLIE 1", "CALLIE 123456789", "CALLIE 00000000 extra", "CALLIE 00000000"]) expect((await sms(f, body)).response.status).toBe(200);
    expect((await sms(f, `CALLIE ${code}`, { From: "+12025550000" })).response.status).toBe(200);
    expect((await sms(other, `CALLIE ${code}`)).response.status).toBe(200);
    expect((await read(f, call.id)).triggerMessageSid).toBeNull();
    await db.update(intakes).set({ challengeExpiresAt: new Date(Date.now() - 1) }).where(eq(intakes.callId, call.id));
    await sms(f, `CALLIE ${code}`); expect((await read(f, call.id)).triggerMessageSid).toBeNull();
  });
  it("makes both same-message and fresh-message used-code replays non-authorizing", async () => {
    const f = await fixture(), { call, code } = await qualified(f);
    const first = await sms(f, `CALLIE ${code}`), version = (await read(f, call.id)).version;
    await sms(f, `CALLIE ${code}`, { MessageSid: first.messageSid }); await sms(f, `CALLIE ${code}`);
    expect(await read(f, call.id)).toMatchObject({ version, triggerMessageSid: first.messageSid });
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "callie.one_call_sms_requested")))).toHaveLength(1);
  });
  it("STOP has priority over challenge text and neither CALLIE nor START restores general consent", async () => {
    const f = await fixture(), { call, code } = await qualified(f);
    await sms(f, `CALLIE ${code}`, { OptOutType: "STOP" });
    expect((await read(f, call.id)).triggerMessageSid).toBeNull();
    expect(await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, f.org))).toHaveLength(1);
    await sms(f, `CALLIE ${code}`); expect((await read(f, call.id)).state).toBe("blocked");
    await sms(f, "START"); expect((await read(f, call.id)).triggerMessageSid).toBeNull();
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.organizationId, f.org))).toHaveLength(0);
  });
  it.each(["HELP", "START"])("does not treat provider %s as CALLIE consent", async (optOut) => {
    const f = await fixture(), { call, code } = await qualified(f);
    await sms(f, `CALLIE ${code}`, { OptOutType: optOut });
    expect((await read(f, call.id)).triggerMessageSid).toBeNull();
  });
  it.each(["policy", "owner", "binding", "company", "environment"])("fails closed when %s changes before confirmation", async (change) => {
    const f = await fixture(), { call, code } = await qualified(f);
    if (change === "policy") await approve(f, false);
    if (change === "owner") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.owner));
    if (change === "binding") await db.update(twilioClientBindingsTable).set({ smsDisclosureVersion: "changed-program" }).where(eq(twilioClientBindingsTable.id, f.bindingId));
    if (change === "company") await transitionCustomerLifecycle(f.org, f.owner, { action: "pause", expectedVersion: 0, reason: "Synthetic intake pause" });
    if (change === "environment") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await sms(f, `CALLIE ${code}`); expect((await read(f, call.id)).triggerMessageSid).toBeNull();
  });
  it("checks all matching DNC contacts without auto-linking an ambiguous shared phone", async () => {
    const f = await fixture(), { call, code } = await qualified(f);
    await db.insert(contactsTable).values([{ organizationId: f.org, firstName: "Synthetic A", phone: f.phone }, { organizationId: f.org, firstName: "Synthetic B", phone: f.phone, doNotContactSms: true }]);
    await sms(f, `CALLIE ${code}`); expect((await read(f, call.id))).toMatchObject({ state: "blocked", triggerMessageSid: null });
    const [original] = await db.select().from(twilioCallsTable).where(eq(twilioCallsTable.id, call.id)); expect(original.contactId).toBeNull();
  });
  it.each(["reassigned", "unassigned", "done", "cancelled"] as const)("signed incoming SMS preserves a %s callback and cannot create a grant", async change => {
    const f = await fixture(), { call, code } = await qualified(f);
    const before = await staffChangesTask(f, call.id, change);
    const first = await sms(f, `CALLIE ${code}`);
    expect(first.response.status).toBe(200);
    expect(await read(f, call.id)).toMatchObject({ state: "blocked", reason: "office_callback_changed", triggerMessageSid: null });
    expect(await callbackTask(f, call.id)).toEqual(before);
    await sms(f, `CALLIE ${code}`, { MessageSid: first.messageSid }); await sms(f, `CALLIE ${code}`);
    expect((await read(f, call.id)).triggerMessageSid).toBeNull();
    expect(await callbackTask(f, call.id)).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("preserves in-progress status and original deadline through successful signed Gather and SMS", async () => {
    const f = await fixture(), { call, row } = await missed(f), original = await callbackTask(f, call.id);
    await db.update(crmTasksTable).set({ status: "in_progress" }).where(eq(crmTasksTable.id, original.id));
    for (const digit of ["3", "2", "1", "1"]) {
      await step(f, call, digit);
      expect(await callbackTask(f, call.id)).toMatchObject({ assignedUserId: f.owner, status: "in_progress", completedAt: null, dueAt: row.dueAt });
    }
    const awaiting = await read(f, call.id), code = decryptSecret(awaiting.challengeEncrypted!, `callie:${f.org}:${awaiting.id}:challenge`);
    expect((await sms(f, `CALLIE ${code}`)).response.status).toBe(200);
    expect((await read(f, call.id)).state).toBe("confirmed");
    expect(await callbackTask(f, call.id)).toMatchObject({ assignedUserId: f.owner, status: "in_progress", completedAt: null, dueAt: row.dueAt });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite").each(["Gather", "SMS"] as const)("signed %s waits for the real original-task row lock and honors committed staff reassignment", async kind => {
    const f = await fixture(), prepared = kind === "SMS" ? await qualified(f) : { ...await missed(f), code: "" };
    const callback = await callbackTask(f, prepared.call.id);
    const [other] = await db.insert(usersTable).values({ organizationId: f.org, email: `${randomUUID()}@example.invalid`, role: "office", isActive: true, emailVerifiedAt: new Date() }).returning();
    const writer = await pool.connect();
    let request: Promise<{ error: unknown }> | undefined, changedAt: Date | undefined;
    try {
      await writer.query("BEGIN");
      const held = await writer.query<{ pid: number; updatedAt: Date }>("UPDATE crm_tasks SET assigned_user_id=$1, status='in_progress', description='Concurrent staff reassignment must survive.', updated_at=now() WHERE organization_id=$2 AND id=$3 RETURNING pg_backend_pid() AS pid, updated_at AS \"updatedAt\"", [other.id, f.org, callback.id]);
      changedAt = held.rows[0].updatedAt;
      const action = kind === "SMS" ? sms(f, `CALLIE ${prepared.code}`) : step(f, prepared.call, "1");
      request = action.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      // This checks an actual blocked SELECT FOR UPDATE on an independent
      // backend, not an artificial timer or PGlite's serialized socket shim.
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE '%from \"crm_tasks\"%' AND query LIKE '%for update%'", [held.rows[0].pid]);
        expect(waiting.rows[0].count).toBeGreaterThan(0);
      }, { timeout: 4000, interval: 25 });
      await writer.query("COMMIT");
    } finally { await writer.query("ROLLBACK"); writer.release(); }
    expect((await request!).error).toBeUndefined();
    expect(await read(f, prepared.call.id)).toMatchObject({ state: "blocked", reason: "office_callback_changed", triggerMessageSid: null });
    expect(await callbackTask(f, prepared.call.id)).toMatchObject({ assignedUserId: other.id, status: "in_progress", description: "Concurrent staff reassignment must survive.", updatedAt: changedAt });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 10_000);
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("concurrent independent PostgreSQL confirmations consume one exact trigger", async () => {
    const f = await fixture(), { call, code } = await qualified(f);
    const results = await Promise.all([sms(f, `CALLIE ${code}`), sms(f, `CALLIE ${code}`)]);
    expect(results.map((value) => value.response.status)).toEqual([200, 200]);
    const row = await read(f, call.id); expect(results.map((value) => value.messageSid)).toContain(row.triggerMessageSid);
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "callie.one_call_sms_requested")))).toHaveLength(1);
  });
  it("rejects cross-company policy, owner, binding, trigger and partial grant SQL relationships", async () => {
    const f = await fixture(), { call } = await missed(f), other = await fixture(), [foreign] = await db.select().from(policies).where(eq(policies.organizationId, other.org));
    // Catch the real constraint error in a server-side subtransaction. PGlite's
    // wire adapter mishandles repeated extended-protocol ERROR/ROLLBACK pairs;
    // this still requires the actual FK/check to reject each invalid write.
    for (const [column, value] of [["policy_revision_id", foreign.id], ["owner_user_id", other.owner], ["binding_id", other.bindingId], ["trigger_from", f.phone], ["state", "confirmed"], ["state", "booked"]]) {
      expect(column).toMatch(/^[a-z_]+$/); expect(value).toMatch(/^[a-zA-Z0-9_+-]+$/); expect(call.id).toMatch(/^[a-f0-9-]+$/);
      await db.execute(sql.raw(`DO $negative$ BEGIN BEGIN UPDATE callie_intakes SET ${column} = '${value}' WHERE call_id = '${call.id}'::uuid; RAISE EXCEPTION 'invalid write unexpectedly accepted'; EXCEPTION WHEN foreign_key_violation OR check_violation THEN NULL; END; END $negative$;`));
    }
    expect((await read(f, call.id)).state).toBe("collecting");
    expect(f.org).toMatch(/^[a-f0-9-]+$/);
    await db.execute(sql.raw(`DO $negative$ BEGIN BEGIN UPDATE callie_policy_revisions SET snapshot = snapshot - 'enabled' WHERE organization_id = '${f.org}'::uuid; RAISE EXCEPTION 'missing enabled unexpectedly accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $negative$;`));
  });
});
