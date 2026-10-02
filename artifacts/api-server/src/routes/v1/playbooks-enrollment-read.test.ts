import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  db,
  organizationsTable,
  playbookEnrollmentsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { autoEnrollLead, pauseEnrollmentById } from "../../services/playbooks";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import * as crm from "../../services/crm";

let server: Server;
let baseUrl: string;
let organizationId: string;
let leadId: string;
let enrollmentId: string;
let sid: string;

const stamp = Date.now();

beforeAll(async () => {
  const [organization] = await db
    .insert(organizationsTable)
    .values({
      name: "Enrollment read route org",
      slug: `enrollment-read-${stamp}`,
    })
    .returning();
  organizationId = organization.id;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `enrollment-read-${stamp}@example.com`,
      organizationId,
      role: "sales_rep",
    })
    .returning();
  sid = await createSession({
    user: {
      id: user.id,
      email: user.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  const contact = await crm.createContact(organizationId, {
    firstName: "Read",
    lastName: "Only",
    email: `enrollment-contact-${stamp}@example.com`,
  });
  const lead = await crm.createLead(organizationId, {
    contactId: contact.id,
    assignedUserId: user.id,
  });
  leadId = lead!.id;
  const enrollment = await autoEnrollLead(organizationId, leadId);
  enrollmentId = enrollment!.id;
  await pauseEnrollmentById(
    organizationId,
    enrollmentId,
    "paused for read test",
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(organizationId);
});

describe("GET /v1/leads/:id/enrollment", () => {
  it("returns enrollment status without advancing or resuming it", async () => {
    const [before] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollmentId));

    const response = await fetch(
      `${baseUrl}/v1/leads/${encodeURIComponent(leadId)}/enrollment`,
      { headers: { authorization: `Bearer ${sid}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: enrollmentId,
      leadId,
      status: "paused",
      currentStep: before.currentStep,
      pauseReason: "paused for read test",
    });

    const [after] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollmentId));
    expect(after.status).toBe(before.status);
    expect(after.currentStep).toBe(before.currentStep);
    expect(after.pauseReason).toBe(before.pauseReason);
    expect(after.history).toEqual(before.history);
  });
});
