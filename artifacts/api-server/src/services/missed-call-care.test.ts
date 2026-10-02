import { createECDH, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db, organizationsTable, usersTable, contactsTable, consentRecordsTable, twilioClientBindingsTable,
  twilioCallsTable, twilioConsentProofsTable, twilioDispatchesTable, twilioInboundEventsTable,
  missedCallCareCasesTable as cases, missedCallCarePoliciesTable as policies, revenueExecutionsTable as receipts,
  missedCallHandoffsTable as handoffs, crmTasksTable, customerLifecycleTable, leadsTable, staffPushDeliveriesTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createSession, deleteSession } from "../lib/auth";
import { registerStaffPush, saveStaffPushPolicy } from "./staff-push";
import { SMS_DISCLOSURE_VERSION } from "./twilio-controls";
import { ensureMissedCallHandoff, reviewMissedCall } from "./missed-call-handoff";
import { approveMissedCallCare, closeMissedCallCare, getMissedCallCarePolicy, listMissedCallCare, previewMissedCallCare, processMissedCallCare, saveMissedCallCarePolicy } from "./missed-call-care";
import { careOperationKey, DEFAULT_CARE_POLICY } from "./missed-call-care-policy";
import { expireInterruptedActions, reconcileExecution } from "./durable-execution";

const boundary = vi.hoisted(() => ({ hook: undefined as undefined | (() => Promise<void>) }));
vi.mock("./twilio-delivery", async (original) => {
  const actual = await original<typeof import("./twilio-delivery")>();
  return { ...actual, sendTwilioSms: (...args: Parameters<typeof actual.sendTwilioSms>) => actual.sendTwilioSms(args[0], args[1], args[2], async () => {
    await boundary.hook?.(); await args[3]?.();
  }) };
});
let org: string, otherOrg: string, owner: string, afterOwner: string, outsider: string, contact: string, call: string, account: string;
const provider = vi.fn<typeof fetch>(), phone = "+12025550101";
const policy = () => ({ ...DEFAULT_CARE_POLICY, enabled: true, days: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59", businessHoursOwnerId: owner, afterHoursOwnerId: afterOwner });
const row = async () => (await db.select().from(cases).where(and(eq(cases.organizationId, org), eq(cases.callId, call))))[0];
const records = () => db.select().from(receipts).where(eq(receipts.organizationId, org));
async function reviewed(enable = true, createLead = false) {
  if (enable) await saveMissedCallCarePolicy(org, owner, 0, policy());
  await ensureMissedCallHandoff(org, call);
  const result = await reviewMissedCall(org, call, owner, { requestId: randomUUID(), action: createLead ? "create_opportunity" : "link_contact", contactId: contact });
  expect(result).not.toHaveProperty("error");
}
async function approve() {
  const preview = await previewMissedCallCare(org, call);
  return approveMissedCallCare(org, call, owner, preview.version, preview.snapshot);
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-02T16:00:00Z"));
  boundary.hook = undefined;
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("TWILIO_CLIENT_CARE_AUTH_TOKEN", "synthetic-webhook");
  vi.stubEnv("TWILIO_CLIENT_CARE_API_KEY_SECRET", "synthetic-secret");
  provider.mockReset().mockImplementation(async () => Response.json({ sid: `SM${randomUUID().replaceAll("-", "")}` }, { status: 201 }));
  vi.stubGlobal("fetch", provider);
  [org, otherOrg] = (await db.insert(organizationsTable).values([
    { name: "Synthetic missed-call company", slug: `care-${randomUUID()}` }, { name: "Other synthetic company", slug: `care-${randomUUID()}` },
  ]).returning()).map((item) => item.id);
  [owner, afterOwner, outsider] = (await db.insert(usersTable).values([
    { organizationId: org, role: "owner", emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` },
    { organizationId: org, role: "sales_rep", emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` },
    { organizationId: otherOrg, role: "owner", emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` },
  ]).returning()).map((item) => item.id);
  [contact] = (await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic caller", phone }).returning()).map((item) => item.id);
  account = `AC${randomUUID().replaceAll("-", "")}`;
  await db.insert(twilioClientBindingsTable).values({ organizationId: org, accountSid: account, phoneNumber: "+15005550009",
    messagingServiceSid: `MG${"2".repeat(32)}`, apiKeySid: `SK${"3".repeat(32)}`,
    authTokenSecretRef: "TWILIO_CLIENT_CARE_AUTH_TOKEN", apiKeySecretRef: "TWILIO_CLIENT_CARE_API_KEY_SECRET",
    publicOrigin: "https://growth.example", businessName: "Synthetic Contractor", smsDisclosureVersion: SMS_DISCLOSURE_VERSION,
    dailySmsLimit: 20, launchApproved: true, smsEnabled: true, registrationApproved: true, advancedOptOut: true, geoPermissionsReviewed: true });
  await db.insert(consentRecordsTable).values({ organizationId: org, contactId: contact, channel: "sms", granted: true, disclosureVersion: SMS_DISCLOSURE_VERSION });
  await db.insert(twilioConsentProofsTable).values({ organizationId: org, contactId: contact, phone, purpose: "customer_care", granted: true, disclosureVersion: SMS_DISCLOSURE_VERSION, source: "synthetic purpose opt-in" });
  [call] = (await db.insert(twilioCallsTable).values({ organizationId: org, contactId: contact, requestKey: randomUUID(), direction: "inbound", phone, staffPhone: "+12025550109", accountSid: account,
    providerSid: `CA${randomUUID().replaceAll("-", "")}`, status: "completed", dialStatus: "no-answer", authorizationSource: "signed-inbound", createdAt: new Date(Date.now() - 60_000) }).returning()).map((item) => item.id);
});
afterEach(async () => {
  await deleteTestOrgs(org, otherOrg);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("reviewed missed-call recovery", () => {
  it("keeps default-disabled and unknown callers in review without creating leads, consent, or SMS", async () => {
    await ensureMissedCallHandoff(org, call); await ensureMissedCallHandoff(org, call);
    await processMissedCallCare(org);
    expect((await getMissedCallCarePolicy(org)).policy.enabled).toBe(false);
    expect((await db.select().from(cases).where(eq(cases.organizationId, org)))).toHaveLength(1);
    expect((await db.select().from(handoffs).where(eq(handoffs.organizationId, org)))).toHaveLength(1);
    expect((await db.select().from(leadsTable).where(eq(leadsTable.organizationId, org)))).toHaveLength(0);
    await expect(previewMissedCallCare(org, call)).rejects.toMatchObject({ code: "caller_review_required" });
    expect(await records()).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
  });
  it("rejects answered calls, tenant crossing, and foreign or inactive owners", async () => {
    await db.update(twilioCallsTable).set({ dialStatus: "completed" }).where(eq(twilioCallsTable.id, call));
    expect(await ensureMissedCallHandoff(org, call)).toBeNull();
    await expect(previewMissedCallCare(otherOrg, call)).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
    await expect(saveMissedCallCarePolicy(org, owner, 0, { ...policy(), afterHoursOwnerId: outsider })).rejects.toMatchObject({ code: "owner_unavailable" });
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, afterOwner));
    await expect(saveMissedCallCarePolicy(org, owner, 0, policy())).rejects.toMatchObject({ code: "owner_unavailable" });
    expect(provider).not.toHaveBeenCalled();
  });
  it("sends only the approved branded message once and exposes provider acceptance separately from replies", async () => {
    await reviewed(true, true); const preview = await previewMissedCallCare(org, call);
    await approveMissedCallCare(org, call, owner, preview.version, preview.snapshot);
    expect(provider).not.toHaveBeenCalled();
    await processMissedCallCare(org); await processMissedCallCare(org);
    expect(provider).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(provider.mock.calls[0][1]?.body));
    expect(body.get("Body")).toBe(preview.snapshot.renderedMessage);
    expect(body.get("StatusCallback")).toMatch(/^https:\/\/growth.example\/api\/v1\/public\/sms\/status\?operation=/);
    expect((await row()).state).toBe("awaiting_reply"); expect((await records())[0].state).toBe("succeeded");
    const item = (await listMissedCallCare(org)).items[0];
    expect(item.delivery?.status).toBe("accepted"); expect(item.replies).toHaveLength(0);
    expect(item.handoff.leadId).toBeTruthy();
    await expect(approveMissedCallCare(org, call, owner, (await row()).version, preview.snapshot)).rejects.toMatchObject({ code: "recovery_already_owned" });
  });
  it("rejects a stale exact-message preview and stale policy version", async () => {
    await reviewed(); const preview = await previewMissedCallCare(org, call);
    await expect(approveMissedCallCare(org, call, owner, preview.version, { ...preview.snapshot, body: "Different unapproved message" })).rejects.toMatchObject({ code: "stale_approval" });
    await saveMissedCallCarePolicy(org, owner, 1, { ...policy(), responseMinutes: 45 });
    await expect(saveMissedCallCarePolicy(org, owner, 1, policy())).rejects.toMatchObject({ code: "stale_policy" });
    await expect(approveMissedCallCare(org, call, owner, preview.version, preview.snapshot)).rejects.toMatchObject({ code: "stale_approval" });
    expect(await records()).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
  });
  it.each(["purpose", "dnc", "policy", "phone", "owner", "reply"] as const)("rechecks %s changes after approval and does not send", async (change) => {
    await reviewed(); await approve();
    if (change === "purpose") await db.update(twilioConsentProofsTable).set({ granted: false }).where(eq(twilioConsentProofsTable.organizationId, org));
    if (change === "dnc") await db.update(contactsTable).set({ doNotContactSms: true }).where(eq(contactsTable.id, contact));
    if (change === "policy") await saveMissedCallCarePolicy(org, owner, 1, { ...policy(), enabled: false });
    if (change === "phone") await db.update(contactsTable).set({ phone: "+12025550102" }).where(eq(contactsTable.id, contact));
    if (change === "owner") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner));
    if (change === "reply") await db.insert(twilioInboundEventsTable).values({ organizationId: org, messageSid: `SM${randomUUID().replaceAll("-", "")}`, phone, eventType: "message", body: "Please call tomorrow", receivedAt: new Date() });
    await processMissedCallCare(org);
    expect(["blocked", "reply_needs_review"]).toContain((await row()).state);
    expect(provider).not.toHaveBeenCalled(); expect(await records()).toHaveLength(0);
  });
  it("requires purpose-specific consent even when a known caller has generic SMS consent", async () => {
    await reviewed(); await db.delete(twilioConsentProofsTable).where(eq(twilioConsentProofsTable.organizationId, org));
    expect((await previewMissedCallCare(org, call)).eligibility).toEqual({ ready: false, reason: "customer_care_consent_required" });
    await expect(approve()).rejects.toMatchObject({ code: "customer_care_consent_required" });
    expect(provider).not.toHaveBeenCalled();
  });
  it("rechecks stale policy approval immediately before the actual provider handoff", async () => {
    await reviewed(); await approve();
    boundary.hook = async () => { await saveMissedCallCarePolicy(org, owner, 1, { ...policy(), enabled: false }); };
    await processMissedCallCare(org);
    expect(provider).not.toHaveBeenCalled(); expect((await row()).state).toBe("indeterminate");
    expect((await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org)))[0].status).toBe("cancelled");
    await processMissedCallCare(org); expect(provider).not.toHaveBeenCalled();
  });
  it.each(["company", "environment"] as const)("does not send while the %s hold is active", async (hold) => {
    await reviewed(); await approve();
    if (hold === "company") await db.insert(customerLifecycleTable).values({ organizationId: org, state: "paused", reason: "Synthetic hold", updatedByUserId: owner });
    else vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await processMissedCallCare(org);
    expect(provider).not.toHaveBeenCalled(); expect(await records()).toHaveLength(0);
    expect((await listMissedCallCare(org))[hold === "company" ? "companyPaused" : "environmentHeld"]).toBe(true);
  });
  it("defers after-hours customer SMS without consuming an execution receipt and names the after-hours owner", async () => {
    await saveMissedCallCarePolicy(org, owner, 0, { ...policy(), opensAt: "17:00", closesAt: "18:00" });
    await reviewed(false); const preview = await previewMissedCallCare(org, call);
    expect(preview.snapshot.ownerUserId).toBe(afterOwner); expect(preview.eligibility.resumeAt).toBe("2026-10-02T17:00:00.000Z");
    await approve(); await processMissedCallCare(org);
    expect((await row()).state).toBe("deferred"); expect(await records()).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
  });
  it("caps another response to the same phone across different calls", async () => {
    await reviewed(); await approve(); await processMissedCallCare(org);
    const [nextCall] = await db.insert(twilioCallsTable).values({ organizationId: org, contactId: contact, requestKey: randomUUID(), direction: "inbound", phone,
      staffPhone: "+12025550109", accountSid: account, dialStatus: "busy", authorizationSource: "signed-inbound", createdAt: new Date() }).returning();
    call = nextCall.id; await reviewed(false);
    expect((await previewMissedCallCare(org, call)).eligibility.reason).toBe("frequency_cap");
    await approve(); await processMissedCallCare(org);
    expect(provider).toHaveBeenCalledOnce(); expect((await row()).state).toBe("deferred");
  });
  it("escalates a missed deadline to the accountable callback task, not a second SMS", async () => {
    await reviewed(); await approve(); await processMissedCallCare(org);
    await db.update(cases).set({ dueAt: new Date(Date.now() - 1) }).where(eq(cases.callId, call));
    await processMissedCallCare(org);
    expect((await row()).reason).toBe("no_reply_deadline");
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, org));
    expect(task).toMatchObject({ status: "open", priority: "high", assignedUserId: owner });
    expect(task.description).toContain("No appointment or emergency dispatch is confirmed");
    expect(provider).toHaveBeenCalledOnce();
  });
  it("shows signed inbound reply/STOP evidence without asserting a booked appointment or precise campaign attribution", async () => {
    await reviewed(); await approve(); await processMissedCallCare(org);
    await db.insert(twilioInboundEventsTable).values({ organizationId: org, messageSid: `SM${randomUUID().replaceAll("-", "")}`, phone, eventType: "STOP", receivedAt: new Date() });
    await processMissedCallCare(org);
    const item = (await listMissedCallCare(org)).items[0];
    expect(item.care).toMatchObject({ state: "reply_needs_review", reason: "caller_opted_out" });
    expect(item.replyAssociation).toBe("same_company_phone_after_call_requires_staff_review");
    expect(item.replies).toHaveLength(1); expect(provider).toHaveBeenCalledOnce();
  });
  it("never retries an uncertain send, even with a fresh approval; closing requires recorded reconciliation", async () => {
    await reviewed(); await approve(); provider.mockRejectedValueOnce(new Error("Synthetic lost provider acknowledgement"));
    await processMissedCallCare(org); await processMissedCallCare(org);
    expect((await row()).state).toBe("indeterminate"); expect(provider).toHaveBeenCalledOnce();
    await expect(approve()).rejects.toMatchObject({ code: "recovery_already_owned" });
    await expect(closeMissedCallCare(org, call, owner, (await row()).version, "resolved")).rejects.toMatchObject({ code: "provider_reconciliation_required" });
    const [receipt] = await records();
    await reconcileExecution(org, receipt.id, owner, "confirmed_not_performed", "Synthetic operator check; do not resend.");
    await closeMissedCallCare(org, call, owner, (await row()).version, "resolved");
    await processMissedCallCare(org); expect(provider).toHaveBeenCalledOnce(); expect((await records())[0].actionKey).toBe(careOperationKey(call));
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, org)))[0].status).toBe("done");
  });
  it("recognizes an abandoned receipt without acquiring a new send identity", async () => {
    await reviewed(); await approve();
    await db.update(cases).set({ state: "dispatching" }).where(eq(cases.callId, call));
    await db.insert(receipts).values({ organizationId: org, actionKey: careOperationKey(call), kind: "missed_call_care_sms", fingerprint: "a".repeat(64), expiresAt: new Date(Date.now() - 1) });
    await processMissedCallCare(org); await expireInterruptedActions(org);
    expect((await row()).state).toBe("indeterminate"); expect((await records())[0].state).toBe("indeterminate"); expect(provider).not.toHaveBeenCalled();
  });
  it("creates one canonical lead push only inside the reviewed new-lead transaction", async () => {
    const key = createECDH("prime256v1"); key.generateKeys();
    vi.stubEnv("WEB_PUSH_ENABLED", "true"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:synthetic@example.invalid");
    const session = await createSession({ user: { id: owner, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
    try {
      await saveStaffPushPolicy(org, owner, { enabled: true, timezone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59", businessHoursUserIds: [owner], afterHoursUserIds: [owner] });
      await registerStaffPush(org, owner, session, { endpoint: `https://web.push.apple.com/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } });
      await ensureMissedCallHandoff(org, call);
      const input = { requestId: randomUUID(), action: "create_opportunity" as const, contactId: contact };
      await reviewMissedCall(org, call, owner, input); await reviewMissedCall(org, call, owner, input);
      expect(await db.select().from(staffPushDeliveriesTable).where(eq(staffPushDeliveriesTable.organizationId, org))).toHaveLength(1);
      expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, org))).toHaveLength(1);
      expect(provider).not.toHaveBeenCalled();
    } finally { await deleteSession(session); }
  });
});
