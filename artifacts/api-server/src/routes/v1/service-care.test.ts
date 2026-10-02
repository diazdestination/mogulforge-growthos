import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { contactsTable, db, organizationsTable, orgSettingsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createApiKey } from "../../services/api-keys";
import { createServiceObligation } from "../../services/service-obligations";
import { resolveCustomerEmailSender, sendCustomerEmail } from "../../services/customer-email";

vi.mock("../../services/customer-email", () => ({ resolveCustomerEmailSender: vi.fn(), sendCustomerEmail: vi.fn() }));
let server: Server, base: string, org: string, other: string, staff: string, serviceId: string, key: string;
const sessions: string[] = [];
type CareResult = { expectedUpdatedAt: string; preview: { fingerprint: string }; reminder: { state: string }; response: { evidence: string } };
let office: string, viewer: string, invited: string, foreign: string;
async function login(organizationId: string, role: "office" | "viewer", verified = true) {
  const [user] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: verified ? new Date() : null }).returning();
  const session = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(session); return { user, session };
}
beforeAll(async () => {
  const companies = await db.insert(organizationsTable).values(["A", "B"].map(name => ({ name: `Synthetic care HTTP ${name}`, slug: `service-care-http-${randomUUID()}` }))).returning(); org = companies[0].id; other = companies[1].id;
  const member = await login(org, "office"); staff = member.user.id; office = member.session;
  viewer = (await login(org, "viewer")).session; invited = (await login(org, "office", false)).session; foreign = (await login(other, "office")).session;
  const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic customer", email: "customer@example.invalid" }).returning();
  await db.insert(orgSettingsTable).values({ organizationId: org, sendingHours: { quietHoursEnabled: false } });
  const obligation = await createServiceObligation(org, staff, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic system", dueDate: "2035-01-01", noticeDays: 14 });
  if ("error" in obligation) throw new Error(obligation.error); serviceId = obligation.id;
  key = (await createApiKey({ organizationId: org, createdByUserId: staff, name: "Synthetic care reader", role: "office" })).key;
  vi.mocked(resolveCustomerEmailSender).mockResolvedValue({ userId: staff, source: "company_default", provider: "microsoft", senderEmail: "office@example.invalid" });
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/service-obligations/${serviceId}/care`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const sid of sessions) await deleteSession(sid); await deleteTestOrgs(org, other); });
const headers = (sid = office) => ({ authorization: `Bearer ${sid}`, "content-type": "application/json" });
async function approval() {
  const value = await (await fetch(base, { headers: headers() })).json() as CareResult;
  return { requestId: randomUUID(), expectedUpdatedAt: value.expectedUpdatedAt, channel: "email", previewFingerprint: value.preview.fingerprint, agreementNote: "Reviewed current synthetic service expectation.", expectedServiceConfirmed: true };
}
it("requires authentication and same-tenant reads, with no-store and no provider send", async () => {
  expect((await fetch(base)).status).toBe(401);
  expect((await fetch(base, { headers: headers(foreign) })).status).toBe(404);
  const response = await fetch(base, { headers: headers(viewer) }); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ active: true, reminder: null, preview: { sender: { provider: "microsoft" } } }); expect(sendCustomerEmail).not.toHaveBeenCalled();
});
it("blocks viewer, invitation/unverified and programmatic API-key attestations", async () => {
  const input = await approval();
  for (const session of [viewer, invited]) expect((await fetch(`${base}/reminder`, { method: "POST", headers: headers(session), body: JSON.stringify(input) })).status).toBe(403);
  expect((await fetch(`${base}/reminder`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(403);
});
it("rejects cross-site changes, non-JSON, unknown channels and recipient/org overrides", async () => {
  const input = await approval();
  expect((await fetch(`${base}/reminder`, { method: "POST", headers: { ...headers(), origin: "https://untrusted.example" }, body: JSON.stringify(input) })).status).toBe(403);
  expect((await fetch(`${base}/reminder`, { method: "POST", headers: { authorization: `Bearer ${office}`, "content-type": "text/plain" }, body: JSON.stringify(input) })).status).toBe(415);
  for (const query of ["channel=push", `organizationId=${other}`]) expect((await fetch(`${base}?${query}`, { headers: headers() })).status).toBe(400);
  for (const extra of [{ to: "override@example.invalid" }, { organizationId: other }, { expectedServiceConfirmed: false }]) expect((await fetch(`${base}/reminder`, { method: "POST", headers: headers(), body: JSON.stringify({ ...input, ...extra }) })).status).toBe(400);
});
it("queues the reviewed message once through HTTP and exposes the durable preparation receipt", async () => {
  const input = await approval();
  const first = await fetch(`${base}/reminder`, { method: "POST", headers: headers(), body: JSON.stringify(input) }); expect(first.status).toBe(200);
  const accepted = await first.json() as { approvalId: string; replayed: boolean };
  const repeated = await fetch(`${base}/reminder`, { method: "POST", headers: headers(), body: JSON.stringify(input) }); expect(await repeated.json()).toEqual({ ...accepted, replayed: true });
  expect((await fetch(`${base}/reminder`, { method: "POST", headers: headers(), body: JSON.stringify({ ...input, requestId: randomUUID() }) })).status).toBe(409);
  expect(await (await fetch(base, { headers: headers() })).json()).toMatchObject({ reminder: { approvalId: accepted.approvalId, state: "pending", deliveryConfirmed: false } });
  expect(sendCustomerEmail).not.toHaveBeenCalled();
});
it("records a staff response and books one appointment through the permissioned HTTP path", async () => {
  const current = await (await fetch(base, { headers: headers() })).json() as CareResult;
  const response = await fetch(`${base}/response`, { method: "POST", headers: headers(), body: JSON.stringify({ requestId: randomUUID(), expectedUpdatedAt: current.expectedUpdatedAt, channel: "phone", outcome: "ready_to_book", respondedAt: new Date(Date.now() - 1000).toISOString(), note: "Synthetic customer confirmed the proposed service window.", staffAttested: true }) });
  expect(response.status).toBe(200); const recorded = await response.json() as { responseId: string };
  const fresh = await (await fetch(base, { headers: headers() })).json() as CareResult;
  expect(fresh.reminder.state).toBe("cancelled"); expect(fresh.response.evidence).toBe("staff_attested_not_provider_verified");
  const booking = { requestId: randomUUID(), expectedUpdatedAt: fresh.expectedUpdatedAt, responseId: recorded.responseId, assignedUserId: staff, type: "inspection", scheduledStart: "2035-01-05T15:00:00.000Z", scheduledEnd: "2035-01-05T16:00:00.000Z", customerConfirmed: true };
  const result = await fetch(`${base}/book`, { method: "POST", headers: headers(), body: JSON.stringify(booking) }); expect(result.status).toBe(200);
  const booked = await result.json() as { appointmentId: string; replayed: boolean };
  expect(await (await fetch(`${base}/book`, { method: "POST", headers: headers(), body: JSON.stringify(booking) })).json()).toEqual({ ...booked, replayed: true });
  expect(await (await fetch(base, { headers: headers() })).json()).toMatchObject({ active: true, appointment: { id: booked.appointmentId, status: "confirmed" } }); expect(sendCustomerEmail).not.toHaveBeenCalled();
});
