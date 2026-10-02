import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { contactsTable, db, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import * as apiKeys from "../../services/api-keys";

const originalFetch = globalThis.fetch, origin = "https://growth.example";
let server: Server, base: string, org: string, other: string, lead: string, ownerSid: string, viewerSid: string, otherSid: string;
const sessions: string[] = [];
async function staff(organizationId: string, role: "owner" | "viewer") {
  const [user] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: new Date() }).returning();
  const sid = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" }); sessions.push(sid); return sid;
}
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => originalFetch(`${base}/api/v1/source-adoption${path}`, { method: body === undefined ? "GET" : "POST",
  headers: { origin, cookie: `sid=${ownerSid}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const adoptionInput = () => ({ expectedVersion: 0, sourceAsOf: new Date(Date.now() - 3600_000).toISOString(), cutoverAt: new Date(Date.now() - 1800_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), evidence: "Synthetic reconciled source account and controlled cutover.", sourceWriterStopped: true, currentStatusVerified: true, noUnreviewedReplies: true });
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin);
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Use isolated runner");
  [org, other] = (await db.insert(organizationsTable).values([{ name: "Synthetic source HTTP", slug: randomUUID() }, { name: "Other source HTTP", slug: randomUUID() }]).returning()).map(row => row.id);
  ownerSid = await staff(org, "owner"); viewerSid = await staff(org, "viewer"); otherSid = await staff(other, "owner");
  const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", email: "source@example.invalid" }).returning();
  const history = { version: 1 as const, kind: "csv_snapshot" as const, originalCreatedAt: null, sourceUpdatedAt: null, statusChangedAt: null, lastContactAt: null, snapshotAsOf: null,
    firstImportedAt: new Date().toISOString(), lastImportedAt: new Date().toISOString(), externalCustomerId: null, externalEstimateId: null, currency: null, fingerprint: "a".repeat(64), appliedFingerprint: "b".repeat(64), mappedFields: ["firstName"] };
  [lead] = (await db.insert(leadsTable).values({ organizationId: org, contactId: contact.id, creationMethod: "import", importSourceKey: "synthetic-hcp", externalOpportunityId: "row-1", importedHistory: history }).returning()).map(row => row.id);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async () => { throw new Error("No external provider calls allowed"); });
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const sid of sessions) await deleteSession(sid); await deleteTestOrgs(org, other);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
it("derives company from staff session, protects foreign records and exposes read-only evidence", async () => {
  expect((await request("", undefined, { cookie: "" })).status).toBe(401);
  const list = await request("", undefined, { cookie: `sid=${viewerSid}` }); expect(list.status).toBe(200); expect(list.headers.get("cache-control")).toBe("no-store");
  expect((await request(`/leads/${lead}`, undefined, { cookie: `sid=${otherSid}` })).status).toBe(404);
  expect((await request(`/outreach/${randomUUID()}`, undefined, { cookie: `sid=${otherSid}` })).status).toBe(404);
  expect((await request(`/leads/${lead}/preview`, adoptionInput(), { cookie: `sid=${viewerSid}` })).status).toBe(403);
  expect((await request(`?organizationId=${other}`)).status).toBe(400);
  expect((await request("?page=1&campaignPage=0")).status).toBe(200);
  expect((await request("?page=-1")).status).toBe(400);
  expect((await request("?page=0&page=1")).status).toBe(400);
});
it("requires trusted origin, JSON and real session; Basic header cannot bypass cookie CSRF", async () => {
  const variants: Record<string, string>[] = [{ origin: "https://evil.growth.example", authorization: "Basic ignored" }, { origin: "null" }, { origin: `${origin}/path` }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }];
  for (const headers of variants) expect((await request(`/leads/${lead}/preview`, adoptionInput(), headers)).status).toBe(403);
  expect((await request(`/leads/${lead}/preview`, adoptionInput(), { "content-type": "text/plain" })).status).toBe(415);
  const resolve = vi.spyOn(apiKeys, "resolveApiKey");
  expect((await request(`/leads/${lead}/preview`, adoptionInput(), { "x-api-key": "synthetic-not-looked-up" })).status).toBe(403); expect(resolve).not.toHaveBeenCalled();
  const noOrigin = await originalFetch(`${base}/api/v1/source-adoption/leads/${lead}/preview`, { method: "POST", headers: { cookie: `sid=${ownerSid}`, authorization: "Basic ignored", "content-type": "application/json" }, body: JSON.stringify(adoptionInput()) });
  expect(noOrigin.status).toBe(403);
});
it("accepts exact human adoption without granting email permission or sending, and rejects unknown/stale approvals", async () => {
  expect((await request(`/leads/${lead}/preview`, { ...adoptionInput(), organizationId: other })).status).toBe(400);
  const previewResponse = await request(`/leads/${lead}/preview`, adoptionInput()); expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json() as { previewId: string; payloadSha256: string };
  const body = { previewId: preview.previewId, payloadSha256: preview.payloadSha256, confirmed: true };
  const approved = await request(`/leads/${lead}/approve`, body); expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ current: true, marketingPermission: false });
  expect((await request(`/leads/${lead}/approve`, body)).status).toBe(409);
  expect((await request(`/leads/${lead}/revoke`, { expectedVersion: 1, reason: "Synthetic owner revoked the management decision." })).status).toBe(200);
  expect((await request(`/outreach/${randomUUID()}/send`, { expectedVersion: 2, payloadSha256: "a".repeat(64), confirmed: true, requestId: randomUUID() })).status).toBe(400);
});
