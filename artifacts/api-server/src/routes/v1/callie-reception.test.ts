import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { getExpectedTwilioSignature } from "twilio";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db, callieReceptionSessionsTable, twilioCallsTable, usersTable } from "@workspace/db";
import { GetCallieIntakeResponse, GetCalliePolicyResponse, GetCallieReceptionResponse, ListCallieIntakesResponse, PreviewCallieReceptionPolicyResponse, UpdateCallieOfficeResponse } from "@workspace/api-zod";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { callieReceptionFixture } from "../../test-helpers/callie-reception-fixture";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { callieReceptionViewSchema, callieReceptionPreviewSchema } from "../../services/callie-reception-contract";
import * as apiKeys from "../../services/api-keys";

let f: Awaited<ReturnType<typeof callieReceptionFixture>>, other: Awaited<ReturnType<typeof callieReceptionFixture>>;
let server: Server, base: string, sid: string, viewerSid: string, unverifiedSid: string, otherSid: string;
let providerCapability = "", callSid = "", receptionId = "", conversationId = "";
const originalFetch = globalThis.fetch, origin = "https://growth.example", provider = vi.fn<typeof fetch>();
const session = (id: string) => createSession({ user: { id, email: `${id}@example.invalid`, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return originalFetch(`${base}/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: `sid=${sid}`, origin,
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function signedVoice(path: string, fields: Record<string, string>, valid = true) {
  return originalFetch(`${base}/api/v1/public/voice/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": valid ? getExpectedTwilioSignature("synthetic-http-token", `${origin}/api/v1/public/voice/${path}`, fields) : "invalid" }, body: new URLSearchParams(fields) });
}
function conversation() { return { agent_id: f.binding.agentId, version_id: f.binding.agentVersionId, branch_id: f.binding.branchId, environment: "staging", conversation_id: conversationId,
  metadata: { phone_call: { type: "twilio", direction: "inbound", call_sid: callSid, external_number: "+12025550101", agent_number: f.voice.phoneNumber } } }; }
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin); vi.stubEnv("SESSION_SECRET", "synthetic-http-reception-signing-secret"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "72".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("TWILIO_CLIENT_RECEPTION_TEST_AUTH_TOKEN", "synthetic-http-token"); vi.stubEnv("TWILIO_CLIENT_RECEPTION_TEST_API_KEY_SECRET", "synthetic-http-key");
  f = await callieReceptionFixture(); other = await callieReceptionFixture();
  for (const [suffix, value] of Object.entries({ API_KEY: "synthetic-http-el-api", WEBHOOK_SECRET: "synthetic-http-el-webhook", CONFIG_SHA256: f.binding.configurationSha256, AGENT_VERSION_ID: f.binding.agentVersionId })) vi.stubEnv(`${f.environmentPrefix}_${suffix}`, value);
  sid = await session(f.owner.id); otherSid = await session(other.owner.id);
  const [viewer, unverified] = await db.insert(usersTable).values([{ organizationId: f.org, role: "viewer", emailVerifiedAt: new Date() }, { organizationId: f.org, role: "office", emailVerifiedAt: null }]).returning();
  viewerSid = await session(viewer.id); unverifiedSid = await session(unverified.id);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  provider.mockImplementation(async (url, init) => {
    if (String(url).includes("/agents/")) return Response.json(f.remoteConfiguration);
    if (String(url).includes("/conversations/")) return Response.json(conversation());
    if (String(url).endsWith("/twilio/register-call")) {
      const data = JSON.parse(String(init?.body)).conversation_initiation_client_data.dynamic_variables;
      providerCapability = data.secret__callie_capability; receptionId = data.callie_session_id;
      return Response.json('<Response><Connect><Stream url="wss://api.elevenlabs.io/v1/convai/twilio/http-synthetic" /></Connect></Response>');
    }
    throw new Error("Unexpected synthetic provider call");
  }); vi.stubGlobal("fetch", provider);
});
afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); for (const id of [sid, viewerSid, unverifiedSid, otherSid]) if (id) await deleteSession(id); await deleteTestOrgs(f?.org, other?.org); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("session-only GET is exact company-bound and SELECT-only even without credentials", async () => {
  const response = await request("/communications/callie/reception"); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store"); const value = await response.json(); expect(callieReceptionViewSchema.safeParse(value).success).toBe(true);
  expect(GetCallieReceptionResponse.safeParse(value).success).toBe(true);
  expect(GetCalliePolicyResponse.safeParse(await (await request("/communications/callie/policy")).json()).success).toBe(true);
  expect(value).toMatchObject({ organizationId: f.org, currentMode: "conversation" });
  expect((await request("/communications/callie/reception", undefined, { cookie: `sid=${viewerSid}` })).status).toBe(200);
  const foreign = await request("/communications/callie/reception", undefined, { cookie: `sid=${otherSid}` }); expect(foreign.status).toBe(200); expect(await foreign.json()).toMatchObject({ organizationId: other.org, readiness: { ready: false } });
  expect((await request("/communications/callie/reception", undefined, { cookie: `sid=${unverifiedSid}` })).status).toBe(403);
  expect((await request(`/communications/callie/reception?organizationId=${other.org}`)).status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
});
it("rejects empty/nonempty API keys, stale role, unsafe origins and arbitrary binding fields", async () => {
  const resolve = vi.spyOn(apiKeys, "resolveApiKey");
  for (const key of ["", "synthetic"]) expect((await request("/communications/callie/reception", undefined, { "x-api-key": key })).status).toBe(403);
  expect(resolve).not.toHaveBeenCalled(); resolve.mockRestore();
  const body = { expectedVersion: 1, policy: f.settings };
  expect((await request("/communications/callie/reception/policy/preview", body, { cookie: `sid=${viewerSid}` })).status).toBe(403);
  expect((await request("/communications/callie/reception/policy/preview", body, { origin: "https://evil.invalid" })).status).toBe(403);
  expect((await request("/communications/callie/reception/binding", { apiKey: "never-accepted-secret" })).status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
});
it("previews are strict actor-bound reviews, not provider configuration or immediate activation", async () => {
  const response = await request("/communications/callie/reception/policy/preview", { expectedVersion: 1, policy: f.settings }); expect(response.status).toBe(200);
  const value = callieReceptionPreviewSchema.parse(await response.json());
  expect(PreviewCallieReceptionPolicyResponse.safeParse(value).success).toBe(true);
  expect((await request("/communications/callie/reception/policy/approve", { expectedVersion: 1, expectedSnapshot: value.expectedSnapshot, previewHash: value.previewHash, confirmed: false })).status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
});
it("fresh signed staff-first inbound and exact missed Dial admit one reception and reject unsigned/cross-call callbacks", async () => {
  callSid = `CA${randomUUID().replaceAll("-", "")}`;
  const fields = { AccountSid: f.voice.accountSid, CallSid: callSid, From: "+12025550101", To: f.voice.phoneNumber, CallStatus: "ringing" };
  expect((await signedVoice("inbound", fields, false)).status).toBe(403);
  const inbound = await signedVoice("inbound", fields); expect(inbound.status).toBe(200); expect(await inbound.text()).toContain(f.voice.staffPhone!);
  const [call] = await db.select().from(twilioCallsTable).where(and(eq(twilioCallsTable.organizationId, f.org), eq(twilioCallsTable.providerSid, callSid)));
  const completePath = `complete?operation=${call.id}`, missed = { ...fields, CallStatus: "in-progress", DialCallStatus: "no-answer" };
  expect((await signedVoice(completePath, { ...missed, CallSid: `CA${"8".repeat(32)}` })).status).toBe(403);
  const completed = await signedVoice(completePath, missed); expect(completed.status).toBe(200); expect(await completed.text()).toContain("<Connect>");
  const duplicate = await signedVoice(completePath, missed); expect(await duplicate.text()).not.toContain("<Connect>");
  expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(await db.select().from(callieReceptionSessionsTable).where(eq(callieReceptionSessionsTable.callId, call.id))).toHaveLength(1);
});
it("public tools authenticate a header capability and real original conversation, not a locator or staff cookie", async () => {
  conversationId = `conv_${randomUUID().replaceAll("-", "")}`;
  const input = { action: "initialize", requestId: randomUUID(), conversationId, agentId: f.binding.agentId }, path = `/public/callie/reception/${receptionId}/tool`;
  expect((await request(path, input)).status).toBe(403);
  expect((await request(path, { ...input, executeUrl: "https://evil.invalid" }, { "x-callie-capability": providerCapability })).status).toBe(400);
  const accepted = await request(path, input, { "x-callie-capability": providerCapability }); expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ ok: true, context: { businessName: f.voice.businessName } });
  expect((await request(path, { ...input, conversationId: "conv_foreign" }, { "x-callie-capability": providerCapability })).status).toBe(403);
});
it("fixed post-call endpoint verifies exact raw bytes and bounded known original context", async () => {
  const body = { type: "post_call_transcription", data: { ...conversation(), status: "done", analysis: { transcript_summary: "Synthetic request; no appointment confirmed." } } };
  const raw = JSON.stringify(body), t = String(Math.floor(Date.now() / 1000)), sig = `t=${t},v0=${createHmac("sha256", "synthetic-http-el-webhook").update(`${t}.${raw}`).digest("hex")}`;
  const send = (text: string, signature: string) => originalFetch(`${base}/api/v1/public/callie/reception/post-call`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": signature }, body: text });
  expect((await send(raw, "bad")).status).toBe(403); expect((await send(`${raw} `, sig)).status).toBe(403);
  expect((await send(raw, sig)).status).toBe(200); expect((await send(raw, sig)).status).toBe(200);
  expect((await db.select().from(callieReceptionSessionsTable).where(eq(callieReceptionSessionsTable.id, receptionId)))[0]).toMatchObject({ conversationOutcome: "completed" });
});

it("generated GET/list and real office-command responses retain the conversation summary fields", async () => {
  // Use the real signed ingress/registration/post-call flow above, not merely
  // an admitted fixture: office_pending begins only after original reservation.
  const [registered] = await db.select().from(callieReceptionSessionsTable).where(eq(callieReceptionSessionsTable.id, receptionId));
  expect(registered).toBeDefined();
  const detailResponse = await request(`/communications/callie/${registered.intakeId}`);
  expect(detailResponse.status).toBe(200);
  const raw = await detailResponse.json() as Record<string, unknown>, detail = GetCallieIntakeResponse.parse(raw);
  expect(detail).toMatchObject({ organizationId: f.org, mode: "conversation", state: "office_pending", smsProof: "not_confirmed" });
  const invalid = { ...raw, state: "invented_state" };
  expect(GetCallieIntakeResponse.safeParse(invalid).success).toBe(false);
  const missing = { ...raw }; delete missing.organizationId; delete missing.mode;
  expect(GetCallieIntakeResponse.safeParse(missing).success).toBe(false);
  // A healthy request before its original deadline belongs to Waiting. Failed
  // evidence/overdue work belongs to Attention; the projection must support both.
  const pageResponse = await request("/communications/callie?scope=waiting&offset=0");
  expect(pageResponse.status).toBe(200);
  const page = ListCallieIntakesResponse.parse(await pageResponse.json());
  expect(page.items.find(row => row.id === detail.id)).toMatchObject({ organizationId: f.org, mode: "conversation", state: "office_pending" });
  const assignedResponse = await request(`/communications/callie/${detail.id}/office-action`, {
    requestId: randomUUID(), expectedVersion: detail.version, expectedFingerprint: detail.expectedFingerprint,
    action: "assign", assignedUserId: f.afterOwner.id, note: "Fictional office reassigned the original callback for exact API proof.",
  });
  expect(assignedResponse.status).toBe(200);
  const assigned = UpdateCallieOfficeResponse.parse(await assignedResponse.json());
  expect(assigned).toMatchObject({ replayed: false, detail: { organizationId: f.org, mode: "conversation", state: "blocked", reason: "owner_changed_office_only", owner: { id: f.afterOwner.id }, task: { id: detail.task.id } } });
});
