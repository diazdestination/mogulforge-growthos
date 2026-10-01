import { randomUUID } from "node:crypto";
import {
  activitiesTable,
  bieActionProposalsTable,
  contactsTable,
  db,
  DEFAULT_SENDING_HOURS,
  leadsTable,
  organizationsTable,
  revenueExecutionsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

const senderStatus = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
vi.mock("./user-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./user-email")>()),
  getUserEmailStatus: senderStatus,
  sendEmailForUser: send,
}));
import { executeBieProposal } from "./bie";
import { MicrosoftMailError } from "./microsoft-oauth";
import { updateOrgSettings } from "./settings";

let organizationId: string, userId: string;
beforeAll(async () => {
  const stamp = randomUUID();
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic BIE Microsoft", slug: `bie-ms-${stamp}` })
    .returning();
  organizationId = org.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId,
      email: `${stamp}@example.invalid`,
      role: "owner",
    })
    .returning();
  userId = user.id;
  await updateOrgSettings(organizationId, {
    sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false },
  });
});
beforeEach(() => {
  senderStatus
    .mockReset()
    .mockResolvedValue({
      provider: "microsoft",
      configured: true,
      connected: true,
    });
  send
    .mockReset()
    .mockResolvedValue({
      id: null,
      provider: "microsoft",
      senderEmail: "selected@example.invalid",
      acceptance: "accepted",
      providerRequestId: "00000000-0000-4000-8000-000000000001",
      clientRequestId: "00000000-0000-4000-8000-000000000002",
    });
});
afterAll(async () => {
  await deleteTestOrgs(organizationId);
});
async function proposal() {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId,
      firstName: "Synthetic",
      email: `${randomUUID()}@example.invalid`,
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId, contactId: contact.id, assignedUserId: userId })
    .returning();
  const [action] = await db
    .insert(bieActionProposalsTable)
    .values({
      organizationId,
      leadId: lead.id,
      actionType: "send_email",
      status: "approved",
      title: "Synthetic email approval",
      rationale: "Test only",
      payload: { subject: "Test", body: "No real send" },
      createdByUserId: userId,
      reviewedByUserId: userId,
    })
    .returning();
  return { contact, lead, action };
}

it("executes an approved Microsoft email once and labels acceptance without invented delivery or message IDs", async () => {
  const { contact, lead, action } = await proposal();
  const result = await executeBieProposal(organizationId, action.id, userId);
  expect(result).toMatchObject({
    status: "executed",
    executionDetail:
      "Accepted by microsoft; delivery and reply are not yet confirmed.",
  });
  expect(send).toHaveBeenCalledWith({
    organizationId,
    userId,
    to: contact.email,
    subject: "Test",
    body: "No real send",
  });
  const [activity] = await db
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.leadId, lead.id),
        eq(activitiesTable.type, "bie_email_sent"),
      ),
    );
  expect(activity.metadata).toMatchObject({
    provider: "microsoft",
    providerMessageId: null,
    providerRequestId: "00000000-0000-4000-8000-000000000001",
    clientRequestId: "00000000-0000-4000-8000-000000000002",
    deliveryConfirmed: false,
  });
  await executeBieProposal(organizationId, action.id, userId);
  expect(send).toHaveBeenCalledTimes(1);
});

it("blocks automatic replay after ambiguous Microsoft acceptance and keeps the durable result visible", async () => {
  const { lead, action } = await proposal();
  send.mockRejectedValue(
    new MicrosoftMailError(
      "microsoft_send_outcome_unknown",
      "Synthetic private provider detail",
      false,
      true,
    ),
  );
  expect(
    await executeBieProposal(organizationId, action.id, userId),
  ).toMatchObject({ status: "indeterminate" });
  expect(
    await executeBieProposal(organizationId, action.id, userId),
  ).toMatchObject({ status: "indeterminate" });
  expect(send).toHaveBeenCalledTimes(1);
  const [receipt] = await db
    .select()
    .from(revenueExecutionsTable)
    .where(
      and(
        eq(revenueExecutionsTable.organizationId, organizationId),
        eq(revenueExecutionsTable.actionKey, `bie:${action.id}`),
      ),
    );
  expect(receipt.state).toBe("indeterminate");
  expect(receipt.detail).toContain("automatic replay is blocked");
  expect(receipt.detail).not.toContain("Synthetic private");
  expect(
    await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "bie_email_sent"),
        ),
      ),
  ).toHaveLength(0);
});

it("blocks a disconnected selected sender before the BIE send caller is invoked", async () => {
  senderStatus.mockResolvedValue({
    provider: "microsoft",
    configured: true,
    connected: false,
  });
  const { action } = await proposal();
  expect(
    await executeBieProposal(organizationId, action.id, userId),
  ).toMatchObject({ status: "blocked" });
  expect(send).not.toHaveBeenCalled();
});
