import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activitiesTable, auditEventsTable, consentRecordsTable, contactsTable, customerLifecycleTable, db, emailIntelligenceMessagesTable, emailIntelligenceSourcesTable, emailResponseReviewsTable, leadsTable, organizationsTable, revenueExecutionsTable, usersTable } from "@workspace/db";
import { sourceAdoptionsTable as adoptions, sourceOutreachBatchesTable as batches, sourceOutreachItemsTable as items } from "../../../../lib/db/src/schema/source-adoption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { approveSourceAdoption, approveSourceOutreach, getSourceAdoption, getSourceOutreach, listSourceAdoptions, previewSourceAdoption, previewSourceOutreach, recordSourceEmailPermission, revokeSourceAdoption, revokeSourceOutreach, sendSourceOutreach } from "./source-adoption";
import { sourceOutreachKey } from "./source-adoption-contract";
import { resolveCustomerEmailSender, sendCustomerEmail } from "./customer-email";
import { addSuppression, checkSendEligibility } from "./send-gate";
import { reconcileExecution } from "./durable-execution";
import { registerEmailResponse } from "./response-correlation";

vi.mock("./customer-email", () => ({ resolveCustomerEmailSender: vi.fn(), sendCustomerEmail: vi.fn() }));
const orgs: string[] = [], effects: string[] = [];
const senders = new Map<string, Awaited<ReturnType<typeof resolveCustomerEmailSender>>>();
let lateChange: (() => Promise<void>) | null = null, lostReceipt = false;
const now = new Date("2026-10-02T16:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"); vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubGlobal("fetch", async () => { throw new Error("External calls forbidden in source adoption tests"); });
  vi.mocked(resolveCustomerEmailSender).mockImplementation(async ({ organizationId }) => {
    const sender = senders.get(organizationId); if (!sender) throw new Error("Synthetic sender unavailable"); return { ...sender };
  });
  vi.mocked(sendCustomerEmail).mockImplementation(async input => {
    await lateChange?.(); await input.beforeDispatch?.(); expect(input.expectedSender).toEqual(senders.get(input.organizationId));
    effects.push(input.organizationId); if (lostReceipt) throw new Error("Synthetic lost provider acknowledgement");
    const sender = senders.get(input.organizationId)!;
    return { id: sender.provider === "gmail" ? "synthetic-accepted" : null, provider: sender.provider, senderEmail: sender.senderEmail,
      senderUserId: sender.userId, acceptance: "accepted", ...(sender.provider === "microsoft" ? { providerRequestId: "synthetic-ms-request", clientRequestId: "synthetic-ms-client" } : {}) };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); effects.length = 0; lateChange = null; lostReceipt = false; });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture() {
  const [company] = await db.insert(organizationsTable).values({ name: "Synthetic adoption contractor", slug: `source-test-${randomUUID()}` }).returning(); orgs.push(company.id);
  const [actor] = await db.insert(usersTable).values({ organizationId: company.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: company.id, firstName: "Synthetic", email: "customer@example.invalid" }).returning();
  const history = { version: 1 as const, kind: "csv_snapshot" as const, originalCreatedAt: "2025-01-01T12:00:00.000Z", sourceUpdatedAt: "2026-10-01T12:00:00.000Z",
    statusChangedAt: null, lastContactAt: null, snapshotAsOf: "2026-10-01T12:00:00.000Z", firstImportedAt: now.toISOString(), lastImportedAt: now.toISOString(),
    externalCustomerId: "customer-1", externalEstimateId: "estimate-1", currency: "USD" as const, fingerprint: "a".repeat(64), appliedFingerprint: "b".repeat(64), mappedFields: ["firstName", "email", "externalOpportunityId"] };
  const [lead] = await db.insert(leadsTable).values({ organizationId: company.id, contactId: contact.id, assignedUserId: actor.id,
    status: "follow_up", creationMethod: "import", importSourceKey: "hcp-account-one", externalOpportunityId: "opportunity-1", importedHistory: history, createdAt: new Date(now.getTime() - 86_400_000) }).returning();
  senders.set(company.id, { userId: actor.id, source: "lead_assignee", provider: "gmail", senderEmail: "office@example.invalid" });
  return { org: company.id, company: company.name, actor: actor.id, contact: contact.id, lead: lead.id, history };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const reviewInput = (version = 0) => ({ expectedVersion: version, sourceAsOf: "2026-10-02T12:00:00.000Z", cutoverAt: "2026-10-02T12:30:00.000Z",
  expiresAt: "2026-10-03T16:00:00.000Z", evidence: "Synthetic approved export reconciled; old workflow stopped.", sourceWriterStopped: true, currentStatusVerified: true, noUnreviewedReplies: true });
async function adopt(f: Fixture) {
  const current = await getSourceAdoption(f.org, f.lead), preview = await previewSourceAdoption(f.org, f.actor, f.lead, reviewInput(current.adoption?.version ?? 0));
  return approveSourceAdoption(f.org, f.actor, f.lead, { previewId: preview.previewId, payloadSha256: preview.payloadSha256, confirmed: true });
}
async function permission(f: Fixture, granted = true) {
  const current = await getSourceAdoption(f.org, f.lead);
  return recordSourceEmailPermission(f.org, f.actor, f.lead, { expectedSourceSha256: current.sourceSha256, expectedRecipient: current.recipient,
    expectedConsentId: current.consentId, granted, observedAt: now.toISOString(), evidence: "Synthetic signed marketing permission for this address.", marketingPermissionConfirmed: true });
}
const draftInput = (f: Fixture) => ({ leadIds: [f.lead], businessName: f.company, mailingAddress: "123 Synthetic Lane, Test City, GA 30000", subject: "Following up on your estimate",
  body: "Would you like our office to review your outstanding estimate?", timezone: "America/New_York", days: ["Fri"], startHour: 9, endHour: 18, dailyLimit: 10, expiresAt: "2026-10-02T22:00:00.000Z" });
const approval = (p: { version: number; payloadSha256: string }) => ({ expectedVersion: p.version, payloadSha256: p.payloadSha256, confirmed: true });
async function ready(f: Fixture) {
  await adopt(f); await permission(f);
  const preview = await previewSourceOutreach(f.org, f.actor, draftInput(f));
  return approveSourceOutreach(f.org, f.actor, preview.id, approval(preview));
}
async function contactOnlyReply(f: Fixture) {
  const [source] = await db.insert(emailIntelligenceSourcesTable).values({ organizationId: f.org, intakeAlias: randomUUID() }).returning();
  await db.insert(emailResponseReviewsTable).values({ organizationId: f.org, sourceId: source.id, externalMessageId: randomUUID(), payloadSha256: "c".repeat(64),
    contactId: f.contact, leadId: null, reason: "review_required", holdActive: true });
}
describe("native-source decisions do not rewrite history or grant permission", () => {
  it("requires stable source identity and exact actor-bound version review; adoption sends nothing", async () => {
    const f = await fixture(), p = await previewSourceAdoption(f.org, f.actor, f.lead, reviewInput());
    await expect(approveSourceAdoption(f.org, f.actor, f.lead, { previewId: p.previewId, payloadSha256: "f".repeat(64), confirmed: true })).rejects.toMatchObject({ code: "source_review_changed" });
    await approveSourceAdoption(f.org, f.actor, f.lead, { previewId: p.previewId, payloadSha256: p.payloadSha256, confirmed: true });
    await expect(approveSourceAdoption(f.org, f.actor, f.lead, { previewId: p.previewId, payloadSha256: p.payloadSha256, confirmed: true })).rejects.toMatchObject({ code: "source_review_changed" });
    const current = await getSourceAdoption(f.org, f.lead); expect(current.current).toBe(true); expect(current.marketingPermission).toBe(false); expect(current.importedHistory).toEqual(f.history);
    expect(vi.mocked(sendCustomerEmail)).not.toHaveBeenCalled();
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, f.lead)); expect(lead.creationMethod).toBe("import");
    await db.update(leadsTable).set({ externalOpportunityId: null }).where(eq(leadsTable.id, f.lead));
    await expect(previewSourceAdoption(f.org, f.actor, f.lead, reviewInput(1))).rejects.toMatchObject({ code: "source_identity_incomplete" });
  });
  it("rejects missing marketing permission and generic email consent; independent exact evidence enables only this lane", async () => {
    const f = await fixture(); await adopt(f);
    await expect(previewSourceOutreach(f.org, f.actor, draftInput(f))).rejects.toMatchObject({ code: "email_marketing_permission_required" });
    await db.insert(consentRecordsTable).values({ organizationId: f.org, contactId: f.contact, channel: "email", granted: true, disclosureVersion: "generic-email" });
    await expect(previewSourceOutreach(f.org, f.actor, draftInput(f))).rejects.toMatchObject({ code: "email_marketing_permission_required" });
    await permission(f); const draft = await previewSourceOutreach(f.org, f.actor, draftInput(f)); expect(draft.state).toBe("draft");
    const [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, f.contact));
    expect(await checkSendEligibility({ organizationId: f.org, leadId: f.lead, contact, channel: "email", kind: "outreach" })).toMatchObject({ ok: false, reason: "imported_source_requires_current_review" });
    expect(await checkSendEligibility({ organizationId: f.org, leadId: f.lead, contact, channel: "email", kind: "outreach", sourceOutreachItemId: draft.items[0].id })).toMatchObject({ ok: false });
  });
  it("rejects foreign lead/actor, office role and unaccepted or disabled owner", async () => {
    const f = await fixture(), other = await fixture();
    await expect(previewSourceAdoption(other.org, other.actor, f.lead, reviewInput())).rejects.toMatchObject({ status: 404 });
    await expect(previewSourceAdoption(f.org, other.actor, f.lead, reviewInput())).rejects.toMatchObject({ status: 403 });
    const [invite] = await db.insert(usersTable).values({ id: `invite:${randomUUID()}`, organizationId: f.org, role: "owner", isActive: true, emailVerifiedAt: now }).returning();
    await expect(previewSourceAdoption(f.org, invite.id, f.lead, reviewInput())).rejects.toMatchObject({ status: 403 });
    for (const fields of [{ role: "office" as const }, { role: "owner" as const, emailVerifiedAt: null }, { emailVerifiedAt: now, isActive: false }]) {
      await db.update(usersTable).set(fields).where(eq(usersTable.id, f.actor));
      await expect(previewSourceAdoption(f.org, f.actor, f.lead, reviewInput())).rejects.toMatchObject({ status: 403 });
    }
  });
  it("invalidates changed source, operations and expiry, but identical snapshots do not change adoption", async () => {
    const f = await fixture(); await adopt(f); const original = await getSourceAdoption(f.org, f.lead);
    await db.update(leadsTable).set({ importedHistory: f.history }).where(eq(leadsTable.id, f.lead));
    const same = await getSourceAdoption(f.org, f.lead); expect(same.current).toBe(true); expect(same.adoption).toEqual(original.adoption);
    await db.update(leadsTable).set({ importedHistory: { ...f.history, fingerprint: "d".repeat(64) } }).where(eq(leadsTable.id, f.lead));
    expect((await getSourceAdoption(f.org, f.lead)).current).toBe(false);
    await adopt(f); await db.update(leadsTable).set({ status: "lost" }).where(eq(leadsTable.id, f.lead)); expect((await getSourceAdoption(f.org, f.lead)).current).toBe(false);
    await adopt(f); vi.setSystemTime(new Date("2026-10-04T12:00:00Z")); expect((await getSourceAdoption(f.org, f.lead)).current).toBe(false);
  });
  it("paginates all imported opportunities and retained campaign evidence without hiding truncation", async () => {
    const f = await fixture();
    await db.insert(leadsTable).values(Array.from({ length: 100 }, (_, i) => ({ organizationId: f.org, contactId: f.contact, creationMethod: "import",
      importSourceKey: "synthetic-many", externalOpportunityId: `source-${i}`, importedHistory: f.history })));
    const page = await listSourceAdoptions(f.org); expect(page.candidates).toHaveLength(100); expect(page.hasMore).toBe(true);
    const next = await listSourceAdoptions(f.org, 1); expect(next.candidates).toHaveLength(1); expect(next.hasMore).toBe(false);
    expect(new Set([...page.candidates, ...next.candidates].map(row => row.id)).size).toBe(101);
    const settings = { businessName: f.company, mailingAddress: "1 Synthetic Lane", subject: "Synthetic preview", body: "Synthetic body only", timezone: "America/New_York", days: ["Fri"], startHour: 9, endHour: 18, dailyLimit: 10 };
    await db.insert(batches).values(Array.from({ length: 26 }, () => ({ organizationId: f.org, settings, payloadSha256: "c".repeat(64), createdByUserId: f.actor, previewExpiresAt: now, expiresAt: now })));
    const firstCampaigns = await listSourceAdoptions(f.org), older = await listSourceAdoptions(f.org, 0, 1);
    expect(firstCampaigns.campaigns).toHaveLength(25); expect(firstCampaigns.hasMoreCampaigns).toBe(true); expect(older.campaigns).toHaveLength(1); expect(older.hasMoreCampaigns).toBe(false);
  });
});
describe("frozen bounded one-touch email", () => {
  it.each(["gmail", "microsoft"] as const)("runs preview -> adoption -> independent permission -> exact approval -> %s receipt with no history rewrite", async provider => {
    const f = await fixture(); senders.get(f.org)!.provider = provider;
    const batch = await ready(f); expect(effects).toHaveLength(0); expect(batch.items[0].snapshot.body).toContain("123 Synthetic Lane");
    expect(batch.items[0].snapshot.body).toContain("/api/v1/public/unsubscribe/");
    const sent = await sendSourceOutreach(f.org, f.actor, batch.id, approval(batch)); expect(sent.items[0].delivery.state).toBe("accepted"); expect(sent.items[0].delivery.deliveryConfirmed).toBe(false);
    expect(effects).toEqual([f.org]); expect((await getSourceAdoption(f.org, f.lead)).importedHistory).toEqual(f.history);
    await sendSourceOutreach(f.org, f.actor, batch.id, approval(batch)); expect(effects).toHaveLength(1);
    const activities = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, f.org), eq(activitiesTable.type, "email_sent")));
    expect(activities).toHaveLength(1); expect(activities[0].metadata).toMatchObject({ acceptance: "accepted", deliveryConfirmed: false });
  });
  it("approval is exact, expires and never dispatches automatically", async () => {
    const f = await fixture(); await adopt(f); await permission(f);
    const p = await previewSourceOutreach(f.org, f.actor, draftInput(f));
    await expect(approveSourceOutreach(f.org, f.actor, p.id, { ...approval(p), payloadSha256: "c".repeat(64) })).rejects.toMatchObject({ code: "source_review_changed" });
    vi.setSystemTime(new Date(now.getTime() + 11 * 60_000));
    await expect(approveSourceOutreach(f.org, f.actor, p.id, approval(p))).rejects.toMatchObject({ code: "source_review_changed" });
    expect(effects).toHaveLength(0);
  });
  it("links the actual reviewed-send receipt to exactly one verified incoming parent and holds the contact", async () => {
    const f = await fixture(), batch = await ready(f); await sendSourceOutreach(f.org, f.actor, batch.id, approval(batch));
    const [source] = await db.insert(emailIntelligenceSourcesTable).values({ organizationId: f.org, intakeAlias: randomUUID() }).returning();
    const external = randomUUID();
    const [message] = await db.insert(emailIntelligenceMessagesTable).values({ organizationId: f.org, sourceId: source.id, externalMessageId: external,
      contentSha256: "d".repeat(64), forwardedBy: "office@example.invalid", fromEmail: "customer@example.invalid", toEmails: ["office@example.invalid"],
      redactedSubject: "Synthetic reply", rawExpiresAt: new Date(now.getTime() + 86_400_000) }).returning();
    const reply = await db.transaction(tx => registerEmailResponse(tx, { organizationId: f.org, sourceId: source.id, messageId: message.id, externalMessageId: external,
      payloadSha256: "d".repeat(64), from: "customer@example.invalid", to: ["office@example.invalid"], sentAt: now,
      replyTo: { provider: "gmail", outboundMessageId: "synthetic-accepted", senderEmail: "office@example.invalid" } }));
    expect(reply).toMatchObject({ state: "confirmed", reason: "verified_parent", leadId: f.lead, contactId: f.contact, holdActive: true });
  });
  it.each(["adoption", "campaign", "permission", "suppression", "reply", "sender", "identity", "company_hold", "global_hold", "expiry", "staff"])("stops late %s changes at the provider boundary after preparation", async kind => {
    const f = await fixture(), batch = await ready(f);
    lateChange = async () => {
      if (kind === "adoption") await revokeSourceAdoption(f.org, f.actor, f.lead, { expectedVersion: 1, reason: "Synthetic late cutover revocation by owner." });
      if (kind === "campaign") await revokeSourceOutreach(f.org, f.actor, batch.id, { expectedVersion: batch.version, reason: "Synthetic late campaign revocation by owner." });
      if (kind === "permission") await permission(f, false);
      if (kind === "suppression") await addSuppression({ organizationId: f.org, channel: "email", value: "customer@example.invalid", reason: "unsubscribed" });
      if (kind === "reply") await contactOnlyReply(f);
      if (kind === "sender") senders.get(f.org)!.senderEmail = "changed@example.invalid";
      if (kind === "identity") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact));
      if (kind === "company_hold") await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic hold" });
      if (kind === "global_hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      if (kind === "expiry") vi.setSystemTime(new Date("2026-10-03T02:00:00Z"));
      if (kind === "staff") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.actor));
    };
    const sent = await sendSourceOutreach(f.org, f.actor, batch.id, approval(batch));
    expect(sent.items[0].delivery.state).toBe("held"); expect(effects).toHaveLength(0); expect(sent.items[0].claimedAt).not.toBeNull();
  });
  it("refuses a contact-only unresolved reply and suppressed recipients before a campaign exists", async () => {
    const f = await fixture(); await adopt(f); await permission(f); await contactOnlyReply(f);
    await expect(previewSourceOutreach(f.org, f.actor, draftInput(f))).rejects.toMatchObject({ code: "source_reply_review_required" });
    expect(vi.mocked(sendCustomerEmail)).not.toHaveBeenCalled();
  });
  it("never releases unknown, expired, reconciled or pre-provider reservations to another campaign", async () => {
    const f = await fixture(), first = await ready(f);
    const alternative = await previewSourceOutreach(f.org, f.actor, draftInput(f));
    const other = await approveSourceOutreach(f.org, f.actor, alternative.id, approval(alternative));
    lostReceipt = true; const unknown = await sendSourceOutreach(f.org, f.actor, first.id, approval(first)); expect(unknown.items[0].delivery.state).toBe("uncertain");
    await expect(sendSourceOutreach(f.org, f.actor, other.id, approval(other))).rejects.toMatchObject({ code: "source_touch_reserved" });
    await expect(previewSourceOutreach(f.org, f.actor, draftInput(f))).rejects.toMatchObject({ code: "source_touch_reserved" });
    await reconcileExecution(f.org, unknown.items[0].delivery.executionId!, f.actor, "confirmed_not_performed", "Synthetic operator checked mailbox; this does not rearm.");
    await sendSourceOutreach(f.org, f.actor, first.id, approval(first)); expect(effects).toHaveLength(1);
    const otherFixture = await fixture(), reserved = await ready(otherFixture);
    await db.update(items).set({ claimedAt: new Date() }).where(eq(items.id, reserved.items[0].id));
    expect((await getSourceOutreach(otherFixture.org, reserved.id)).items[0].delivery.state).toBe("uncertain");
    await sendSourceOutreach(otherFixture.org, otherFixture.actor, reserved.id, approval(reserved)); expect(effects).toHaveLength(1);
  });
  it("detects saved copy tampering and keeps campaign authority outside managed beta scope", async () => {
    const f = await fixture(), batch = await ready(f);
    await db.update(items).set({ snapshot: { ...batch.items[0].snapshot, body: "tampered" } }).where(eq(items.id, batch.items[0].id));
    await expect(sendSourceOutreach(f.org, f.actor, batch.id, approval(batch))).rejects.toBeDefined(); expect(effects).toHaveLength(0);
    const other = await fixture(); await adopt(other); await permission(other);
    await db.update(organizationsTable).set({ entitlements: { version: 1, planId: "beta", source: "manual", grants: [] } }).where(eq(organizationsTable.id, other.org));
    await expect(previewSourceOutreach(other.org, other.actor, draftInput(other))).rejects.toMatchObject({ code: "capability_unavailable" });
  });
  it("keeps SMS source context and contact-wide generic sends blocked", async () => {
    const f = await fixture(), batch = await ready(f), [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, f.contact));
    expect(await checkSendEligibility({ organizationId: f.org, contact, channel: "email", kind: "outreach", sourceOutreachItemId: batch.items[0].id })).toMatchObject({ ok: false });
    expect(await checkSendEligibility({ organizationId: f.org, leadId: f.lead, contact, channel: "sms", kind: "outreach", sourceOutreachItemId: batch.items[0].id })).toMatchObject({ ok: false });
  });
  it("preserves a strict rolling company cap across separately approved campaigns", async () => {
    const f = await fixture(); await adopt(f); await permission(f);
    const p = await previewSourceOutreach(f.org, f.actor, { ...draftInput(f), dailyLimit: 1 }); const first = await approveSourceOutreach(f.org, f.actor, p.id, approval(p));
    const [contact] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Second", email: "second@example.invalid" }).returning();
    const [lead] = await db.insert(leadsTable).values({ organizationId: f.org, contactId: contact.id, assignedUserId: f.actor, creationMethod: "import", importSourceKey: "hcp-account-one", externalOpportunityId: "opportunity-2", importedHistory: f.history }).returning();
    const secondFixture = { ...f, lead: lead.id, contact: contact.id }; await adopt(secondFixture); await permission(secondFixture);
    const secondPreview = await previewSourceOutreach(f.org, f.actor, { ...draftInput(secondFixture), dailyLimit: 1 }); const second = await approveSourceOutreach(f.org, f.actor, secondPreview.id, approval(secondPreview));
    await sendSourceOutreach(f.org, f.actor, first.id, approval(first));
    await expect(sendSourceOutreach(f.org, f.actor, second.id, approval(second))).rejects.toMatchObject({ code: "source_daily_limit" }); expect(effects).toHaveLength(1);
  });
  it("stops an expired or operator-reconciled durable owner before the provider boundary", async () => {
    const f = await fixture(), batch = await ready(f);
    lateChange = async () => { await db.update(revenueExecutionsTable).set({ state: "confirmed_not_performed" }).where(and(eq(revenueExecutionsTable.organizationId, f.org), eq(revenueExecutionsTable.actionKey, sourceOutreachKey(f.lead)))); };
    const result = await sendSourceOutreach(f.org, f.actor, batch.id, approval(batch)); expect(result.items[0].delivery.state).toBe("reconciled"); expect(effects).toHaveLength(0);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("serializes two independently racing campaign sends on PostgreSQL", async () => {
    const f = await fixture(), batch = await ready(f);
    const results = await Promise.allSettled([sendSourceOutreach(f.org, f.actor, batch.id, approval(batch)), sendSourceOutreach(f.org, f.actor, batch.id, approval(batch))]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true); expect(effects).toHaveLength(1);
    const receipts = await db.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, f.org), eq(revenueExecutionsTable.actionKey, sourceOutreachKey(f.lead))));
    expect(receipts).toHaveLength(1);
  });
});
