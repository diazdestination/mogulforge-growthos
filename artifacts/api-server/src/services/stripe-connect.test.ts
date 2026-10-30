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
import { getInvoice } from "./invoices";
import {
  beginStripeConnect,
  createInvoicePaymentLink,
  disconnectStripe,
  getPaymentAccountStatus,
  handleConnectWebhook,
  listInvoicePaymentLinks,
  refreshStripeAccount,
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
  Buffer.from(JSON.stringify({ id: `evt_${Math.random()}`, type, account, data: { object } }));

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
    expect(params).toMatchObject({ mode: "payment", payment_method_types: ["card", "us_bank_account"] });
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

describe("stableUuid", () => {
  it("is deterministic and RFC 4122 v4 shaped", () => {
    expect(stableUuid("a")).toBe(stableUuid("a"));
    expect(stableUuid("a")).not.toBe(stableUuid("b"));
    expect(stableUuid("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
