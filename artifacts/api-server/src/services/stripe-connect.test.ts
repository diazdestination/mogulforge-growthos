import {
  auditEventsTable,
  db,
  invoicePaymentLinksTable,
  stripeConnectAccountsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { invoiceAttemptFixture } from "../test-helpers/invoice-attempt-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getInvoice, recordInvoicePayment } from "./invoices";
import {
  beginStripeConnect,
  createInvoicePaymentLink,
  connectWebhookConfigured,
  disconnectStripe,
  getPaymentAccountStatus,
  handleConnectWebhook,
  listInvoicePaymentLinks,
  refreshStripeAccount,
  reconcileInvoicePaymentLink,
  setConnectStripeForTests,
  stableUuid,
  StripeConnectError,
  StripeConnectWebhookVerificationError,
} from "./stripe-connect";

/** In-memory Stripe: records calls; webhook "signature" must equal "valid". */
const fake = {
  calls: [] as { method: string; args: unknown[] }[],
  sessions: 0,
  account: { id: "acct_synthetic", charges_enabled: false, payouts_enabled: false, details_submitted: false },
};
const client = {
  accounts: {
    create: vi.fn(async (...args: unknown[]) => { fake.calls.push({ method: "accounts.create", args }); return { ...fake.account }; }),
    retrieve: vi.fn(async (...args: unknown[]) => { fake.calls.push({ method: "accounts.retrieve", args }); return { ...fake.account }; }),
  },
  accountLinks: {
    create: vi.fn(async (...args: unknown[]) => { fake.calls.push({ method: "accountLinks.create", args }); return { url: "https://connect.stripe.test/onboard" }; }),
  },
  checkout: {
    sessions: {
      retrieve: vi.fn(),
      expire: vi.fn(),
      create: vi.fn(async (...args: unknown[]) => {
        fake.calls.push({ method: "checkout.sessions.create", args });
        fake.sessions += 1;
        return { id: `cs_test_${fake.sessions}`, url: `https://checkout.stripe.test/c/${fake.sessions}`, expires_at: Math.floor(Date.now() / 1000) + 86_400 };
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

const previous = { secret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET, hold: process.env.GROWTHOS_OUTBOUND_HOLD };
let fixture: Awaited<ReturnType<typeof invoiceAttemptFixture>>;
let otherOrg: Awaited<ReturnType<typeof invoiceAttemptFixture>>;

const event = (type: string, object: Record<string, unknown>, account = "acct_synthetic") =>
  Buffer.from(JSON.stringify({ id: `evt_${Math.random()}`, type, account, livemode: false, data: { object } }));

beforeAll(async () => {
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_synthetic";
  delete process.env.GROWTHOS_OUTBOUND_HOLD;
  setConnectStripeForTests(client as never);
  fixture = await invoiceAttemptFixture();
  otherOrg = await invoiceAttemptFixture();
});

beforeEach(() => {
  fake.calls.length = 0;
});

afterAll(async () => {
  setConnectStripeForTests(undefined);
  for (const f of [fixture, otherOrg]) {
    if (!f) continue;
    await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, f.actor));
    await deleteTestOrgs(f.org);
    await db.delete(usersTable).where(eq(usersTable.id, f.actor));
  }
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = previous.secret;
  if (previous.hold === undefined) delete process.env.GROWTHOS_OUTBOUND_HOLD;
  else process.env.GROWTHOS_OUTBOUND_HOLD = previous.hold;
});

describe("Stripe Connect account", () => {
  it("creates the contractor's account once and returns onboarding", async () => {
    expect(await getPaymentAccountStatus(fixture.org)).toMatchObject({ configured: true, connected: false });
    const first = await beginStripeConnect(fixture.org, fixture.actor);
    expect(first.url).toBe("https://connect.stripe.test/onboard");
    await beginStripeConnect(fixture.org, fixture.actor);
    expect(fake.calls.filter((call) => call.method === "accounts.create")).toHaveLength(1);
    expect((await getPaymentAccountStatus(fixture.org)).connected).toBe(true);
  });

  it("refuses payment links until Stripe reports charges enabled", async () => {
    await expect(createInvoicePaymentLink(fixture.org, fixture.actor, fixture.invoice.id)).rejects.toMatchObject({ code: "not_ready" });
    fake.account.charges_enabled = true;
    fake.account.details_submitted = true;
    expect(await refreshStripeAccount(fixture.org)).toMatchObject({ chargesEnabled: true, detailsSubmitted: true });
  });
});

describe("invoice payment links", () => {
  it("creates one link for the balance on the contractor's account and reuses it", async () => {
    const link = await createInvoicePaymentLink(fixture.org, fixture.actor, fixture.invoice.id);
    expect(link).toMatchObject({ amountCents: 10_000, state: "open", url: "https://checkout.stripe.test/c/1" });
    const create = fake.calls.find((call) => call.method === "checkout.sessions.create")!;
    const [params, options] = create.args as [Record<string, unknown>, Record<string, unknown>];
    expect(options).toMatchObject({ stripeAccount: "acct_synthetic", idempotencyKey: `growthos:invoice-pay:${link.id}` });
    expect(params).toMatchObject({ mode: "payment" });
    expect(params).not.toHaveProperty("payment_method_types");
    expect(JSON.stringify(params)).not.toContain("application_fee_amount");

    const again = await createInvoicePaymentLink(fixture.org, fixture.actor, fixture.invoice.id);
    expect(again.id).toBe(link.id);
    expect(fake.calls.filter((call) => call.method === "checkout.sessions.create")).toHaveLength(1);
  });

  it("refuses another tenant's invoice and the staging hold", async () => {
    await expect(createInvoicePaymentLink(otherOrg.org, otherOrg.actor, fixture.invoice.id)).rejects.toBeInstanceOf(StripeConnectError);
    process.env.GROWTHOS_OUTBOUND_HOLD = "true";
    try {
      await expect(createInvoicePaymentLink(fixture.org, fixture.actor, fixture.invoice.id)).rejects.toMatchObject({ code: "held" });
    } finally {
      delete process.env.GROWTHOS_OUTBOUND_HOLD;
    }
  });
});

describe("Connect webhook", () => {
  it("rejects unsigned events", async () => {
    await expect(handleConnectWebhook(event("checkout.session.completed", {}), "forged")).rejects.toBeInstanceOf(StripeConnectWebhookVerificationError);
  });
  it("refuses signed live-mode events on the sandbox endpoint", async () => {
    await expect(handleConnectWebhook(Buffer.from(JSON.stringify({ id: "evt_live_fixture", type: "account.updated", livemode: true, data: { object: { id: "acct_synthetic" } } })), "valid")).rejects.toBeInstanceOf(StripeConnectWebhookVerificationError);
  });

  it("ignores a session reported by a different connected account", async () => {
    await handleConnectWebhook(event("checkout.session.completed", { id: "cs_test_1", payment_status: "paid", amount_total: 10_000, currency: "usd", payment_intent: "pi_x" }, "acct_attacker"), "valid");
    const [link] = await listInvoicePaymentLinks(fixture.org, fixture.invoice.id);
    expect(link!.state).toBe("open");
  });

  it("holds a bank payment as processing, then records it exactly once on success", async () => {
    const session = { id: "cs_test_1", payment_status: "unpaid", amount_total: 10_000, currency: "usd", payment_intent: "pi_synthetic" };
    await handleConnectWebhook(event("checkout.session.completed", session), "valid");
    expect((await listInvoicePaymentLinks(fixture.org, fixture.invoice.id))[0]!.state).toBe("processing");

    const paid = { ...session, payment_status: "paid" };
    await handleConnectWebhook(event("checkout.session.async_payment_succeeded", paid), "valid");
    await handleConnectWebhook(event("checkout.session.async_payment_succeeded", paid), "valid");

    const [link] = await listInvoicePaymentLinks(fixture.org, fixture.invoice.id);
    expect(link).toMatchObject({ state: "paid", url: null });
    const invoice = await getInvoice(fixture.org, fixture.actor, fixture.invoice.id);
    expect(invoice.recordedPaidCents).toBe(10_000);
    expect(invoice.paymentState).toBe("paid");
    const audits = await db
      .select({ metadata: auditEventsTable.metadata })
      .from(auditEventsTable)
      .where(and(eq(auditEventsTable.organizationId, fixture.org), eq(auditEventsTable.action, "revenue.value_recorded")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ evidence: "stripe_checkout" });
  });

  it("holds a payment it cannot apply exactly for a human instead of guessing", async () => {
    // Fully paid invoice: a second, different payment cannot be applied automatically.
    const [row] = await db
      .insert(invoicePaymentLinksTable)
      .values({ organizationId: fixture.org, invoiceId: fixture.invoice.id, invoiceVersion: 1, amountCents: 10_000, stripeAccountId: "acct_synthetic", checkoutSessionId: "cs_test_extra", createdByUserId: fixture.actor, state: "open" })
      .returning();
    await handleConnectWebhook(event("checkout.session.completed", { id: "cs_test_extra", payment_status: "paid", amount_total: 10_000, currency: "usd", payment_intent: "pi_extra" }), "valid");
    const [held] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, row!.id));
    expect(held!.state).toBe("needs_reconciliation");
    expect((await getInvoice(fixture.org, fixture.actor, fixture.invoice.id)).recordedPaidCents).toBe(10_000);
  });

  it("marks unused links expired and refreshes account flags", async () => {
    const [row] = await db
      .insert(invoicePaymentLinksTable)
      .values({ organizationId: fixture.org, invoiceId: fixture.invoice.id, invoiceVersion: 1, amountCents: 5_000, stripeAccountId: "acct_synthetic", checkoutSessionId: "cs_test_expire", createdByUserId: fixture.actor, state: "open" })
      .returning();
    await handleConnectWebhook(event("checkout.session.expired", { id: "cs_test_expire" }), "valid");
    const [expired] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, row!.id));
    expect(expired!.state).toBe("expired");

    await handleConnectWebhook(event("account.updated", { id: "acct_synthetic", charges_enabled: false, payouts_enabled: true, details_submitted: true }), "valid");
    const [account] = await db.select().from(stripeConnectAccountsTable).where(eq(stripeConnectAccountsTable.organizationId, fixture.org));
    expect(account).toMatchObject({ chargesEnabled: false, payoutsEnabled: true });
  });

  it("disconnects without touching history", async () => {
    expect(await disconnectStripe(fixture.org, fixture.actor)).toBe(true);
    expect((await getPaymentAccountStatus(fixture.org)).connected).toBe(false);
    expect((await listInvoicePaymentLinks(fixture.org, fixture.invoice.id)).length).toBeGreaterThan(0);
  });
});

describe("Connect configuration isolation", () => {
  it("requires explicit sandbox configuration and never uses the subscription or live key", () => {
    const names = ["STRIPE_CONNECT_ENABLED", "STRIPE_CONNECT_SECRET_KEY", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET"] as const;
    const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_fixture";
      process.env.STRIPE_CONNECT_ENABLED = "true";
      process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
      delete process.env.STRIPE_CONNECT_SECRET_KEY;
      setConnectStripeForTests(undefined);
      expect(connectWebhookConfigured()).toBe(false);
      process.env.STRIPE_CONNECT_SECRET_KEY = "sk_live_fixture";
      setConnectStripeForTests(undefined);
      expect(connectWebhookConfigured()).toBe(false);
      process.env.STRIPE_CONNECT_SECRET_KEY = "rk_test_fixture";
      setConnectStripeForTests(undefined);
      expect(connectWebhookConfigured()).toBe(true);
      process.env.STRIPE_CONNECT_ENABLED = "false";
      expect(connectWebhookConfigured()).toBe(false);
    } finally {
      for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
      setConnectStripeForTests(client as never);
    }
  });
});

describe("stableUuid", () => {
  it("is deterministic and RFC 4122 v4 shaped", () => {
    expect(stableUuid("a")).toBe(stableUuid("a"));
    expect(stableUuid("a")).not.toBe(stableUuid("b"));
    expect(stableUuid("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("collection ownership regressions", () => {
  const fixtures: Awaited<ReturnType<typeof invoiceAttemptFixture>>[] = [];
  async function ready() {
    const f = await invoiceAttemptFixture();
    fixtures.push(f);
    fake.account.id = `acct_${f.org}`;
    await beginStripeConnect(f.org, f.actor);
    await db.update(stripeConnectAccountsTable).set({ chargesEnabled: true }).where(eq(stripeConnectAccountsTable.organizationId, f.org));
    return f;
  }
  afterAll(async () => {
    for (const f of fixtures) {
      await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, f.actor));
      await deleteTestOrgs(f.org);
      await db.delete(usersTable).where(eq(usersTable.id, f.actor));
    }
  });
  it("requires a receipt webhook before offering collection", async () => {
    const f = await ready();
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    try {
      await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "not_configured" });
      expect(fake.calls.filter(c => c.method === "checkout.sessions.create")).toHaveLength(0);
    } finally { process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_synthetic"; }
  });
  it("holds onboarding before any provider write", async () => {
    const f = await invoiceAttemptFixture(); fixtures.push(f);
    fake.account.id = `acct_${f.org}`;
    process.env.GROWTHOS_OUTBOUND_HOLD = "true";
    try {
      await expect(beginStripeConnect(f.org, f.actor)).rejects.toMatchObject({ code: "held" });
      expect(fake.calls).toHaveLength(0);
    } finally { delete process.env.GROWTHOS_OUTBOUND_HOLD; }
  });
  it("reserves an invoice before concurrent session creation", async () => {
    const f = await ready();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const called = new Promise<void>(done => { entered = done; });
    client.checkout.sessions.create.mockImplementationOnce(async (...args: unknown[]) => {
      fake.calls.push({ method: "checkout.sessions.create", args }); entered(); await gate;
      return { id: `cs_test_concurrent_${f.org}`, url: "https://checkout.stripe.test/concurrent", expires_at: Math.floor(Date.now() / 1000) + 86400 };
    });
    const first = createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    await called;
    const second = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id).catch(error => error);
    release(); await first;
    expect(second).toMatchObject({ code: "held" });
    expect(fake.calls.filter(c => c.method === "checkout.sessions.create")).toHaveLength(1);
  });
  it("never replaces a bank payment that is still clearing", async () => {
    const f = await ready(); const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const [row] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
    await handleConnectWebhook(event("checkout.session.completed", { id: row!.checkoutSessionId, payment_status: "unpaid" }, row!.stripeAccountId), "valid");
    fake.calls.length = 0;
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "held" });
    expect(fake.calls).toHaveLength(0);
  });
  it("keeps a near-expiry session instead of making a second payable link", async () => {
    const f = await ready(); const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    await db.update(invoicePaymentLinksTable).set({ expiresAt: new Date(Date.now() + 30 * 60_000) }).where(eq(invoicePaymentLinksTable.id, link.id));
    expect((await createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).id).toBe(link.id);
    expect(fake.calls.filter(c => c.method === "checkout.sessions.create")).toHaveLength(1);
  });
  it("holds an ambiguous create instead of retrying with a new idempotency key", async () => {
    const f = await ready();
    client.checkout.sessions.create.mockImplementationOnce(async (...args: unknown[]) => { fake.calls.push({ method: "checkout.sessions.create", args }); throw new Error("response lost"); });
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "provider_failed" });
    await expect(createInvoicePaymentLink(f.org, f.actor, f.invoice.id)).rejects.toMatchObject({ code: "held" });
    expect(fake.calls.filter(c => c.method === "checkout.sessions.create")).toHaveLength(1);
    const [held] = await listInvoicePaymentLinks(f.org, f.invoice.id);
    client.checkout.sessions.retrieve.mockImplementationOnce(async (id: string) => ({ id, livemode: false, metadata: { growthosPaymentLinkId: held!.id, growthosInvoiceId: f.invoice.id, growthosOrganizationId: f.org }, amount_total: 10000, currency: "usd", status: "complete", payment_status: "paid", payment_intent: `pi_recovered_${f.org}` }));
    await reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, held!.id);
    const calls = fake.calls.filter(c => c.method === "checkout.sessions.create");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[1]).toEqual(calls[0]!.args[1]);
    expect(calls[1]!.args[0]).toEqual(calls[0]!.args[0]);
    expect((await listInvoicePaymentLinks(f.org, f.invoice.id))[0]!.state).toBe("paid");
    expect((await getInvoice(f.org, f.actor, f.invoice.id)).recordedPaidCents).toBe(10000);
  });
  it("blocks a manual balance change while Checkout can still collect", async () => {
    const f = await ready(); await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const invoice = await getInvoice(f.org, f.actor, f.invoice.id);
    await expect(recordInvoicePayment(f.org, f.actor, f.invoice.id, { requestId: stableUuid(`manual:${f.org}`), expectedVersion: invoice.version, confirmed: true, amountCents: 1000, sourceReference: `manual:${f.org}`, occurredAt: new Date().toISOString() })).rejects.toMatchObject({ code: "invoice_collection_pending" });
  });
  it("recognizes an already committed exact receipt after an interrupted link update", async () => {
    const f = await ready(); const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const [row] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
    const paid = event("checkout.session.completed", { id: row!.checkoutSessionId, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_${f.org}` }, row!.stripeAccountId);
    await handleConnectWebhook(paid, "valid");
    await db.update(invoicePaymentLinksTable).set({ state: "needs_reconciliation" }).where(eq(invoicePaymentLinksTable.id, link.id));
    await handleConnectWebhook(paid, "valid");
    expect((await listInvoicePaymentLinks(f.org, f.invoice.id))[0]!.state).toBe("paid");
    expect((await getInvoice(f.org, f.actor, f.invoice.id)).recordedPaidCents).toBe(10000);
  });
  it("releases an unpaid reservation only after Stripe confirms expiry", async () => {
    const f = await ready(); const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const [row] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
    const session = { id: row!.checkoutSessionId, livemode: false, metadata: { growthosPaymentLinkId: link.id, growthosInvoiceId: f.invoice.id, growthosOrganizationId: f.org }, currency: "usd", amount_total: 10000, status: "open", payment_status: "unpaid" };
    client.checkout.sessions.retrieve.mockResolvedValueOnce(session);
    client.checkout.sessions.expire.mockResolvedValueOnce({ ...session, status: "expired" });
    expect((await reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, link.id, { expire: true })).state).toBe("expired");
    const invoice = await getInvoice(f.org, f.actor, f.invoice.id);
    await expect(recordInvoicePayment(f.org, f.actor, f.invoice.id, { requestId: stableUuid(`resolved:${f.org}`), expectedVersion: invoice.version, confirmed: true, amountCents: 1000, sourceReference: `resolved:${f.org}`, occurredAt: new Date().toISOString() })).resolves.toMatchObject({ duplicate: false });
  });
  it("never expires or releases a submitted bank payment", async () => {
    const f = await ready(); const link = await createInvoicePaymentLink(f.org, f.actor, f.invoice.id);
    const [row] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
    client.checkout.sessions.expire.mockClear();
    client.checkout.sessions.retrieve.mockResolvedValueOnce({ id: row!.checkoutSessionId, livemode: false, metadata: { growthosPaymentLinkId: link.id, growthosInvoiceId: f.invoice.id, growthosOrganizationId: f.org }, currency: "usd", amount_total: 10000, status: "complete", payment_status: "unpaid" });
    expect((await reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, link.id, { expire: true })).state).toBe("processing");
    expect(client.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it("refuses new requests after the unknown-outcome idempotency window", async () => {
    const f = await ready();
    const [link] = await db.insert(invoicePaymentLinksTable).values({ organizationId: f.org, invoiceId: f.invoice.id, invoiceVersion: 1, amountCents: 10000, stripeAccountId: `acct_${f.org}`, createdByUserId: f.actor, state: "needs_reconciliation", createdAt: new Date(Date.now() - 24 * 60 * 60_000) }).returning();
    await expect(reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, link!.id)).rejects.toMatchObject({ code: "held" });
    expect(fake.calls.filter(c => c.method === "checkout.sessions.create")).toHaveLength(0);
  });
  it("rejects a supplied recovery session belonging to a different reservation", async () => {
    const f = await ready();
    const [link] = await db.insert(invoicePaymentLinksTable).values({ organizationId: f.org, invoiceId: f.invoice.id, invoiceVersion: 1, amountCents: 10000, stripeAccountId: `acct_${f.org}`, createdByUserId: f.actor, state: "needs_reconciliation" }).returning();
    client.checkout.sessions.retrieve.mockResolvedValueOnce({ id: "cs_test_foreign", livemode: false, metadata: { growthosPaymentLinkId: "different" }, amount_total: 10000, currency: "usd", payment_status: "paid" });
    await expect(reconcileInvoicePaymentLink(f.org, f.actor, f.invoice.id, link!.id, { checkoutSessionId: "cs_test_foreign" })).rejects.toMatchObject({ code: "held" });
    expect((await listInvoicePaymentLinks(f.org, f.invoice.id))[0]!.state).toBe("needs_reconciliation");
  });
});
