import {
  auditEventsTable,
  db,
  invoicePaymentLinksTable,
  stripeConnectAccountsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { invoiceAttemptFixture } from "../test-helpers/invoice-attempt-fixture";
import { getInvoice, recordInvoicePayment } from "./invoices";
import {
  beginStripeConnect,
  connectWebhookConfigured,
  createInvoicePaymentLink,
  getPaymentAccountStatus,
  handleConnectWebhook,
  listInvoicePaymentLinks,
  onboardingState,
  reconcileInvoicePaymentLink,
  setConnectStripeForTests,
  stableUuid,
  stripeFailure,
  StripeConnectWebhookVerificationError,
} from "./stripe-connect";
import { resolveConnectConfig } from "./stripe-mode";

/** In-memory Stripe for both modes. No network; webhook "signature" must equal "valid". */
const calls: { method: string; args: unknown[] }[] = [];
let sessionCount = 0;
let accountSeq = 0;
const sessionMode = { force: null as null | "test" | "live" };
const live = () => process.env.STRIPE_CONNECT_MODE === "live";
const client = {
  accounts: {
    create: vi.fn(async (...args: unknown[]) => { calls.push({ method: "accounts.create", args }); accountSeq += 1; return { id: `acct_live_suite_${accountSeq}_${Date.now()}` }; }),
    retrieve: vi.fn(),
  },
  accountLinks: { create: vi.fn(async (...args: unknown[]) => { calls.push({ method: "accountLinks.create", args }); return { url: "https://connect.stripe.test/onboard" }; }) },
  checkout: {
    sessions: {
      retrieve: vi.fn(),
      expire: vi.fn(),
      create: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "checkout.sessions.create", args });
        sessionCount += 1;
        const asLive = sessionMode.force ? sessionMode.force === "live" : live();
        return { id: `cs_${asLive ? "live" : "test"}_suite${sessionCount}`, livemode: asLive, url: `https://checkout.stripe.test/c/suite${sessionCount}`, expires_at: Math.floor(Date.now() / 1000) + 86_400 };
      }),
    },
  },
  webhooks: {
    constructEvent: (raw: Buffer, signature: string) => {
      if (signature !== "valid") throw new Error("bad signature");
      return JSON.parse(raw.toString("utf8"));
    },
  },
};

let eventSeq = 0;
function event(type: string, object: Record<string, unknown>, account: string, options: { livemode?: boolean; id?: string; created?: number } = {}) {
  eventSeq += 1;
  return Buffer.from(JSON.stringify({
    id: options.id ?? `evt_suite_${eventSeq}_${Date.now()}`,
    type,
    account,
    livemode: options.livemode ?? live(),
    created: options.created ?? Math.floor(Date.now() / 1000),
    data: { object },
  }));
}

const fixtures: Awaited<ReturnType<typeof invoiceAttemptFixture>>[] = [];
async function fixture() {
  const f = await invoiceAttemptFixture();
  fixtures.push(f);
  return f;
}
/** A company whose Stripe account (in the current mode) can take charges. */
async function readyCompany() {
  const f = await fixture();
  await beginStripeConnect(f.org, f.actor);
  const [account] = await db.update(stripeConnectAccountsTable).set({ chargesEnabled: true, detailsSubmitted: true }).where(eq(stripeConnectAccountsTable.organizationId, f.org)).returning();
  return { ...f, account: account! };
}
async function audits(org: string, action: string) {
  return db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.action, action)));
}
async function linkRow(id: string) {
  return (await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, id)))[0]!;
}

beforeAll(() => {
  setConnectStripeForTests(client as never);
});
beforeEach(() => {
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_synthetic");
  vi.stubEnv("STRIPE_CONNECT_MODE", "test");
  vi.stubEnv("STRIPE_CONNECT_SECRET_KEY", "");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  calls.length = 0;
  sessionMode.force = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  setConnectStripeForTests(undefined);
  for (const f of fixtures) {
    await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, f.actor));
    await deleteTestOrgs(f.org);
    await db.delete(usersTable).where(eq(usersTable.id, f.actor));
  }
});

describe("live-mode configuration", () => {
  const base = { STRIPE_CONNECT_ENABLED: "true", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_fixture", NODE_ENV: "test" };

  it("defaults to test mode and accepts matching keys", () => {
    expect(resolveConnectConfig({ ...base, STRIPE_CONNECT_SECRET_KEY: "sk_test_fixture" })).toMatchObject({ enabled: true, ok: true, mode: "test" });
    expect(resolveConnectConfig({ ...base, STRIPE_CONNECT_MODE: "test", STRIPE_CONNECT_SECRET_KEY: "rk_test_fixture" })).toMatchObject({ ok: true, mode: "test" });
    expect(resolveConnectConfig({ ...base, STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture" })).toMatchObject({ ok: true, mode: "live" });
    expect(resolveConnectConfig({ ...base, STRIPE_CONNECT_MODE: "LIVE", STRIPE_CONNECT_SECRET_KEY: "rk_live_fixture" })).toMatchObject({ ok: true, mode: "live" });
    expect(resolveConnectConfig({ ...base, NODE_ENV: "production", STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture", STRIPE_CONNECT_LIVE_CONFIRMED: "true" })).toMatchObject({ ok: true, mode: "live" });
    expect(resolveConnectConfig({ ...base, NODE_ENV: "production", STRIPE_CONNECT_SECRET_KEY: "sk_test_fixture" })).toMatchObject({ ok: true, mode: "test" });
  });

  it("is off unless enabled, and refuses every mismatch with a plain reason", () => {
    expect(resolveConnectConfig({ ...base, STRIPE_CONNECT_ENABLED: "false", STRIPE_CONNECT_SECRET_KEY: "sk_test_fixture" })).toMatchObject({ enabled: false });
    const issue = (env: Record<string, string>) => {
      const config = resolveConnectConfig({ ...base, ...env });
      expect(config).toMatchObject({ enabled: true, ok: false });
      expect(config.issue).not.toMatch(/fixture/);
      return config.issue;
    };
    expect(issue({ STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture" })).toMatch(/live Stripe key.*test/);
    expect(issue({ STRIPE_CONNECT_MODE: "test", STRIPE_CONNECT_SECRET_KEY: "rk_live_fixture" })).toMatch(/live Stripe key/);
    expect(issue({ STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "sk_test_fixture" })).toMatch(/live but the Stripe key is a test key/);
    expect(issue({ STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "rk_test_fixture" })).toMatch(/test key/);
    expect(issue({ STRIPE_CONNECT_MODE: "production", STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture" })).toMatch(/must be test or live/);
    expect(issue({ STRIPE_CONNECT_MODE: "live" })).toMatch(/SECRET_KEY is not set/);
    expect(issue({ STRIPE_CONNECT_SECRET_KEY: "pk_test_fixture" })).toMatch(/not a Stripe secret/);
    expect(issue({ STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture", STRIPE_CONNECT_WEBHOOK_SECRET: "" })).toMatch(/live endpoint's signing secret/);
    expect(issue({ NODE_ENV: "production", STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture" })).toMatch(/STRIPE_CONNECT_LIVE_CONFIRMED=true/);
    expect(issue({ NODE_ENV: "production", STRIPE_CONNECT_MODE: "live", STRIPE_CONNECT_SECRET_KEY: "sk_live_fixture", STRIPE_CONNECT_LIVE_CONFIRMED: "yes" })).toMatch(/CONFIRMED/);
    // The subscription key never enables collection.
    expect(issue({ STRIPE_SECRET_KEY: "sk_live_fixture" })).toMatch(/SECRET_KEY is not set/);
  });

  it("refuses at first use with not_configured, before any Stripe call", async () => {
    const f = await fixture();
    vi.stubEnv("STRIPE_CONNECT_MODE", "live");
    vi.stubEnv("STRIPE_CONNECT_SECRET_KEY", "sk_test_fixture");
    expect(connectWebhookConfigured()).toBe(false);
    const status = await getPaymentAccountStatus(f.org);
    expect(status).toMatchObject({ configured: false, mode: "live" });
    expect(status.configIssue).toMatch(/test key/);
    await expect(beginStripeConnect(f.org, f.actor)).rejects.toMatchObject({ code: "not_configured" });
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "not_configured" });
    await expect(handleConnectWebhook(event("account.updated", { id: "acct_x" }, "acct_x"), "valid")).rejects.toMatchObject({ code: "not_configured" });
    vi.stubEnv("STRIPE_CONNECT_MODE", "test");
    vi.stubEnv("STRIPE_CONNECT_SECRET_KEY", "sk_live_fixture");
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "not_configured" });
    expect(calls).toHaveLength(0);
  });
});

describe("onboarding status", () => {
  const base = { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, requirements: null };
  const req = (patch: Record<string, unknown>) => ({ currentlyDue: [], pastDue: [], pendingVerification: [], disabledReason: null, currentDeadline: null, ...patch });
  it("maps Stripe's account state to not started, needs info, ready and restricted", () => {
    expect(onboardingState(null).state).toBe("not_started");
    expect(onboardingState(base)).toMatchObject({ state: "needs_info" });
    expect(onboardingState({ ...base, requirements: req({ currentlyDue: ["external_account", "tos_acceptance.date"], disabledReason: "requirements.past_due" }) })).toMatchObject({ state: "needs_info", due: 2 });
    expect(onboardingState({ ...base, detailsSubmitted: true, requirements: req({ disabledReason: "requirements.pending_verification" }) }).detail).toMatch(/checking your details/);
    expect(onboardingState({ ...base, detailsSubmitted: true, requirements: req({ pastDue: ["individual.id_number"], disabledReason: "requirements.past_due" }) }).state).toBe("restricted");
    expect(onboardingState({ ...base, detailsSubmitted: true, requirements: req({ disabledReason: "rejected.fraud" }) }).state).toBe("restricted");
    expect(onboardingState({ ...base, chargesEnabled: true, detailsSubmitted: true })).toMatchObject({ state: "ready" });
    expect(onboardingState({ ...base, chargesEnabled: true, requirements: req({ currentlyDue: ["company.tax_id"] }) }).detail).toMatch(/needs 1 more detail/);
  });
});

describe("live mode end to end", () => {
  it("onboards in live, gates pay links on account.updated, and records a live payment with its mode", async () => {
    vi.stubEnv("STRIPE_CONNECT_MODE", "live");
    const f = await fixture();
    expect((await getPaymentAccountStatus(f.org)).onboarding).toBe("not_started");
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "not_connected" });
    expect((await beginStripeConnect(f.org, f.actor)).url).toBe("https://connect.stripe.test/onboard");
    const create = calls.find((call) => call.method === "accounts.create")!;
    expect(create.args[1]).toEqual({ idempotencyKey: `growthos:connect:live:${f.org}` });
    const [account] = await db.select().from(stripeConnectAccountsTable).where(eq(stripeConnectAccountsTable.organizationId, f.org));
    expect(account).toMatchObject({ mode: "live", chargesEnabled: false });
    expect((await audits(f.org, "payments.stripe_account_created"))[0]!.metadata).toMatchObject({ mode: "live" });

    // Stripe says more info is needed: still no pay links.
    await handleConnectWebhook(event("account.updated", { id: account!.stripeAccountId, charges_enabled: false, payouts_enabled: false, details_submitted: true, requirements: { currently_due: ["external_account"], past_due: [], pending_verification: [], disabled_reason: "requirements.past_due", current_deadline: null } }, account!.stripeAccountId), "valid");
    expect(await getPaymentAccountStatus(f.org)).toMatchObject({ onboarding: "restricted", requirementsDue: 1, chargesEnabled: false });
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "not_ready", message: expect.stringMatching(/paused payments/) });

    // A test-mode event for the same account is refused, never applied.
    await expect(handleConnectWebhook(event("account.updated", { id: account!.stripeAccountId, charges_enabled: true, payouts_enabled: true, details_submitted: true }, account!.stripeAccountId, { livemode: false }), "valid")).rejects.toBeInstanceOf(StripeConnectWebhookVerificationError);
    expect((await getPaymentAccountStatus(f.org)).chargesEnabled).toBe(false);

    await handleConnectWebhook(event("account.updated", { id: account!.stripeAccountId, charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } }, account!.stripeAccountId), "valid");
    expect(await getPaymentAccountStatus(f.org)).toMatchObject({ onboarding: "ready", chargesEnabled: true, payoutsEnabled: true });

    const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    expect(link).toMatchObject({ mode: "live", state: "open", url: "https://checkout.stripe.test/c/" + `suite${sessionCount}` });
    const row = await linkRow(link.id);
    expect(row.checkoutSessionId).toMatch(/^cs_live_/);
    expect((await audits(f.org, "payments.invoice_link_created"))[0]!.metadata).toMatchObject({ mode: "live" });

    // A live session event delivered as test, and a test session id in live mode, are never recorded.
    const paid = { id: row.checkoutSessionId, payment_status: "paid", amount_total: 10_000, currency: "usd", payment_intent: `pi_live_${f.org}` };
    await expect(handleConnectWebhook(event("checkout.session.completed", paid, account!.stripeAccountId, { livemode: false }), "valid")).rejects.toBeInstanceOf(StripeConnectWebhookVerificationError);
    await handleConnectWebhook(event("checkout.session.completed", { ...paid, id: `cs_test_${f.org}` }, account!.stripeAccountId), "valid");
    expect((await linkRow(link.id)).state).toBe("open");
    expect((await getInvoice(f.org, f.actor, f.invoice.id)).recordedPaidCents).toBe(0);

    await handleConnectWebhook(event("checkout.session.completed", paid, account!.stripeAccountId), "valid");
    expect((await linkRow(link.id))).toMatchObject({ state: "paid", mode: "live" });
    expect((await getInvoice(f.org, f.actor, f.invoice.id)).recordedPaidCents).toBe(10_000);
    const recorded = await audits(f.org, "revenue.value_recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.metadata).toMatchObject({ evidence: "stripe_checkout", stripeMode: "live" });
    const processed = await audits(f.org, "payments.stripe_event_processed");
    expect(processed.map((a) => a.metadata.mode)).toEqual(expect.arrayContaining(["live"]));
    expect(processed.every((a) => a.metadata.mode === "live")).toBe(true);
  });

  it("holds a session Stripe returns in the wrong mode, in either direction", async () => {
    vi.stubEnv("STRIPE_CONNECT_MODE", "live");
    const f = await readyCompany();
    sessionMode.force = "test";
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "held" });
    const [held] = await listInvoicePaymentLinks(f.org, f.invoice.id);
    expect(held).toMatchObject({ state: "needs_reconciliation", url: null, mode: "live" });

    vi.stubEnv("STRIPE_CONNECT_MODE", "test");
    const t = await readyCompany();
    sessionMode.force = "live";
    await expect(createInvoicePaymentLink(t.org, t.actor, t.invoice.id)).rejects.toMatchObject({ code: "held" });
    expect((await listInvoicePaymentLinks(t.org, t.invoice.id))[0]).toMatchObject({ state: "needs_reconciliation", url: null, mode: "test" });
  });

  it("keeps test and live accounts apart and retires test collections once live", async () => {
    const f = await readyCompany();
    const testLink = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    expect(testLink.mode).toBe("test");

    vi.stubEnv("STRIPE_CONNECT_MODE", "live");
    // The test account does not carry over, and the test link is not payable in live.
    expect(await getPaymentAccountStatus(f.org)).toMatchObject({ mode: "live", connected: false, onboarding: "not_started" });
    expect((await listInvoicePaymentLinks(f.org, f.invoice.id))[0]!.url).toBeNull();
    // Recovery of a test collection never calls Stripe in live mode.
    calls.length = 0;
    await expect(reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, testLink.id)).rejects.toMatchObject({ code: "held" });
    expect(client.checkout.sessions.retrieve).not.toHaveBeenCalled();
    // In live mode a test-mode collection no longer blocks the office from recording a payment.
    const invoice = await getInvoice(f.org, f.actor, f.invoice.id);
    await expect(recordInvoicePayment(f.org, f.actor, f.invoice.id, { requestId: stableUuid(`manual-live:${f.org}`), expectedVersion: invoice.version, confirmed: true, amountCents: 1000, sourceReference: `manual-live:${f.org}`, occurredAt: new Date().toISOString() })).resolves.toMatchObject({ duplicate: false });

    await beginStripeConnect(f.org, f.actor);
    const accounts = await db.select().from(stripeConnectAccountsTable).where(eq(stripeConnectAccountsTable.organizationId, f.org));
    expect(accounts.map((a) => a.mode).sort()).toEqual(["live", "test"]);
    expect((await linkRow(testLink.id))).toMatchObject({ state: "expired", checkoutUrl: null });
    expect(await audits(f.org, "payments.invoice_link_retired_test_mode")).toHaveLength(1);

    // Back in test mode, the test account is still there and untouched.
    vi.stubEnv("STRIPE_CONNECT_MODE", "test");
    expect(await getPaymentAccountStatus(f.org)).toMatchObject({ mode: "test", connected: true, chargesEnabled: true });
  });
});

describe("hardened webhook", () => {
  it("processes each event id once, even when redelivered concurrently", async () => {
    const f = await readyCompany();
    const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const row = await linkRow(link.id);
    const paid = event("checkout.session.completed", { id: row.checkoutSessionId, payment_status: "paid", amount_total: 10_000, currency: "usd", payment_intent: `pi_dup_${f.org}` }, f.account.stripeAccountId, { id: `evt_dup_${f.org}` });
    await Promise.all([handleConnectWebhook(paid, "valid"), handleConnectWebhook(paid, "valid"), handleConnectWebhook(paid, "valid")]);
    await handleConnectWebhook(paid, "valid");
    expect(await audits(f.org, "revenue.value_recorded")).toHaveLength(1);
    expect((await getInvoice(f.org, f.actor, f.invoice.id)).recordedPaidCents).toBe(10_000);
    const processed = (await audits(f.org, "payments.stripe_event_processed")).filter((a) => a.metadata.stripeEventId === `evt_dup_${f.org}`);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.metadata).toMatchObject({ disposition: "paid", mode: "test" });
  });

  it("is safe when events arrive out of order", async () => {
    const f = await readyCompany();
    const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const row = await linkRow(link.id);
    const session = { id: row.checkoutSessionId, amount_total: 10_000, currency: "usd", payment_intent: `pi_ooo_${f.org}` };
    const acct = f.account.stripeAccountId;
    // Success first, then the older "submitted", "failed" and "expired" events.
    await handleConnectWebhook(event("checkout.session.async_payment_succeeded", { ...session, payment_status: "paid" }, acct), "valid");
    await handleConnectWebhook(event("checkout.session.completed", { ...session, payment_status: "unpaid" }, acct), "valid");
    await handleConnectWebhook(event("checkout.session.async_payment_failed", { ...session, payment_status: "unpaid" }, acct), "valid");
    await handleConnectWebhook(event("checkout.session.expired", { ...session, payment_status: "unpaid" }, acct), "valid");
    expect(await linkRow(link.id)).toMatchObject({ state: "paid" });
    expect((await getInvoice(f.org, f.actor, f.invoice.id)).recordedPaidCents).toBe(10_000);
    expect(await audits(f.org, "revenue.value_recorded")).toHaveLength(1);

    // An older account.updated never rewinds newer account state.
    const now = Math.floor(Date.now() / 1000);
    await handleConnectWebhook(event("account.updated", { id: acct, charges_enabled: true, payouts_enabled: true, details_submitted: true }, acct, { created: now + 5 }), "valid");
    await handleConnectWebhook(event("account.updated", { id: acct, charges_enabled: false, payouts_enabled: false, details_submitted: false }, acct, { created: now - 60 }), "valid");
    expect(await getPaymentAccountStatus(f.org)).toMatchObject({ chargesEnabled: true, payoutsEnabled: true });
    const stale = (await audits(f.org, "payments.stripe_event_processed")).filter((a) => a.metadata.disposition === "stale_ignored");
    expect(stale).toHaveLength(1);
  });

  it("flags refunds and disputes for office review without changing the balance", async () => {
    const f = await readyCompany();
    const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const row = await linkRow(link.id);
    const acct = f.account.stripeAccountId;
    const intent = `pi_refund_${f.org}`;
    await handleConnectWebhook(event("checkout.session.completed", { id: row.checkoutSessionId, payment_status: "paid", amount_total: 10_000, currency: "usd", payment_intent: intent }, acct), "valid");
    const balanceBefore = (await getInvoice(f.org, f.actor, f.invoice.id)).balanceDueCents;

    const charge = { id: `ch_${f.org}`, object: "charge", payment_intent: intent, amount: 10_000, currency: "usd" };
    const partial = event("charge.refunded", { ...charge, amount_refunded: 2_500, refunded: false }, acct);
    await handleConnectWebhook(partial, "valid");
    await handleConnectWebhook(partial, "valid");
    await handleConnectWebhook(event("charge.refunded", { ...charge, amount_refunded: 10_000, refunded: true }, acct), "valid");
    // An older, smaller refund event delivered late changes nothing.
    await handleConnectWebhook(event("charge.refunded", { ...charge, amount_refunded: 2_500, refunded: false }, acct), "valid");

    let [view] = await listInvoicePaymentLinks(f.org, f.invoice.id);
    expect(view!.state).toBe("paid");
    expect(view!.review).toEqual([expect.objectContaining({ kind: "refund", stripeId: charge.id, amountCents: 10_000, status: "full" })]);
    const refundAudits = await audits(f.org, "payments.invoice_refund_flagged");
    expect(refundAudits.map((a) => a.metadata.amountCents)).toEqual(expect.arrayContaining([2_500, 10_000]));
    expect(refundAudits).toHaveLength(2);
    expect(refundAudits.every((a) => a.metadata.balanceChanged === false)).toBe(true);

    await handleConnectWebhook(event("charge.dispute.created", { id: `dp_${f.org}`, object: "dispute", charge: charge.id, payment_intent: intent, amount: 10_000, status: "needs_response", reason: "fraudulent" }, acct), "valid");
    await handleConnectWebhook(event("charge.dispute.closed", { id: `dp_${f.org}`, object: "dispute", charge: charge.id, payment_intent: intent, amount: 10_000, status: "won", reason: "fraudulent" }, acct), "valid");
    // A late copy of the older "created" event never rewinds the closed dispute.
    await handleConnectWebhook(event("charge.dispute.created", { id: `dp_${f.org}`, object: "dispute", charge: charge.id, payment_intent: intent, amount: 10_000, status: "needs_response", reason: "fraudulent" }, acct, { created: Math.floor(Date.now() / 1000) - 3600 }), "valid");
    [view] = await listInvoicePaymentLinks(f.org, f.invoice.id);
    expect(view!.review).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "dispute", status: "won", reason: "fraudulent" })]));
    expect(await audits(f.org, "payments.invoice_dispute_flagged")).toHaveLength(2);

    const after = await getInvoice(f.org, f.actor, f.invoice.id);
    expect(after.balanceDueCents).toBe(balanceBefore);
    expect(after.recordedPaidCents).toBe(10_000);
  });

  it("acknowledges unknown events, accounts and charges without recording anything", async () => {
    const f = await readyCompany();
    const acct = f.account.stripeAccountId;
    expect(await handleConnectWebhook(event("payout.paid", { id: "po_1" }, acct), "valid")).toBe("payout.paid");
    expect(await handleConnectWebhook(event("account.updated", { id: "acct_unknown", charges_enabled: true }, "acct_unknown"), "valid")).toBe("account.updated");
    await handleConnectWebhook(event("charge.refunded", { id: "ch_other_business", payment_intent: "pi_other_business", amount_refunded: 500, refunded: false }, acct), "valid");
    const processed = await audits(f.org, "payments.stripe_event_processed");
    expect(processed.map((a) => a.metadata.eventType)).toEqual(["charge.refunded"]);
    expect(processed[0]!.metadata.disposition).toBe("unmatched");
    expect(await audits(f.org, "payments.invoice_refund_flagged")).toHaveLength(0);
  });

  it("rolls back the processed marker when processing fails, so Stripe's redelivery is applied", async () => {
    const f = await readyCompany();
    const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const row = await linkRow(link.id);
    const delivery = event("checkout.session.completed", { id: row.checkoutSessionId, payment_status: "unpaid", payment_intent: `pi_retry_${f.org}` }, f.account.stripeAccountId, { id: `evt_retry_${f.org}` });
    // Simulate a crash mid-processing by breaking the link row's state check once.
    const spy = vi.spyOn(db, "update").mockImplementationOnce(() => { throw new Error("connection lost"); });
    await expect(handleConnectWebhook(delivery, "valid")).rejects.toThrow("connection lost");
    spy.mockRestore();
    expect((await audits(f.org, "payments.stripe_event_processed")).filter((a) => a.metadata.stripeEventId === `evt_retry_${f.org}`)).toHaveLength(0);
    await handleConnectWebhook(delivery, "valid");
    expect(await linkRow(link.id)).toMatchObject({ state: "processing", paymentIntentId: `pi_retry_${f.org}` });
  });
});

describe("Stripe error handling", () => {
  it("maps Stripe errors to plain staff messages", () => {
    expect(stripeFailure({ type: "StripeRateLimitError" }, "x")).toMatchObject({ code: "provider_failed", released: true, message: expect.stringMatching(/busy/) });
    expect(stripeFailure({ type: "StripeAuthenticationError" }, "x")).toMatchObject({ code: "not_configured", released: true });
    expect(stripeFailure({ type: "StripePermissionError" }, "x")).toMatchObject({ code: "not_configured", released: true });
    expect(stripeFailure({ type: "StripeAPIError" }, "create the payment link")).toMatchObject({ code: "provider_failed", released: false, message: expect.stringMatching(/not responding/) });
    expect(stripeFailure({ type: "StripeConnectionError" }, "x")).toMatchObject({ code: "provider_failed", released: false });
    expect(stripeFailure({ type: "StripeIdempotencyError" }, "x")).toMatchObject({ code: "held", released: false });
    expect(stripeFailure({ type: "StripeCardError", code: "card_declined" }, "x")).toMatchObject({ code: "invalid", message: expect.stringMatching(/another card/) });
    expect(stripeFailure({ type: "StripeInvalidRequestError", code: "account_invalid" }, "x")).toMatchObject({ code: "not_ready", released: false });
    expect(stripeFailure(new Error("socket hang up"), "x")).toMatchObject({ code: "provider_failed", released: false });
  });

  it("releases a create Stripe never executed, but holds one that may have succeeded", async () => {
    const f = await readyCompany();
    client.checkout.sessions.create.mockImplementationOnce(async (...args: unknown[]) => { calls.push({ method: "checkout.sessions.create", args }); throw Object.assign(new Error("Too many requests"), { type: "StripeRateLimitError" }); });
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "provider_failed", message: expect.stringMatching(/busy/) });
    const [failed] = await listInvoicePaymentLinks(f.org, f.invoice.id);
    expect(failed).toMatchObject({ state: "failed" });
    // Recovery of a refused create never creates a session.
    calls.length = 0;
    expect((await reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, failed!.id)).state).toBe("failed");
    expect(calls).toHaveLength(0);
    // A fresh link can be made right away.
    expect((await createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).state).toBe("open");

    const g = await readyCompany();
    client.checkout.sessions.create.mockImplementationOnce(async () => { throw Object.assign(new Error("upstream 500"), { type: "StripeAPIError" }); });
    await expect(createInvoicePaymentLink(g.org, g.actor, g.invoice.id)).rejects.toMatchObject({ code: "provider_failed", message: expect.stringMatching(/not responding/) });
    expect((await listInvoicePaymentLinks(g.org, g.invoice.id))[0]).toMatchObject({ state: "needs_reconciliation" });
    await expect(createInvoicePaymentLink(g.org, g.actor, g.invoice.id)).rejects.toMatchObject({ code: "held" });
  });

  it("explains onboarding failures plainly", async () => {
    const f = await fixture();
    client.accounts.create.mockImplementationOnce(async () => { throw Object.assign(new Error("Invalid API Key"), { type: "StripeAuthenticationError" }); });
    await expect(beginStripeConnect(f.org, f.actor)).rejects.toMatchObject({ code: "not_configured", message: expect.stringMatching(/payment key/) });
    expect(await db.select().from(stripeConnectAccountsTable).where(eq(stripeConnectAccountsTable.organizationId, f.org))).toHaveLength(0);
  });
});

it("keeps the schema's mode constraint", async () => {
  const f = await fixture();
  await expect(db.insert(stripeConnectAccountsTable).values({ organizationId: f.org, stripeAccountId: `acct_bad_${f.org}`, mode: "prod" as never })).rejects.toThrow();
  const rows = await db.execute(sql`select count(*)::int as n from stripe_connect_accounts where organization_id = ${f.org}`);
  expect((rows.rows[0] as { n: number }).n).toBe(0);
});
