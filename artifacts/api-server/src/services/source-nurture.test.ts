import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { appointmentsTable, contactsTable, customerLifecycleTable, db, emailSenderPreferencesTable, leadsTable, organizationsTable, orgSettingsTable, pool, revenueExecutionsTable, scheduledActionsTable, usersTable } from "@workspace/db";
import { sourceNurtureItemsTable as items, sourceNurturePlansTable as plans, sourceNurtureStepsTable as steps } from "../../../../lib/db/src/schema/source-nurture";
import { sourceOutreachItemsTable as legacyItems } from "../../../../lib/db/src/schema/source-adoption";
import { contactTouchReservationsTable as touches } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { completeNurtureScan, nurtureJson, nurtureTokens, sourceNurtureDraft, sourceNurtureFixture, startNurtureFixture, type SourceNurtureFixture } from "../test-helpers/source-nurture-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { approveSourceNurture, getSourceNurture, listSourceNurture, previewSourceNurture, startSourceNurture, stopSourceNurture } from "./source-nurture";
import { processSourceNurture } from "./source-nurture-runtime";
import { processDueScheduledActions } from "./automation";
import { addSuppression } from "./send-gate";
import { getSourceAdoption, previewSourceOutreach, approveSourceOutreach, sendSourceOutreach, recordSourceEmailPermission, revokeSourceAdoption } from "./source-adoption";
import { runDurableAction, reconcileExecution } from "./durable-execution";
import { contactTouchTimes, claimContactTouch, assertContactTouchCurrent, type ContactTouchClaim } from "./contact-touch-claim";
import { nurturePlanFingerprint } from "./source-nurture-fingerprint";
import { sourceFingerprint } from "./source-adoption-contract";

const base = new Date("2026-10-05T16:00:00Z"), orgs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(base);
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ed".repeat(32)); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "cd".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubGlobal("fetch", async () => { throw new Error("External network forbidden in nurture tests"); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture() { const f = await sourceNurtureFixture(); orgs.push(f.org); return f; }
const approveInput = (p: { version: number; payloadSha256: string }) => ({ expectedVersion: p.version, payloadSha256: p.payloadSha256, confirmed: true as const });
async function approved(f: SourceNurtureFixture) { const p = await previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(f)); return (await approveSourceNurture(f.org, f.owner.id, p.id, approveInput(p))).detail; }
function sender(f: SourceNurtureFixture, change?: () => Promise<void>, unknown = false) {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/token")) return nurtureJson(nurtureTokens("Mail.Send User.Read"));
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) { await change?.(); return nurtureJson(f.profile); }
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); if (unknown) throw new Error("Synthetic acceptance lost"); return new Response(null, { status: 202 }); }
    throw new Error("Unexpected synthetic URL; no network fallback");
  });
  return posts;
}
async function tick(f: SourceNurtureFixture) { await processSourceNurture(f.org); await processDueScheduledActions(f.org); }

it("keeps review and approval send-free, explicitly starts two permanent actions and replays exact commands only", async () => {
  const f = await fixture(), p = await approved(f);
  expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
  const command = { ...approveInput(p), requestId: randomUUID() };
  const started = await startSourceNurture(f.org, f.owner.id, p.id, command);
  expect(started.detail.items[0].steps).toHaveLength(2); expect(started.detail.items[0].admittedAt).not.toBeNull();
  expect(await startSourceNurture(f.org, f.owner.id, p.id, command)).toMatchObject({ command: { replayed: true, appliedVersion: 3 } });
  await expect(startSourceNurture(f.org, f.owner.id, p.id, { ...command, expectedVersion: 3 })).rejects.toMatchObject({ code: "nurture_command_conflict" });
  const stop = { ...approveInput(started.detail), requestId: randomUUID(), reason: "Synthetic owner deliberately stopped this original sequence." };
  const stopped = await stopSourceNurture(f.org, f.owner.id, p.id, stop);
  expect(stopped.detail.items[0].steps.every(step => step.state === "cancelled")).toBe(true);
  expect((await stopSourceNurture(f.org, f.owner.id, p.id, stop)).command.replayed).toBe(true);
  await expect(previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(f))).rejects.toMatchObject({ code: "source_touch_reserved" });
  expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(2);
});
it("keeps stopped/default evidence readable while providers, lifecycle and entitlement are held", async () => {
  const f = await fixture(), p = await startNurtureFixture(f);
  await db.update(organizationsTable).set({ entitlements: { version: 1, planId: "beta", source: "manual", grants: [] } }).where(eq(organizationsTable.id, f.org));
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "false"); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
  const stopped = await stopSourceNurture(f.org, f.owner.id, p.id, { ...approveInput(p), requestId: randomUUID(), reason: "Stopping remains available while delivery is disabled." });
  expect(stopped.detail.state).toBe("stopped"); expect(stopped.detail.items[0].mailboxSync.ready).toBe(false);
  const before = (await db.select().from(plans).where(eq(plans.id, p.id)))[0];
  expect((await getSourceNurture(f.org, p.id)).state).toBe("stopped");
  expect((await listSourceNurture(f.org, "history", 0)).items.map(item => item.id)).toEqual([p.id]);
  expect((await db.select().from(plans).where(eq(plans.id, p.id)))[0]).toEqual(before);
});
it("rejects cross-company, unaccepted actor, changed body, expiry and selected Gmail rather than Microsoft", async () => {
  const f = await fixture(), other = await fixture(), p = await previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(f));
  await expect(getSourceNurture(other.org, p.id)).rejects.toMatchObject({ status: 404 });
  await expect(approveSourceNurture(f.org, other.owner.id, p.id, approveInput(p))).rejects.toMatchObject({ status: 403 });
  await db.update(steps).set({ body: "Altered exact copy not shown in the original review." }).where(eq(steps.id, p.items[0].steps[0].id));
  await expect(approveSourceNurture(f.org, f.owner.id, p.id, approveInput(p))).rejects.toMatchObject({ code: "nurture_review_changed" });
  const fresh = await previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(f)); vi.setSystemTime(new Date(base.getTime() + 11 * 60_000));
  await expect(approveSourceNurture(f.org, f.owner.id, fresh.id, approveInput(fresh))).rejects.toMatchObject({ code: "nurture_review_expired_or_changed" });
  vi.setSystemTime(base); await db.update(emailSenderPreferencesTable).set({ provider: "gmail" }).where(eq(emailSenderPreferencesTable.userId, f.owner.id));
  await expect(previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(f))).rejects.toMatchObject({ code: "mailbox_sender_changed" });
});
it("does not admit without fresh full scan, and cannot adopt a second alias of the same address", async () => {
  const f = await fixture(), p = await approved(f); vi.setSystemTime(new Date(base.getTime() + 6 * 60_000));
  await expect(startSourceNurture(f.org, f.owner.id, p.id, { ...approveInput(p), requestId: randomUUID() })).rejects.toMatchObject({ code: "mailbox_sync_stale" });
  expect((await getSourceNurture(f.org, p.id)).items[0].admittedAt).toBeNull();
  await completeNurtureScan(f); await startSourceNurture(f.org, f.owner.id, p.id, { ...approveInput(p), requestId: randomUUID() });
  const alias = await sourceNurtureFixture({ organizationId: f.org, ownerUserId: f.owner.id, recipient: f.contact.email! });
  await expect(previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(alias))).rejects.toMatchObject({ code: "source_touch_reserved" });
});
it.each(["recipient", "owner", "permission", "adoption", "suppression", "stage", "lost", "inspection_scheduled", "completed", "sending hours", "appointment"])("stops OAuth-time %s changes with zero provider POST and no replacement action", async kind => {
  const f = await fixture(), p = await startNurtureFixture(f), original = p.items[0].steps.map(step => step.scheduledActionId);
  const posts = sender(f, async () => {
    if (kind === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
    if (kind === "owner") await db.update(leadsTable).set({ assignedUserId: null }).where(eq(leadsTable.id, f.lead.id));
    if (kind === "stage") await db.update(leadsTable).set({ status: "won" }).where(eq(leadsTable.id, f.lead.id));
    if (kind === "lost" || kind === "inspection_scheduled" || kind === "completed") await db.update(leadsTable).set({ status: kind }).where(eq(leadsTable.id, f.lead.id));
    if (kind === "sending hours") await db.update(orgSettingsTable).set({ sendingHours: { timezone: "America/New_York", days: ["Sun"], startHour: 9, endHour: 17, quietHoursEnabled: true, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.org));
    if (kind === "appointment") await db.insert(appointmentsTable).values({ organizationId: f.org, leadId: f.lead.id, contactId: f.contact.id, scheduledStart: new Date(base.getTime() + 3_600_000), scheduledEnd: new Date(base.getTime() + 7_200_000), status: "scheduled" });
    if (kind === "suppression") await addSuppression({ organizationId: f.org, channel: "email", value: f.contact.email!, reason: "unsubscribed" });
    if (kind === "adoption") { const current = await getSourceAdoption(f.org, f.lead.id); await revokeSourceAdoption(f.org, f.owner.id, f.lead.id, { expectedVersion: current.adoption!.version, reason: "Synthetic source authority intentionally revoked." }); }
    if (kind === "permission") { const current = await getSourceAdoption(f.org, f.lead.id); await recordSourceEmailPermission(f.org, f.owner.id, f.lead.id, { expectedSourceSha256: current.sourceSha256, expectedRecipient: current.recipient, expectedConsentId: current.consentId, granted: false, observedAt: new Date().toISOString(), evidence: "Synthetic customer withdrew promotional email permission.", marketingPermissionConfirmed: true }); }
  });
  await tick(f); expect(posts).toHaveLength(0); vi.setSystemTime(new Date(base.getTime() + 60_000)); await tick(f);
  expect(posts).toHaveLength(0); expect((await getSourceNurture(f.org, p.id)).items[0].steps.map(step => step.scheduledActionId)).toEqual(original);
  expect((await getSourceNurture(f.org, p.id)).items[0].steps[1].state).toBe("cancelled");
});
it("preserves an unknown predecessor after reconciliation and never grants a follow-up or new sequence", async () => {
  const f = await fixture(), p = await startNurtureFixture(f), posts = sender(f, undefined, true); await tick(f); expect(posts).toHaveLength(1);
  const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(receipt.state).toBe("indeterminate");
  await reconcileExecution(f.org, receipt.id, f.owner.id, "confirmed_succeeded", "Synthetic operator attestation is not actual retained acceptance.");
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, receipt.id)))[0].state).toBe("confirmed_succeeded");
  vi.setSystemTime(new Date(base.getTime() + 4 * 86_400_000)); await completeNurtureScan(f); await tick(f);
  expect(posts).toHaveLength(1); expect((await getSourceNurture(f.org, p.id)).items[0].steps[1].state).toBe("cancelled");
  await expect(previewSourceNurture(f.org, f.owner.id, sourceNurtureDraft(f))).rejects.toMatchObject({ code: "source_touch_reserved" });
});
it("expires quiet-hour deferrals in the same finite window without claiming a late effect", async () => {
  const f = await fixture(), p = await startNurtureFixture(f, { days: ["Sun"] }); await tick(f);
  expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).toHaveLength(0);
  vi.setSystemTime(new Date(Date.parse(p.expiresAt) + 1)); await processSourceNurture(f.org);
  expect((await getSourceNurture(f.org, p.id)).state).toBe("expired"); expect((await getSourceNurture(f.org, p.id)).items[0].steps.every(step => step.state === "cancelled")).toBe(true);
});
it("counts aliases and pending/unknown receipts once; changed address/channel cannot use a saved allowance", async () => {
  const f = await fixture(); const [alias] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Synthetic alias", email: ` ${f.contact.email!.toUpperCase()} ` }).returning();
  const touch: ContactTouchClaim = { organizationId: f.org, logicalKey: `scheduled:${randomUUID()}`, contactId: f.contact.id, address: f.contact.email!, channel: "email", sourceKind: "automation", payload: { version: 1 } };
  await claimContactTouch(touch); expect(await contactTouchTimes(db, f.org, alias.id, new Date(base.getTime() - 86_400_000))).toHaveLength(1);
  await expect(claimContactTouch({ ...touch, logicalKey: `scheduled:${randomUUID()}`, contactId: alias.id })).rejects.toMatchObject({ reason: "frequency_cap" });
  expect((await claimContactTouch(touch)).created).toBe(false);
  await expect(assertContactTouchCurrent(db, { ...touch, channel: "sms" })).rejects.toMatchObject({ code: "touch_claim_changed" });
  await db.update(contactsTable).set({ email: "different@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
  await expect(assertContactTouchCurrent(db, touch)).rejects.toMatchObject({ code: "touch_contact_unavailable" });
});
it("leaves source/date/hash intact as accepted work changes only runtime fields", async () => {
  const f = await fixture(), p = await startNurtureFixture(f), posts = sender(f); await tick(f); expect(posts).toHaveLength(1);
  const [plan] = await db.select().from(plans).where(eq(plans.id, p.id)), cohort = await db.select().from(items).where(eq(items.planId, p.id)), sequence = await db.select().from(steps).where(eq(steps.planId, p.id));
  expect(nurturePlanFingerprint(plan, cohort, sequence)).toBe(p.payloadSha256); expect((await db.select().from(leadsTable).where(eq(leadsTable.id, f.lead.id)))[0].creationMethod).toBe("import");
  expect(await contactTouchTimes(db, f.org, f.contact.id, new Date(base.getTime() - 86_400_000))).toHaveLength(1);
});
it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("PostgreSQL independent legacy send and nurture admission permanently converge on one source owner", async () => {
  const f = await fixture(), p = await approved(f), draft = sourceNurtureDraft(f);
  const legacy = await previewSourceOutreach(f.org, f.owner.id, { leadIds: draft.leadIds, businessName: draft.businessName, mailingAddress: draft.mailingAddress, ...draft.steps[0], timezone: draft.timezone, days: draft.days, startHour: draft.startHour, endHour: draft.endHour, dailyLimit: 10, expiresAt: new Date(base.getTime() + 3_600_000).toISOString() });
  const batch = await approveSourceOutreach(f.org, f.owner.id, legacy.id, approveInput(legacy)), posts = sender(f);
  const results = await Promise.allSettled([startSourceNurture(f.org, f.owner.id, p.id, { ...approveInput(p), requestId: randomUUID() }), sendSourceOutreach(f.org, f.owner.id, batch.id, approveInput(batch))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const native = await db.select().from(items).where(and(eq(items.organizationId, f.org), sql`${items.admittedAt} is not null`));
  const old = await db.select().from(legacyItems).where(and(eq(legacyItems.organizationId, f.org), sql`${legacyItems.claimedAt} is not null`));
  expect(native.length + old.length).toBe(1); expect(posts.length).toBeLessThanOrEqual(1);
});
it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("PostgreSQL independent nurture and generic workers cannot both own the final alias contact allowance", async () => {
  const f = await fixture(), p = await startNurtureFixture(f), posts = sender(f);
  const [alias] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Synthetic alias", email: f.contact.email! }).returning();
  const [scheduled] = await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: { type: "send_email", params: { subject: "Synthetic competing effect", body: "Synthetic competing email only." } }, context: { contactId: alias.id }, runAt: new Date(base.getTime() + 86_400_000) }).returning();
  const payload = { action: scheduled.action, context: scheduled.context }; let otherEffects = 0;
  await Promise.allSettled([processDueScheduledActions(f.org), runDurableAction({ organizationId: f.org, actionKey: `scheduled:${scheduled.id}`, kind: "send_email", payload,
    contactTouch: { organizationId: f.org, logicalKey: `scheduled:${scheduled.id}`, contactId: alias.id, address: alias.email!, channel: "email", sourceKind: "automation", payload },
    execute: async () => { otherEffects++; return { state: "succeeded", detail: "Synthetic competing effect accepted." }; } })]);
  expect(posts.length + otherEffects).toBe(1); expect(await db.select().from(touches).where(eq(touches.organizationId, f.org))).toHaveLength(1);
  const current = await getSourceNurture(f.org, p.id); expect(current.items[0].steps[1].acceptedAt).toBeNull();
});
