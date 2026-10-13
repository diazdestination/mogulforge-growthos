import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  estimatesTable,
  contactsTable,
  leadsTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
} from "@workspace/db";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../test-helpers/returning-customer-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createEstimate } from "./crm";
import { createCustomerWorkEstimate } from "./returning-customer";
import {
  previewEstimateEmail,
  getEstimateEmailEvidence,
} from "./estimate-delivery";
import {
  claimEstimateEmail,
  finalizeEstimateEmail,
} from "./estimate-delivery-execution";

const orgs: string[] = [];
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
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
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: f.org, customerEmailSenderUserId: f.office.id });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: f.org, userId: f.office.id, provider: "gmail" });
  await db.insert(gmailConnectionsTable).values({
    organizationId: f.org,
    userId: f.office.id,
    email: "office@example.test",
    encryptedRefreshToken: "synthetic-not-decrypted",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: f.secondProperty.id,
      source: "manual",
    })
    .returning();
  const draft = returningEstimateDraft(f);
  const estimate = returning
    ? (await createCustomerWorkEstimate(f.org, f.actor, draft)).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead.id,
          title: draft.title,
          lineItems: draft.lineItems.map((x) => ({ ...x, totalCents: 10000 })),
          notes: draft.notes,
        },
        f.actor,
      ))!;
  return { ...f, estimate };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) =>
  previewEstimateEmail(f.org, f.actor, f.estimate.id, {
    expectedUpdatedAt: new Date(f.estimate.updatedAt).toISOString(),
    expectedWorkVersion: f.estimate.workVersion,
  });
const sendBody = (p: Awaited<ReturnType<typeof preview>>) => ({
  previewId: p.previewId,
  payloadSha256: p.payloadSha256,
  confirmed: true as const,
});
const audits = (f: Fixture, action: string) =>
  db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityId, f.estimate.id),
        eq(auditEventsTable.action, action),
      ),
    );
it.each([false, true])(
  "retains one exact actor-bound review without saved-history mutation returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      before = await audits(f, "estimate.saved_state"),
      p = await preview(f),
      [review] = await audits(f, "estimate_delivery.previewed");
    expect(Date.parse(p.expiresAt) - review.createdAt.getTime()).toBe(600000);
    expect(review).toMatchObject({
      organizationId: f.org,
      actorUserId: f.actor.userId,
      entityType: "estimate",
      entityId: f.estimate.id,
    });
    expect(await audits(f, "estimate.saved_state")).toHaveLength(before.length);
    expect(Object.keys(p.sender).sort()).toEqual([
      "provider",
      "senderEmail",
      "source",
    ]);
    expect(
      (await getEstimateEmailEvidence(f.org, f.estimate.id)).canPrepare,
    ).toBe(true);
  },
);
it("rejects stale versions and additional request fields", async () => {
  const f = await fixture(true);
  for (const raw of [
    { expectedUpdatedAt: new Date(0).toISOString(), expectedWorkVersion: 1 },
    {
      expectedUpdatedAt: new Date(f.estimate.updatedAt).toISOString(),
      expectedWorkVersion: 2,
    },
    {
      expectedUpdatedAt: new Date(f.estimate.updatedAt).toISOString(),
      expectedWorkVersion: 1,
      recipient: "bad@example.test",
    },
  ]) {
    await expect(
      previewEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).rejects.toBeDefined();
  }
  expect(await audits(f, "estimate_delivery.previewed")).toHaveLength(0);
});
it("does not fabricate provider acceptance from an operator success attestation", async () => {
  const f = await fixture(),
    c = await claimEstimateEmail(
      f.org,
      f.actor,
      f.estimate.id,
      sendBody(await preview(f)),
    );
  await db
    .update(revenueExecutionsTable)
    .set({ state: "confirmed_succeeded", detail: "secret operator text" })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  await db.insert(revenueExecutionEventsTable).values({
    organizationId: f.org,
    executionId: c.executionId,
    state: "confirmed_succeeded",
    actorUserId: f.actor.userId,
    detail: "secret operator text",
  });
  const e = await getEstimateEmailEvidence(f.org, f.estimate.id);
  expect(e).toMatchObject({
    state: "reconciled",
    canPrepare: false,
    acceptedAt: null,
    providerMessageId: null,
  });
  expect(JSON.stringify(e).includes("secret operator text")).toBe(false);
});
it("projects original retained participants and keeps reconciliation alongside late proof", async () => {
  const f = await fixture(),
    c = await claimEstimateEmail(
      f.org,
      f.actor,
      f.estimate.id,
      sendBody(await preview(f)),
    );
  await finalizeEstimateEmail(c, {
    state: "uncertain",
    reason: "private failure",
  });
  await db
    .update(revenueExecutionsTable)
    .set({ state: "confirmed_not_performed" })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  await db.insert(revenueExecutionEventsTable).values({
    organizationId: f.org,
    executionId: c.executionId,
    state: "confirmed_not_performed",
    actorUserId: f.actor.userId,
    detail: "Reconciled",
  });
  await db
    .update(estimatesTable)
    .set({ title: "Changed current document" })
    .where(eq(estimatesTable.id, f.estimate.id));
  await db
    .update(contactsTable)
    .set({
      firstName: "Changed mutable customer",
      email: "retargeted@example.test",
    })
    .where(eq(contactsTable.id, f.contact.id));
  await finalizeEstimateEmail(c, {
    state: "accepted",
    receipt: {
      id: "synthetic-id",
      provider: "gmail",
      senderEmail: "office@example.test",
      acceptance: "accepted",
    },
    acceptedAt: new Date(),
  });
  const e = await getEstimateEmailEvidence(f.org, f.estimate.id);
  expect(e).toMatchObject({
    state: "reconciled",
    canPrepare: false,
    providerMessageId: "synthetic-id",
    document: c.snapshot.document,
    message: c.snapshot.message,
    deliveryConfirmed: false,
  });
  expect(JSON.stringify(e).includes(c.payloadSha256)).toBe(false);
  expect(JSON.stringify(e).includes(c.snapshot.sender.userId)).toBe(false);
});
it.each([
  "admission actor",
  "review entity",
  "proof actor",
  "event tenant",
  "execution fingerprint",
  "proof receipt",
])("fails closed on damaged retained %s", async (kind) => {
  const f = await fixture(),
    c = await claimEstimateEmail(
      f.org,
      f.actor,
      f.estimate.id,
      sendBody(await preview(f)),
    );
  await finalizeEstimateEmail(c, {
    state: "accepted",
    receipt: {
      id: "synthetic",
      provider: "gmail",
      senderEmail: "office@example.test",
      acceptance: "accepted",
    },
    acceptedAt: new Date(),
  });
  if (kind === "admission actor")
    await db
      .update(auditEventsTable)
      .set({ actorUserId: f.viewer.id })
      .where(
        and(
          eq(auditEventsTable.entityId, f.estimate.id),
          eq(auditEventsTable.action, "estimate_delivery.admitted"),
        ),
      );
  if (kind === "review entity")
    await db
      .update(auditEventsTable)
      .set({ entityType: "invoice" })
      .where(
        eq(
          auditEventsTable.id,
          (await audits(f, "estimate_delivery.previewed"))[0].id,
        ),
      );
  if (kind === "proof actor")
    await db
      .update(auditEventsTable)
      .set({ actorUserId: f.viewer.id })
      .where(
        and(
          eq(auditEventsTable.entityId, f.estimate.id),
          eq(auditEventsTable.action, "estimate_delivery.provider_accepted"),
        ),
      );
  if (kind === "event tenant") {
    const foreign = await returningCustomerFixture();
    orgs.push(foreign.org);
    await db
      .update(revenueExecutionEventsTable)
      .set({ organizationId: foreign.org })
      .where(eq(revenueExecutionEventsTable.executionId, c.executionId));
  }
  if (kind === "execution fingerprint")
    await db
      .update(revenueExecutionsTable)
      .set({ fingerprint: "a".repeat(64) })
      .where(eq(revenueExecutionsTable.id, c.executionId));
  if (kind === "proof receipt") {
    const [proof] = await audits(f, "estimate_delivery.provider_accepted");
    await db
      .update(auditEventsTable)
      .set({
        metadata: {
          ...(proof.metadata as object),
          receipt: {
            id: "synthetic",
            provider: "gmail",
            senderEmail: "other@example.test",
            acceptance: "accepted",
          },
        },
      })
      .where(eq(auditEventsTable.id, proof.id));
  }
  expect(await getEstimateEmailEvidence(f.org, f.estimate.id)).toMatchObject({
    integrity: "unavailable",
    canPrepare: false,
    acceptedAt: null,
  });
});
it("manual sent marker and orphan retained admission never permit prepare or fabricate receipt", async () => {
  const f = await fixture();
  await db
    .update(estimatesTable)
    .set({ sentAt: new Date() })
    .where(eq(estimatesTable.id, f.estimate.id));
  expect(await getEstimateEmailEvidence(f.org, f.estimate.id)).toMatchObject({
    canPrepare: false,
    acceptedAt: null,
    providerMessageId: null,
  });
  const g = await fixture();
  await db.insert(auditEventsTable).values({
    organizationId: g.org,
    entityType: "estimate",
    entityId: g.estimate.id,
    action: "estimate_delivery.admitted",
    metadata: {},
  });
  expect(await getEstimateEmailEvidence(g.org, g.estimate.id)).toMatchObject({
    integrity: "unavailable",
    canPrepare: false,
  });
});
it("expired processing read remains read-only and permanently owned", async () => {
  const f = await fixture(),
    c = await claimEstimateEmail(
      f.org,
      f.actor,
      f.estimate.id,
      sendBody(await preview(f)),
    );
  await db
    .update(revenueExecutionsTable)
    .set({ expiresAt: new Date(0) })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  expect(await getEstimateEmailEvidence(f.org, f.estimate.id)).toMatchObject({
    state: "uncertain",
    canPrepare: false,
  });
  const [r] = await db
    .select()
    .from(revenueExecutionsTable)
    .where(eq(revenueExecutionsTable.id, c.executionId));
  expect(r.state).toBe("processing");
});
it("an orphan permanent execution blocks a fresh preview", async () => {
  const f = await fixture();
  await db.insert(revenueExecutionsTable).values({
    organizationId: f.org,
    actionKey: `estimate-delivery:${f.estimate.id}:email`,
    fingerprint: "a".repeat(64),
    kind: "estimate_email",
    actorUserId: f.actor.userId,
    state: "blocked",
    detail: "Synthetic orphan",
    expiresAt: new Date(0),
  });
  let refused = false;
  try {
    await preview(f);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
  expect(await audits(f, "estimate_delivery.previewed")).toHaveLength(0);
});
