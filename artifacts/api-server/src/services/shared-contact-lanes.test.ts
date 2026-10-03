import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activitiesTable, bieActionProposalsTable, contactsTable, db, DEFAULT_SENDING_HOURS,
  emailSenderPreferencesTable, leadsTable, microsoftConnectionsTable, organizationsTable,
  playbookEnrollmentsTable, playbooksTable, revenueExecutionsTable, usersTable,
} from "@workspace/db";
import { contactTouchReservationsTable as reservations } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { executeBieProposal, prepareBieEmailProposal, reviewBieProposal } from "./bie";
import { claimContactTouch, contactTouchTimes, type ContactTouchClaim } from "./contact-touch-claim";
import { reconcileExecution } from "./durable-execution";
import { executePlaybookStep } from "./playbooks";
import { checkOutreachTiming } from "./send-gate";
import { updateOrgSettings } from "./settings";

// Run the real service, claim, send-gate and Microsoft final-dispatch guard. Only
// physical HTTP is synthetic; no mocked claim/authority helper can hide a race.
const orgs: string[] = [];
const transport = vi.fn<typeof fetch>();
const mailbox = { id: "synthetic-shared-lanes-mailbox", mail: "shared-office@example.invalid" };
let onRefresh: (() => Promise<void>) | undefined;
let postCount = 0;
let unknown = false;
let phoneSequence = 1000;
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("OPENAI_API_KEY", "");
  postCount = 0; unknown = false; onRefresh = undefined;
  transport.mockReset().mockImplementation(async input => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/") && url.endsWith("/token"))
      return response({ token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-rotated", scope: "Mail.Send User.Read" });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      const hook = onRefresh; onRefresh = undefined; await hook?.();
      return response(mailbox);
    }
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail") {
      postCount++;
      if (unknown) throw new Error("Synthetic unknown acceptance; never replay");
      return new Response(null, { status: 202 });
    }
    throw new Error("Unexpected synthetic transport operation");
  });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });

async function fixture(maxTouchesPerDay = 1) {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic shared contact lanes", slug: randomUUID() }).returning();
  orgs.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", email: `owner-${randomUUID()}@example.invalid`, emailVerifiedAt: new Date() }).returning();
  await db.insert(microsoftConnectionsTable).values({ organizationId: org.id, userId: user.id, accountId: mailbox.id, email: mailbox.mail,
    encryptedRefreshToken: encryptSecret("synthetic-refresh", `${org.id}:${user.id}:microsoft`), grantedScopes: ["mail.send", "user.read"] });
  await db.insert(emailSenderPreferencesTable).values({ organizationId: org.id, userId: user.id, provider: "microsoft" });
  await updateOrgSettings(org.id, { sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay } });
  return { org: org.id, user: user.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function customer(f: Fixture, aliases: { email?: string; phone?: string } = {}) {
  const [contact] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Synthetic", email: aliases.email ?? `${randomUUID()}@example.invalid`,
    phone: aliases.phone ?? `+1202555${phoneSequence++}` }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: f.org, contactId: contact.id, assignedUserId: f.user,
    creationMethod: "form", status: "follow_up" }).returning();
  return { contact, lead };
}
type Customer = Awaited<ReturnType<typeof customer>>;
async function proposal(f: Fixture, c: Customer) {
  const [draft] = await db.insert(bieActionProposalsTable).values({ organizationId: f.org, leadId: c.lead.id, actionType: "send_email", status: "proposed",
    title: "Synthetic reviewed BIE touch", rationale: "Synthetic isolated allowance check", createdByUserId: f.user,
    payload: { subject: "Exact reviewed subject", body: "Exact reviewed follow-up." } }).returning();
  const prepared = await prepareBieEmailProposal(f.org, draft.id, f.user, { expectedPayload: draft.payload });
  expect(await reviewBieProposal(f.org, draft.id, f.user, "approve", prepared.payload)).toMatchObject({ status: "approved" });
  return { id: draft.id, payload: prepared.payload, key: `bie:${draft.id}` };
}
async function playbook(f: Fixture, c: Customer) {
  const step = { channel: "email" as const, delayMinutes: 0, subject: "Synthetic fixed subject", prompt: "Offer help without promises." };
  const [book] = await db.insert(playbooksTable).values({ organizationId: f.org, name: "Synthetic one-step playbook", steps: [step] }).returning();
  const [enrollment] = await db.insert(playbookEnrollmentsTable).values({ organizationId: f.org, playbookId: book.id, leadId: c.lead.id }).returning();
  const key = `playbook:${enrollment.id}:0`;
  const originalClaim: ContactTouchClaim = { organizationId: f.org, logicalKey: key, contactId: c.contact.id, leadId: c.lead.id,
    address: c.contact.email!, channel: "email", sourceKind: "playbook", payload: { enrollmentId: enrollment.id, stepIndex: 0,
      playbookId: book.id, step, leadId: c.lead.id, contactId: c.contact.id, recipient: c.contact.email! } };
  return { id: enrollment.id, key, input: { enrollmentId: enrollment.id, stepIndex: 0 }, originalClaim };
}
const claims = (org: string) => db.select().from(reservations).where(eq(reservations.organizationId, org));
const receipts = (org: string) => db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, org));
const times = (f: Fixture, c: Customer, excludeKey?: string) => contactTouchTimes(db, f.org, c.contact.id, new Date(Date.now() - 86_400_000), excludeKey);
const timing = (f: Fixture, c: Customer) => checkOutreachTiming({ organizationId: f.org, contact: c.contact });
const pending = (f: Fixture, c: Customer, key = `playbook:${randomUUID()}:0`): ContactTouchClaim => ({ organizationId: f.org, logicalKey: key,
  contactId: c.contact.id, leadId: c.lead.id, address: c.contact.email!, channel: "email", sourceKind: "playbook", payload: { syntheticOriginalStep: key } });

describe("shared BIE and playbook original contact allowance", () => {
  it("counts an accepted BIE claim, execution receipt and accepted activity exactly once, retaining the original key on retry", async () => {
    const f = await fixture(), c = await customer(f), action = await proposal(f, c);
    expect(await executeBieProposal(f.org, action.id, f.user)).toMatchObject({ status: "executed" });
    expect(postCount).toBe(1);
    const [claim] = await claims(f.org);
    expect(claim).toMatchObject({ logicalKey: action.key, sourceKind: "bie", contactId: c.contact.id });
    expect(claim.dispatchStartedAt).toBeInstanceOf(Date); expect(claim.acceptedAt).toBeInstanceOf(Date);
    expect(await receipts(f.org)).toEqual([expect.objectContaining({ actionKey: action.key, state: "succeeded" })]);
    const activity = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, f.org), eq(activitiesTable.type, "bie_email_sent")));
    expect(activity).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ touchLogicalKey: action.key, proposalId: action.id }) })]);
    expect(await times(f, c)).toHaveLength(1); expect(await times(f, c, action.key)).toHaveLength(0);
    expect(await timing(f, c)).toMatchObject({ outcome: "deferred", reason: "frequency_cap" });
    const calls = transport.mock.calls.length;
    await executeBieProposal(f.org, action.id, f.user);
    expect(transport).toHaveBeenCalledTimes(calls); expect(await claims(f.org)).toHaveLength(1);
  });

  it("counts an accepted playbook step once and never recreates its original step after completion", async () => {
    const f = await fixture(), c = await customer(f), book = await playbook(f, c);
    expect(await executePlaybookStep(f.org, book.input)).toMatchObject({ status: "success" });
    expect(await times(f, c)).toHaveLength(1);
    expect(await claims(f.org)).toEqual([expect.objectContaining({ logicalKey: book.key, acceptedAt: expect.any(Date), dispatchStartedAt: expect.any(Date) })]);
    expect(await executePlaybookStep(f.org, book.input)).toMatchObject({ status: "skipped" });
    expect(postCount).toBe(1); expect(await claims(f.org)).toHaveLength(1);
    const [row] = await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, book.id));
    expect(row).toMatchObject({ currentStep: 1, status: "completed" });
  });

  it("keeps an accepted touch inside the rolling window until actual acceptance ages out, not its earlier reservation", async () => {
    const f = await fixture(), c = await customer(f), action = await proposal(f, c);
    expect(await executeBieProposal(f.org, action.id, f.user)).toMatchObject({ status: "executed" });
    // A provider may accept several minutes after the claim. Move the real
    // synthetic receipt to the edge of the rolling window without fake timers
    // or replacing service logic, preserving a valid sub-15-minute dispatch.
    const reservedAt = new Date(Date.now() - 86_400_000 + 30_000);
    const acceptedAt = new Date(reservedAt.getTime() + 10 * 60_000);
    await db.update(reservations).set({ reservedAt, dispatchStartedAt: new Date(acceptedAt.getTime() - 1000), acceptedAt }).where(eq(reservations.organizationId, f.org));
    await db.update(revenueExecutionsTable).set({ createdAt: reservedAt, completedAt: acceptedAt }).where(eq(revenueExecutionsTable.organizationId, f.org));
    await db.update(activitiesTable).set({ occurredAt: acceptedAt }).where(and(eq(activitiesTable.organizationId, f.org), eq(activitiesTable.type, "bie_email_sent")));
    expect(await times(f, c)).toEqual([acceptedAt]);
    const gate = await timing(f, c);
    expect(gate).toMatchObject({ outcome: "deferred", reason: "frequency_cap" });
    if (!gate.ok && gate.outcome === "deferred") expect(gate.resumeAt.getTime()).toBeGreaterThanOrEqual(acceptedAt.getTime() + 86_400_000);
  });

  it.each(["indeterminate", "processing", "confirmed_succeeded", "succeeded"] as const)("does not erase a legacy unknown/parallel %s BIE allowance using an unrelated accepted activity on the same lead", async state => {
    const f = await fixture(2), c = await customer(f);
    const accepted = await proposal(f, c), uncertain = await proposal(f, c);
    const createdAt = new Date(Date.now() - 5 * 60_000), occurredAt = new Date(createdAt.getTime() + 20_000);
    // Before the shared ledger existed, activity metadata did not necessarily
    // identify its proposal. Similar lead/time evidence cannot consume two
    // distinct receipts or resolve the other proposal's unknown provider effect.
    await db.insert(revenueExecutionsTable).values([
      { organizationId: f.org, actionKey: accepted.key, kind: "send_email", fingerprint: "a".repeat(64), state: "succeeded",
        actorUserId: f.user, createdAt, completedAt: new Date(occurredAt.getTime() + 1000), expiresAt: new Date(Date.now() + 60_000) },
      { organizationId: f.org, actionKey: uncertain.key, kind: "send_email", fingerprint: "b".repeat(64), state,
        actorUserId: f.user, createdAt: new Date(createdAt.getTime() + 10_000), completedAt: state === "processing" ? null : new Date(occurredAt.getTime() + 2000), expiresAt: new Date(Date.now() + 60_000) },
    ]);
    await db.update(bieActionProposalsTable).set({ status: "executed", executedAt: occurredAt }).where(eq(bieActionProposalsTable.id, accepted.id));
    await db.update(bieActionProposalsTable).set({ status: state === "succeeded" ? "executed" : "indeterminate" }).where(eq(bieActionProposalsTable.id, uncertain.id));
    await db.insert(activitiesTable).values({ organizationId: f.org, leadId: c.lead.id, contactId: c.contact.id,
      type: "bie_email_sent", title: "Legacy accepted BIE email", occurredAt, metadata: { provider: "microsoft", acceptance: "accepted" } });
    expect(await times(f, c)).toHaveLength(2);
    expect(await timing(f, c)).toMatchObject({ outcome: "deferred", reason: "frequency_cap" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["normalized email", "normalized phone"])("a pending original claim blocks a competing BIE contact sharing %s without consuming its own key", async alias => {
    const f = await fixture(), c = await customer(f);
    const other = await customer(f, alias === "normalized email"
      ? { email: ` ${c.contact.email!.toUpperCase()} ` }
      : { phone: c.contact.phone!.slice(2).replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3") });
    const action = await proposal(f, other), hold = pending(f, c);
    expect(await claimContactTouch(hold)).toMatchObject({ created: true });
    expect(await times(f, other)).toHaveLength(1);
    expect(await executeBieProposal(f.org, action.id, f.user)).toMatchObject({ status: "approved", executionDetail: expect.stringContaining("allowance held") });
    expect(await claims(f.org)).toEqual([expect.objectContaining({ logicalKey: hold.logicalKey, acceptedAt: null })]);
    expect(await receipts(f.org)).toHaveLength(0); expect(transport).not.toHaveBeenCalled();
  });

  it("an unknown BIE provider effect retains its original key and blocks an alias playbook, including after negative operator reconciliation", async () => {
    const f = await fixture(), c = await customer(f), action = await proposal(f, c);
    const alias = await customer(f, { email: c.contact.email! }), book = await playbook(f, alias);
    unknown = true;
    expect(await executeBieProposal(f.org, action.id, f.user)).toMatchObject({ status: "indeterminate" });
    const [receipt] = await receipts(f.org);
    expect(receipt).toMatchObject({ state: "indeterminate", actionKey: action.key });
    expect(await claims(f.org)).toEqual([expect.objectContaining({ logicalKey: action.key, dispatchStartedAt: expect.any(Date), acceptedAt: null })]);
    expect(await executePlaybookStep(f.org, book.input)).toMatchObject({ status: "skipped", detail: "deferred: frequency_cap" });
    // Simulate a process interruption/older projection whose proposal still
    // looks approved: the durable original key, not that display state, owns
    // the effect and must prevent another provider attempt.
    await db.update(bieActionProposalsTable).set({ status: "approved" }).where(eq(bieActionProposalsTable.id, action.id));
    expect(await executeBieProposal(f.org, action.id, f.user)).toMatchObject({ status: "indeterminate" });
    await reconcileExecution(f.org, receipt.id, f.user, "confirmed_not_performed", "Synthetic operator statement is not fresh provider acceptance.");
    await db.update(bieActionProposalsTable).set({ status: "approved" }).where(eq(bieActionProposalsTable.id, action.id));
    await executeBieProposal(f.org, action.id, f.user);
    expect(await executePlaybookStep(f.org, book.input)).toMatchObject({ status: "skipped", detail: "deferred: frequency_cap" });
    expect(await times(f, alias)).toHaveLength(1); expect(postCount).toBe(1);
    expect((await receipts(f.org))[0]).toMatchObject({ actionKey: action.key, state: "confirmed_not_performed" });
    expect(await claims(f.org)).toHaveLength(1);
    const [row] = await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, book.id));
    expect(row).toMatchObject({ currentStep: 0, status: "active" });
  });

  it("an unknown playbook effect permanently retains its original step and blocks a competing BIE alias", async () => {
    const f = await fixture(), c = await customer(f), book = await playbook(f, c);
    const alias = await customer(f, { email: c.contact.email! }), action = await proposal(f, alias);
    unknown = true;
    await expect(executePlaybookStep(f.org, book.input)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(await executePlaybookStep(f.org, book.input)).toMatchObject({ status: "skipped" });
    expect(await executeBieProposal(f.org, action.id, f.user)).toMatchObject({ status: "approved", executionDetail: expect.stringContaining("allowance held") });
    expect(postCount).toBe(1); expect(await receipts(f.org)).toHaveLength(0);
    expect(await claims(f.org)).toEqual([expect.objectContaining({ logicalKey: book.key, dispatchStartedAt: expect.any(Date), acceptedAt: null })]);
    expect(await times(f, alias)).toHaveLength(1);
  });

  it("an orphan original playbook reservation cannot recreate the claimed step or switch to a replacement key", async () => {
    const f = await fixture(0), c = await customer(f), book = await playbook(f, c);
    await claimContactTouch(book.originalClaim);
    expect(await executePlaybookStep(f.org, book.input)).toMatchObject({ status: "skipped", detail: "paused: original_touch_owned" });
    expect(await claims(f.org)).toEqual([expect.objectContaining({ logicalKey: book.key })]);
    expect(transport).not.toHaveBeenCalled();
    const [row] = await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, book.id));
    expect(row).toMatchObject({ status: "paused", currentStep: 0 });
  });

  it.each(["BIE", "playbook"])("%s rechecks the shared cap after OAuth and cannot dispatch when an alias claim uses the changed allowance", async lane => {
    const f = await fixture(2), c = await customer(f), alias = await customer(f, { email: c.contact.email! });
    const action = lane === "BIE" ? await proposal(f, c) : null;
    const book = lane === "playbook" ? await playbook(f, c) : null;
    const run = () => action ? executeBieProposal(f.org, action.id, f.user) : executePlaybookStep(f.org, book!.input);
    onRefresh = async () => {
      await claimContactTouch(pending(f, alias));
      await updateOrgSettings(f.org, { sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay: 1 } });
    };
    expect(await run()).toMatchObject(action ? { status: "blocked" } : { status: "skipped", detail: expect.stringContaining("final_email_guard_changed") });
    expect(postCount).toBe(0); expect(await claims(f.org)).toHaveLength(2);
    expect((await claims(f.org)).every(row => row.dispatchStartedAt === null && row.acceptedAt === null)).toBe(true);
    const calls = transport.mock.calls.length;
    await run(); expect(transport).toHaveBeenCalledTimes(calls);
  });

  it.each(["BIE", "playbook"])("%s fails closed when the current sender loses authority during OAuth", async lane => {
    const f = await fixture(), c = await customer(f);
    const action = lane === "BIE" ? await proposal(f, c) : null;
    const book = lane === "playbook" ? await playbook(f, c) : null;
    onRefresh = async () => { await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.user)); };
    const run = () => action ? executeBieProposal(f.org, action.id, f.user) : executePlaybookStep(f.org, book!.input);
    expect(await run()).toMatchObject(action ? { status: "blocked" } : { status: "skipped", detail: expect.stringContaining("final_email_guard_changed") });
    expect(postCount).toBe(0);
    expect(await claims(f.org)).toEqual([expect.objectContaining({ logicalKey: action?.key ?? book!.key, dispatchStartedAt: null, acceptedAt: null })]);
    await run(); expect(postCount).toBe(0); expect(await claims(f.org)).toHaveLength(1);
  });

  it("does not share another company's allowance even when its fictional email and phone are identical", async () => {
    const first = await fixture(), c = await customer(first), hold = pending(first, c);
    await claimContactTouch(hold);
    const second = await fixture(), other = await customer(second, { email: c.contact.email!, phone: c.contact.phone! });
    const action = await proposal(second, other);
    expect(await executeBieProposal(second.org, action.id, second.user)).toMatchObject({ status: "executed" });
    expect(await times(first, c)).toHaveLength(1); expect(await times(second, other)).toHaveLength(1); expect(postCount).toBe(1);
    expect(await executeBieProposal(first.org, action.id, first.user)).toBeNull();
    expect(await claims(first.org)).toEqual([expect.objectContaining({ logicalKey: hold.logicalKey, acceptedAt: null })]);
  });

  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("real PostgreSQL serializes competing BIE and playbook workers for the last alias allowance", async () => {
    const f = await fixture(), c = await customer(f), alias = await customer(f, { email: c.contact.email! });
    const action = await proposal(f, c), book = await playbook(f, alias);
    const results = await Promise.all([
      executeBieProposal(f.org, action.id, f.user),
      executePlaybookStep(f.org, book.input),
    ]);
    expect(results.filter(result => result?.status === "executed" || result?.status === "success")).toHaveLength(1);
    expect(postCount).toBe(1); expect(await claims(f.org)).toHaveLength(1);
    expect(await times(f, c)).toHaveLength(1); expect(await times(f, alias)).toHaveLength(1);
    await executeBieProposal(f.org, action.id, f.user);
    await executePlaybookStep(f.org, book.input);
    expect(postCount).toBe(1); expect(await claims(f.org)).toHaveLength(1);
  });
});
