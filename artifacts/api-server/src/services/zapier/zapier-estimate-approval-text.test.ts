import { randomUUID } from "node:crypto";
import {
  consentRecordsTable,
  contactsTable,
  db,
  estimateApprovalsTable,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  usersTable,
  zapierActionExecutionsTable,
  zapierCapabilityBindingsTable,
  zapierMcpConnectionsTable,
  zapierSpecialistPoliciesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "../../lib/token-encryption";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createEstimate, updateEstimate } from "../crm";
import { createCustomerWorkEstimate } from "../returning-customer";
import { approveEstimate, createEstimateApprovalLink, revokeEstimateApprovalLink } from "../estimate-approvals";
import { getZapierCapability } from "./zapier-capabilities";
import { approveZapierAction } from "./zapier-executions";
import { sha256Hex } from "./zapier-mcp-client";
import {
  buildEstimateApprovalTextInput,
  estiRequestApprovalLinkText,
  OPT_OUT_LINE,
  rebuildZapierRequestInput,
} from "./zapier-specialist-flows";

const fake = vi.hoisted(() => ({ calls: 0, bodies: [] as string[] }));
vi.mock("./zapier-mcp-client", async (original) => ({
  ...(await original<typeof import("./zapier-mcp-client")>()),
  withZapierMcpSession: async (_url: string, fn: (session: unknown) => Promise<unknown>) =>
    fn({
      callTool: async (_name: string, params: Record<string, unknown>) => {
        fake.calls++;
        fake.bodies.push(String(params.body ?? ""));
        return { value: { id: "synthetic" }, digest: "b".repeat(64), isError: false };
      },
    }),
}));

beforeEach(() => {
  fake.calls = 0;
  fake.bodies = [];
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 42).toString("base64"));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
});

const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});
type Execution = Parameters<typeof rebuildZapierRequestInput>[0];

async function connected(org: string, mode: "auto" | "approve") {
  const url = "https://mcp.zapier.com/api/mcp/s/synthetic-estimate-texts/mcp";
  await db.insert(zapierMcpConnectionsTable).values({ organizationId: org, encryptedServerUrl: encryptSecret(url, `${org}:zapier-mcp`), serverUrlFingerprint: sha256Hex(url), serverHost: "mcp.zapier.com", serverMode: "managed" });
  await db.insert(zapierCapabilityBindingsTable).values({ organizationId: org, capability: "esti.sms.approval_link", specialistId: "esti", direction: "write", zapierApp: "OpenPhoneCLIAPI", zapierAppName: "Quo", zapierAction: "send_message", zapierActionName: "Send Message", bindingConfig: { from: "+14045550100" } });
  await db.insert(zapierSpecialistPoliciesTable).values({ organizationId: org, capability: "esti.sms.approval_link", specialistId: "esti", mode, dailyBudget: 20 });
}

async function fixture(options: { smsConsent?: boolean } = {}) {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Estimate Texts", slug: `test-esti-text-${randomUUID()}` }).returning();
  orgs.push(org!.id);
  await db.insert(orgSettingsTable).values({ organizationId: org!.id, sendingHours: { quietHoursEnabled: false } });
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org!.id, firstName: "Dana", phone: "+14045550142" }).returning();
  if (options.smsConsent !== false) {
    await db.insert(consentRecordsTable).values({ organizationId: org!.id, contactId: contact!.id, channel: "sms", granted: true, disclosureVersion: "test" });
  }
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id }).returning();
  const estimate = await createEstimate(org!.id, { leadId: lead!.id, title: "Heat pump install", status: "sent", lineItems: [{ description: "3-ton heat pump", quantity: 1, unitPriceCents: 850000, totalCents: 0 }] }, { userId: owner!.id });
  const link = await createEstimateApprovalLink(org!.id, estimate!.id, owner!.id);
  return { orgId: org!.id, owner: owner!, contact: contact!, lead: lead!, estimate: estimate!, link };
}

describe("ESTI approval-link texts", () => {
  it("is registered as an approve-by-default customer text with Twilio and Quo candidates", () => {
    const definition = getZapierCapability("esti.sms.approval_link")!;
    expect(definition).toMatchObject({ specialistId: "esti", direction: "write", defaultMode: "approve", summaryFields: ["toPhone"] });
    expect(definition.candidates.map((c) => c.app).sort()).toEqual(["OpenPhoneCLIAPI", "TwilioCLIAPI"]);
  });

  it("builds the text with the link and opt-out line, and rebuilds it for approval", async () => {
    const f = await fixture();
    const built = await buildEstimateApprovalTextInput(f.orgId, f.estimate.id);
    expect(built.input.toPhone).toBe("+14045550142");
    expect(built.input.body).toContain(f.link.url);
    expect(built.input.body).toContain("$8,500.00");
    expect(built.input.body.endsWith(OPT_OUT_LINE)).toBe(true);
    expect(built.idempotencyKey).toBe(`esti-approval-text:${f.estimate.id}:${f.link.approval.id}`);
    const execution = { capability: "esti.sms.approval_link", organizationId: f.orgId, idempotencyKey: built.idempotencyKey, linkedEntityId: f.estimate.id } as Execution;
    expect(await rebuildZapierRequestInput(execution)).toEqual(built.input);
  });

  it("refuses without consent, and after the link is revoked, outdated, replaced or decided", async () => {
    const noConsent = await fixture({ smsConsent: false });
    await expect(buildEstimateApprovalTextInput(noConsent.orgId, noConsent.estimate.id)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/not agreed to receive texts/) });

    const f = await fixture();
    const built = await buildEstimateApprovalTextInput(f.orgId, f.estimate.id);
    const execution = { capability: "esti.sms.approval_link", organizationId: f.orgId, idempotencyKey: built.idempotencyKey, linkedEntityId: f.estimate.id } as Execution;
    await revokeEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await expect(rebuildZapierRequestInput(execution)).rejects.toMatchObject({ code: "invalid_input" });
    // A replacement link is a different link: the old request stays refused.
    await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await expect(rebuildZapierRequestInput(execution)).rejects.toMatchObject({ message: expect.stringMatching(/link changed/) });

    await updateEstimate(f.orgId, f.estimate.id, { notes: "Changed after the link" }, { userId: f.owner.id });
    await expect(buildEstimateApprovalTextInput(f.orgId, f.estimate.id)).rejects.toMatchObject({ message: expect.stringMatching(/estimate changed/) });

    const expired = await fixture();
    await db.update(estimateApprovalsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(estimateApprovalsTable.estimateId, expired.estimate.id));
    await expect(buildEstimateApprovalTextInput(expired.orgId, expired.estimate.id)).rejects.toMatchObject({ message: expect.stringMatching(/expired/) });

    const decided = await fixture();
    await approveEstimate(decided.link.url.split("/approve/")[1]!, { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, { ip: null, userAgent: null });
    await expect(buildEstimateApprovalTextInput(decided.orgId, decided.estimate.id)).rejects.toMatchObject({ code: "invalid_input" });

    await expect(buildEstimateApprovalTextInput(noConsent.orgId, f.estimate.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("texts a returning-customer estimate's link to its work root's customer", async () => {
    const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Returning Texts", slug: `test-esti-text-rc-${randomUUID()}` }).returning();
    orgs.push(org!.id);
    await db.insert(orgSettingsTable).values({ organizationId: org!.id, sendingHours: { quietHoursEnabled: false } });
    const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", emailVerifiedAt: new Date(), isActive: true }).returning();
    const [contact] = await db.insert(contactsTable).values({ organizationId: org!.id, firstName: "Robin", phone: "+14045550199" }).returning();
    await db.insert(consentRecordsTable).values({ organizationId: org!.id, contactId: contact!.id, channel: "sms", granted: true, disclosureVersion: "test" });
    const { estimate } = await createCustomerWorkEstimate(org!.id, { userId: owner!.id }, {
      requestId: randomUUID(), confirmed: true, source: { kind: "existing_customer", contactId: contact!.id, propertyId: null },
      title: "Spring service", lineItems: [{ description: "Tune-up", quantity: 1, unitPriceCents: 19900 }], taxCents: 0, notes: null,
    });
    const link = await createEstimateApprovalLink(org!.id, estimate.id, owner!.id);
    const built = await buildEstimateApprovalTextInput(org!.id, estimate.id);
    expect(built.input.toPhone).toBe("+14045550199");
    expect(built.input.body).toContain(link.url);
    expect(built.input.body.startsWith("Hi Robin, ")).toBe(true);
  });

  it("parks for approval by default and sends exactly the re-derived text once approved", async () => {
    const f = await fixture();
    await connected(f.orgId, "approve");
    const pending = await estiRequestApprovalLinkText({ organizationId: f.orgId, estimateId: f.estimate.id, actorUserId: f.owner.id });
    expect(pending.execution.state).toBe("pending_approval");
    expect(fake.calls).toBe(0);
    // The same request is idempotent: it returns the pending receipt instead of a second row.
    expect((await estiRequestApprovalLinkText({ organizationId: f.orgId, estimateId: f.estimate.id, actorUserId: f.owner.id })).execution.id).toBe(pending.execution.id);
    const [row] = await db.select().from(zapierActionExecutionsTable).where(eq(zapierActionExecutionsTable.id, pending.execution.id));
    expect(JSON.stringify(row!.requestSummary)).not.toContain("/approve/");
    const done = await approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    expect(done.state).toBe("succeeded");
    expect(fake.calls).toBe(1);
    expect(fake.bodies[0]).toContain(f.link.url);
    // Replaying the same request returns the original receipt without a second text.
    const replay = await estiRequestApprovalLinkText({ organizationId: f.orgId, estimateId: f.estimate.id, actorUserId: f.owner.id });
    expect(replay.execution.id).toBe(pending.execution.id);
    expect(fake.calls).toBe(1);
  });

  it("never sends a pending text whose link was revoked before approval", async () => {
    const f = await fixture();
    await connected(f.orgId, "approve");
    const pending = await estiRequestApprovalLinkText({ organizationId: f.orgId, estimateId: f.estimate.id, actorUserId: f.owner.id });
    await revokeEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await expect(approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id })).rejects.toBeDefined();
    // A new link cannot be texted while the old request still waits for review.
    await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await expect(estiRequestApprovalLinkText({ organizationId: f.orgId, estimateId: f.estimate.id, actorUserId: f.owner.id })).rejects.toMatchObject({ code: "conflict" });
    expect(fake.calls).toBe(0);
  });
});
