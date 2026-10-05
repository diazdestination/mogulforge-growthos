import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { appointmentsTable, contactsTable, db, leadsTable, organizationsTable, propertiesTable, scheduledActionsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server, base: string, org: string, sid: string, contact: string, first: string, second: string, lead: string;
beforeAll(async () => {
  const [company] = await db.insert(organizationsTable).values({ name: "Synthetic appointment property HTTP", slug: randomUUID() }).returning(); org = company.id;
  const [user] = await db.insert(usersTable).values({ organizationId: org, role: "office", emailVerifiedAt: new Date() }).returning();
  sid = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const [customer] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic customer" }).returning(); contact = customer.id;
  [first, second] = (await db.insert(propertiesTable).values(["100", "200"].map(number => ({ organizationId: org, contactId: contact, addressLine1: `${number} Synthetic Lane`, city: "Example", state: "GA", postalCode: "00000" }))).returning()).map(row => row.id);
  const [opportunity] = await db.insert(leadsTable).values({ organizationId: org, contactId: contact, propertyId: first }).returning(); lead = opportunity.id;
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await deleteTestOrgs(org); });
const headers = () => ({ authorization: `Bearer ${sid}`, "content-type": "application/json" });
const create = (refs: Record<string, unknown>) => fetch(`${base}/appointments`, { method: "POST", headers: headers(), body: JSON.stringify({ contactId: contact, type: "other", scheduledStart: "2035-08-01T14:00:00Z", scheduledEnd: "2035-08-01T15:00:00Z", ...refs }) });

it("accepts an explicit null property in the generated create contract without deriving the lead worksite", async () => {
  const response = await create({ leadId: lead, propertyId: null });
  expect(response.status).toBe(201);
  const appointment = z.object({ id: z.uuid(), contactId: z.uuid().nullable(), leadId: z.uuid().nullable(), propertyId: z.uuid().nullable() }).parse(await response.json());
  expect(appointment).toMatchObject({ id: expect.any(String), contactId: contact, leadId: lead, propertyId: null });
  expect(await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), sql`${scheduledActionsTable.context}->>'appointmentId' = ${appointment.id}`))).toHaveLength(1);
});

it("creates a service-only customer's explicitly chosen worksite and rejects a contradictory optional lead", async () => {
  const response = await create({ propertyId: second, notes: "Office selected this exact worksite." });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ contactId: contact, propertyId: second, leadId: null, notes: "Office selected this exact worksite." });
  const before = await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, org));
  const invalid = await create({ leadId: lead, propertyId: second });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ code: "customer_reference_mismatch" });
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, org))).toEqual(before);
});
