import { randomUUID } from "node:crypto";
import { createVapidTestKeyPair } from "../test-helpers/vapid-test-keys";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contactsTable, crmTasksTable, db, leadsTable, organizationsTable, serviceObligationsTable,
  serviceWatchCasesTable as cases, staffPushDeliveriesTable as deliveries, usersTable } from "@workspace/db";
vi.mock("./staff-push-transport", async original => ({ ...await original<typeof import("./staff-push-transport")>(), sendStaffPush: vi.fn() }));
import { sendStaffPush, StaffPushDispatchBlockedError } from "./staff-push-transport";
import { enqueueStaffServiceNotice, processStaffLeadPush, registerStaffPush, saveStaffPushPolicy } from "./staff-push";
import { getServiceWatch, processServiceWatch, updateServiceWatch } from "./service-watch";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

const key = createVapidTestKeyPair().ecdh;
let org: string, otherOrg: string, owner: string, otherOwner: string, sid: string, contact: string, service: string, task: string;
const policy = (enabled = true) => ({ enabled: true, serviceAlertsEnabled: enabled, timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6],
  opensAt: "09:00", closesAt: "18:00", businessHoursUserIds: [owner], afterHoursUserIds: [owner] });
const rows = () => db.select().from(deliveries).where(eq(deliveries.organizationId, org));
beforeEach(async () => {
  vi.stubEnv("WEB_PUSH_ENABLED", "true"); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:synthetic@example.invalid"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  vi.mocked(sendStaffPush).mockReset().mockImplementation(async (_subscription, _payload, _user, guard) => {
    if (guard && !await guard()) throw new StaffPushDispatchBlockedError();
    return 201;
  });
  [org, otherOrg] = (await db.insert(organizationsTable).values([
    { name: "Synthetic service push", slug: randomUUID() }, { name: "Other synthetic service push", slug: randomUUID() },
  ]).returning()).map(row => row.id);
  [owner, otherOwner] = (await db.insert(usersTable).values([
    { organizationId: org, role: "owner" }, { organizationId: otherOrg, role: "owner" },
  ]).returning()).map(row => row.id);
  sid = await createSession({ user: { id: owner, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
  [contact] = (await db.insert(contactsTable).values({ organizationId: org, firstName: "Private synthetic customer" }).returning()).map(row => row.id);
  [task] = (await db.insert(crmTasksTable).values({ organizationId: org, contactId: contact, assignedUserId: owner, title: "Private synthetic service plan" }).returning()).map(row => row.id);
  [service] = (await db.insert(serviceObligationsTable).values({ organizationId: org, contactId: contact, taskId: task, kind: "maintenance", equipmentLabel: "Private equipment", dueAt: new Date("2020-01-01T12:00:00Z") }).returning()).map(row => row.id);
  await saveStaffPushPolicy(org, owner, policy());
  await registerStaffPush(org, owner, sid, { endpoint: `https://web.push.apple.com/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } });
});
afterEach(async () => { await deleteTestOrgs(org, otherOrg); await deleteSession(sid); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("typed, accountable service-owner push", () => {
  it("atomically enqueues one device notice for an exception without manufacturing a lead, then accepts only once", async () => {
    await processServiceWatch(org);
    const [first] = await rows();
    expect(first).toMatchObject({ leadId: null, serviceObligationId: service, serviceOwnerId: owner, state: "pending" });
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, org))).toHaveLength(0);
    expect(sendStaffPush).not.toHaveBeenCalled();
    await processServiceWatch(org);
    const [watch] = await db.select().from(cases).where(eq(cases.organizationId, org));
    await db.transaction(tx => enqueueStaffServiceNotice({ organizationId: org, serviceObligationId: service, caseId: watch.id,
      assignedUserId: owner, eventKey: first.eventKey!, noticeRevision: watch.noticeRevision, occurredAt: new Date() }, tx));
    expect(await rows()).toHaveLength(1);
    await processStaffLeadPush(org); await processStaffLeadPush(org);
    expect(sendStaffPush).toHaveBeenCalledOnce();
    const payload = JSON.parse(vi.mocked(sendStaffPush).mock.calls[0][1]);
    expect(payload).toMatchObject({ organizationId: org, serviceObligationId: service, url: `/service?serviceObligationId=${service}&organizationId=${org}` });
    expect(payload.leadId).toBeUndefined(); expect(JSON.stringify(payload)).not.toContain("Private");
    expect((await rows())[0]).toMatchObject({ state: "accepted", reason: "provider_accepted_not_received_or_read" });
  });
  it("keeps legacy policies off and never broadcasts unassigned services", async () => {
    const { serviceAlertsEnabled: _ignored, ...legacy } = policy();
    await saveStaffPushPolicy(org, owner, legacy); await processServiceWatch(org);
    expect(await rows()).toHaveLength(0);
    await saveStaffPushPolicy(org, owner, policy());
    await db.update(crmTasksTable).set({ assignedUserId: null }).where(eq(crmTasksTable.id, task));
    await processServiceWatch(org);
    expect(await rows()).toHaveLength(0);
  });
  it.each(["acknowledge", "completed", "reassigned", "policy", "logout", "unverified"])("cancels a queued alert after %s", async change => {
    await processServiceWatch(org);
    if (change === "acknowledge") {
      const review = await getServiceWatch(org, owner, service);
      await updateServiceWatch(org, owner, service, { action: "acknowledge", requestId: randomUUID(), expectedVersion: review.expectedVersion, expectedFingerprint: review.expectedFingerprint,
        assignedUserId: owner, note: "Office will review the equipment schedule", nextActionAt: new Date(Date.now() + 86_400_000).toISOString(), reviewed: true });
    }
    if (change === "completed") await db.update(serviceObligationsTable).set({ status: "completed" }).where(eq(serviceObligationsTable.id, service));
    if (change === "reassigned") await db.update(crmTasksTable).set({ assignedUserId: null }).where(eq(crmTasksTable.id, task));
    if (change === "policy") await saveStaffPushPolicy(org, owner, policy(false));
    if (change === "logout") await deleteSession(sid);
    if (change === "unverified") await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, owner));
    await processStaffLeadPush(org);
    expect(sendStaffPush).not.toHaveBeenCalled(); expect((await rows())[0].state).toBe("cancelled");
  });
  it("holds the queue for company pause and never claims another company", async () => {
    await processServiceWatch(org);
    await processStaffLeadPush(otherOrg); expect(sendStaffPush).not.toHaveBeenCalled();
    await transitionCustomerLifecycle(org, owner, { action: "pause", expectedVersion: 0, reason: "Synthetic operational hold" });
    await processStaffLeadPush(org); expect(sendStaffPush).not.toHaveBeenCalled();
    expect((await rows())[0].state).toBe("pending");
  });
  it("rechecks a changed case at the actual transport boundary and labels definite non-dispatch", async () => {
    await processServiceWatch(org);
    vi.mocked(sendStaffPush).mockImplementationOnce(async (_s, _p, _u, guard) => {
      await db.update(serviceObligationsTable).set({ status: "completed" }).where(eq(serviceObligationsTable.id, service));
      expect(await guard!()).toBe(false);
      throw new StaffPushDispatchBlockedError();
    });
    await processStaffLeadPush(org);
    expect((await rows())[0]).toMatchObject({ state: "cancelled", reason: "dispatch_authorization_changed" });
  });
  it("retains uncertain acceptance and never replays it on the next monitor tick", async () => {
    await processServiceWatch(org);
    vi.mocked(sendStaffPush).mockRejectedValueOnce(new Error("PRIVATE_ENDPOINT"));
    await processStaffLeadPush(org); await processServiceWatch(org); await processStaffLeadPush(org);
    expect(sendStaffPush).toHaveBeenCalledOnce();
    expect(await rows()).toHaveLength(1); expect((await rows())[0].state).toBe("indeterminate");
    expect(JSON.stringify(await rows())).not.toContain("PRIVATE_ENDPOINT");
  });
  it("rejects cross-company service owners at the database boundary", async () => {
    await processServiceWatch(org);
    const [queued] = await rows();
    await expect(db.update(deliveries).set({ serviceOwnerId: otherOwner }).where(and(eq(deliveries.id, queued.id), eq(deliveries.organizationId, org)))).rejects.toThrow();
    expect((await rows())[0].serviceOwnerId).toBe(owner);
  });
  it("rolls back service reconciliation and notification work together", async () => {
    await processServiceWatch(org);
    const [queued] = await rows();
    await expect(db.transaction(async tx => {
      await tx.delete(deliveries).where(eq(deliveries.id, queued.id));
      await tx.delete(cases).where(eq(cases.id, queued.serviceWatchCaseId!));
      throw new Error("Synthetic rollback");
    })).rejects.toThrow("Synthetic rollback");
    expect(await rows()).toHaveLength(1);
    expect(await db.select().from(cases).where(eq(cases.organizationId, org))).toHaveLength(1);
  });
});
