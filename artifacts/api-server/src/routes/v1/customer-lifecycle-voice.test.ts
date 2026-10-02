import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio";
import { and, eq, inArray } from "drizzle-orm";
import { db, organizationsTable, usersTable, contactsTable, customerLifecycleTable,
  twilioClientBindingsTable, twilioCallsTable, missedCallHandoffsTable, rateLimitCountersTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { transitionCustomerLifecycle } from "../../services/customer-lifecycle";
import * as lifecycle from "../../services/customer-lifecycle-runtime";

type Company = { org: string; owner: string; sid: string; contact: string; account: string; number: string; staff: string; token: string };
const companies: Company[] = [];
const realFetch = globalThis.fetch;
const phone = "+12025550101", origin = "https://voice-lifecycle.example.test";
const network = vi.fn();
let server: Server, base: string;
const pause = (company: Company) => transitionCustomerLifecycle(company.org, company.owner, { action: "pause", expectedVersion: 0, reason: "Synthetic lifecycle voice hold" });
const calls = (company: Company) => db.select().from(twilioCallsTable).where(eq(twilioCallsTable.organizationId, company.org));
const start = (company: Company, requestId = randomUUID()) => realFetch(`${base}/api/v1/communications/voice`, {
  method: "POST", headers: { authorization: `Bearer ${company.sid}`, origin, "content-type": "application/json" },
  body: JSON.stringify({ contactId: company.contact, requestId, requestedByContact: true }),
});
function webhook(company: Company, path: string, fields: Record<string, string>, signed = true) {
  const body = { AccountSid: company.account, From: phone, To: company.number, ...fields };
  return realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": signed ? getExpectedTwilioSignature(company.token, `${origin}${path}`, body) : "invalid" }, body: new URLSearchParams(body) });
}
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin);
  for (const [index, label] of ["A", "B"].entries()) {
    const [org] = await db.insert(organizationsTable).values({ name: `Synthetic lifecycle voice ${label}`, slug: `lifecycle-voice-${randomUUID()}` }).returning();
    const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner" }).returning();
    const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic caller", phone }).returning();
    const sid = await createSession({ user: { id: owner.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const token = `synthetic-lifecycle-voice-${label}`, account = `AC${randomUUID().replaceAll("-", "")}`;
    const number = index ? "+15005550007" : "+15005550006", staff = index ? "+12025550119" : "+12025550109";
    const tokenRef = `TWILIO_CLIENT_LIFECYCLE_${label}_AUTH_TOKEN`, apiRef = `TWILIO_CLIENT_LIFECYCLE_${label}_API_KEY_SECRET`;
    vi.stubEnv(tokenRef, token); vi.stubEnv(apiRef, "synthetic-api-key-only");
    await db.insert(twilioClientBindingsTable).values({ organizationId: org.id, accountSid: account, phoneNumber: number,
      apiKeySid: `SK${randomUUID().replaceAll("-", "")}`, authTokenSecretRef: tokenRef, apiKeySecretRef: apiRef,
      publicOrigin: origin, businessName: `Synthetic ${label}`, staffPhone: staff, dailyCallLimit: 100,
      launchApproved: true, voiceEnabled: true, voiceApproved: true, geoPermissionsReviewed: true });
    companies.push({ org: org.id, owner: owner.id, sid, contact: contact.id, account, number, staff, token });
  }
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local test listener");
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  // Reset only this synthetic worker's loopback voice budget; production rate
  // limiting remains active and unchanged for every request under test.
  await db.delete(rateLimitCountersTable).where(eq(rateLimitCountersTable.key, `voice-app:127.0.0.1:test-${process.pid}`));
  await db.delete(missedCallHandoffsTable).where(inArray(missedCallHandoffsTable.organizationId, companies.map((company) => company.org)));
  await db.delete(twilioCallsTable).where(inArray(twilioCallsTable.organizationId, companies.map((company) => company.org)));
  await db.delete(customerLifecycleTable).where(inArray(customerLifecycleTable.organizationId, companies.map((company) => company.org)));
  network.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    const company = companies.find((item) => url === `https://api.twilio.com/2010-04-01/Accounts/${item.account}/Calls.json`);
    if (!company) throw new Error("Unexpected external request is forbidden");
    expect(new URLSearchParams(String(init.body)).get("To")).toBe(company.staff);
    return Response.json({ sid: `CA${randomUUID().replaceAll("-", "")}` }, { status: 201 });
  });
  // All provider calls terminate at this synthetic boundary; app HTTP uses realFetch directly.
  vi.stubGlobal("fetch", network);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const company of companies) await deleteSession(company.sid);
  await deleteTestOrgs(...companies.map((company) => company.org)); vi.unstubAllEnvs();
});

it("rejects fresh calls before any claim or provider attempt for the paused company while the other company still works", async () => {
  const [held, active] = companies; await pause(held);
  const rejected = await start(held);
  expect(rejected.status).toBe(423); expect(await rejected.json()).toMatchObject({ code: "customer_lifecycle_paused" });
  expect(await calls(held)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  expect((await start(active)).status).toBe(202);
  expect(await calls(active)).toHaveLength(1); expect(await calls(held)).toHaveLength(0);
  expect(network).toHaveBeenCalledTimes(1);
});

it("cancels a claimed but unsent call if pause arrives during preparation and never replays that request identity", async () => {
  const company = companies[0], requestId = randomUUID(), actual = lifecycle.customerWorkHeld;
  let reads = 0;
  vi.spyOn(lifecycle, "customerWorkHeld").mockImplementation(async (org) => {
    if (org === company.org && ++reads === 2) await pause(company);
    return actual(org);
  });
  expect((await start(company, requestId)).status).toBe(423);
  expect((await calls(company))[0]).toMatchObject({ status: "cancelled", providerSid: null, bridgeStarted: false });
  expect(network).not.toHaveBeenCalled();
  await transitionCustomerLifecycle(company.org, company.owner, { action: "resume", expectedVersion: 1, reason: "Owner reviewed cancelled synthetic operation", resumeQueuedWork: true });
  expect((await start(company, requestId)).status).toBe(409);
  expect(network).not.toHaveBeenCalled();
});

it("blocks answer and customer bridge after pause while continuing to record signed completion and status callbacks", async () => {
  const company = companies[0]; expect((await start(company)).status).toBe(202);
  const [call] = await calls(company); await pause(company);
  const fields = { CallSid: call.providerSid!, From: company.number, To: company.staff };
  const answer = await webhook(company, `/api/v1/public/voice/answer?operation=${call.id}`, fields);
  expect(answer.status).toBe(200); expect(await answer.text()).not.toMatch(/<Gather|<Dial/);
  const connectPath = `/api/v1/public/voice/connect?operation=${call.id}`;
  expect((await webhook(company, connectPath, { ...fields, Digits: "1" }, false)).status).toBe(403);
  const connect = await webhook(company, connectPath, { ...fields, Digits: "1" });
  expect(connect.status).toBe(200); expect(await connect.text()).not.toContain("<Dial");
  expect((await calls(company))[0].bridgeStarted).toBe(false);
  const status = await webhook(company, `/api/v1/public/voice/status?operation=${call.id}`, { ...fields, CallStatus: "completed" });
  expect(status.status).toBe(204);
  const complete = await webhook(company, `/api/v1/public/voice/complete?operation=${call.id}`, { ...fields, DialCallStatus: "busy" });
  expect(complete.status).toBe(200);
  expect((await calls(company))[0]).toMatchObject({ status: "completed", dialStatus: "busy", bridgeStarted: false });
  expect(network).toHaveBeenCalledTimes(1);
});

it("keeps signed inbound call evidence while refusing a new staff leg for a held company", async () => {
  const company = companies[0]; await pause(company);
  const CallSid = `CA${randomUUID().replaceAll("-", "")}`;
  const response = await webhook(company, "/api/v1/public/voice/inbound", { CallSid });
  expect(response.status).toBe(200);
  const xml = await response.text(); expect(xml).toContain("<Reject"); expect(xml).not.toContain("<Dial");
  const [call] = await calls(company); expect(call).toMatchObject({ direction: "inbound", phone, providerSid: CallSid });
  expect((await webhook(company, `/api/v1/public/voice/status?operation=${call.id}`, { CallSid, CallStatus: "busy" })).status).toBe(204);
  expect((await calls(company))[0].status).toBe("busy");
  expect(network).not.toHaveBeenCalled();
});

it("preserves the missed-call review record for an inbound leg handed off before pause", async () => {
  const company = companies[0], CallSid = `CA${randomUUID().replaceAll("-", "")}`;
  const response = await webhook(company, "/api/v1/public/voice/inbound", { CallSid });
  expect(await response.text()).toContain("<Dial");
  const [call] = await calls(company); await pause(company);
  const path = `/api/v1/public/voice/complete?operation=${call.id}`;
  expect((await webhook(company, path, { CallSid, DialCallStatus: "no-answer" })).status).toBe(200);
  expect((await webhook(company, path, { CallSid, DialCallStatus: "no-answer" })).status).toBe(200);
  expect(await db.select().from(missedCallHandoffsTable).where(and(eq(missedCallHandoffsTable.organizationId, company.org), eq(missedCallHandoffsTable.callId, call.id)))).toHaveLength(1);
  expect((await calls(company))[0].dialStatus).toBe("no-answer");
  expect(network).not.toHaveBeenCalled();
});

it("fails closed if the lifecycle check is unavailable, without a call claim or external effect", async () => {
  vi.spyOn(lifecycle, "customerWorkHeld").mockRejectedValue(new Error("synthetic lifecycle database failure"));
  expect((await start(companies[0])).status).toBe(500);
  expect(await calls(companies[0])).toHaveLength(0); expect(network).not.toHaveBeenCalled();
});
