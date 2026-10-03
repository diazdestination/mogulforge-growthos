import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { contactsTable, db, organizationsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";
import { createServiceObligation } from "../../services/service-obligations";
import { processServiceWatch } from "../../services/service-watch";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server, base: string, org: string, other: string, staff: string, serviceId: string, office: string, viewer: string, unverified: string, foreign: string, key: string;
const sessions: string[] = [];
async function login(organizationId: string, role: "office" | "viewer", verified = true) {
  const [user] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: verified ? new Date() : null }).returning();
  const session = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(session); return { user, session };
}
const headers = (session = office) => ({ authorization: `Bearer ${session}`, "content-type": "application/json" });
beforeAll(async () => {
  const companies = await db.insert(organizationsTable).values(["A", "B"].map(name => ({ name: `Synthetic watch HTTP ${name}`, slug: `service-watch-http-${randomUUID()}` }))).returning(); org = companies[0].id; other = companies[1].id;
  const accepted = await login(org, "office"); staff = accepted.user.id; office = accepted.session;
  viewer = (await login(org, "viewer")).session; unverified = (await login(org, "office", false)).session; foreign = (await login(other, "office")).session;
  const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic service customer" }).returning();
  const service = await createServiceObligation(org, staff, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic HVAC system", dueDate: new Date().toISOString().slice(0, 10), noticeDays: 14 });
  if ("error" in service) throw new Error(service.error); serviceId = service.id;
  key = (await createApiKey({ organizationId: org, createdByUserId: staff, role: "office", name: "Synthetic watch key" })).key;
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const session of sessions) await deleteSession(session); await deleteTestOrgs(org, other); });
const detailUrl = () => `${base}/service-obligations/${serviceId}/watch`;
async function input() {
  const detail = await (await fetch(detailUrl(), { headers: headers() })).json() as { expectedVersion: number; expectedFingerprint: string };
  return { requestId: randomUUID(), action: "acknowledge", expectedVersion: detail.expectedVersion, expectedFingerprint: detail.expectedFingerprint,
    assignedUserId: staff, note: "Office will review actual customer contact and confirm next steps.", nextActionAt: new Date(Date.now() + 86_400_000).toISOString(), reviewed: true };
}
it("requires accepted staff, hides foreign records, and labels an unmonitored empty queue", async () => {
  expect((await fetch(detailUrl())).status).toBe(401);
  expect((await fetch(detailUrl(), { headers: headers(foreign) })).status).toBe(404);
  expect((await fetch(detailUrl(), { headers: headers(unverified) })).status).toBe(403);
  const read = await fetch(detailUrl(), { headers: headers(viewer) }); expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await (await fetch(`${base}/service-watch`, { headers: headers() })).json()).toMatchObject({ items: [], unmonitoredCount: 1, hasMore: false });
});
it("denies wrong-role, API-key, cross-origin and non-JSON plan changes", async () => {
  const command = await input();
  for (const session of [viewer, unverified, foreign]) {
    expect((await fetch(detailUrl(), { method: "PATCH", headers: headers(session), body: JSON.stringify(command) })).status).toBe(session === foreign ? 404 : 403);
  }
  expect((await fetch(detailUrl(), { method: "PATCH", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(command) })).status).toBe(403);
  expect((await fetch(detailUrl(), { method: "PATCH", headers: { ...headers(), origin: "https://foreign.example.invalid" }, body: JSON.stringify(command) })).status).toBe(403);
  expect((await fetch(detailUrl(), { method: "PATCH", headers: { authorization: `Bearer ${office}`, "content-type": "text/plain" }, body: JSON.stringify(command) })).status).toBe(415);
});
it("rejects identity overrides, missing review and invalid query bounds", async () => {
  const command = await input();
  for (const extra of [{ organizationId: other }, { customerReplied: true }, { reviewed: false }, { expectedVersion: -1 }]) {
    expect((await fetch(detailUrl(), { method: "PATCH", headers: headers(), body: JSON.stringify({ ...command, ...extra }) })).status).toBe(400);
  }
  for (const query of ["offset=-1", "offset=100001", "scope=foreign", `organizationId=${other}`]) expect((await fetch(`${base}/service-watch?${query}`, { headers: headers() })).status).toBe(400);
});
it("reads monitored attention, records one explicit office plan, and replays a lost acknowledgement", async () => {
  await processServiceWatch(org);
  expect(await (await fetch(`${base}/service-watch`, { headers: headers() })).json()).toMatchObject({ unmonitoredCount: 0, items: [{ serviceObligationId: serviceId, state: "open" }] });
  const command = await input();
  const save = () => fetch(detailUrl(), { method: "PATCH", headers: headers(), body: JSON.stringify(command) });
  const first = await save(); expect(first.status).toBe(200); const result = await first.json() as { caseId: string; version: number };
  expect(await (await save()).json()).toEqual({ ...result, replayed: true });
  expect(await (await fetch(detailUrl(), { headers: headers() })).json()).toMatchObject({ state: "acknowledged", nextAction: command.note, assignedUserId: staff });
});
