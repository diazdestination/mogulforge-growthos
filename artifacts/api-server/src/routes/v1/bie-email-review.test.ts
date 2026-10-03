import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bieActionProposalsTable, contactsTable, db, DEFAULT_SENDING_HOURS, emailSenderPreferencesTable, leadsTable, microsoftConnectionsTable, organizationsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { encryptSecret } from "../../lib/token-encryption";
import { createApiKey } from "../../services/api-keys";
import { updateOrgSettings } from "../../services/settings";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server, base: string, org: string, otherOrg: string, user: string, lead: string, contact: string;
let ownerSid: string, viewerSid: string, foreignSid: string, unverifiedSid: string, apiKey: string;
const nativeFetch = globalThis.fetch;
let posts = 0;
const session = async (organizationId: string, role: "owner" | "viewer", verified = true) => {
  const [actor] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: verified ? new Date() : null }).returning();
  const sid = await createSession({ user: { id: actor.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  return { user: actor.id, sid };
};
const call = (id: string, operation: string, body: unknown = {}, sid = ownerSid, headers: Record<string, string> = {}) =>
  nativeFetch(`${base}/api/v1/bie/actions/${id}/${operation}`, { method: "POST", headers: { cookie: `sid=${sid}`, "content-type": "application/json", origin: process.env.APP_ORIGIN!, ...headers }, body: JSON.stringify(body) });
async function proposal() { return (await db.insert(bieActionProposalsTable).values({ organizationId: org, leadId: lead, actionType: "send_email", title: "Synthetic exact review", rationale: "Local HTTP test", payload: { subject: "Exact subject", body: "Exact body" } }).returning())[0]; }
beforeAll(async () => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  [org, otherOrg] = (await db.insert(organizationsTable).values([1, 2].map(() => ({ name: "Synthetic BIE HTTP", slug: randomUUID() }))).returning()).map(row => row.id);
  ({ user, sid: ownerSid } = await session(org, "owner")); viewerSid = (await session(org, "viewer")).sid; foreignSid = (await session(otherOrg, "owner")).sid; unverifiedSid = (await session(org, "owner", false)).sid;
  apiKey = (await createApiKey({ organizationId: org, name: "Synthetic not-human", role: "sales_rep", createdByUserId: user })).key;
  const [customer] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", email: "customer@example.invalid" }).returning(); contact = customer.id;
  [lead] = (await db.insert(leadsTable).values({ organizationId: org, contactId: contact, assignedUserId: user, creationMethod: "form", status: "follow_up" }).returning()).map(row => row.id);
  await db.insert(microsoftConnectionsTable).values({ organizationId: org, userId: user, accountId: "synthetic-mailbox", email: "office@example.invalid", encryptedRefreshToken: encryptSecret("synthetic-refresh", `${org}:${user}:microsoft`), grantedScopes: ["mail.send", "user.read"] });
  await db.insert(emailSenderPreferencesTable).values({ organizationId: org, userId: user, provider: "microsoft" });
  await updateOrgSettings(org, { sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay: 0 } });
  // External URLs are synthetic-only. The HTTP client above uses nativeFetch
  // exclusively against this owned loopback listener.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/") && url.endsWith("/token")) return new Response(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-access", scope: "Mail.Send User.Read" }), { status: 200 });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return new Response(JSON.stringify({ id: "synthetic-mailbox", mail: "office@example.invalid" }), { status: 200 });
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail") { posts++; return new Response(null, { status: 202 }); }
    throw new Error("Unexpected synthetic transport operation");
  }));
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { posts = 0; });
afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await deleteTestOrgs(org, otherOrg); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("human BIE email review HTTP", () => {
  it("prepares exact identity, approves unchanged saved payload, and executes once", async () => {
    const action = await proposal(); const preparedResponse = await call(action.id, "prepare-email", { expectedPayload: action.payload }); expect(preparedResponse.status).toBe(200);
    const prepared = await preparedResponse.json() as { status: string; payload: Record<string, unknown> };
    expect(preparedResponse.headers.get("cache-control")).toBe("no-store"); expect(prepared.status).toBe("proposed"); expect(posts).toBe(0);
    expect(prepared.payload.emailReview).toMatchObject({ recipient: "customer@example.invalid", sender: { provider: "microsoft", senderEmail: "office@example.invalid" } });
    expect((await call(action.id, "approve", { expectedPayload: action.payload })).status).toBe(409);
    expect((await call(action.id, "approve", { expectedPayload: prepared.payload })).status).toBe(200);
    expect(await (await call(action.id, "execute")).json()).toMatchObject({ status: "executed" }); expect(posts).toBe(1);
    await call(action.id, "execute"); expect(posts).toBe(1);
  });
  it("actual draft edit removes frozen emailReview and deliverySnapshot and requires prepare again", async () => {
    const action = await proposal(); const prepared = await (await call(action.id, "prepare-email", { expectedPayload: action.payload })).json() as { payload: Record<string, unknown> };
    // The strict edit route replaces any prior tracking context too. It never
    // treats copied metadata as a fresh review decision.
    await db.update(bieActionProposalsTable).set({ payload: { ...prepared.payload, deliverySnapshot: { synthetic: "cannot survive editing" } } }).where(eq(bieActionProposalsTable.id, action.id));
    const edited = await nativeFetch(`${base}/api/v1/revenue/proposals/${action.id}`, { method: "PATCH", headers: { cookie: `sid=${ownerSid}`, "content-type": "application/json" }, body: JSON.stringify({ subject: "Edited subject", body: "Edited body" }) });
    expect(edited.status).toBe(200); const value = await edited.json() as { payload: Record<string, unknown> };
    expect(value.payload).toEqual({ subject: "Edited subject", body: "Edited body" });
    expect((await call(action.id, "approve", { expectedPayload: prepared.payload })).status).toBe(409);
    expect((await call(action.id, "approve", { expectedPayload: value.payload })).status).toBe(409);
    const again = await call(action.id, "prepare-email", { expectedPayload: value.payload }); expect(again.status).toBe(200); expect(posts).toBe(0);
  });
  it.each(["prepare-email", "approve", "execute"])("%s rejects valid API-key authority and foreign sibling origin even with a real cookie and bogus Authorization", async operation => {
    const action = await proposal(); const input = { expectedPayload: action.payload };
    expect((await call(action.id, operation, input, ownerSid, { "x-api-key": apiKey })).status).toBe(403);
    expect((await call(action.id, operation, input, ownerSid, { origin: "https://sibling.example", authorization: "Basic unrelated" })).status).toBe(403);
    expect((await call(action.id, operation, input, ownerSid, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect(posts).toBe(0);
  });
  it("refuses unauthenticated, viewer, unverified, foreign, changed and extra-field preparation", async () => {
    const action = await proposal(), input = { expectedPayload: action.payload };
    expect((await call(action.id, "prepare-email", input, "")).status).toBe(401);
    expect((await call(action.id, "prepare-email", input, viewerSid)).status).toBe(403);
    expect((await call(action.id, "prepare-email", input, unverifiedSid)).status).toBe(403);
    expect((await call(action.id, "prepare-email", input, foreignSid)).status).toBe(409);
    expect((await call(action.id, "prepare-email", { expectedPayload: {} })).status).toBe(409);
    expect((await call(action.id, "prepare-email", { ...input, from: "spoof@example.invalid" })).status).toBe(400);
    expect((await call(action.id, "prepare-email", input, ownerSid, { "content-type": "text/plain" })).status).toBe(415);
    expect(posts).toBe(0);
  });
});
