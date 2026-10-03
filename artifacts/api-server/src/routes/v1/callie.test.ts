import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, usersTable } from "@workspace/db";
import { GetCalliePolicyResponse, GetCallieIntakeResponse, ListCallieIntakesResponse, ReviewCallieCallerBody, ReviewCallieCallerResponse, BookCallieVisitBody, BookCallieVisitResponse, PreviewCalliePolicyResponse, ApproveCalliePolicyResponse, UpdateCallieOfficeResponse } from "@workspace/api-zod";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { callieOfficeFixture } from "../../test-helpers/callie-office-fixture";
import * as apiKeys from "../../services/api-keys";

const origin = "https://growth.example", originalFetch = globalThis.fetch;
let server: Server, base: string, f: Awaited<ReturnType<typeof callieOfficeFixture>>, other: Awaited<ReturnType<typeof callieOfficeFixture>>;
let ownerSession: string, viewerSession: string, otherSession: string, unverifiedSession: string;
async function session(id: string) { return createSession({ user: { id, email: `${id}@example.invalid`, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" }); }
function request(suffix: string, body?: unknown, headers: Record<string, string> = {}) {
  return originalFetch(`${base}/api/v1/communications/callie${suffix}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: `sid=${ownerSession}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin);
  f = await callieOfficeFixture(); other = await callieOfficeFixture();
  ownerSession = await session(f.owner.id); otherSession = await session(other.owner.id);
  const [viewer, unverified] = await db.insert(usersTable).values([{ organizationId: f.org, role: "viewer", emailVerifiedAt: new Date() }, { organizationId: f.org, role: "office", emailVerifiedAt: null }]).returning();
  viewerSession = await session(viewer.id); unverifiedSession = await session(unverified.id);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", () => { throw new Error("No provider network allowed"); });
});
afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await deleteTestOrgs(f?.org, other?.org); for (const id of [ownerSession, viewerSession, otherSession, unverifiedSession]) if (id) await deleteSession(id); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("CALLIE human-session HTTP and generated contracts", () => {
  it("matches actual SELECT-only list/detail/policy responses to generated schemas", async () => {
    for (const [suffix, schema] of [["?scope=attention&offset=0", ListCallieIntakesResponse], [`/${f.intake.id}`, GetCallieIntakeResponse], ["/policy", GetCalliePolicyResponse]] as const) {
      const result = await request(suffix); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store"); expect(schema.safeParse(await result.json()).success).toBe(true);
    }
    const read = await request(`/${f.intake.id}`); expect(JSON.stringify(await read.json())).not.toMatch(/challengeHash|stepReceipts|challengeEncrypted|triggerMessageSid/);
  });
  it("enforces accepted human identity, tenant and bounded strict query validation", async () => {
    expect((await request("", undefined, { cookie: "" })).status).toBe(401);
    expect((await request(`/${f.intake.id}`, undefined, { cookie: `sid=${otherSession}` })).status).toBe(404);
    expect((await request("", undefined, { cookie: `sid=${unverifiedSession}` })).status).toBe(403);
    expect((await request("", undefined, { cookie: `sid=${viewerSession}` })).status).toBe(200);
    expect((await request("?organizationId=" + f.org)).status).toBe(400);
    expect((await request("?scope=attention&offset=-1")).status).toBe(400);
    expect((await request("?scope=all")).status).toBe(400);
    expect((await request(`/${f.intake.id}?organizationId=${f.org}`)).status).toBe(400);
  });
  it("rejects API keys before lookup, unsafe Origin, cookie header bypass and non-JSON", async () => {
    const resolve = vi.spyOn(apiKeys, "resolveApiKey");
    expect((await request("", undefined, { "x-api-key": "synthetic-not-resolved" })).status).toBe(403);
    expect((await request(`/${f.intake.id}/book`, {}, { "x-api-key": "synthetic-not-resolved" })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled(); resolve.mockRestore();
    const blockedHeaders: Record<string, string>[] = [{ origin: "https://sibling.growth.example", authorization: "Basic synthetic" }, { origin: "null" }, { origin: `${origin}/path` }, { origin, "sec-fetch-site": "same-site" }, { origin, "sec-fetch-site": "cross-site" }, { origin: "https://foreign.example", authorization: `Bearer ${ownerSession}` }];
    for (const headers of blockedHeaders) {
      expect((await request(`/${f.intake.id}/book`, {}, headers)).status).toBe(403);
    }
    expect((await request(`/${f.intake.id}/book`, {}, { "content-type": "text/plain" })).status).toBe(415);
    const noOrigin = (authorization?: string) => originalFetch(`${base}/api/v1/communications/callie/policy/preview`, { method: "POST", headers: { cookie: `sid=${ownerSession}`, "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: "{}" });
    expect((await noOrigin()).status).toBe(403); expect((await noOrigin("Basic synthetic")).status).toBe(403); expect((await noOrigin("Bearer bad-session")).status).toBe(401);
    expect((await noOrigin(`Bearer ${ownerSession}`)).status).toBe(400);
  });
  it("requires current exact approval and preserves a disabled policy through real preview/approval contracts", async () => {
    const value = await (await request("/policy")).json() as { version: number; policy: unknown };
    const input = { expectedVersion: value.version, policy: value.policy };
    expect((await request("/policy/preview", input, { cookie: `sid=${viewerSession}` })).status).toBe(403);
    const previewResponse = await request("/policy/preview", input); expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { expectedVersion: number; expectedSnapshot: Record<string, unknown>; previewHash: string };
    expect(PreviewCalliePolicyResponse.safeParse(preview).success).toBe(true);
    expect((await request("/policy/approve", { ...preview, confirmed: false })).status).toBe(400);
    const saved = await request("/policy/approve", { expectedVersion: preview.expectedVersion, expectedSnapshot: preview.expectedSnapshot, previewHash: preview.previewHash, confirmed: true });
    expect(saved.status).toBe(200); expect(ApproveCalliePolicyResponse.safeParse(await saved.json()).success).toBe(true);
  });
  it("executes real caller review and native booking with current strict generated request/response types", async () => {
    const initial = await (await request(`/${f.intake.id}`)).json() as { version: number; expectedFingerprint: string };
    const review = { requestId: randomUUID(), expectedVersion: initial.version, expectedFingerprint: initial.expectedFingerprint, action: "link_contact", contactId: f.contact.id, staffConfirmed: true };
    expect(ReviewCallieCallerBody.safeParse(review).success).toBe(true);
    expect((await request(`/${f.intake.id}/review-caller`, review, { cookie: `sid=${viewerSession}` })).status).toBe(403);
    const result = await request(`/${f.intake.id}/review-caller`, review); expect(result.status).toBe(200);
    const reviewed = await result.json() as { detail: { version: number; expectedFingerprint: string } }; expect(ReviewCallieCallerResponse.safeParse(reviewed).success).toBe(true);
    const book = { requestId: randomUUID(), expectedVersion: reviewed.detail.version, expectedFingerprint: reviewed.detail.expectedFingerprint, contactId: f.contact.id, leadId: null, propertyId: f.property.id, assignedUserId: f.office.id, type: "other", scheduledStart: "2035-02-03T15:00:00.000Z", scheduledEnd: "2035-02-03T16:00:00.000Z", confirmationNote: "Fictional customer expressly agreed to the exact visit and office assignment.", customerConfirmed: true };
    expect(BookCallieVisitBody.safeParse(book).success).toBe(true);
    expect((await request(`/${f.intake.id}/book`, { ...book, customerConfirmed: false })).status).toBe(400);
    const saved = await request(`/${f.intake.id}/book`, book); expect(saved.status).toBe(200); expect(BookCallieVisitResponse.safeParse(await saved.json()).success).toBe(true);
    const repeated = await request(`/${f.intake.id}/book`, book); expect(repeated.status).toBe(200); expect((await repeated.json() as { replayed: boolean }).replayed).toBe(true);
  });
  it("matches a real explicit office-close response and never grants a send or booking", async () => {
    const read = await (await request(`/${other.intake.id}`, undefined, { cookie: `sid=${otherSession}` })).json() as { version: number; expectedFingerprint: string };
    const result = await request(`/${other.intake.id}/office-action`, { requestId: randomUUID(), expectedVersion: read.version, expectedFingerprint: read.expectedFingerprint, action: "resolved", note: "Office completed the fictional callback without a visit.", staffConfirmed: true }, { cookie: `sid=${otherSession}` });
    expect(result.status).toBe(200); const value = await result.json(); expect(UpdateCallieOfficeResponse.safeParse(value).success).toBe(true);
    expect(value).toMatchObject({ detail: { state: "resolved", appointment: null } });
  });
});
