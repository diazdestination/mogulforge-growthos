import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  contactsTable,
  estimatesTable,
  leadsTable,
  usersTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  organizationsTable,
  suppressionsTable,
  emailIntelligenceSourcesTable,
  emailResponseReviewsTable,
  customerLifecycleTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../test-helpers/returning-customer-fixture";
import { createEstimate } from "./crm";
import { createCustomerWorkEstimate } from "./returning-customer";
import {
  readEstimateEmailAuthority,
  assertEstimateEmailEligibility,
} from "./estimate-delivery-authority";
import type { EstimateDeliveryActor } from "./estimate-delivery-contract";
import { readNativeWorkLineage } from "./customer-work-lineage";
const orgs: string[] = [];
const providerCall = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Authority must not call provider/OAuth");
  }),
);
vi.mock("./gmail-oauth", async (original) => ({
  ...(await original<typeof import("./gmail-oauth")>()),
  getGmailConnection: providerCall,
  getGmailStatus: providerCall,
  sendGmailForUser: providerCall,
}));
vi.mock("./microsoft-oauth", async (original) => ({
  ...(await original<typeof import("./microsoft-oauth")>()),
  getMicrosoftConnection: providerCall,
  getMicrosoftStatus: providerCall,
  sendMicrosoftForUser: providerCall,
}));
afterEach(() => {
  expect(providerCall).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await deleteTestOrgs(...orgs);
});
async function fixture(returning = false, property = true) {
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
    encryptedRefreshToken: "synthetic-never-decrypted",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: property ? f.secondProperty.id : null,
      source: "manual",
    })
    .returning();
  const estimate = returning
    ? (
        await createCustomerWorkEstimate(
          f.org,
          f.actor,
          returningEstimateDraft(f, property ? f.secondProperty.id : null),
        )
      ).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead.id,
          title: "Synthetic saved quote",
          lineItems: [
            {
              description: "Complete scope",
              quantity: 1,
              unitPriceCents: 100,
              totalCents: 100,
            },
          ],
          notes: "Original complete notes",
        },
        f.actor,
      ))!;
  return { ...f, lead, estimate };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (f: Fixture, actor: EstimateDeliveryActor = f.actor) =>
  db.transaction((tx) =>
    readEstimateEmailAuthority(tx, f.org, actor, f.estimate.id, true),
  );
it.each([false, true])(
  "reads canonical complete %s source without property",
  async (returning) => {
    const f = await fixture(returning, false);
    const s = await read(f);
    expect(s.contactId).toBe(f.contact.id);
    expect(s.propertyId).toBeNull();
    expect(s.leadId).toBe(returning ? null : f.lead.id);
    expect(s.customerWorkId).toBe(f.estimate.customerWorkId);
    expect(s.document.notes).toBe(f.estimate.notes);
    expect(s.document.businessName).toBe(f.company.name);
    expect(s.sender.source).toBe("company_default");
    await assertEstimateEmailEligibility(db, s);
    const upper = await db.transaction((tx) =>
      readEstimateEmailAuthority(
        tx,
        f.org,
        f.actor,
        f.estimate.id.toUpperCase(),
        true,
      ),
    );
    expect(upper).toEqual(s);
  },
);
it.each(["inactive", "unverified", "viewer", "invited"])(
  "holds %s selected sender",
  async (kind) => {
    const f = await fixture();
    if (kind === "invited") {
      const [invite] = await db
        .insert(usersTable)
        .values({
          id: `invite:${randomUUID()}`,
          organizationId: f.org,
          role: "office",
          emailVerifiedAt: new Date(),
          isActive: true,
        })
        .returning();
      await db
        .update(orgSettingsTable)
        .set({ customerEmailSenderUserId: invite.id })
        .where(eq(orgSettingsTable.organizationId, f.org));
    } else
      await db
        .update(usersTable)
        .set(
          kind === "inactive"
            ? { isActive: false }
            : kind === "unverified"
              ? { emailVerifiedAt: null }
              : { role: "viewer" },
        )
        .where(eq(usersTable.id, f.office.id));
    await expect(read(f)).rejects.toMatchObject({
      code: "estimate_sender_unavailable",
    });
  },
);
it.each(["office", "admin", "owner"] as const)(
  "accepts %s approver",
  async (role) => {
    const f = await fixture();
    await db
      .update(usersTable)
      .set({ role })
      .where(eq(usersTable.id, f.owner.id));
    expect(
      (await read(f, { userId: f.owner.id, effectiveRole: role })).actorUserId,
    ).toBe(f.owner.id);
  },
);
it.each([false, true])(
  "holds lifecycle/outbound and changed address on %s branch",
  async (returning) => {
    const f = await fixture(returning);
    const s = await read(f);
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await expect(assertEstimateEmailEligibility(db, s)).rejects.toMatchObject({
      code: "estimate_email_held",
    });
    vi.unstubAllEnvs();
    await db
      .insert(customerLifecycleTable)
      .values({
        organizationId: f.org,
        state: "paused",
        reason: "Synthetic office hold",
      });
    await expect(assertEstimateEmailEligibility(db, s)).rejects.toMatchObject({
      code: "estimate_email_held",
    });
    await db
      .update(customerLifecycleTable)
      .set({ state: "active" })
      .where(eq(customerLifecycleTable.organizationId, f.org));
    await db
      .update(contactsTable)
      .set({ email: "changed@example.test" })
      .where(eq(contactsTable.id, f.contact.id));
    await expect(assertEstimateEmailEligibility(db, s)).rejects.toMatchObject({
      code: "estimate_email_held",
    });
  },
);
it("retains assigned sender without company mailbox fallback", async () => {
  const f = await fixture();
  await db
    .update(leadsTable)
    .set({ assignedUserId: f.office.id })
    .where(eq(leadsTable.id, f.lead.id));
  expect((await read(f)).sender.source).toBe("lead_assignee");
  await db
    .update(leadsTable)
    .set({ assignedUserId: f.owner.id })
    .where(eq(leadsTable.id, f.lead.id));
  await expect(read(f)).rejects.toBeDefined();
});
it.each(["viewer", "sales_rep", "sales_manager"] as const)(
  "denies current/effective %s despite broad CRM permissions",
  async (role) => {
    const f = await fixture();
    await expect(
      read(f, { ...f.actor, effectiveRole: role }),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .update(usersTable)
      .set({ role })
      .where(eq(usersTable.id, f.owner.id));
    await expect(read(f)).rejects.toMatchObject({ status: 403 });
  },
);
it.each(["inactive", "unverified", "invited"])(
  "denies %s approver",
  async (kind) => {
    const f = await fixture();
    if (kind === "invited")
      await expect(
        read(f, { ...f.actor, userId: "invite:synthetic" }),
      ).rejects.toBeDefined();
    else {
      await db
        .update(usersTable)
        .set(
          kind === "inactive" ? { isActive: false } : { emailVerifiedAt: null },
        )
        .where(eq(usersTable.id, f.owner.id));
      await expect(read(f)).rejects.toMatchObject({ status: 403 });
    }
  },
);
it("requires explicit preference and never seeds missing settings", async () => {
  const f = await fixture();
  await db
    .delete(emailSenderPreferencesTable)
    .where(eq(emailSenderPreferencesTable.userId, f.office.id));
  await expect(read(f)).rejects.toBeDefined();
  await db
    .delete(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, f.org));
  await expect(read(f)).rejects.toBeDefined();
  expect(
    await db
      .select()
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.organizationId, f.org)),
  ).toHaveLength(0);
});
it("fingerprints mailbox replacement but excludes refreshed token bytes", async () => {
  const f = await fixture();
  const before = await read(f);
  await db
    .update(gmailConnectionsTable)
    .set({ encryptedRefreshToken: "synthetic-refreshed" })
    .where(eq(gmailConnectionsTable.userId, f.office.id));
  expect((await read(f)).senderIdentitySha256).toBe(
    before.senderIdentitySha256,
  );
  await db
    .delete(gmailConnectionsTable)
    .where(eq(gmailConnectionsTable.userId, f.office.id));
  await db.insert(gmailConnectionsTable).values({
    organizationId: f.org,
    userId: f.office.id,
    email: "office@example.test",
    encryptedRefreshToken: "synthetic-replaced",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  expect((await read(f)).senderIdentitySha256).not.toBe(
    before.senderIdentitySha256,
  );
});
it("rejects foreign and mixed original roots and mismatched property", async () => {
  const f = await fixture(),
    other = await fixture(true);
  await db
    .update(estimatesTable)
    .set({ leadId: other.lead.id })
    .where(eq(estimatesTable.id, f.estimate.id));
  await expect(read(f)).rejects.toBeDefined();
  await expect(
    readNativeWorkLineage(db, f.org, {
      leadId: f.lead.id,
      customerWorkId: other.estimate.customerWorkId,
    }),
  ).rejects.toBeDefined();
  await db
    .update(estimatesTable)
    .set({ leadId: f.lead.id })
    .where(eq(estimatesTable.id, f.estimate.id));
  await db
    .update(leadsTable)
    .set({ propertyId: other.firstProperty.id })
    .where(eq(leadsTable.id, f.lead.id));
  await expect(read(f)).rejects.toBeDefined();
});
it("fingerprints original business and customer semantic changes", async () => {
  const f = await fixture();
  const before = await read(f);
  await db
    .update(organizationsTable)
    .set({ name: "Changed saved business" })
    .where(eq(organizationsTable.id, f.org));
  expect((await read(f)).sourceSha256).not.toBe(before.sourceSha256);
});
it.each([false, true])(
  "preserves DNC and address suppression on %s branch",
  async (returning) => {
    const f = await fixture(returning);
    const s = await read(f);
    await db
      .update(contactsTable)
      .set({ doNotContact: true })
      .where(eq(contactsTable.id, f.contact.id));
    await expect(assertEstimateEmailEligibility(db, s)).rejects.toBeDefined();
    await db
      .update(contactsTable)
      .set({ doNotContact: false })
      .where(eq(contactsTable.id, f.contact.id));
    await db.insert(suppressionsTable).values({
      organizationId: f.org,
      channel: "email",
      value: f.contact.email!,
      reason: "manual",
    });
    await expect(assertEstimateEmailEligibility(db, s)).rejects.toBeDefined();
  },
);
it("requires the original transaction for locking", async () => {
  const f = await fixture();
  await expect(
    readEstimateEmailAuthority(db, f.org, f.actor, f.estimate.id, true),
  ).rejects.toBeDefined();
});
it.each([false, true])(
  "holds lead/contact replies on %s source without OAuth or transport",
  async (returning) => {
    const f = await fixture(returning);
    const s = await read(f);
    const [source] = await db
      .insert(emailIntelligenceSourcesTable)
      .values({
        organizationId: f.org,
        intakeAlias: `synthetic-${randomUUID()}`,
      })
      .returning();
    await db.insert(emailResponseReviewsTable).values({
      organizationId: f.org,
      sourceId: source.id,
      externalMessageId: randomUUID(),
      payloadSha256: "a".repeat(64),
      reason: "Synthetic customer reply",
      state: "confirmed",
      contactId: f.contact.id,
      leadId: returning ? null : f.lead.id,
      holdActive: true,
    });
    await db.transaction(async (tx) => {
      const current = await readEstimateEmailAuthority(
        tx,
        f.org,
        f.actor,
        f.estimate.id,
        true,
      );
      await expect(
        assertEstimateEmailEligibility(tx, current),
      ).rejects.toMatchObject({ code: "estimate_email_held" });
    });
  },
);
