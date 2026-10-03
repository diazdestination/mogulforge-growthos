import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, usersTable, organizationsTable, platformEmailDispatchesTable as dispatches, platformEmailEventsTable as events } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { issueIdentityTokenRecord } from "../../services/identity-token";
import { sendEmailVerification } from "../../services/identity-email";
import { createStaffInvitation } from "../../services/staff-invitations";
import { transactionalEmailProvider } from "../../services/providers";
import { platformEmailContext, type listPlatformEmailDeliveries } from "../../services/platform-email-delivery";

const signingBytes = Buffer.from("synthetic-platform-webhook-signing-secret");
let server: Server, base: string, org: string, foreign: string, context: string;
let operator: { id: string; sid: string }, owner: { id: string; sid: string }, viewer: { id: string; sid: string }, unverified: { id: string; sid: string };
const session = async (organizationId: string, role: "owner" | "viewer", platform = false, verified = true) => {
  const [user] = await db.insert(usersTable).values({ organizationId, email: `staff-${randomUUID()}@example.invalid`, role,
    isPlatformAdmin: platform, emailVerifiedAt: verified ? new Date() : null }).returning();
  return { id: user!.id, sid: await createSession({ user: { id: user!.id, email: user!.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" }) };
};
const get = (path: string, sid?: string, headers: Record<string, string> = {}) => fetch(`${base}/api/v1${path}`, { headers: { ...(sid ? { authorization: `Bearer ${sid}` } : {}), ...headers } });
const deliveryResponse = async (response: Response) => await response.json() as Awaited<ReturnType<typeof listPlatformEmailDeliveries>>;
const callback = async (messageId: string, to: string, signatureValid = true, type = "email.delivered") => {
  const payload = { type, created_at: new Date().toISOString(), data: { email_id: messageId, from: "account@platform.example", to: [to] } };
  const body = JSON.stringify(payload), id = `msg_${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", signingBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  return fetch(`${base}/api/v1/public/webhooks/resend`, { method: "POST", body,
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signatureValid ? signature : "forged"}` } });
};

beforeAll(() => { server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
beforeEach(async () => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-not-networked");
  vi.stubEnv("RESEND_FROM_EMAIL", "account@platform.example");
  vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", `http-test-${randomUUID()}`);
  vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${signingBytes.toString("base64")}`);
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  context = platformEmailContext().providerContext;
  [org, foreign] = (await db.insert(organizationsTable).values([{ name: "Identity HTTP A", slug: randomUUID() }, { name: "Identity HTTP B", slug: randomUUID() }]).returning({ id: organizationsTable.id })).map(row => row.id);
  operator = await session(foreign, "owner", true);
  owner = await session(org, "owner"); viewer = await session(org, "viewer"); unverified = await session(org, "owner", true, false);
  vi.spyOn(transactionalEmailProvider, "send").mockImplementation(async () => ({ id: randomUUID(), provider: "resend" }));
});
afterEach(async () => { await db.delete(events).where(eq(events.providerContext, context)); await deleteTestOrgs(org, foreign); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

describe("platform email delivery authenticated HTTP", () => {
  it("exposes exact receipt status to platform staff but not ordinary company members or API keys", async () => {
    const [person] = await db.insert(usersTable).values({ organizationId: org, email: `verify-${randomUUID()}@example.invalid`, emailVerifiedAt: null }).returning();
    const identity = await issueIdentityTokenRecord({ userId: person!.id, purpose: "email_verification" });
    const receipt = await sendEmailVerification({ to: person!.email!, ...identity });
    const denied = await get("/platform/email-deliveries", owner.sid); expect(denied.status).toBe(403);
    expect((await get("/platform/email-deliveries", unverified.sid)).status).toBe(403);
    expect((await get("/platform/email-deliveries", operator.sid, { "x-api-key": "not-a-session" })).status).toBe(403);
    expect((await get("/platform/email-deliveries")).status).toBe(401);
    const response = await get(`/platform/email-deliveries?organizationId=${org}`, operator.sid);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await deliveryResponse(response);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({ id: receipt.dispatchId, outcome: "accepted", deliveryConfirmed: false, retryAllowed: false });
    expect(JSON.stringify(result)).not.toContain(identity.token);
    expect(JSON.stringify(result)).not.toContain(identity.tokenRecordId);
    expect(JSON.stringify(result)).not.toContain(createHash("sha256").update(identity.token).digest("hex"));
    expect((await get("/staff-invitations/email-deliveries", owner.sid)).status).toBe(200);
    expect((await deliveryResponse(await get("/staff-invitations/email-deliveries", owner.sid))).deliveries).toEqual([]);
  });

  it("company invitation evidence never exposes another company or platform identity", async () => {
    const invited = await createStaffInvitation({ userId: owner.id, scope: "member" }, org, { requestId: randomUUID(), email: `invite-${randomUUID()}@example.invalid`, role: "viewer" });
    const allowed = await get(`/staff-invitations/email-deliveries?invitationId=${invited.invitation.id}`, owner.sid);
    expect(allowed.status).toBe(200); expect((await deliveryResponse(allowed)).deliveries).toHaveLength(1);
    const foreignRead = await get(`/staff-invitations/email-deliveries?invitationId=${invited.invitation.id}`, operator.sid);
    expect(foreignRead.status).toBe(200); expect((await deliveryResponse(foreignRead)).deliveries).toEqual([]);
    expect((await get(`/staff-invitations/email-deliveries?organizationId=${foreign}`, owner.sid)).status).toBe(400);
    expect((await get("/staff-invitations/email-deliveries", viewer.sid)).status).toBe(403);
    expect((await get("/staff-invitations/email-deliveries?page=0", owner.sid)).status).toBe(400);
  });

  it("requires a signed raw callback and reconciles callback-before-receipt without verifying the user", async () => {
    const [person] = await db.insert(usersTable).values({ organizationId: org, email: `verify-${randomUUID()}@example.invalid`, emailVerifiedAt: null }).returning();
    const id = randomUUID();
    vi.mocked(transactionalEmailProvider.send).mockImplementation(async () => {
      expect((await callback(id, person!.email!, false)).status).toBe(403);
      expect(await db.select().from(events).where(eq(events.providerContext, context))).toHaveLength(0);
      expect((await callback(id, person!.email!)).status).toBe(200);
      return { id, provider: "resend" };
    });
    const identity = await issueIdentityTokenRecord({ userId: person!.id, purpose: "email_verification" });
    await sendEmailVerification({ to: person!.email!, ...identity });
    const status = await deliveryResponse(await get(`/platform/email-deliveries?organizationId=${org}`, operator.sid));
    expect(status.deliveries[0]).toMatchObject({ deliveryState: "delivered", deliveryConfirmed: true });
    expect((await db.select().from(usersTable).where(eq(usersTable.id, person!.id)))[0]!.emailVerifiedAt).toBeNull();
    expect((await db.select().from(dispatches).where(eq(dispatches.organizationId, org)))).toHaveLength(1);
  });
});
