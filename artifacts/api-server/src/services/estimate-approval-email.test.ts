import { OAuth2Client } from "google-auth-library";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  emailSenderPreferencesTable,
  estimateApprovalsTable,
  estimatesTable,
  gmailConnectionsTable,
  leadsTable,
  orgSettingsTable,
  revenueExecutionEventsTable,
  revenueExecutionsTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { returningCustomerFixture, returningEstimateDraft } from "../test-helpers/returning-customer-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createEstimate, updateEstimate } from "./crm";
import { createCustomerWorkEstimate } from "./returning-customer";
import { getEstimateEmailEvidence, previewEstimateEmail, sendEstimateEmail } from "./estimate-delivery";
import { ESTIMATE_APPROVAL_LINK_PLACEHOLDER } from "./estimate-delivery-contract";
import { createEstimateApprovalLink, revokeEstimateApprovalLink } from "./estimate-approvals";

/**
 * ESTI approval links in estimate emails: the reviewed, digested and retained
 * email holds a fixed placeholder; the bearer link is rendered only for the
 * provider hand-off and is never written to any retained record.
 */

const orgs: string[] = [];
const transporter = Object.getPrototypeOf(new OAuth2Client().transporter);
let wire: string[] = [];

beforeEach(() => {
  wire = [];
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockResolvedValue({ token: "synthetic-access" } as never);
  vi.spyOn(transporter, "request").mockImplementation(async (input: any) => {
    if (input.url !== "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") throw Error("Unexpected Gmail operation");
    wire.push(Buffer.from(input.data.raw, "base64url").toString("utf8"));
    return { data: { id: `synthetic-gmail-${wire.length}` } };
  });
  vi.stubGlobal("fetch", () => {
    throw Error("No live transport");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => deleteTestOrgs(...orgs));

async function fixture(returning = false) {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await db.insert(orgSettingsTable).values({ organizationId: f.org, customerEmailSenderUserId: f.office.id });
  await db.insert(emailSenderPreferencesTable).values({ organizationId: f.org, userId: f.office.id, provider: "gmail" });
  await db.insert(gmailConnectionsTable).values({
    organizationId: f.org,
    userId: f.office.id,
    email: "office@example.test",
    encryptedRefreshToken: encryptSecret("synthetic-refresh", `${f.org}:${f.office.id}:gmail`),
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  const [lead] = await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contact.id, propertyId: f.secondProperty.id, source: "manual" }).returning();
  const draft = returningEstimateDraft(f);
  const estimate = returning
    ? (await createCustomerWorkEstimate(f.org, f.actor, draft)).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead!.id,
          title: draft.title,
          lineItems: draft.lineItems.map((x) => ({ ...x, totalCents: Math.round(x.quantity * x.unitPriceCents) })),
          taxCents: draft.taxCents,
          notes: draft.notes,
        },
        f.actor,
      ))!;
  return { ...f, estimate };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function preview(f: Fixture) {
  const [current] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, f.estimate.id));
  return previewEstimateEmail(f.org, f.actor, f.estimate.id, {
    expectedUpdatedAt: current!.updatedAt.toISOString(),
    expectedWorkVersion: current!.workVersion,
  });
}
const send = (f: Fixture, p: Awaited<ReturnType<typeof preview>>) =>
  sendEstimateEmail(f.org, f.actor, f.estimate.id, { previewId: p.previewId, payloadSha256: p.payloadSha256, confirmed: true });
const sentBody = () => wire[0]!.split("\r\n\r\n").slice(1).join("\r\n\r\n");
const sentUrl = () => sentBody().match(/https:\/\/growth\.example\/approve\/[A-Za-z0-9_-]{43}$/)?.[0] ?? null;

async function retainedText(org: string) {
  const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, org));
  const executions = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, org));
  const events = executions.length
    ? await db.select().from(revenueExecutionEventsTable).where(inArray(revenueExecutionEventsTable.executionId, executions.map((e) => e.id)))
    : [];
  const approvals = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.organizationId, org));
  return JSON.stringify({ audits, executions, events, approvals });
}

it.each([false, true])("emails the approval link while the retained record never contains the token returning=%s", async (returning) => {
  const f = await fixture(returning);
  const p = await preview(f);
  expect(p.message.body.endsWith(`\n${ESTIMATE_APPROVAL_LINK_PLACEHOLDER}`)).toBe(true);
  expect(JSON.stringify(p)).not.toContain("/approve/");

  const evidence = await send(f, p);
  expect(evidence.state).toBe("accepted");
  expect(wire).toHaveLength(1);
  const url = sentUrl();
  expect(url).not.toBeNull();
  expect(sentBody()).toBe(p.message.body.replace(ESTIMATE_APPROVAL_LINK_PLACEHOLDER, url!));
  const token = url!.split("/approve/")[1]!;

  // Evidence shows the reviewed placeholder, and no retained row holds the bearer link.
  expect(evidence.message).toEqual(p.message);
  const retained = await retainedText(f.org);
  expect(retained).not.toContain(token);
  expect(retained).not.toContain("/approve/");
  expect(JSON.stringify(await getEstimateEmailEvidence(f.org, f.estimate.id))).not.toContain(token);

  // The link the customer received is the estimate's one open approval link.
  const [approval] = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, f.estimate.id));
  expect(approval).toMatchObject({ revokedAt: null, decision: null, createdByUserId: f.actor.userId });
});

it("reuses the estimate's open link, and replaces one made outdated before review", async () => {
  const f = await fixture();
  const staffLink = await createEstimateApprovalLink(f.org, f.estimate.id, f.actor.userId);
  await send(f, await preview(f));
  expect(sentUrl()).toBe(staffLink.url);

  const g = await fixture();
  const stale = await createEstimateApprovalLink(g.org, g.estimate.id, g.actor.userId);
  await updateEstimate(g.org, g.estimate.id, { notes: "Updated scope after the first link" }, g.actor);
  wire = [];
  await send(g, await preview(g));
  expect(sentUrl()).not.toBeNull();
  expect(sentUrl()).not.toBe(stale.url);
  const rows = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, g.estimate.id));
  expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
});

it("sends the reviewed estimate without the approval block when no valid link can be made at send time", async () => {
  const f = await fixture();
  const p = await preview(f);
  // A link problem at the hand-off (here: no signing key) must not strand the claimed email.
  vi.stubEnv("SESSION_SECRET", "");
  const evidence = await send(f, p);
  expect(evidence.state).toBe("accepted");
  expect(sentBody()).not.toContain("approve");
  expect(sentBody()).not.toContain(ESTIMATE_APPROVAL_LINK_PLACEHOLDER);
  expect(p.message.body.startsWith(sentBody())).toBe(true);
  expect(await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, f.estimate.id))).toHaveLength(0);
});

it("uses a fresh link after staff revoke the old one, since the reviewed email promises a link", async () => {
  const f = await fixture();
  const revoked = await createEstimateApprovalLink(f.org, f.estimate.id, f.actor.userId);
  await revokeEstimateApprovalLink(f.org, f.estimate.id, f.actor.userId);
  await send(f, await preview(f));
  expect(sentUrl()).not.toBe(revoked.url);
  const created = await db.select().from(auditEventsTable).where(eq(auditEventsTable.entityId, f.estimate.id));
  expect(created.filter((a) => a.action === "estimate.approval_link_created").map((a) => (a.metadata as { source?: string }).source)).toEqual(
    expect.arrayContaining(["staff", "estimate_email"]),
  );
});
