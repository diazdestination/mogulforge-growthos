import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, customerLifecycleTable, db, emailResponseReviewsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";
import { deleteLeadMailboxFixtures, leadMailboxFixture, receiveLeadFixture, type LeadMailboxFixture } from "../../test-helpers/mailbox-lead-fixture";
import { mailboxConnectorsTable } from "../../../../../lib/db/src/schema/mailbox-connectors";

let server: Server, base: string, f: LeadMailboxFixture, other: LeadMailboxFixture, replyId: string;
let office: string, viewer: string, unverified: string, foreign: string, key: string;
const sessions: string[] = [];
async function sessionFor(user: { id: string }) {
  const session = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(session); return session;
}
async function login(org: string, role: "office" | "viewer", verified = true) {
  const [user] = await db.insert(usersTable).values({ organizationId: org, role, emailVerifiedAt: verified ? new Date() : null }).returning();
  return sessionFor(user);
}
const headers = (session = office) => ({ authorization: `Bearer ${session}`, "content-type": "application/json" });
const command = () => ({ requestId: randomUUID(), expectedVersion: 1, decision: "handled", note: "The office inspected the exact retained reply and recorded its next step.", reviewed: true });
beforeAll(async () => {
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "d1".repeat(32)); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "e1".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  f = await leadMailboxFixture(); other = await leadMailboxFixture();
  replyId = (await receiveLeadFixture(f)).result.replyId!;
  office = await login(f.org, "office"); viewer = await login(f.org, "viewer"); unverified = await login(f.org, "office", false); foreign = await sessionFor(other.staff);
  key = (await createApiKey({ organizationId: f.org, createdByUserId: f.staff.id, role: "office", name: "Synthetic typed reply key" })).key;
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/leads/${f.lead.id}/mailbox-replies`;
});
afterAll(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const session of sessions) await deleteSession(session);
  await deleteLeadMailboxFixtures([f.org, other.org]); vi.unstubAllEnvs();
});
const reviewUrl = () => `${base}/${replyId}/review`;
it("keeps retained reply evidence authenticated, accepted, private and tenant-scoped", async () => {
  expect((await fetch(base)).status).toBe(401);
  expect((await fetch(base, { headers: headers(foreign) })).status).toBe(404);
  expect((await fetch(base, { headers: headers(unverified) })).status).toBe(403);
  const response = await fetch(base, { headers: headers(viewer) }); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ items: [{ id: replyId, state: "confirmed", historical: false, holdActive: true, taskTitle: "Review the customer's email reply", assignedUserName: "Synthetic Owner", monitoringCurrent: true, evidence: "original_mailbox_observation" }], hasMore: false, limit: 25 });
});
it("rejects unauthorized roles, API keys, cross-site requests and non-JSON mutations", async () => {
  for (const session of [viewer, unverified, foreign]) expect((await fetch(reviewUrl(), { method: "POST", headers: headers(session), body: JSON.stringify(command()) })).status).toBe(session === foreign ? 404 : 403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(command()) })).status).toBe(403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { ...headers(), origin: "https://untrusted.example.invalid" }, body: JSON.stringify(command()) })).status).toBe(403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { ...headers(), "sec-fetch-site": "cross-site" }, body: JSON.stringify(command()) })).status).toBe(403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { authorization: `Bearer ${office}`, "content-type": "text/plain" }, body: JSON.stringify(command()) })).status).toBe(415);
});
it("rejects arbitrary customer, tenant, sender and implicit approval fields", async () => {
  for (const override of [{ organizationId: other.org }, { customerConfirmed: true }, { senderEmail: "other@example.invalid" }, { reviewed: false }, { expectedVersion: 0 }])
    expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify({ ...command(), ...override }) })).status).toBe(400);
  for (const query of ["offset=-1", "offset=100001", `organizationId=${other.org}`]) expect((await fetch(`${base}?${query}`, { headers: headers() })).status).toBe(400);
});
it("does not let legacy review or resolve routes mutate typed retained evidence", async () => {
  const prefix = base.slice(0, base.indexOf("/leads/"));
  for (const suffix of ["review", "resolve"]) {
    const body = suffix === "review" ? { decision: "confirm", leadId: f.lead.id, note: "Legacy bypass must not handle typed retained evidence." } : { note: "Legacy bypass must not release typed retained evidence." };
    const response = await fetch(`${prefix}/email-intelligence/replies/${replyId}/${suffix}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "typed_reply_review_required" });
  }
  expect((await db.select().from(emailResponseReviewsTable).where(eq(emailResponseReviewsTable.id, replyId)))[0].holdActive).toBe(true);
});
it("handles stored evidence after read revocation without mailbox access and rejects stale or altered replay", async () => {
  await db.update(mailboxConnectorsTable).set({ state: "disabled", encryptedRefreshToken: null, version: 2 }).where(eq(mailboxConnectorsTable.id, f.connector.id));
  const input = command(), send = () => fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify(input) });
  const first = await send(); expect(first.status).toBe(200); const saved = await first.json() as { replyId: string; version: number; replayed: boolean };
  expect(saved).toMatchObject({ replyId, version: 2, replayed: false }); expect(await (await send()).json()).toEqual({ ...saved, replayed: true });
  expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify({ ...input, note: "Same request with changed content is not a retry." }) })).status).toBe(409);
  expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify(command()) })).status).toBe(409);
  expect(await (await fetch(base, { headers: headers() })).json()).toMatchObject({ items: [{ holdActive: false, version: 2, monitoringCurrent: false, taskStatus: "done" }] });
  expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org))).filter(row => row.action === "customer_reply.mailbox_handled")).toHaveLength(1);
});
it("preserves read-only evidence but blocks handling during company lifecycle hold", async () => {
  await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic company pause" });
  expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify(command()) })).status).toBe(409);
  expect((await fetch(base, { headers: headers() })).status).toBe(200);
});
