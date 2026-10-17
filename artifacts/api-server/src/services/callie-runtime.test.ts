import { randomInt, randomUUID } from "node:crypto";
import type { Request } from "express";
import { getExpectedTwilioSignature } from "twilio";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEventsTable, callieAckDispatchesTable as acks, callieIntakesTable as intakes, calliePolicyRevisionsTable as policies,
  consentRecordsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, leadsTable, missedCallCareCasesTable,
  missedCallHandoffsTable, organizationsTable, revenueExecutionsTable as executions, twilioCallsTable as calls,
  twilioClientBindingsTable as bindings, twilioConsentProofsTable, twilioDispatchesTable, twilioInboundEventsTable as inbound, usersTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber, syntheticTwilioSid } from "../test-helpers/synthetic-twilio";
import { approveCalliePolicy, assertCallieCurrentAuthority, getCalliePolicy, previewCalliePolicy } from "./callie-policy";
import { acceptCallieStatusCallback, processCallieIntakes } from "./callie-runtime";
import { callieChallengeHash, callieOperationKey, callieTriggerHash, DEFAULT_CALLIE_POLICY } from "./callie-contract";
import { ensureMissedCallHandoff } from "./missed-call-handoff";
import { listMissedCallCare, previewMissedCallCare, processMissedCallCare } from "./missed-call-care";
import { addSuppression } from "./send-gate";
import { sendTwilioSms } from "./twilio-delivery";
import { encryptSecret } from "../lib/token-encryption";

const boundary = vi.hoisted(() => ({ beforeDispatch: undefined as undefined | (() => Promise<void>) }));
const carrier = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./sms-carrier-transport", async original => {
  const actual = await original<typeof import("./sms-carrier-transport")>();
  return { ...actual, postSmsOnce: carrier.post.mockImplementation(actual.postSmsOnce) };
});
vi.mock("./callie-ack-transport", async original => {
  const actual = await original<typeof import("./callie-ack-transport")>();
  return { ...actual, postCallieAcknowledgment: async (...args: Parameters<typeof actual.postCallieAcknowledgment>) => {
    await boundary.beforeDispatch?.(); return actual.postCallieAcknowledgment(...args);
  } };
});
let org: string, otherOrg: string, owner: string, afterOwner: string, foreignOwner: string, bindingId: string, accountSid: string;
let revisionId: string;
const phone = "+12025550101", sender = syntheticTwilioNumber(), providerMessageSid = syntheticTwilioSid("SM"), provider = vi.fn<typeof fetch>();
const settings = () => ({ ...DEFAULT_CALLIE_POLICY, enabled: true, days: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59", businessHoursOwnerId: owner, afterHoursOwnerId: afterOwner });
async function approvePolicy(policy = settings()) {
  const current = await getCalliePolicy(org);
  const preview = await previewCalliePolicy(org, owner, { expectedVersion: current.version, policy });
  const result = await approveCalliePolicy(org, owner, { expectedVersion: current.version, expectedSnapshot: { ...preview.expectedSnapshot }, previewHash: preview.previewHash, confirmed: true });
  revisionId = result.revisionId!; return result;
}
async function fixture(otherPhone = phone) {
  const now = new Date(), intakeId = randomUUID(), messageSid = `SM${randomUUID().replaceAll("-", "")}`, code = String(randomInt(10000000, 100000000));
  const [call] = await db.insert(calls).values({ organizationId: org, requestKey: randomUUID(), direction: "inbound", phone: otherPhone,
    staffPhone: "+12025550109", accountSid, providerSid: `CA${randomUUID().replaceAll("-", "")}`, status: "completed", dialStatus: "no-answer", authorizationSource: "signed-inbound-fixture", createdAt: now }).returning();
  await db.insert(inbound).values({ organizationId: org, messageSid, phone: otherPhone, eventType: "CALLIE", body: null, receivedAt: now });
  const [intake] = await db.insert(intakes).values({ id: intakeId, organizationId: org, callId: call.id, policyRevisionId: revisionId,
    state: "confirmed", stage: "complete", bindingId, accountSid, providerCallSid: call.providerSid!, fromPhone: otherPhone,
    calledNumber: sender, ownerUserId: owner, dueAt: new Date(now.getTime() + 30 * 60_000), ackDueAt: now,
    serviceIntent: "repair", requestIntent: "visit", callbackWindow: "morning", challengeHash: callieChallengeHash(code),
    challengeEncrypted: encryptSecret(code, `callie:${org}:${intakeId}:challenge`), challengeExpiresAt: new Date(now.getTime() + 15 * 60_000),
    triggerMessageSid: messageSid, triggerAccountSid: accountSid, triggerFrom: otherPhone, triggerTo: sender,
    triggerPayloadHash: callieTriggerHash({ accountSid, from: otherPhone, to: sender, messageSid, bodyHash: callieChallengeHash(code) }),
    confirmedAt: now, grantExpiresAt: new Date(now.getTime() + 86400_000), createdAt: now }).returning();
  const handoff = await ensureMissedCallHandoff(org, call.id);
  await db.update(crmTasksTable).set({ assignedUserId: owner, dueAt: intake.dueAt }).where(eq(crmTasksTable.id, handoff!.taskId));
  return { call, intake, taskId: handoff!.taskId };
}
const currentIntake = async (id: string) => (await db.select().from(intakes).where(eq(intakes.id, id)))[0];
const operations = () => db.select().from(acks).where(eq(acks.organizationId, org));
const receipts = () => db.select().from(executions).where(eq(executions.organizationId, org));
beforeEach(async () => {
  carrier.post.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-03T16:00:00Z"));
  boundary.beforeDispatch = undefined;
  vi.stubEnv("SESSION_SECRET", "callie-synthetic-preview-never-deploy");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "17".repeat(32));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("TWILIO_CLIENT_CALLIE_RUNTIME_AUTH_TOKEN", "callie-synthetic-signature");
  vi.stubEnv("TWILIO_CLIENT_CALLIE_RUNTIME_API_KEY_SECRET", "callie-synthetic-api");
  provider.mockReset().mockImplementation(async () => Response.json({ sid: `SM${randomUUID().replaceAll("-", "")}` }, { status: 201 }));
  vi.stubGlobal("fetch", provider);
  [org, otherOrg] = (await db.insert(organizationsTable).values([{ name: "CALLIE synthetic", slug: randomUUID() }, { name: "Other CALLIE synthetic", slug: randomUUID() }]).returning()).map(row => row.id);
  [owner, afterOwner, foreignOwner] = (await db.insert(usersTable).values([
    { organizationId: org, role: "owner", emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` },
    { organizationId: org, role: "sales_rep", emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` },
    { organizationId: otherOrg, role: "owner", emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` },
  ]).returning()).map(row => row.id);
  accountSid = `AC${randomUUID().replaceAll("-", "")}`;
  const [binding] = await db.insert(bindings).values({ organizationId: org, accountSid, phoneNumber: sender, staffPhone: "+12025550109",
    messagingServiceSid: `MG${"2".repeat(32)}`, apiKeySid: `SK${"3".repeat(32)}`, authTokenSecretRef: "TWILIO_CLIENT_CALLIE_RUNTIME_AUTH_TOKEN",
    apiKeySecretRef: "TWILIO_CLIENT_CALLIE_RUNTIME_API_KEY_SECRET", publicOrigin: "https://growth.example", businessName: "Synthetic Contractor",
    smsDisclosureVersion: "callie-synthetic.v1", dailySmsLimit: 20, dailyCallLimit: 20, launchApproved: true, voiceEnabled: true, voiceApproved: true,
    smsEnabled: true, registrationApproved: true, advancedOptOut: true, geoPermissionsReviewed: true }).returning();
  bindingId = binding.id;
});
afterEach(async () => { await deleteTestOrgs(org, otherOrg); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("CALLIE exact standing policy", () => {
  it("defaults off and a preview alone grants no standing authority", async () => {
    expect(await getCalliePolicy(org)).toMatchObject({ version: 0, policy: { enabled: false }, readiness: { ready: false } });
    await previewCalliePolicy(org, owner, { expectedVersion: 0, policy: settings() });
    await expect(assertCallieCurrentAuthority(org)).rejects.toMatchObject({ code: "policy_disabled_or_revised" });
    expect(await db.select().from(policies).where(eq(policies.organizationId, org))).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });
  it("requires the exact actor-bound saved unexpired review and rejects stale approval", async () => {
    const preview = await previewCalliePolicy(org, owner, { expectedVersion: 0, policy: settings() });
    const approval = { expectedVersion: 0, expectedSnapshot: { ...preview.expectedSnapshot }, previewHash: preview.previewHash, confirmed: true as const };
    await expect(approveCalliePolicy(otherOrg, foreignOwner, approval)).rejects.toMatchObject({ code: "stale_policy_preview" });
    await expect(approveCalliePolicy(org, owner, { ...approval, expectedSnapshot: { ...approval.expectedSnapshot, policy: { ...approval.expectedSnapshot.policy, responseMinutes: 5 } } })).rejects.toMatchObject({ code: "invalid_policy_preview" });
    await approveCalliePolicy(org, owner, approval);
    await expect(approveCalliePolicy(org, owner, approval)).rejects.toMatchObject({ code: "stale_policy" });
    const expiring = await previewCalliePolicy(org, owner, { expectedVersion: 1, policy: settings() });
    vi.setSystemTime(new Date(Date.now() + 600_001));
    await expect(approveCalliePolicy(org, owner, { expectedVersion: 1, expectedSnapshot: { ...expiring.expectedSnapshot }, previewHash: expiring.previewHash, confirmed: true })).rejects.toMatchObject({ code: "stale_policy_preview" });
  });
  it("keeps approved policy visibly held and allows disabling without provider credentials", async () => {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    expect(await approvePolicy()).toMatchObject({ policy: { enabled: true }, readiness: { ready: false, reason: "environment_outbound_hold" } });
    vi.stubEnv("TWILIO_CLIENT_CALLIE_RUNTIME_AUTH_TOKEN", "");
    expect(await approvePolicy({ ...settings(), enabled: false })).toMatchObject({ version: 2, policy: { enabled: false } });
    expect(provider).not.toHaveBeenCalled();
  });
  it("requires accepted same-company owners and rechecks the non-selected owner", async () => {
    await expect(previewCalliePolicy(org, owner, { expectedVersion: 0, policy: { ...settings(), afterHoursOwnerId: foreignOwner } })).rejects.toMatchObject({ code: "owner_unavailable" });
    await approvePolicy();
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, afterOwner));
    await expect(assertCallieCurrentAuthority(org)).rejects.toMatchObject({ code: "owner_unavailable" });
  });
});

describe("CALLIE one-call acknowledgment actual adapter", () => {
  it("sends exactly one fixed response without creating contact, lead, consent or a booking", async () => {
    await approvePolicy(); const f = await fixture();
    await processCallieIntakes(org); await processCallieIntakes(org);
    expect(provider).toHaveBeenCalledOnce();
    expect(carrier.post).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    const body = new URLSearchParams(String(provider.mock.calls[0][1]!.body));
    expect([...body.keys()]).toEqual(["To", "MessagingServiceSid", "Body", "StatusCallback"]);
    expect(body.get("Body")).toBe("Synthetic Contractor: We received your request about your missed call. Our office will review your service and callback preferences. A visit is not booked, and emergency dispatch is not confirmed. Please call our shop if you need to speak with the team.\nReply STOP to opt out. HELP for help.");
    expect(body.get("StatusCallback")).toBe(`https://growth.example/api/v1/public/sms/status?callieOperation=${(await operations())[0].id}`);
    expect(body.get("Body")).toContain("Synthetic Contractor:"); expect(body.get("Body")).toContain("A visit is not booked");
    expect(body.get("Body")).not.toContain("12345678"); expect(body.get("StatusCallback")).toContain("?callieOperation=");
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "accepted", appointmentId: null });
    expect(await operations()).toHaveLength(1); expect(await receipts()).toMatchObject([{ actionKey: callieOperationKey(f.call.id), state: "succeeded" }]);
    for (const table of [contactsTable, leadsTable, consentRecordsTable, twilioConsentProofsTable]) expect(await db.select().from(table).where(eq(table.organizationId, org))).toHaveLength(0);
    expect((await db.select().from(missedCallHandoffsTable).where(eq(missedCallHandoffsTable.callId, f.call.id)))[0]).toMatchObject({ reviewedAt: null, reviewedByUserId: null });
  });
  it("permanently excludes admitted calls from the older care approval and scheduler", async () => {
    await approvePolicy(); const f = await fixture(); await processMissedCallCare(org);
    expect((await listMissedCallCare(org)).items).toHaveLength(0);
    expect(await db.select().from(missedCallCareCasesTable).where(eq(missedCallCareCasesTable.organizationId, org))).toHaveLength(0);
    await expect(previewMissedCallCare(org, f.call.id)).rejects.toMatchObject({ code: "callie_intake_authoritative" });
    expect(provider).not.toHaveBeenCalled();
  });
  it("escalates an overdue working callback once without undoing progress or changing its review timestamp again", async () => {
    await approvePolicy(); const f = await fixture(); await processCallieIntakes(org);
    await db.update(crmTasksTable).set({ status: "in_progress", priority: "normal", description: null,
      dueAt: null }).where(eq(crmTasksTable.id, f.taskId));
    const readTask = async () => (await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.taskId)))[0];
    const working = await readTask();
    vi.setSystemTime(new Date(f.intake.dueAt.getTime() + 60_000)); await processCallieIntakes(org);
    const escalated = await readTask();
    expect(escalated).toMatchObject({ status: "in_progress", assignedUserId: owner, priority: "high",
      completedAt: working.completedAt, dueAt: f.intake.dueAt });
    expect(escalated.description).toContain("callback_deadline_reached");
    expect(escalated.updatedAt.getTime()).toBeGreaterThan(working.updatedAt.getTime());
    for (const delay of [120_000, 180_000]) {
      vi.setSystemTime(new Date(f.intake.dueAt.getTime() + delay)); await processCallieIntakes(org);
      expect(await readTask()).toEqual(escalated);
    }
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "accepted", dueAt: f.intake.dueAt });
    expect(provider).toHaveBeenCalledOnce(); expect(await operations()).toHaveLength(1); expect(await receipts()).toHaveLength(1);
  });
  it.each(["policy", "day_owner", "after_owner", "binding", "program", "hold", "company", "DNC", "suppression", "reply", "late_call_failure", "task_closed", "task_reassigned", "expired", "grant", "dispatch_tuple", "allowance", "lowered_allowance"] as const)("rechecks %s after atomic ownership and before the physical POST", async change => {
    await approvePolicy(); const f = await fixture();
    boundary.beforeDispatch = async () => {
      boundary.beforeDispatch = undefined;
      if (change === "policy") await approvePolicy({ ...settings(), enabled: false });
      if (change === "day_owner" || change === "after_owner") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, change === "day_owner" ? owner : afterOwner));
      if (change === "binding") await db.update(bindings).set({ businessName: "Changed business" }).where(eq(bindings.id, bindingId));
      if (change === "program") await db.update(bindings).set({ smsDisclosureVersion: "changed.v2" }).where(eq(bindings.id, bindingId));
      if (change === "hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      if (change === "company") await db.insert(customerLifecycleTable).values({ organizationId: org, state: "paused", reason: "Synthetic safety hold" });
      if (change === "DNC") await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", phone, doNotContactSms: true });
      if (change === "suppression") await addSuppression({ organizationId: org, channel: "sms", value: phone, reason: "stop_keyword", source: "synthetic" });
      if (change === "reply") await db.insert(inbound).values({ organizationId: org, messageSid: `SM${randomUUID().replaceAll("-", "")}`, phone, eventType: "message", body: "Please wait", receivedAt: new Date() });
      if (change === "late_call_failure") await db.update(calls).set({ status: "canceled" }).where(eq(calls.id, f.call.id));
      if (change === "task_closed") await db.update(crmTasksTable).set({ status: "done", completedAt: new Date() }).where(eq(crmTasksTable.id, f.taskId));
      if (change === "task_reassigned") await db.update(crmTasksTable).set({ assignedUserId: afterOwner }).where(eq(crmTasksTable.id, f.taskId));
      if (change === "expired") vi.setSystemTime(new Date(Date.now() + 86400_001));
      if (change === "grant") await db.update(intakes).set({ triggerPayloadHash: "a".repeat(64) }).where(eq(intakes.id, f.intake.id));
      if (change === "dispatch_tuple") await db.update(acks).set({ toPhone: "+12025550102" }).where(eq(acks.intakeId, f.intake.id));
      if (change === "allowance") await db.update(bindings).set({ dailySmsLimit: 0 }).where(eq(bindings.id, bindingId));
      if (change === "lowered_allowance") {
        const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Other synthetic", phone: "+12025550102" }).returning();
        await db.insert(twilioDispatchesTable).values({ organizationId: org, contactId: contact.id, idempotencyKey: "another-owned-send", payloadHash: "a".repeat(64), phone: contact.phone!, purpose: "customer_care", accountSid, status: "uncertain", createdAt: new Date() });
        await db.update(bindings).set({ dailySmsLimit: 1 }).where(eq(bindings.id, bindingId));
      }
    };
    await processCallieIntakes(org);
    expect(provider).not.toHaveBeenCalled(); expect(await operations()).toMatchObject([{ status: "cancelled", providerSid: null }]);
    expect(await receipts()).toMatchObject([{ state: "blocked" }]);
    if (change === "task_closed") expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.taskId)))[0].status).toBe("done");
    if (change === "task_reassigned") expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.taskId)))[0].assignedUserId).toBe(afterOwner);
  });
  it("blocks ambiguous phone identities and all prior response ownership", async () => {
    await approvePolicy(); const f = await fixture();
    await db.insert(contactsTable).values([{ organizationId: org, firstName: "One", phone }, { organizationId: org, firstName: "Two", phone }]);
    await processCallieIntakes(org); expect(provider).not.toHaveBeenCalled();
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "blocked", reason: "caller_phone_ambiguous" });
    const other = await fixture("+12025550102");
    await db.insert(executions).values({ organizationId: org, actionKey: callieOperationKey(other.call.id), fingerprint: "a".repeat(64), kind: "missed_call_care_sms", state: "confirmed_not_performed", expiresAt: new Date() });
    await processCallieIntakes(org); expect(provider).not.toHaveBeenCalled();
    expect(await currentIntake(other.intake.id)).toMatchObject({ state: "blocked", reason: "logical_response_already_owned" });
  });
  it("defers only within the grant and keeps the original callback deadline", async () => {
    await approvePolicy({ ...settings(), opensAt: "17:00", closesAt: "18:00" }); const f = await fixture();
    await db.update(intakes).set({ ownerUserId: afterOwner }).where(eq(intakes.id, f.intake.id));
    await db.update(crmTasksTable).set({ assignedUserId: afterOwner }).where(eq(crmTasksTable.id, f.taskId));
    await processCallieIntakes(org);
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "deferred", dueAt: f.intake.dueAt, ackDueAt: new Date("2026-10-03T17:00:00Z") });
    expect(await receipts()).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-10-03T17:00:00Z")); await processCallieIntakes(org); expect(provider).toHaveBeenCalledOnce();
  });
  it("does not rearm a timeout even with a reconciled receipt and changed policy", async () => {
    await approvePolicy(); const f = await fixture(); provider.mockRejectedValueOnce(new Error("Synthetic timeout after POST"));
    await processCallieIntakes(org); expect(await currentIntake(f.intake.id)).toMatchObject({ state: "indeterminate" });
    expect(await operations()).toMatchObject([{ status: "uncertain" }]);
    await db.update(executions).set({ state: "confirmed_not_performed" }).where(eq(executions.organizationId, org));
    await approvePolicy(); await processCallieIntakes(org); expect(provider).toHaveBeenCalledOnce();
  });
  it.each([
    { kind: "429", status: "rate_limited" }, { kind: "503", status: "uncertain" },
    { kind: "malformed201", status: "uncertain" }, { kind: "missingSid", status: "uncertain" },
    { kind: "timeout", status: "uncertain" },
  ])("settles CALLIE $kind without throwing or rearming the original intake", async ({ kind, status }) => {
    await approvePolicy(); const f = await fixture();
    if (kind === "timeout") provider.mockRejectedValueOnce(new Error("Synthetic timeout after POST"));
    else provider.mockResolvedValueOnce(kind === "malformed201" ? new Response("not json", { status: 201 }) : kind === "missingSid" ? Response.json({}, { status: 201 }) : Response.json({ code: Number(kind) }, { status: Number(kind) }));
    await expect(processCallieIntakes(org)).resolves.toBeUndefined();
    const [owned] = await operations();
    expect(owned).toMatchObject({ status, providerSid: null });
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "indeterminate" });
    expect(await receipts()).toMatchObject([{ state: "indeterminate" }]);
    await expect(processCallieIntakes(org)).resolves.toBeUndefined();
    expect(provider).toHaveBeenCalledOnce(); expect((await operations()).map(row => row.id)).toEqual([owned.id]);
  });
  // Intentional backend trigger failure needs actual PostgreSQL. PGlite's one
  // backend/socket adapter cannot attest recovery across an aborted transaction.
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("keeps an accepted network effect uncertain when the atomic final storage fails", async () => {
    await approvePolicy(); const f = await fixture();
    const suffix = randomUUID().replaceAll("-", ""), functionName = `callie_fail_${suffix}`, triggerName = `callie_fail_${suffix}`;
    await db.execute(sql.raw(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic final storage outage'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON callie_ack_dispatches FOR EACH ROW WHEN (NEW.status = 'accepted' AND NEW.organization_id = '${org}'::uuid) EXECUTE FUNCTION "${functionName}"()`));
    try {
      await processCallieIntakes(org); await processCallieIntakes(org);
      expect(provider).toHaveBeenCalledOnce(); expect(await operations()).toMatchObject([{ status: "uncertain", providerSid: null }]);
      expect(await receipts()).toMatchObject([{ state: "indeterminate" }]);
      expect(await currentIntake(f.intake.id)).toMatchObject({ state: "indeterminate" });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER "${triggerName}" ON callie_ack_dispatches`));
      await db.execute(sql.raw(`DROP FUNCTION "${functionName}"()`));
    }
  });
  it("expires a request whose next permitted window is outside its one-call grant", async () => {
    await approvePolicy({ ...settings(), days: [1], opensAt: "09:00", closesAt: "18:00" }); const f = await fixture();
    await db.update(intakes).set({ ownerUserId: afterOwner }).where(eq(intakes.id, f.intake.id));
    await db.update(crmTasksTable).set({ assignedUserId: afterOwner }).where(eq(crmTasksTable.id, f.taskId));
    await processCallieIntakes(org);
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "blocked", reason: "grant_expires_before_safe_window", dueAt: f.intake.dueAt });
    expect(await receipts()).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
  });
  it("preserves actual late acceptance without overwriting a reconciled receipt", async () => {
    await approvePolicy(); const f = await fixture();
    provider.mockImplementationOnce(async () => {
      await db.update(executions).set({ state: "confirmed_not_performed" }).where(eq(executions.organizationId, org));
      return Response.json({ sid: providerMessageSid }, { status: 201 });
    });
    await processCallieIntakes(org);
    expect(await operations()).toMatchObject([{ status: "accepted", providerSid: providerMessageSid }]);
    expect(await receipts()).toMatchObject([{ state: "confirmed_not_performed" }]);
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "indeterminate" });
    await processCallieIntakes(org); expect(provider).toHaveBeenCalledOnce();
  });
  it("keeps HTTP failures non-retryable and creates permanent suppression only for typed recipient errors", async () => {
    await approvePolicy(); await fixture(); provider.mockResolvedValueOnce(Response.json({ code: 21610 }, { status: 400 }));
    await processCallieIntakes(org); await processCallieIntakes(org);
    expect(await operations()).toMatchObject([{ status: "failed", errorCode: "21610" }]);
    expect(await receipts()).toMatchObject([{ state: "indeterminate" }]); expect(provider).toHaveBeenCalledOnce();
  });
  it("validates signed original delivery context and retains late delivery without replay", async () => {
    await approvePolicy(); await fixture(); provider.mockRejectedValueOnce(new Error("Synthetic timeout")); await processCallieIntakes(org);
    const [ack] = await operations();
    const request = (overrides: Record<string, string> = {}, signed = true) => {
      const body = { AccountSid: accountSid, From: sender, To: phone, MessageSid: providerMessageSid, MessageStatus: "delivered", MessagingServiceSid: `MG${"2".repeat(32)}`, ...overrides };
      const originalUrl = `/api/v1/public/sms/status?callieOperation=${ack.id}`;
      return { body, query: { callieOperation: ack.id }, originalUrl, is: () => "application/x-www-form-urlencoded", headers: { "x-twilio-signature": signed ? getExpectedTwilioSignature("callie-synthetic-signature", `https://growth.example${originalUrl}`, body) : "bad" } } as unknown as Request;
    };
    expect(await acceptCallieStatusCallback(request({}, false))).toBe(false);
    expect(await acceptCallieStatusCallback(request({ To: "+12025550102" }))).toBe(false);
    expect(await acceptCallieStatusCallback(request())).toBe(true);
    expect(await operations()).toMatchObject([{ status: "delivered", providerSid: providerMessageSid }]);
    expect(await receipts()).toMatchObject([{ state: "indeterminate" }]);
    expect(await acceptCallieStatusCallback(request({ MessageStatus: "sent" }))).toBe(true);
    expect(await operations()).toMatchObject([{ status: "delivered" }]);
    await processCallieIntakes(org); expect(provider).toHaveBeenCalledOnce();
  });
  it("counts the new ledger in the ordinary SMS allowance without borrowing one-call permission", async () => {
    await approvePolicy(); await fixture(); await db.update(bindings).set({ dailySmsLimit: 1 }).where(eq(bindings.id, bindingId));
    await processCallieIntakes(org);
    const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Other synthetic", phone: "+12025550102" }).returning();
    const context = { organizationId: org, contactId: contact.id, purpose: "customer_care" as const, idempotencyKey: "ordinary-test" };
    await expect(sendTwilioSms(contact.phone!, "Ordinary requested care", context)).rejects.toThrow(/consent/);
    await db.insert(consentRecordsTable).values({ organizationId: org, contactId: contact.id, channel: "sms", granted: true, disclosureVersion: "callie-synthetic.v1" });
    await db.insert(twilioConsentProofsTable).values({ organizationId: org, contactId: contact.id, phone: contact.phone!, purpose: "customer_care", granted: true, disclosureVersion: "callie-synthetic.v1", source: "synthetic" });
    await expect(sendTwilioSms(contact.phone!, "Ordinary requested care", context)).rejects.toThrow(/daily operation limit/);
    expect(provider).toHaveBeenCalledOnce();
  });
  it("counts an older ordinary dispatch in the CALLIE phone cap", async () => {
    await approvePolicy(); const f = await fixture();
    const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", phone }).returning();
    await db.insert(twilioDispatchesTable).values({ organizationId: org, contactId: contact.id, idempotencyKey: "older-response", payloadHash: "a".repeat(64),
      phone, purpose: "customer_care", accountSid, status: "uncertain", createdAt: new Date(Date.now() - 60_000) });
    await processCallieIntakes(org);
    expect(await currentIntake(f.intake.id)).toMatchObject({ state: "blocked", reason: "grant_expires_before_safe_window" });
    expect(provider).not.toHaveBeenCalled(); expect(await receipts()).toHaveLength(0);
  });
});

describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("independent PostgreSQL CALLIE ownership", () => {
  it("claims one physical response under simultaneous workers", async () => {
    await approvePolicy(); await fixture(); await Promise.all([processCallieIntakes(org), processCallieIntakes(org)]);
    expect(provider).toHaveBeenCalledOnce(); expect(await operations()).toHaveLength(1); expect(await receipts()).toHaveLength(1);
  });
  it("serializes shared daily allowance across two separately granted callers", async () => {
    await approvePolicy(); await fixture(); await fixture("+12025550102"); await db.update(bindings).set({ dailySmsLimit: 1 }).where(eq(bindings.id, bindingId));
    await Promise.all([processCallieIntakes(org), processCallieIntakes(org)]);
    expect(provider).toHaveBeenCalledOnce(); expect(await operations()).toHaveLength(1);
  });
  it("shares the same allowance lock with the contact-required transport", async () => {
    await approvePolicy(); await fixture();
    const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Other synthetic", phone: "+12025550102" }).returning();
    await db.insert(consentRecordsTable).values({ organizationId: org, contactId: contact.id, channel: "sms", granted: true, disclosureVersion: "callie-synthetic.v1" });
    await db.insert(twilioConsentProofsTable).values({ organizationId: org, contactId: contact.id, phone: contact.phone!, purpose: "customer_care", granted: true, disclosureVersion: "callie-synthetic.v1", source: "synthetic" });
    await db.update(bindings).set({ dailySmsLimit: 1 }).where(eq(bindings.id, bindingId));
    await Promise.allSettled([processCallieIntakes(org), sendTwilioSms(contact.phone!, "Ordinary requested care", { organizationId: org, contactId: contact.id, purpose: "customer_care", idempotencyKey: "competing-ordinary" })]);
    expect(provider).toHaveBeenCalledOnce();
    expect((await operations()).length + (await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org))).length).toBe(1);
  });
});
