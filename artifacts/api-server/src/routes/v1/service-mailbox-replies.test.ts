import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, contactsTable, customerLifecycleTable, db, organizationsTable, usersTable } from "@workspace/db";
import { mailboxCommunicationParentsTable as parents, mailboxServiceRepliesTable as replies } from "../../../../../lib/db/src/schema/mailbox-communication";
import { mailboxConnectorsTable } from "../../../../../lib/db/src/schema/mailbox-connectors";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { encryptEmailContent } from "../../lib/email-content-encryption";
import { createApiKey } from "../../services/api-keys";
import { createServiceObligation } from "../../services/service-obligations";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

vi.mock("../../services/mailbox-connector", () => ({ assertMailboxIdentityCurrent: vi.fn(async () => {}), getMicrosoftMailboxIdentity: vi.fn(async () => null) }));
let server: Server, base: string, org: string, other: string, staff: string, serviceId: string, replyId: string, office: string, viewer: string, unverified: string, foreign: string, key: string;
const sessions: string[] = [];
async function login(organizationId: string, role: "office" | "viewer", verified = true) {
  const [user] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: verified ? new Date() : null }).returning();
  const session = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(session); return { user, session };
}
const headers = (session = office) => ({ authorization: `Bearer ${session}`, "content-type": "application/json" });
const command = () => ({ requestId: randomUUID(), expectedVersion: 1, decision: "office_follow_up", note: "Office reviewed the synthetic service reply and will call the customer.", reviewed: true });
beforeAll(async () => {
  vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "ce".repeat(32));
  const companies = await db.insert(organizationsTable).values(["A", "B"].map(name => ({ name: `Synthetic service replies HTTP ${name}`, slug: `service-replies-http-${randomUUID()}` }))).returning(); org = companies[0].id; other = companies[1].id;
  const member = await login(org, "office"); staff = member.user.id; office = member.session;
  viewer = (await login(org, "viewer")).session; unverified = (await login(org, "office", false)).session; foreign = (await login(other, "office")).session;
  const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic customer", email: "customer@example.invalid" }).returning();
  const service = await createServiceObligation(org, staff, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic HVAC", dueDate: "2035-01-01", noticeDays: 14 });
  if ("error" in service) throw new Error(service.error); serviceId = service.id;
  const connectionId = randomUUID(), now = new Date();
  const [connector] = await db.insert(mailboxConnectorsTable).values({ organizationId: org, userId: staff, connectionId, connectionRevision: now.toISOString(), mailboxAccountId: "synthetic", mailboxEmail: "office@example.invalid", startedAt: now }).returning();
  const [parent] = await db.insert(parents).values({ organizationId: org, contactId: contact.id, serviceObligationId: serviceId, contextSnapshot: { dueAt: service.dueAt.toISOString(), occurrenceIndex: 0, createdAt: service.createdAt.toISOString(), updatedAt: service.updatedAt.toISOString(), approvalId: randomUUID(), scheduledActionId: randomUUID() },
    provider: "microsoft", senderUserId: staff, connectionId, connectionRevision: now.toISOString(), mailboxAccountId: "synthetic", mailboxEmail: "office@example.invalid", connectorId: connector.id, connectorVersion: 1, policyVersion: 1, connectorStartedAt: now.toISOString(),
    recipient: contact.email!, contentSha256: "a".repeat(64), subjectSha256: "a".repeat(64), bodySha256: "a".repeat(64), correlationHeader: "b".repeat(64), actionKey: `synthetic-only:${randomUUID()}`, executionFingerprint: "c".repeat(64) }).returning();
  replyId = randomUUID();
  await db.insert(replies).values({ id: replyId, organizationId: org, parentId: parent.id, serviceObligationId: serviceId, contactId: contact.id, connectorId: connector.id, providerMessageId: `synthetic-inbox-${replyId}`, internetMessageId: `<${replyId}@example.invalid>`, payloadSha256: "d".repeat(64), replyAt: now, receivedAt: now, holdActive: true,
    encryptedText: encryptEmailContent(JSON.stringify({ subject: "Synthetic service reply", text: "Please call to arrange the actual visit." }), `${org}:${replyId}:service-reply`), rawExpiresAt: new Date(Date.now() + 86_400_000) });
  key = (await createApiKey({ organizationId: org, createdByUserId: staff, role: "office", name: "Synthetic reply reader" })).key;
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/service-obligations/${serviceId}/mailbox-replies`;
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  for (const session of sessions) await deleteSession(session);
  await db.delete(replies).where(eq(replies.organizationId, org)); await db.delete(parents).where(eq(parents.organizationId, org)); await deleteTestOrgs(org, other); vi.unstubAllEnvs();
});
const reviewUrl = () => `${base}/${replyId}/review`;
it("keeps service reply reads authenticated, accepted, tenant-bound and private", async () => {
  expect((await fetch(base)).status).toBe(401);
  expect((await fetch(base, { headers: headers(foreign) })).status).toBe(404);
  expect((await fetch(base, { headers: headers(unverified) })).status).toBe(403);
  const read = await fetch(base, { headers: headers(viewer) }); expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toMatchObject({ items: [{ id: replyId, state: "needs_review", content: { text: "Please call to arrange the actual visit." } }], hasMore: false, limit: 25 });
});
it("blocks viewer, invitation, API-key, cross-site and non-JSON reviews", async () => {
  for (const session of [viewer, unverified, foreign]) expect((await fetch(reviewUrl(), { method: "POST", headers: headers(session), body: JSON.stringify(command()) })).status).toBe(session === foreign ? 404 : 403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(command()) })).status).toBe(403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { ...headers(), origin: "https://untrusted.example.invalid" }, body: JSON.stringify(command()) })).status).toBe(403);
  expect((await fetch(reviewUrl(), { method: "POST", headers: { authorization: `Bearer ${office}`, "content-type": "text/plain" }, body: JSON.stringify(command()) })).status).toBe(415);
});
it("rejects arbitrary sender/booking/tenant overrides and invalid page bounds", async () => {
  for (const override of [{ organizationId: other }, { customerConfirmed: true }, { senderEmail: "other@example.invalid" }, { reviewed: false }]) expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify({ ...command(), ...override }) })).status).toBe(400);
  for (const query of ["offset=-1", "offset=100001", `organizationId=${other}`]) expect((await fetch(`${base}?${query}`, { headers: headers() })).status).toBe(400);
});
it("reviews exact evidence once without inventing a customer interpretation or releasing the service hold", async () => {
  const input = command(), send = () => fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify(input) });
  const first = await send(); expect(first.status).toBe(200); const result = await first.json() as { replyId: string; version: number; replayed: boolean };
  expect(result).toMatchObject({ replyId, version: 2, replayed: false }); expect(await (await send()).json()).toEqual({ ...result, replayed: true });
  expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify(command()) })).status).toBe(409);
  expect(await (await fetch(base, { headers: headers() })).json()).toMatchObject({ items: [{ state: "reviewed", holdActive: true }] });
  expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, org))).some(event => event.action === "service.care_response_recorded" || event.action === "service.care_visit_booked")).toBe(false);
});
it("holds review during company pause while preserving read-only evidence", async () => {
  await db.insert(customerLifecycleTable).values({ organizationId: org, state: "paused", reason: "Synthetic reply review hold" });
  expect((await fetch(reviewUrl(), { method: "POST", headers: headers(), body: JSON.stringify(command()) })).status).toBe(409);
  expect(await (await fetch(base, { headers: headers() })).json()).toMatchObject({ held: true, items: [{ id: replyId }] });
});
