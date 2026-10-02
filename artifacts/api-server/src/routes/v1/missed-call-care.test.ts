import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, organizationsTable, usersTable, twilioCallsTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { ensureMissedCallHandoff } from "../../services/missed-call-handoff";
import { DEFAULT_CARE_POLICY } from "../../services/missed-call-care-policy";
import * as apiKeys from "../../services/api-keys";

let server: Server, base: string, org: string, otherOrg: string, owner: string, ownerSession: string, viewerSession: string, otherSession: string, call: string;
const originalFetch = globalThis.fetch;
const origin = "https://growth.example";
const policyBody = { expectedVersion: 0, policy: DEFAULT_CARE_POLICY, approveTemplate: true };
async function staff(organizationId: string, role: "owner" | "viewer") {
  const [user] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: new Date(), email: `${randomUUID()}@example.invalid` }).returning();
  const session = await createSession({ user: { id: user.id, email: user.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
  return { user: user.id, session };
}
function request(path: string, body?: unknown, headers: Record<string, string> = {}, method = "POST") {
  return originalFetch(`${base}/api/v1${path}`, { method: body === undefined ? "GET" : method, headers: {
    cookie: `sid=${ownerSession}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  // Pin the server and request fixture together; CI's default origin differs
  // from the disposable local runner, and must not mask downstream guards.
  vi.stubEnv("APP_ORIGIN", origin);
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Use the isolated test runner");
  [org, otherOrg] = (await db.insert(organizationsTable).values([{ name: "Synthetic call API", slug: `care-http-${randomUUID()}` }, { name: "Other call API", slug: `care-http-${randomUUID()}` }]).returning()).map((item) => item.id);
  const primary = await staff(org, "owner"); owner = primary.user; ownerSession = primary.session;
  viewerSession = (await staff(org, "viewer")).session; otherSession = (await staff(otherOrg, "owner")).session;
  [call] = (await db.insert(twilioCallsTable).values({ organizationId: org, requestKey: randomUUID(), direction: "inbound", phone: "+12025550101", staffPhone: "+12025550109", accountSid: `AC${"1".repeat(32)}`, dialStatus: "no-answer", authorizationSource: "signed-inbound" }).returning()).map((item) => item.id);
  await ensureMissedCallHandoff(org, call);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async () => { throw new Error("No provider fetch is allowed in this API test"); });
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org, otherOrg); for (const session of [ownerSession, viewerSession, otherSession]) await deleteSession(session);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
describe("missed-call human approval HTTP boundaries", () => {
  it("requires a session, derives tenant ownership, and permits viewers to inspect but not mutate", async () => {
    expect((await request("/communications/missed-call-care", undefined, { cookie: "" })).status).toBe(401);
    const read = await request("/communications/missed-call-care", undefined, { cookie: `sid=${viewerSession}` });
    expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
    expect((await read.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await (await request("/communications/missed-call-care?organizationId=" + org, undefined, { cookie: `sid=${otherSession}` })).json() as { items: unknown[] }).items).toHaveLength(0);
    expect((await request(`/communications/voice/${call}/care`, undefined, { cookie: `sid=${otherSession}` })).status).toBe(404);
    expect((await request("/communications/missed-call-care/policy", policyBody, { cookie: `sid=${viewerSession}` }, "PUT")).status).toBe(403);
    expect((await request(`/communications/voice/${call}/care/close`, { expectedVersion: 1, outcome: "resolved" }, { cookie: `sid=${viewerSession}` })).status).toBe(403);
  });
  it("rejects foreign/malformed origins, same-site browser writes, and bogus Authorization cookie bypasses", async () => {
    const blockedHeaders: Record<string, string>[] = [
      { origin: "https://untrusted.growth.example", authorization: "Basic synthetic" },
      { origin: "https://untrusted.growth.example", authorization: `Bearer ${ownerSession}` },
      { origin: "null", authorization: "Basic synthetic" },
      { origin: `${origin}/path` },
      { origin, "sec-fetch-site": "same-site" },
      { origin, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of blockedHeaders) {
      expect((await request("/communications/missed-call-care/policy", policyBody, headers, "PUT")).status).toBe(403);
      expect((await request(`/communications/voice/${call}/care/approve`, {}, headers)).status).toBe(403);
      expect((await request(`/communications/voice/${call}/care/close`, { expectedVersion: 1, outcome: "resolved" }, headers)).status).toBe(403);
    }
    const noOrigin = (authorization?: string) => originalFetch(`${base}/api/v1/communications/missed-call-care/policy`, { method: "PUT", headers: {
      cookie: `sid=${ownerSession}`, "content-type": "application/json", ...(authorization ? { authorization } : {}),
    }, body: JSON.stringify(policyBody) });
    expect((await noOrigin()).status).toBe(403); expect((await noOrigin("Basic synthetic")).status).toBe(403);
    expect((await noOrigin("Bearer invalid")).status).toBe(401);
    expect((await noOrigin(`Bearer ${ownerSession}`)).status).toBe(200);
  });
  it("rejects API keys before lookup and non-JSON or unsigned approval contracts", async () => {
    const resolve = vi.spyOn(apiKeys, "resolveApiKey");
    expect((await request(`/communications/voice/${call}/care/approve`, {}, { "x-api-key": "synthetic-not-resolved" })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled(); resolve.mockRestore();
    expect((await request(`/communications/voice/${call}/care/close`, {}, { "content-type": "text/plain" })).status).toBe(415);
    expect((await request("/communications/missed-call-care/policy", { expectedVersion: 1, policy: DEFAULT_CARE_POLICY }, {}, "PUT")).status).toBe(400);
    expect((await request(`/communications/voice/${call}/care/approve`, { expectedVersion: 1, expectedSnapshot: {}, approve: false })).status).toBe(400);
    expect((await request(`/communications/voice/${call}/care/approve`, { expectedVersion: 1, expectedSnapshot: {}, approve: true, organizationId: otherOrg })).status).toBe(400);
  });
  it("cannot turn an unreviewed caller into a send and rejects stale policy writes", async () => {
    expect((await request(`/communications/voice/${call}/care/approve`, { expectedVersion: 1, expectedSnapshot: {}, approve: true })).status).toBe(409);
    const configured = await request("/communications/missed-call-care/policy", { expectedVersion: 1, policy: { ...DEFAULT_CARE_POLICY, enabled: true, businessHoursOwnerId: owner, afterHoursOwnerId: owner }, approveTemplate: true }, {}, "PUT");
    expect(configured.status).toBe(200);
    expect((await request("/communications/missed-call-care/policy", policyBody, {}, "PUT")).status).toBe(409);
    expect((await request(`/communications/voice/${call}/care/approve`, { expectedVersion: 1, expectedSnapshot: {}, approve: true })).status).toBe(409);
  });
});
