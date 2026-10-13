import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { contactsTable, db, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
let server: Server, base: string, org: string, sid: string, staff: string, contact: string, lead: string;
beforeAll(async () => {
  const [company] = await db.insert(organizationsTable).values({ name: "Synthetic schedule HTTP", slug: `schedule-http-${randomUUID()}` }).returning(); org = company.id;
  const [user] = await db.insert(usersTable).values({ organizationId: org, role: "office" }).returning();
  staff = user.id;
  sid = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const [customer] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic" }).returning(); contact = customer.id;
  const [opportunity] = await db.insert(leadsTable).values({ organizationId: org, contactId: contact }).returning(); lead = opportunity.id;
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await deleteTestOrgs(org); });
const headers = () => ({ authorization: `Bearer ${sid}`, "content-type": "application/json" });
const savedRecord = z.object({ id: z.string(), updatedAt: z.iso.datetime() });
const create = () => fetch(`${base}/appointments`, { method: "POST", headers: headers(), body: JSON.stringify({ contactId: contact, type: "other", scheduledStart: "2035-07-01T14:00:00Z", scheduledEnd: "2035-07-01T15:00:00Z" }) });
it("returns named customer appointments in bounded ranges with an explicit limit header", async () => {
  expect((await create()).status).toBe(201);
  const response = await fetch(`${base}/appointments?from=2035-07-01T00:00:00Z&to=2035-07-02T00:00:00Z&contactId=${contact}`, { headers: headers() });
  expect(response.status).toBe(200); expect(response.headers.get("x-result-limit-reached")).toBe("false");
  const rows = z.array(savedRecord.extend({ contactId: z.string(), leadLabel: z.string() })).parse(await response.json()); expect(rows[0]).toMatchObject({ contactId: contact, leadLabel: "Synthetic", updatedAt: expect.any(String) });
  expect((await fetch(`${base}/appointments?from=2035-07-01T00:00:00Z&to=2036-07-01T00:00:00Z`, { headers: headers() })).status).toBe(400);
});
it("rejects cross-origin and non-JSON contractor mutations", async () => {
  for (const path of ["appointments", "projects", "service-obligations"]) {
    expect((await fetch(`${base}/${path}`, { method: "POST", headers: { ...headers(), origin: "https://untrusted.example.test" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/${path}`, { method: "POST", headers: { authorization: `Bearer ${sid}`, "content-type": "application/x-www-form-urlencoded" }, body: "status=completed" })).status).toBe(415);
  }
});
it("rejects a stale update instead of overwriting another office save", async () => {
  const appointment = savedRecord.parse(await (await create()).json());
  const first = await fetch(`${base}/appointments/${appointment.id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ notes: "Current office instruction", expectedUpdatedAt: appointment.updatedAt }) }); expect(first.status).toBe(200);
  const stale = await fetch(`${base}/appointments/${appointment.id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ status: "cancelled", expectedUpdatedAt: appointment.updatedAt }) }); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "stale_update" });
});
it("returns invalid_interval for an end-only crew-job clear and retains its booking", async () => {
  const created = await fetch(`${base}/projects`, { method: "POST", headers: headers(), body: JSON.stringify({ leadId: lead, name: "Synthetic multi-day crew job", crewUserIds: [staff], scheduledStart: "2035-07-20T15:00:00Z", scheduledEnd: "2035-07-23T16:00:00Z" }) });
  expect(created.status).toBe(201);
  const job = savedRecord.parse(await created.json());
  const cleared = await fetch(`${base}/projects/${job.id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ scheduledEnd: null }) });
  expect(cleared.status).toBe(400);
  expect(await cleared.json()).toMatchObject({ code: "invalid_interval" });
  const saved = await fetch(`${base}/projects/${job.id}`, { headers: headers() });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ scheduledStart: "2035-07-20T15:00:00.000Z", scheduledEnd: "2035-07-23T16:00:00.000Z", crewUserIds: [staff], updatedAt: job.updatedAt });
  const overlapping = await fetch(`${base}/appointments`, { method: "POST", headers: headers(), body: JSON.stringify({ contactId: contact, type: "other", assignedUserId: staff, scheduledStart: "2035-07-22T15:00:00Z", scheduledEnd: "2035-07-22T16:00:00Z" }) });
  expect(overlapping.status).toBe(409);
  expect(await overlapping.json()).toMatchObject({ code: "resource_conflict" });
});
it("requires explicit recurrence evidence and returns the successor on service completion", async () => {
  const created = await fetch(`${base}/service-obligations`, { method: "POST", headers: headers(), body: JSON.stringify({ contactId: contact, kind: "maintenance", equipmentLabel: "Synthetic furnace", dueDate: "2035-01-31" }) }); expect(created.status).toBe(201);
  const item = savedRecord.parse(await created.json());
  const missing = await fetch(`${base}/service-obligations/${item.id}/recurrence`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedUpdatedAt: item.updatedAt, intervalMonths: 6, agreementNote: "" }) }); expect(missing.status).toBe(400);
  const approvedResponse = await fetch(`${base}/service-obligations/${item.id}/recurrence`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedUpdatedAt: item.updatedAt, intervalMonths: 6, agreementNote: "Synthetic approved service agreement" }) }); expect(approvedResponse.status).toBe(200);
  const approved = savedRecord.parse(await approvedResponse.json());
  const completed = await fetch(`${base}/service-obligations/${item.id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ status: "completed", expectedUpdatedAt: approved.updatedAt }) }); expect(completed.status).toBe(200); expect(await completed.json()).toMatchObject({ id: item.id, status: "completed", nextObligationId: expect.any(String) });
});
