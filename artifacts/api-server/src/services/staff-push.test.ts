import { createECDH, randomUUID } from "node:crypto";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { db, contactsTable, leadsTable, organizationsTable, usersTable, sessionsTable, staffPushDeliveriesTable as deliveries,
  staffPushSubscriptionsTable as subscriptions, smartSitesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./staff-push-transport", () => ({ sendStaffPush: vi.fn(async () => 201) }));
// The capture contract under test is its durable lead/device transaction.
// Do not run unrelated fire-and-forget playbook/webhook enrollment against
// the single-session PGlite backend while its next capture transaction starts.
vi.mock("./automation", async (original) => ({
  ...await original<typeof import("./automation")>(), emitAutomationEvent: vi.fn(),
}));
import { sendStaffPush } from "./staff-push-transport";
import { enqueueStaffLeadPush, getStaffPushStatus, processStaffLeadPush, registerStaffPush, revokeStaffPush, saveStaffPushPolicy } from "./staff-push";
import { createLead } from "./crm";
import { createCaptureEndpoint, captureExternalLead } from "./capture";
import { authenticateSmartSite, captureSmartSiteInquiry, createSmartSite, updateSmartSite } from "./smart-sites";
import { normalizeSmartSiteIntake } from "./smart-site-contract";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import app from "../app";

const key = createECDH("prime256v1"); key.generateKeys();
const device = () => ({ endpoint: `https://web.push.apple.com/${randomUUID().replaceAll("-", "")}`,
  keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } });
let server: Server, base: string;
let orgId: string, otherOrgId: string, userId: string, otherUserId: string, sid: string, otherSid: string, contactId: string;
const policy = () => ({ enabled: true, timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6], opensAt: "09:00", closesAt: "18:00",
  businessHoursUserIds: [userId], afterHoursUserIds: [userId] });
const rows = () => db.select().from(deliveries).where(eq(deliveries.organizationId, orgId));
const lead = (extra: Record<string, unknown> = {}) => createLead(orgId, { contactId, ...extra });
const request = (path: string, data?: unknown, method = "GET", session = sid) => fetch(`${base}/api/v1${path}`, {
  method, headers: { authorization: `Bearer ${session}`, ...(data !== undefined ? { "content-type": "application/json" } : {}) },
  body: data !== undefined ? JSON.stringify(data) : undefined,
});

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
beforeEach(async () => {
  vi.stubEnv("WEB_PUSH_ENABLED", "true"); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:operator@example.invalid"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  vi.mocked(sendStaffPush).mockReset().mockResolvedValue(201);
  [orgId, otherOrgId] = (await db.insert(organizationsTable).values([
    { name: "Synthetic staff push A", slug: `push-${randomUUID()}` }, { name: "Synthetic staff push B", slug: `push-${randomUUID()}` },
  ]).returning()).map((org) => org.id);
  [userId, otherUserId] = (await db.insert(usersTable).values([
    { organizationId: orgId, role: "owner", email: `${randomUUID()}@example.invalid` },
    { organizationId: otherOrgId, role: "owner", email: `${randomUUID()}@example.invalid` },
  ]).returning()).map((user) => user.id);
  const authUser = (id: string) => ({ id, email: null, firstName: null, lastName: null, profileImageUrl: null });
  sid = await createSession({ user: authUser(userId), access_token: "synthetic" });
  otherSid = await createSession({ user: authUser(otherUserId), access_token: "synthetic" });
  [contactId] = (await db.insert(contactsTable).values({ organizationId: orgId, firstName: "Synthetic homeowner", phone: "4045550199" }).returning()).map((c) => c.id);
});
afterEach(async () => {
  await deleteTestOrgs(orgId, otherOrgId);
  await deleteSession(sid); await deleteSession(otherSid);
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("session-bound staff subscription and policy", () => {
  it("encrypts endpoints/keys and limits status to the signed-in session", async () => {
    const input = device(); await registerStaffPush(orgId, userId, sid, input);
    const [stored] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(stored.encryptedSubscription).not.toContain(input.endpoint);
    const status = await getStaffPushStatus(orgId, userId, sid);
    expect(status.subscriptions).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain(input.keys.auth);
    expect(JSON.stringify(status)).not.toContain(sid);
    expect((await getStaffPushStatus(orgId, userId, otherSid)).subscriptions).toHaveLength(0);
  });
  it("rejects API keys, anonymous users, foreign Origin and viewer policy writes", async () => {
    const apiKey = await fetch(`${base}/api/v1/staff-push/subscriptions`, { method: "POST", headers: {
      authorization: `Bearer ${sid}`, "x-api-key": "synthetic-do-not-resolve", "content-type": "application/json" }, body: JSON.stringify(device()) });
    expect(apiKey.status).toBe(401);
    expect((await request("/staff-push/status", undefined, "GET", "invalid")).status).toBe(401);
    expect((await fetch(`${base}/api/v1/staff-push/status`, { headers: { authorization: `Bearer ${sid}`, origin: "https://attacker.invalid" } })).status).toBe(403);
    await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, userId));
    expect((await request("/staff-push/policy", policy(), "PUT")).status).toBe(403);
  });
  it("registers only matching active member/session, not cross-tenant supplied identities", async () => {
    await expect(registerStaffPush(orgId, userId, otherSid, device())).rejects.toMatchObject({ code: "active_member_session_required" });
    await expect(registerStaffPush(otherOrgId, userId, sid, device())).rejects.toMatchObject({ code: "active_member_session_required" });
    expect((await request("/staff-push/subscriptions", { ...device(), organizationId: otherOrgId }, "POST")).status).toBe(400);
  });
  it("requires complete policy and active same-company recipients", async () => {
    expect((await request("/staff-push/policy", { ...policy(), days: [] }, "PUT")).status).toBe(400);
    await expect(saveStaffPushPolicy(orgId, userId, { ...policy(), afterHoursUserIds: [otherUserId] })).rejects.toMatchObject({ code: "recipients_must_be_active_organization_responders" });
    expect((await request("/staff-push/policy", policy(), "PUT")).status).toBe(200);
    expect(await (await request("/staff-push/policy", undefined, "GET", otherSid)).json()).toEqual({ policy: null });
  });
  it("does not silently transfer an existing browser endpoint to another account", async () => {
    const input = device(); await registerStaffPush(orgId, userId, sid, input);
    await expect(registerStaffPush(otherOrgId, otherUserId, otherSid, input)).rejects.toMatchObject({ status: 409 });
    await revokeStaffPush(otherOrgId, otherUserId, otherSid, input.endpoint);
    expect((await getStaffPushStatus(orgId, userId, sid)).subscriptions).toHaveLength(1);
  });
  it("caps devices at five and renews the same device without duplicating it", async () => {
    const first = device(); const original = await registerStaffPush(orgId, userId, sid, first);
    for (let i = 1; i < 5; i++) await registerStaffPush(orgId, userId, sid, device());
    expect((await registerStaffPush(orgId, userId, sid, first)).id).toBe(original.id);
    await expect(registerStaffPush(orgId, userId, sid, device())).rejects.toMatchObject({ code: "device_limit_revoke_existing_devices" });
  });
  it("binds device expiry to browser and session expiry", async () => {
    const soon = new Date(Date.now() + 120_000);
    await db.update(sessionsTable).set({ expire: soon }).where(eq(sessionsTable.sid, sid));
    const saved = await registerStaffPush(orgId, userId, sid, device());
    expect(saved.expiresAt.getTime()).toBe(soon.getTime());
    const earlier = Date.now() + 60_000;
    expect((await registerStaffPush(orgId, userId, sid, { ...device(), expirationTime: earlier })).expiresAt.getTime()).toBe(earlier);
    await expect(registerStaffPush(orgId, userId, sid, { ...device(), expirationTime: 1 })).rejects.toMatchObject({ code: "device_subscription_expired" });
  });
});

describe("durable new-lead queue and bounded dispatch", () => {
  beforeEach(async () => { await saveStaffPushPolicy(orgId, userId, policy()); await registerStaffPush(orgId, userId, sid, device()); });
  it("commits one opaque receipt with the lead, dedupes repeat enqueue, never sends in request", async () => {
    const saved = (await lead())!;
    await db.transaction((tx) => enqueueStaffLeadPush(tx, orgId, saved));
    expect(await rows()).toHaveLength(1); expect(sendStaffPush).not.toHaveBeenCalled();
    await processStaffLeadPush(orgId);
    expect((await rows())[0].state).toBe("accepted");
    expect((await rows())[0].reason).toBe("provider_accepted_not_received_or_read");
    expect(sendStaffPush).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(sendStaffPush).mock.calls[0][1])).toMatchObject({ organizationId: orgId, leadId: saved.id });
    expect(vi.mocked(sendStaffPush).mock.calls[0][1]).not.toContain("Synthetic homeowner");
    await processStaffLeadPush(orgId); expect(sendStaffPush).toHaveBeenCalledTimes(1);
  });
  it("rolls back the lead and queued effect together", async () => {
    await expect(db.transaction(async (tx) => {
      const [saved] = await tx.insert(leadsTable).values({ organizationId: orgId, contactId }).returning();
      await enqueueStaffLeadPush(tx, orgId, saved); throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    expect(await rows()).toHaveLength(0);
  });
  it("does not notify a historical import or update", async () => {
    await lead({ creationMethod: "import" }); expect(await rows()).toHaveLength(0);
  });
  it("capture retries and contact merges do not add another new-lead notification", async () => {
    const endpoint = await createCaptureEndpoint(orgId, { name: "Synthetic capture", mapping: { email: "email", name: "firstName" } });
    const input = { email: "capture@example.invalid", name: "Synthetic" };
    const first = await captureExternalLead(endpoint, input, { idempotencyKey: "same-request" });
    const retry = await captureExternalLead(endpoint, input, { idempotencyKey: "same-request" });
    const merge = await captureExternalLead(endpoint, input, { idempotencyKey: "new-request" });
    expect(first.ok).toBe(true); expect(retry.ok).toBe(true); expect(merge.ok).toBe(true);
    expect(await rows()).toHaveLength(1);
  });
  it("Smart Site intake and its idempotent retry share the same durable notification", async () => {
    const site = await createSmartSite(orgId, userId, { name: "Synthetic intake", siteKey: `push-${randomUUID()}`, profile: "roofing-exteriors" });
    // Synthetic credential-check evidence only; no hosted site/provider involved.
    await db.update(smartSitesTable).set({ credentialCheckedAt: new Date() }).where(eq(smartSitesTable.id, site.id));
    await updateSmartSite(orgId, userId, site.id, true, true);
    const authenticated = await authenticateSmartSite(site.id, site.secret);
    const input = normalizeSmartSiteIntake({ schemaVersion: 1, requestId: randomUUID(),
      contact: { name: "Synthetic inquiry", email: "site@example.invalid" }, project: { serviceCode: "roof-repair", timing: "planning" },
      consent: { contact: true, analytics: false, policyVersion: "synthetic-v1", channels: ["email"] } });
    const first = await captureSmartSiteInquiry(authenticated, input);
    const second = await captureSmartSiteInquiry(authenticated, input);
    expect(first.duplicate).toBe(false); expect(second.duplicate).toBe(true); expect(second.leadId).toBe(first.leadId);
    expect(await rows()).toHaveLength(1); expect(sendStaffPush).not.toHaveBeenCalled();
  });
  it("bounds each worker cycle to ten effects and leaves further work pending", async () => {
    for (let i = 0; i < 11; i++) await lead();
    await processStaffLeadPush(orgId);
    expect(sendStaffPush).toHaveBeenCalledTimes(10);
    expect((await rows()).filter((row) => row.state === "pending")).toHaveLength(1);
    await processStaffLeadPush(orgId); expect(sendStaffPush).toHaveBeenCalledTimes(11);
  });
  it.each([302, 401, 429, 500])("does not retry a provider response %s", async (status) => {
    await lead(); vi.mocked(sendStaffPush).mockResolvedValueOnce(status);
    await processStaffLeadPush(orgId); await processStaffLeadPush(orgId);
    expect(sendStaffPush).toHaveBeenCalledTimes(1);
    expect((await rows())[0].state).toBe(status >= 500 ? "indeterminate" : "rejected");
  });
  it("held/disabled work stays pending, then an enabled restarted worker can dispatch once", async () => {
    await lead(); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await processStaffLeadPush(orgId); expect((await rows())[0].state).toBe("pending");
    expect(sendStaffPush).not.toHaveBeenCalled();
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"); vi.stubEnv("WEB_PUSH_ENABLED", "false");
    await processStaffLeadPush(orgId); expect((await rows())[0].state).toBe("pending");
    vi.stubEnv("WEB_PUSH_ENABLED", "true"); await processStaffLeadPush(orgId);
    expect((await rows())[0].state).toBe("accepted"); expect(sendStaffPush).toHaveBeenCalledTimes(1);
  });
  it("concurrent workers atomically own the effect once", async () => {
    await lead(); await Promise.all([processStaffLeadPush(orgId), processStaffLeadPush(orgId)]);
    expect(sendStaffPush).toHaveBeenCalledTimes(1); expect((await rows())[0].state).toBe("accepted");
  });
  it("interrupted/ambiguous effects never automatically replay", async () => {
    await lead(); await db.update(deliveries).set({ state: "dispatching", claimedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(deliveries.organizationId, orgId));
    await processStaffLeadPush(orgId); expect((await rows())[0].state).toBe("indeterminate"); expect(sendStaffPush).not.toHaveBeenCalled();
    await lead(); vi.mocked(sendStaffPush).mockRejectedValueOnce(new Error("SECRET_ENDPOINT_AND_KEY"));
    await processStaffLeadPush(orgId); await processStaffLeadPush(orgId);
    expect(sendStaffPush).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await rows())).not.toContain("SECRET");
    expect((await rows()).every((r) => r.state === "indeterminate")).toBe(true);
  });
  it("expires stale pending receipts instead of flooding after an outage", async () => {
    await lead(); await db.update(deliveries).set({ expiresAt: new Date(1) }).where(eq(deliveries.organizationId, orgId));
    await processStaffLeadPush(orgId); expect((await rows())[0].state).toBe("expired"); expect(sendStaffPush).not.toHaveBeenCalled();
  });
  it.each(["logout", "deactivate", "membership", "role", "policy", "revoke"])("rechecks %s before network dispatch", async (change) => {
    await lead();
    if (change === "logout") await deleteSession(sid);
    if (change === "deactivate") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId));
    if (change === "membership") await db.update(usersTable).set({ organizationId: otherOrgId }).where(eq(usersTable.id, userId));
    if (change === "role") await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, userId));
    if (change === "policy") await saveStaffPushPolicy(orgId, userId, { ...policy(), enabled: false });
    if (change === "revoke") await revokeStaffPush(orgId, userId, sid);
    await processStaffLeadPush(orgId); expect(sendStaffPush).not.toHaveBeenCalled(); expect((await rows())[0].state).toBe("cancelled");
  });
  it("rechecks session expiry without background OAuth refresh", async () => {
    await lead(); await db.update(sessionsTable).set({ expire: new Date(1) }).where(eq(sessionsTable.sid, sid));
    await processStaffLeadPush(orgId); expect(sendStaffPush).not.toHaveBeenCalled(); expect((await rows())[0].state).toBe("cancelled");
  });
  it("requires explicit staging user allowlist at dispatch", async () => {
    await lead(); vi.stubEnv("GROWTHOS_ENVIRONMENT", "staging"); vi.stubEnv("STAGING_OUTBOUND_APPROVED", "true");
    vi.stubEnv("STAGING_PUSH_USER_ALLOWLIST", otherUserId);
    await processStaffLeadPush(orgId); expect(sendStaffPush).not.toHaveBeenCalled(); expect((await rows())[0].state).toBe("cancelled");
  });
  it.each([404, 410])("revokes only the recipient device on provider %s", async (status) => {
    const other = await registerStaffPush(otherOrgId, otherUserId, otherSid, device());
    await lead(); vi.mocked(sendStaffPush).mockResolvedValueOnce(status); await processStaffLeadPush(orgId);
    expect((await rows())[0].state).toBe("rejected");
    const [mine] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(mine.encryptedSubscription).toBe(null); expect(mine.revokedAt).toBeInstanceOf(Date);
    const [theirs] = await db.select().from(subscriptions).where(eq(subscriptions.id, other.id)); expect(theirs.revokedAt).toBe(null);
  });
  it("a late expiry response cannot revoke a newly renewed device lease", async () => {
    await lead();
    vi.mocked(sendStaffPush).mockImplementationOnce(async (input) => {
      await registerStaffPush(orgId, userId, sid, input);
      return 410;
    });
    await processStaffLeadPush(orgId);
    const [renewed] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(renewed.revokedAt).toBe(null); expect(renewed.encryptedSubscription).not.toBe(null);
    expect((await rows())[0].state).toBe("rejected");
  });
  it("does not process another tenant queue or expose its receipts", async () => {
    await lead(); await processStaffLeadPush(otherOrgId); expect(sendStaffPush).not.toHaveBeenCalled();
    expect(await (await request("/staff-push/deliveries", undefined, "GET", otherSid)).json()).toMatchObject({ receipts: [] });
  });
});
