import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bieActionProposalsTable, crmTasksTable, db, leadsTable, organizationsTable, revenueExecutionsTable, usersTable, type ImportedOpportunityHistory, type OrganizationEntitlements } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import * as crm from "./crm";
import * as durable from "./durable-execution";
import { buildRevenueRecoveryBriefing, executeBieProposal, getAutopilotPolicy, runAutopilot, updateAutopilotPolicy } from "./bie";

const orgs: string[] = [], users: string[] = [];
const policy = (planId: "beta" | "growth"): OrganizationEntitlements => ({ version: 1, planId, source: "manual", grants: [] });
async function fixture(planId: "beta" | "growth" | null) {
  const [org] = await db.insert(organizationsTable).values({ name: "Capability QA", slug: `capability-bie-${randomUUID()}`, entitlements: planId ? policy(planId) : null }).returning();
  orgs.push(org.id);
  const actor = `capability-${randomUUID()}`;
  users.push(actor);
  await db.insert(usersTable).values({ id: actor, organizationId: org.id, role: "owner", email: `${actor}@example.test` });
  const contact = await crm.createContact(org.id, { firstName: "Synthetic", email: `${randomUUID()}@example.test` });
  const lead = await crm.createLead(org.id, { contactId: contact.id, status: "follow_up" });
  const [proposal] = await db.insert(bieActionProposalsTable).values({ organizationId: org.id, leadId: lead!.id, actionType: "create_task", status: "approved", title: "Synthetic action", rationale: "Test only", payload: { title: "Synthetic follow-up" }, createdByUserId: actor, reviewedByUserId: actor }).returning();
  return { org: org.id, actor, lead: lead!, proposal };
}
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const id of users) await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, id));
  await deleteTestOrgs(...orgs);
  for (const id of users) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("autopilot capability at real execution boundaries", () => {
  it("blocks beta enablement, while an active manager can still disable it", async () => {
    const x = await fixture("beta");
    await expect(updateAutopilotPolicy(x.org, x.actor, { enabled: true, allowedActions: ["create_task"] })).rejects.toMatchObject({ code: "capability_unavailable", reason: "not_in_plan" });
    expect((await getAutopilotPolicy(x.org)).enabled).toBe(false);
    expect((await updateAutopilotPolicy(x.org, x.actor, { enabled: false })).enabled).toBe(false);
    await db.update(usersTable).set({ role: "sales_rep" }).where(eq(usersTable.id, x.actor));
    await expect(updateAutopilotPolicy(x.org, x.actor, { enabled: false })).rejects.toMatchObject({ reason: "permission_required" });
  });
  it("holds an approved queue before claiming on downgrade and permits a later authorized upgrade", async () => {
    const x = await fixture("growth");
    await updateAutopilotPolicy(x.org, x.actor, { enabled: true, allowedActions: ["create_task"] });
    await db.update(organizationsTable).set({ entitlements: policy("beta") }).where(eq(organizationsTable.id, x.org));
    expect(await runAutopilot(x.org)).toEqual([]);
    expect((await executeBieProposal(x.org, x.proposal.id, x.actor, { automated: true }))?.status).toBe("approved");
    expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, x.org))).toHaveLength(0);
    await db.update(organizationsTable).set({ entitlements: policy("growth") }).where(eq(organizationsTable.id, x.org));
    expect((await runAutopilot(x.org))[0]?.status).toBe("executed");
    expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, x.org))).toHaveLength(1);
  });
  it("rechecks a revocation after claim and records a blocked receipt without a task", async () => {
    const x = await fixture("growth");
    await updateAutopilotPolicy(x.org, x.actor, { enabled: true, allowedActions: ["create_task"] });
    const real = durable.runDurableAction;
    vi.spyOn(durable, "runDurableAction").mockImplementationOnce(async (input) => real({ ...input, execute: async () => {
      await db.update(organizationsTable).set({ entitlements: policy("beta") }).where(eq(organizationsTable.id, x.org));
      return input.execute();
    } }));
    expect((await executeBieProposal(x.org, x.proposal.id, x.actor, { automated: true }))?.status).toBe("blocked");
    expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, x.org))).toHaveLength(0);
    const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, x.org));
    expect(receipt.state).toBe("blocked");
  });
  it("preserves manually reviewed actions and legacy access without silently granting a managed plan", async () => {
    const beta = await fixture("beta");
    expect((await executeBieProposal(beta.org, beta.proposal.id, beta.actor))?.status).toBe("executed");
    const legacy = await fixture(null);
    await updateAutopilotPolicy(legacy.org, legacy.actor, { enabled: true, allowedActions: ["create_task"] });
    expect((await runAutopilot(legacy.org))[0]?.status).toBe("executed");
    const [saved] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, legacy.org));
    expect(saved.entitlements).toBeNull();
  });
});

describe("recovery briefing uses source evidence", () => {
  it("uses original source dates but never invents age for an undated import", async () => {
    const x = await fixture(null);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const history: ImportedOpportunityHistory = { version: 1, kind: "csv_snapshot", originalCreatedAt: old, sourceUpdatedAt: old, statusChangedAt: old, lastContactAt: null, snapshotAsOf: now, firstImportedAt: now, lastImportedAt: now, externalCustomerId: null, externalEstimateId: null, currency: "USD", fingerprint: "a".repeat(64), appliedFingerprint: "b".repeat(64), mappedFields: [] };
    await db.update(leadsTable).set({ creationMethod: "import", status: "estimate_sent", estimatedValueCents: 250000, importedHistory: history }).where(eq(leadsTable.id, x.lead.id));
    const unknown = await crm.createLead(x.org, { contactId: x.lead.contactId, creationMethod: "import", status: "estimate_sent", estimatedValueCents: 999999, createdAt: new Date(old) });
    const briefing = await buildRevenueRecoveryBriefing(x.org);
    expect(briefing.revenueAtRiskCents).toBe(250000);
    const ids = briefing.opportunities.filter(o => o.kind !== "data_quality").flatMap(o => o.leadIds);
    expect(ids).toContain(x.lead.id);
    expect(ids).not.toContain(unknown!.id);
    await db.update(leadsTable).set({ importedHistory: { ...history, lastContactAt: now } }).where(and(eq(leadsTable.id, x.lead.id), eq(leadsTable.organizationId, x.org)));
    expect((await buildRevenueRecoveryBriefing(x.org)).revenueAtRiskCents).toBe(0);
  });
});
