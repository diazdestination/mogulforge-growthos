import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

const sendGmailForUserMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/gmail-oauth", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../services/gmail-oauth")>();
  return {
    ...original,
    sendGmailForUser: sendGmailForUserMock,
  };
});

import app from "../../app";
import { createSession } from "../../lib/auth";

let server: Server;
let baseUrl: string;
let org: { id: string };
let user: { id: string };
let sid: string;

const stamp = Date.now();

async function makeLead(input?: { doNotContactEmail?: boolean }) {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Gmail",
      lastName: "Route",
      email: `gmail-route-${stamp}-${Math.random().toString(36).slice(2)}@example.com`,
      doNotContactEmail: input?.doNotContactEmail ?? false,
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  return { contact, lead };
}

async function sendEmail(leadId: string) {
  return fetch(`${baseUrl}/v1/leads/${encodeURIComponent(leadId)}/send-email`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sid}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      subject: "Signed-in sender regression",
      body: "This should be sent only through the current user's Gmail connection.",
    }),
  });
}

beforeAll(async () => {
  const [orgRow] = await db
    .insert(organizationsTable)
    .values({ name: "Gmail route org", slug: `gmail-route-${stamp}` })
    .returning();
  org = orgRow;

  const [userRow] = await db
    .insert(usersTable)
    .values({
      email: `gmail-route-user-${stamp}@example.com`,
      organizationId: org.id,
      role: "sales_rep",
    })
    .returning();
  user = userRow;

  sid = await createSession({
    user: {
      id: user.id,
      email: userRow.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

beforeEach(() => {
  sendGmailForUserMock.mockReset();
  sendGmailForUserMock.mockResolvedValue({
    id: "gmail-message-route-test",
    provider: "gmail",
    senderEmail: "connected-sender@example.com",
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

describe("POST /v1/leads/:id/send-email — per-user Gmail", () => {
  it("sends with the signed-in user's org/user identity and records the sender", async () => {
    const { contact, lead } = await makeLead();

    const response = await sendEmail(lead.id);
    expect(response.status).toBe(201);

    expect(sendGmailForUserMock).toHaveBeenCalledOnce();
    expect(sendGmailForUserMock).toHaveBeenCalledWith({
      organizationId: org.id,
      userId: user.id,
      to: contact.email,
      subject: "Signed-in sender regression",
      body: "This should be sent only through the current user's Gmail connection.",
    });

    const [activity] = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, org.id),
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "lead_email_sent"),
        ),
      )
      .orderBy(desc(activitiesTable.occurredAt))
      .limit(1);
    expect(activity?.metadata).toMatchObject({
      to: contact.email,
      from: "connected-sender@example.com",
      provider: "gmail",
      providerMessageId: "gmail-message-route-test",
      source: "crm-compose",
    });

    const [audit] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "lead.email_sent"),
          eq(auditEventsTable.entityId, lead.id),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(1);
    expect(audit?.actorUserId).toBe(user.id);
    expect(audit?.metadata).toMatchObject({
      from: "connected-sender@example.com",
      providerMessageId: "gmail-message-route-test",
    });
  });

  it("blocks a do-not-email contact before any Gmail provider call", async () => {
    const { lead } = await makeLead({ doNotContactEmail: true });

    const response = await sendEmail(lead.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("do_not_contact_email"),
    });
    expect(sendGmailForUserMock).not.toHaveBeenCalled();

    const [audit] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "send.blocked"),
          eq(auditEventsTable.entityId, lead.id),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(1);
    expect(audit?.actorUserId).toBe(user.id);
    expect(audit?.metadata).toMatchObject({
      channel: "email",
      reason: "do_not_contact_email",
      source: "crm-compose",
    });
  });
});
