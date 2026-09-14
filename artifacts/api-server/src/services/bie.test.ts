import { db, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as crm from "./crm";
import {
  buildRevenueRecoveryBriefing,
  executeBieProposal,
  generateBieProposals,
  getAutopilotPolicy,
  reviewBieProposal,
  updateAutopilotPolicy,
} from "./bie";

let org: { id: string };
let actorId: string;

beforeAll(async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [organization] = await db
    .insert(organizationsTable)
    .values({ name: "BIE Test Roofing", slug: `test-bie-${nonce}` })
    .returning();
  org = organization;
  actorId = `bie-test-user-${nonce}`;
  await db.insert(usersTable).values({
    id: actorId,
    email: `bie-${nonce}@example.test`,
    organizationId: org.id,
    role: "owner",
  });
});

afterAll(async () => {
  // Users are not org-scoped tables, so detach this test user before the
  // generic FK-safe org cleanup discovers and deletes every BIE row.
  await db
    .update(usersTable)
    .set({ organizationId: null })
    .where(eq(usersTable.id, actorId));
  await deleteTestOrgs(org.id);
  await db.delete(usersTable).where(eq(usersTable.id, actorId));
});

describe("BIE Revenue Command", () => {
  it("turns stale tenant-owned pipeline evidence into reviewable, safe actions", async () => {
    const contact = await crm.createContact(org.id, {
      firstName: "Recovery",
      lastName: "Lead",
      email: `recovery-${Date.now()}@example.test`,
    });
    const lead = await crm.createLead(org.id, {
      contactId: contact.id,
      status: "estimate_sent",
      summary: "Storm-damage estimate awaiting homeowner response",
      estimatedValueCents: 185_000,
      creationMethod: "import",
    });
    expect(lead).not.toBeNull();
    await db
      .update(leadsTable)
      .set({
        createdAt: new Date(Date.now() - 9 * 86_400_000),
        updatedAt: new Date(),
        assignedUserId: actorId,
      })
      .where(eq(leadsTable.id, lead!.id));

    const briefing = await buildRevenueRecoveryBriefing(org.id);
    expect(briefing.revenueAtRiskCents).toBe(185_000);
    expect(briefing.opportunities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stalled_estimate",
          leadIds: [lead!.id],
        }),
      ]),
    );
    expect(briefing.sources).toHaveLength(4);
    expect(
      briefing.sources.every((source) => source.status === "not_connected"),
    ).toBe(true);

    const generations = await Promise.all([
      generateBieProposals(org.id, actorId),
      generateBieProposals(org.id, actorId),
    ]);
    const proposals = generations.flat();
    expect(
      proposals.filter((p) => p.actionType === "create_task"),
    ).toHaveLength(1);
    const task = proposals.find(
      (proposal) => proposal.actionType === "create_task",
    );
    expect(task).toBeTruthy();
    expect(task?.status).toBe("proposed");

    const approved = await reviewBieProposal(
      org.id,
      task!.id,
      actorId,
      "approve",
    );
    expect(approved?.status).toBe("approved");
    const executed = await executeBieProposal(org.id, task!.id, actorId);
    expect(executed?.status).toBe("executed");
    expect(executed?.executionDetail).toContain("Created task");
    expect(
      (await crm.listTasks(org.id)).some((item) => item.leadId === lead!.id),
    ).toBe(true);
  });

  it("defaults autopilot off and persists a narrowly-scoped policy", async () => {
    expect(await getAutopilotPolicy(org.id)).toMatchObject({
      enabled: false,
      allowedActions: [],
      dailyEmailCap: 20,
    });
    const policy = await updateAutopilotPolicy(org.id, actorId, {
      enabled: true,
      allowedActions: ["create_task"],
      dailyEmailCap: 3,
    });
    expect(policy).toMatchObject({
      enabled: true,
      allowedActions: ["create_task"],
      dailyEmailCap: 3,
      pausedAt: null,
    });
  });
});
