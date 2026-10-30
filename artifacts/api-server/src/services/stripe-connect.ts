import { createHash } from "node:crypto";

import {
  db,
  invoicePaymentLinksTable,
  invoicesTable,
  stripeConnectAccountsTable,
  usersTable,
  valueEntriesTable,
  type InvoicePaymentLink,
  type InvoicePaymentLinkState,
  type StripeConnectAccount,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import Stripe from "stripe";

import { recordAudit } from "./audit";
import { getInvoice, recordInvoicePayment } from "./invoices";
import { outboundDeliveryHeld } from "./outbound-hold";

/**
 * BILL card & bank collection through Stripe Connect.
 *
 * - Each contractor connects its own Stripe account (Standard). Homeowner
 *   payments settle directly to the contractor; MogulForge never holds funds.
 * - Staff create a payment link for an issued invoice's current balance. The
 *   link is a Stripe Checkout session on the contractor's account (card and
 *   US bank account).
 * - Stripe's signed webhook is the only thing that marks a link paid. The
 *   payment is recorded on the invoice as the staff member who created the
 *   link, with Stripe evidence. Anything that cannot be recorded exactly is
 *   held as `needs_reconciliation` for a human; nothing is guessed or retried.
 */

export class StripeConnectError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "not_connected" | "not_ready" | "invalid" | "not_found" | "provider_failed" | "held",
  ) {
    super(message);
    this.name = "StripeConnectError";
  }
}

export class StripeConnectWebhookVerificationError extends Error {
  constructor() {
    super("Stripe Connect webhook verification failed");
    this.name = "StripeConnectWebhookVerificationError";
  }
}

type StripeLike = Pick<Stripe, "accounts" | "accountLinks" | "checkout" | "webhooks">;

let override: StripeLike | null | undefined;
let cached: StripeLike | null | undefined;

/** Test seam: inject a fake client (or null to simulate "not configured"). */
export function setConnectStripeForTests(client: StripeLike | null | undefined): void {
  override = client;
  cached = undefined;
}

function connectStripe(): StripeLike | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  cached = secret ? new Stripe(secret, { timeout: 10_000, maxNetworkRetries: 0 }) : null;
  return cached;
}

function requireStripe(): StripeLike {
  const client = connectStripe();
  if (!client) throw new StripeConnectError("Card and bank payments are not configured on this GrowthOS deployment.", "not_configured");
  return client;
}

function appOrigin(): string {
  return (process.env.APP_BASE_URL ?? process.env.APP_ORIGIN ?? "http://localhost:5000").trim().replace(/\/$/, "");
}

function applicationFeeCents(amountCents: number): number {
  const bps = Number(process.env.STRIPE_CONNECT_APPLICATION_FEE_BPS ?? "0");
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return Math.floor((amountCents * Math.min(bps, 2000)) / 10000);
}

/** Deterministic RFC 4122 v4-shaped UUID from a stable key (for invoice request ids). */
export function stableUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ---------- connected account ----------

export type PaymentAccountStatus = {
  configured: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  lastSyncedAt: string | null;
};

async function activeAccount(organizationId: string): Promise<StripeConnectAccount | null> {
  const [row] = await db
    .select()
    .from(stripeConnectAccountsTable)
    .where(and(eq(stripeConnectAccountsTable.organizationId, organizationId), isNull(stripeConnectAccountsTable.disconnectedAt)));
  return row ?? null;
}

export async function getPaymentAccountStatus(organizationId: string): Promise<PaymentAccountStatus> {
  const account = await activeAccount(organizationId);
  return {
    configured: connectStripe() !== null,
    connected: account !== null,
    chargesEnabled: account?.chargesEnabled ?? false,
    payoutsEnabled: account?.payoutsEnabled ?? false,
    detailsSubmitted: account?.detailsSubmitted ?? false,
    lastSyncedAt: account?.lastSyncedAt?.toISOString() ?? null,
  };
}

/** Create (once) the contractor's Stripe account and return a Stripe-hosted onboarding URL. */
export async function beginStripeConnect(organizationId: string, userId: string): Promise<{ url: string }> {
  const stripe = requireStripe();
  let account = await activeAccount(organizationId);
  if (!account) {
    const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
    let created: Stripe.Account;
    try {
      created = await stripe.accounts.create(
        { type: "standard", ...(user?.email ? { email: user.email } : {}), metadata: { growthosOrganizationId: organizationId } },
        { idempotencyKey: `growthos:connect:${organizationId}` },
      );
    } catch {
      throw new StripeConnectError("Stripe could not create the payment account. Try again in a moment.", "provider_failed");
    }
    const [existing] = await db
      .select()
      .from(stripeConnectAccountsTable)
      .where(eq(stripeConnectAccountsTable.organizationId, organizationId));
    if (existing) {
      [account] = await db
        .update(stripeConnectAccountsTable)
        .set({ stripeAccountId: created.id, disconnectedAt: null, connectedByUserId: userId, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false })
        .where(eq(stripeConnectAccountsTable.id, existing.id))
        .returning();
    } else {
      [account] = await db
        .insert(stripeConnectAccountsTable)
        .values({ organizationId, stripeAccountId: created.id, connectedByUserId: userId })
        .returning();
    }
    await recordAudit({
      organizationId,
      actorUserId: userId,
      action: "payments.stripe_account_created",
      entityType: "stripe_connect_account",
      entityId: account!.id,
    });
  }
  try {
    const link = await stripe.accountLinks.create({
      account: account!.stripeAccountId,
      type: "account_onboarding",
      refresh_url: `${appOrigin()}/settings?stripe=refresh`,
      return_url: `${appOrigin()}/settings?stripe=return`,
    });
    return { url: link.url };
  } catch {
    throw new StripeConnectError("Stripe could not start onboarding. Try again in a moment.", "provider_failed");
  }
}

function accountFlags(account: Pick<Stripe.Account, "charges_enabled" | "payouts_enabled" | "details_submitted">) {
  return {
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    lastSyncedAt: new Date(),
  };
}

export async function refreshStripeAccount(organizationId: string): Promise<PaymentAccountStatus> {
  const stripe = requireStripe();
  const account = await activeAccount(organizationId);
  if (!account) throw new StripeConnectError("Connect a Stripe account first.", "not_connected");
  let remote: Stripe.Account;
  try {
    remote = await stripe.accounts.retrieve(account.stripeAccountId);
  } catch {
    throw new StripeConnectError("Stripe did not answer. Try again in a moment.", "provider_failed");
  }
  await db.update(stripeConnectAccountsTable).set(accountFlags(remote)).where(eq(stripeConnectAccountsTable.id, account.id));
  return getPaymentAccountStatus(organizationId);
}

export async function disconnectStripe(organizationId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(stripeConnectAccountsTable)
    .set({ disconnectedAt: new Date() })
    .where(and(eq(stripeConnectAccountsTable.organizationId, organizationId), isNull(stripeConnectAccountsTable.disconnectedAt)))
    .returning({ id: stripeConnectAccountsTable.id });
  if (rows.length === 0) return false;
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "payments.stripe_account_disconnected",
    entityType: "stripe_connect_account",
    entityId: rows[0]!.id,
  });
  return true;
}

// ---------- invoice payment links ----------

export type InvoicePaymentLinkView = {
  id: string;
  invoiceId: string;
  invoiceVersion: number;
  amountCents: number;
  url: string | null;
  state: InvoicePaymentLinkState;
  detail: string;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
};

function linkView(row: InvoicePaymentLink): InvoicePaymentLinkView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceVersion: row.invoiceVersion,
    amountCents: row.amountCents,
    url: row.state === "open" ? row.checkoutUrl : null,
    state: row.state,
    detail: row.detail,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listInvoicePaymentLinks(organizationId: string, invoiceId: string): Promise<InvoicePaymentLinkView[]> {
  const rows = await db
    .select()
    .from(invoicePaymentLinksTable)
    .where(and(eq(invoicePaymentLinksTable.organizationId, organizationId), eq(invoicePaymentLinksTable.invoiceId, invoiceId)))
    .orderBy(desc(invoicePaymentLinksTable.createdAt))
    .limit(20);
  return rows.map(linkView);
}

/**
 * Create (or reuse) a Stripe Checkout link for the issued invoice's current
 * balance. The caller must hold invoices.manage; the invoice read re-checks it.
 */
export async function createInvoicePaymentLink(
  organizationId: string,
  userId: string,
  invoiceId: string,
): Promise<InvoicePaymentLinkView> {
  const stripe = requireStripe();
  if (outboundDeliveryHeld()) {
    throw new StripeConnectError("Payment links are disabled by the staging safety hold.", "held");
  }
  const account = await activeAccount(organizationId);
  if (!account) throw new StripeConnectError("Connect a Stripe account in Settings first.", "not_connected");
  if (!account.chargesEnabled) {
    throw new StripeConnectError("Finish Stripe onboarding before collecting payments.", "not_ready");
  }
  const invoice = await getInvoice(organizationId, userId, invoiceId);
  if (invoice.status !== "issued") throw new StripeConnectError("Only an issued invoice can be paid online.", "invalid");
  if (invoice.reconciliationRequired) {
    throw new StripeConnectError("Reconcile this invoice's recorded payments before collecting more.", "invalid");
  }
  const amountCents = invoice.balanceDueCents ?? 0;
  if (amountCents < 50) throw new StripeConnectError("This invoice has no balance to collect.", "invalid");

  const now = new Date();
  const [reusable] = await db
    .select()
    .from(invoicePaymentLinksTable)
    .where(
      and(
        eq(invoicePaymentLinksTable.organizationId, organizationId),
        eq(invoicePaymentLinksTable.invoiceId, invoiceId),
        eq(invoicePaymentLinksTable.invoiceVersion, invoice.version),
        eq(invoicePaymentLinksTable.amountCents, amountCents),
        eq(invoicePaymentLinksTable.stripeAccountId, account.stripeAccountId),
        eq(invoicePaymentLinksTable.state, "open"),
        gt(invoicePaymentLinksTable.expiresAt, new Date(now.getTime() + 60 * 60_000)),
      ),
    )
    .orderBy(desc(invoicePaymentLinksTable.createdAt))
    .limit(1);
  if (reusable?.checkoutUrl) return linkView(reusable);

  const [link] = await db
    .insert(invoicePaymentLinksTable)
    .values({
      organizationId,
      invoiceId,
      invoiceVersion: invoice.version,
      amountCents,
      stripeAccountId: account.stripeAccountId,
      createdByUserId: userId,
      state: "open",
    })
    .returning();
  const fee = applicationFeeCents(amountCents);
  const metadata = { growthosOrganizationId: organizationId, growthosInvoiceId: invoiceId, growthosPaymentLinkId: link!.id };
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card", "us_bank_account"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amountCents,
              product_data: { name: [`Invoice ${invoice.invoiceNumber ?? ""}`.trim(), invoice.title].filter(Boolean).join(" — ").slice(0, 200) },
            },
          },
        ],
        success_url: `${appOrigin()}/pay/complete`,
        cancel_url: `${appOrigin()}/pay/canceled`,
        metadata,
        payment_intent_data: { metadata, ...(fee > 0 ? { application_fee_amount: fee } : {}) },
      },
      { stripeAccount: account.stripeAccountId, idempotencyKey: `growthos:invoice-pay:${link!.id}` },
    );
  } catch {
    await db
      .update(invoicePaymentLinksTable)
      .set({ state: "failed", detail: "Stripe could not create the payment link." })
      .where(eq(invoicePaymentLinksTable.id, link!.id));
    throw new StripeConnectError("Stripe could not create the payment link. Try again in a moment.", "provider_failed");
  }
  const [updated] = await db
    .update(invoicePaymentLinksTable)
    .set({
      checkoutSessionId: session.id,
      checkoutUrl: session.url ?? null,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
    })
    .where(eq(invoicePaymentLinksTable.id, link!.id))
    .returning();
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "payments.invoice_link_created",
    entityType: "invoice_payment_link",
    entityId: link!.id,
    metadata: { invoiceId, invoiceVersion: invoice.version, amountCents, applicationFeeCents: fee },
  });
  return linkView(updated!);
}

// ---------- webhook ----------

async function transition(
  linkId: string,
  from: InvoicePaymentLinkState[],
  patch: Partial<typeof invoicePaymentLinksTable.$inferInsert> & { state: InvoicePaymentLinkState },
): Promise<InvoicePaymentLink | null> {
  const [row] = await db
    .update(invoicePaymentLinksTable)
    .set(patch)
    .where(and(eq(invoicePaymentLinksTable.id, linkId), inArray(invoicePaymentLinksTable.state, from)))
    .returning();
  return row ?? null;
}

async function linkForSession(session: Stripe.Checkout.Session, account: string | undefined): Promise<InvoicePaymentLink | null> {
  if (!account) return null;
  const [row] = await db
    .select()
    .from(invoicePaymentLinksTable)
    .where(and(eq(invoicePaymentLinksTable.checkoutSessionId, session.id), eq(invoicePaymentLinksTable.stripeAccountId, account)));
  return row ?? null;
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  const intent = session.payment_intent;
  if (!intent) return null;
  return typeof intent === "string" ? intent : intent.id;
}

/** Record a Stripe-confirmed payment on the invoice exactly once, or hold it for a human. */
async function recordPaid(link: InvoicePaymentLink, session: Stripe.Checkout.Session): Promise<void> {
  if (link.state === "paid" || link.state === "needs_reconciliation") return;
  const intentId = paymentIntentId(session);
  const amountCents = session.amount_total ?? 0;
  const sourceReference = `stripe:${intentId ?? session.id}`;
  const hold = async (detail: string) => {
    await transition(link.id, ["open", "processing", "expired", "failed"], {
      state: "needs_reconciliation",
      detail,
      paymentIntentId: intentId,
      paidAt: new Date(),
    });
    await recordAudit({
      organizationId: link.organizationId,
      actorUserId: null,
      action: "payments.invoice_link_needs_reconciliation",
      entityType: "invoice_payment_link",
      entityId: link.id,
      metadata: { invoiceId: link.invoiceId, amountCents, sourceReference },
    });
  };
  if (amountCents <= 0 || session.currency !== "usd") {
    await hold("Stripe reported a payment GrowthOS cannot record automatically. Review it in Stripe and record it by hand.");
    return;
  }
  const [invoice] = await db
    .select({ version: invoicesTable.version })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.organizationId, link.organizationId), eq(invoicesTable.id, link.invoiceId)));
  if (!invoice) {
    await hold("The invoice for this payment no longer exists.");
    return;
  }
  try {
    await recordInvoicePayment(
      link.organizationId,
      link.createdByUserId,
      link.invoiceId,
      {
        requestId: stableUuid(`stripe-payment:${session.id}`),
        expectedVersion: invoice.version,
        confirmed: true,
        amountCents,
        sourceReference,
        occurredAt: new Date().toISOString(),
      },
      undefined,
      { evidence: "stripe_checkout" },
    );
  } catch {
    await hold("Stripe confirmed this payment, but it could not be applied to the invoice automatically (the invoice changed, the balance differs, or the staff member who created the link is no longer active). Record it by hand.");
    return;
  }
  const [entry] = await db
    .select({ id: valueEntriesTable.id })
    .from(valueEntriesTable)
    .where(and(eq(valueEntriesTable.organizationId, link.organizationId), eq(valueEntriesTable.sourceReference, sourceReference)));
  await transition(link.id, ["open", "processing", "expired", "failed"], {
    state: "paid",
    detail: "Paid through Stripe and recorded on the invoice.",
    paymentIntentId: intentId,
    recordedValueEntryId: entry?.id ?? null,
    paidAt: new Date(),
  });
}

export function connectWebhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim()) && connectStripe() !== null;
}

export async function handleConnectWebhook(rawBody: Buffer, signature: string | undefined): Promise<string> {
  const stripe = requireStripe();
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) throw new StripeConnectWebhookVerificationError();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new StripeConnectWebhookVerificationError();
  }
  const account = event.account ?? undefined;
  switch (event.type) {
    case "account.updated": {
      const remote = event.data.object as Stripe.Account;
      await db
        .update(stripeConnectAccountsTable)
        .set(accountFlags(remote))
        .where(eq(stripeConnectAccountsTable.stripeAccountId, remote.id));
      break;
    }
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const link = await linkForSession(session, account);
      if (!link) break;
      if (session.payment_status === "paid") await recordPaid(link, session);
      else await transition(link.id, ["open"], { state: "processing", detail: "Bank payment submitted; waiting for it to clear." });
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const link = await linkForSession(session, account);
      if (link) await recordPaid(link, session);
      break;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const link = await linkForSession(session, account);
      if (link) await transition(link.id, ["open", "processing"], { state: "failed", detail: "The bank payment did not clear." });
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      const link = await linkForSession(session, account);
      if (link) await transition(link.id, ["open"], { state: "expired", detail: "The payment link expired unused." });
      break;
    }
    default:
      break;
  }
  return event.type;
}
