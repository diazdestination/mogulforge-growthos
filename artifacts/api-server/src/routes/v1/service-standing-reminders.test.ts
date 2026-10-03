import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { serviceStandingFixture } from "../../test-helpers/service-standing-fixture";
import { serviceStandingViewSchema, serviceStandingPreviewResponseSchema } from "../../services/service-standing-contract";
import * as apiKeys from "../../services/api-keys";

const origin = "https://growth.example", localFetch = globalThis.fetch;
let server: Server, base: string, f: Awaited<ReturnType<typeof serviceStandingFixture>>, other: Awaited<ReturnType<typeof serviceStandingFixture>>;
let ownerSession: string, viewerSession: string, unverifiedSession: string, otherSession: string;
async function session(id: string) { return createSession({ user: { id, email: `${id}@example.invalid`, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" }); }
function request(suffix = "", body?: unknown, headers: Record<string, string> = {}) { return localFetch(`${base}/api/v1/service-obligations/${f.obligation.id}/standing-reminders${suffix}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: `sid=${ownerSession}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin); f = await serviceStandingFixture(); other = await serviceStandingFixture();
  ownerSession = await session(f.owner.id); otherSession = await session(other.owner.id);
  const [viewer, unverified] = await db.insert(usersTable).values([{ organizationId: f.org, role: "viewer", emailVerifiedAt: new Date() }, { organizationId: f.org, role: "owner", emailVerifiedAt: null }]).returning();
  viewerSession = await session(viewer.id); unverifiedSession = await session(unverified.id);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", () => { throw new Error("Provider calls prohibited"); });
});
afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); for (const value of [ownerSession, otherSession, viewerSession, unverifiedSession]) if (value) await deleteSession(value); await deleteTestOrgs(f?.org, other?.org); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("standing service human-session HTTP", () => {
  it("renders a strict disabled default from a no-store read", async () => { const result = await request(); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store"); expect(serviceStandingViewSchema.parse(await result.json()).version).toBe(0); });
  it("requires active verified accepted session, own company and strict query", async () => {
    expect((await request("", undefined, { cookie: "" })).status).toBe(401);
    expect((await request("", undefined, { cookie: `sid=${otherSession}` })).status).toBe(404);
    expect((await request("", undefined, { cookie: `sid=${unverifiedSession}` })).status).toBe(403);
    expect((await request("", undefined, { cookie: `sid=${viewerSession}` })).status).toBe(200);
    expect((await request(`?organizationId=${f.org}`)).status).toBe(400);
  });
  it("rejects API keys before lookup and unsafe mutations", async () => {
    const resolve = vi.spyOn(apiKeys, "resolveApiKey");
    expect((await request("", undefined, { "x-api-key": "synthetic-not-resolved" })).status).toBe(403);
    expect((await request("/preview", {}, { "x-api-key": "synthetic-not-resolved" })).status).toBe(403); expect(resolve).not.toHaveBeenCalled(); resolve.mockRestore();
    expect((await request("/preview", {}, { origin: "https://foreign.example" })).status).toBe(403);
    expect((await request("/preview", {}, { "content-type": "text/plain" })).status).toBe(415);
    expect((await request("/preview", {}, { cookie: `sid=${viewerSession}` })).status).toBe(403);
    expect((await request("/preview", {}, { cookie: `sid=${unverifiedSession}` })).status).toBe(403);
  });
  it("retains exact preview/approval/disable evidence with no message effects", async () => {
    const view = serviceStandingViewSchema.parse(await (await request()).json());
    const input = { expectedVersion: view.version, expectedUpdatedAt: view.expectedUpdatedAt, policy: { enabled: true, channel: "email", agreementStartsOn: "2020-01-01", agreementEndsOn: "2040-12-31", agreementEvidence: "Explicit owner review of synthetic service agreement.", sourceReview: { kind: "native", verifiedAt: new Date().toISOString(), cutoverAt: null, evidence: "Native service source reviewed by the exact owner." } } };
    const raw = await request("/preview", input); expect(raw.status).toBe(200);
    const preview = serviceStandingPreviewResponseSchema.parse(await raw.json());
    const saved = await request("/approve", { expectedVersion: preview.expectedVersion, expectedSnapshot: preview.expectedSnapshot, previewHash: preview.previewHash, confirmed: true });
    expect(saved.status).toBe(200); expect(serviceStandingViewSchema.parse(await saved.json()).version).toBe(1);
    const command = { requestId: randomUUID(), expectedVersion: 1, reason: "Owner disabled this synthetic policy without sending.", confirmed: true };
    expect((await request("/disable", { ...command, confirmed: false })).status).toBe(400);
    const disabled = await request("/disable", command); expect(disabled.status).toBe(200); expect(serviceStandingViewSchema.parse(await disabled.json()).policy?.enabled).toBe(false);
    expect((await request("/disable", command)).status).toBe(200);
  });
});
