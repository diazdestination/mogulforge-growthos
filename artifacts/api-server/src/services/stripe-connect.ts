import { createHash } from "node:crypto";

import {
  db,
  invoicePaymentLinksTable,
  invoiceReceiptAllocationsTable,
  invoicesTable,
  stripeConnectAccountsTable,
  usersTable,
  valueEntriesTable,
  type InvoicePaymentLink,
  type InvoicePaymentLinkState,
  type StripeConnectAccount,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import Stripe from "stripe";

import { recordAudit } from "./audit";
import { getInvoice, readInvoiceDetail, recordInvoicePayment } from "./invoices";
import { outboundDeliveryHeld } from "./outbound-hold";
import { lockCustomerWork } from "./customer-work-lineage";

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
  if (process.env.STRIPE_CONNECT_ENABLED !== "true") return null;
  if (cached !== undefined) return cached;
  // This rollout is sandbox-only. Never let a subscription key enable invoice
  // collection, or allow a live key to enter a sandbox deployment.
  const secret = process.env.STRIPE_CONNECT_SECRET_KEY?.trim();
  if (!secret || !/^(?:sk|rk)_test_/.test(secret)) return null;
  cached = secret ? new Stripe(secret, { timeout: 10_000, maxNetworkRetries: 0 }) : null;
  return cached;
}

function requireStripe(): StripeLike {
  const client = connectStripe();
  if (!client || !process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim()) throw new StripeConnectError("Sandbox payments need their own Stripe key and receipt webhook configuration.", "not_configured");
  return client;
}

function assertDispatchAllowed(): void {
  if (outboundDeliveryHeld()) throw new StripeConnectError("Stripe requests are disabled by the outbound safety hold.", "held");
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
    configured: connectWebhookConfigured(),
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
  assertDispatchAllowed();
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
    assertDispatchAllowed();
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
  assertDispatchAllowed();
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
  sourceReference: string | null;
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
    sourceReference: row.paymentIntentId ? `stripe:${row.paymentIntentId}` : row.checkoutSessionId ? `stripe:${row.checkoutSessionId}` : null,
  };
}

export async function listInvoicePaymentLinks(organizationId: string, invoiceId: string): Promise<InvoicePaymentLinkView[]> {
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.organizationId, organizationId), eq(invoicesTable.id, invoiceId)));
  const rows = await db
    .select()
    .from(invoicePaymentLinksTable)
    .where(and(eq(invoicePaymentLinksTable.organizationId, organizationId), eq(invoicePaymentLinksTable.invoiceId, invoiceId)))
    .orderBy(desc(invoicePaymentLinksTable.createdAt))
    .limit(20);
  return rows.map(row => {
    const view = linkView(row);
    if (!invoice || invoice.status !== "issued" || invoice.version !== row.invoiceVersion || (row.expiresAt && row.expiresAt <= new Date())) view.url = null;
    return view;
  });
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
  // Own the balance before the provider call. A second request sees the durable
  // reservation even if this process loses the Checkout response or stops.
  const reservation = await db.transaction(async tx => {
    await lockCustomerWork(tx, organizationId, true);
    const invoice = await readInvoiceDetail(tx, organizationId, userId, invoiceId, { lockRows: true });
    if (invoice.status !== "issued" || invoice.reconciliationRequired) throw new StripeConnectError("Review the issued invoice before collecting payments.", "invalid");
    const amountCents = invoice.balanceDueCents ?? 0;
    if (amountCents < 50) throw new StripeConnectError("This invoice has no balance to collect.", "invalid");
    const pending = await tx.select().from(invoicePaymentLinksTable).where(and(
      eq(invoicePaymentLinksTable.organizationId, organizationId), eq(invoicePaymentLinksTable.invoiceId, invoiceId),
      inArray(invoicePaymentLinksTable.state, ["open", "processing", "needs_reconciliation"]),
    ));
    if (pending.length) {
      const reusable = pending.length === 1 ? pending[0] : null;
      if (reusable?.state === "open" && reusable.checkoutUrl && reusable.invoiceVersion === invoice.version && reusable.amountCents === amountCents && reusable.stripeAccountId === account.stripeAccountId && reusable.expiresAt && reusable.expiresAt > new Date()) return { existing: reusable, invoice, link: reusable };
      throw new StripeConnectError("An existing collection is pending or needs review. Resolve it in Stripe before creating another link.", "held");
    }
    const [link] = await tx.insert(invoicePaymentLinksTable).values({ organizationId, invoiceId, invoiceVersion: invoice.version, amountCents, stripeAccountId: account.stripeAccountId, createdByUserId: userId, state: "open", detail: "Checkout creation is pending; do not create another collection." }).returning();
    return { existing: null, invoice, link: link! };
  });
  if (reservation.existing) return linkView(reservation.existing);
  return createReservedCheckout(reservation.link, reservation.invoice);
}

async function createReservedCheckout(link: InvoicePaymentLink, invoice: Awaited<ReturnType<typeof readInvoiceDetail>>): Promise<InvoicePaymentLinkView> {
  const stripe = requireStripe();
  const { organizationId, invoiceId, createdByUserId: userId } = link;
  const amountCents = link.amountCents;
  const fee = applicationFeeCents(amountCents);
  const metadata = { growthosOrganizationId: organizationId, growthosInvoiceId: invoiceId, growthosPaymentLinkId: link!.id };
  let session: Stripe.Checkout.Session;
  try {
    assertDispatchAllowed();
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
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
      { stripeAccount: link.stripeAccountId, idempotencyKey: `growthos:invoice-pay:${link!.id}` },
    );
  } catch {
    await db
      .update(invoicePaymentLinksTable)
      .set({ state: "needs_reconciliation", detail: "Checkout creation was not confirmed. Review this reservation in Stripe; do not start another collection." })
      .where(and(eq(invoicePaymentLinksTable.id, link!.id), isNull(invoicePaymentLinksTable.checkoutSessionId)));
    throw new StripeConnectError("Stripe could not create the payment link. Try again in a moment.", "provider_failed");
  }
  if (session.livemode === true || !session.id.startsWith("cs_test_")) throw new StripeConnectError("Stripe returned a session outside the sandbox. Collection remains held.", "held");
  const [updated] = await db
    .update(invoicePaymentLinksTable)
    .set({
      checkoutSessionId: session.id,
      checkoutUrl: session.url ?? null,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
      detail: "Waiting for payment in the Stripe sandbox.",
      state: "open",
    })
    .where(and(eq(invoicePaymentLinksTable.id, link!.id), inArray(invoicePaymentLinksTable.state, ["open", "needs_reconciliation"]), isNull(invoicePaymentLinksTable.paidAt)))
    .returning();
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "payments.invoice_link_created",
    entityType: "invoice_payment_link",
    entityId: link!.id,
    metadata: { invoiceId, invoiceVersion: invoice.version, amountCents, applicationFeeCents: fee },
  });
  if (updated) return linkView(updated);
  const [current] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
  return linkView(current!);
}

/** Explicit staff recovery. Unknown creates reuse their original key only within
 * a 23-hour safety window; older attempts require an exact sandbox session. */
export async function reconcileInvoicePaymentLink(organizationId: string, userId: string, invoiceId: string, linkId: string, options: { checkoutSessionId?: string; expire?: boolean } = {}): Promise<InvoicePaymentLinkView> {
  const stripe = requireStripe();
  assertDispatchAllowed();
  const invoice = await getInvoice(organizationId, userId, invoiceId);
  let [link] = await db.select().from(invoicePaymentLinksTable).where(and(eq(invoicePaymentLinksTable.id, linkId), eq(invoicePaymentLinksTable.organizationId, organizationId), eq(invoicePaymentLinksTable.invoiceId, invoiceId)));
  if (!link) throw new StripeConnectError("Payment link not found.", "not_found");
  if (link.state === "paid") return linkView(link);
  let sessionId = link.checkoutSessionId ?? options.checkoutSessionId;
  if (!sessionId) {
    if (Date.now() - link.createdAt.getTime() >= 23 * 60 * 60_000 || invoice.version !== link.invoiceVersion || invoice.balanceDueCents !== link.amountCents) throw new StripeConnectError("The original request cannot safely be retried. Find the exact Checkout session in Stripe and provide its sandbox session ID for review.", "held");
    await recordAudit({ organizationId, actorUserId: userId, action: "payments.invoice_link_original_request_recovery", entityType: "invoice_payment_link", entityId: link.id });
    await createReservedCheckout(link, invoice);
    const [recovered] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
    link = recovered!;
    sessionId = link.checkoutSessionId ?? undefined;
    if (!sessionId) throw new StripeConnectError("Stripe has not returned the original session. Keep this collection on hold.", "held");
  }
  if (!sessionId.startsWith("cs_test_") || (options.checkoutSessionId && options.checkoutSessionId !== sessionId)) throw new StripeConnectError("Provide the original sandbox Checkout session.", "invalid");
  assertDispatchAllowed();
  let session = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: link.stripeAccountId });
  const metadata = session.metadata;
  if (session.id !== sessionId || session.livemode !== false || metadata?.growthosPaymentLinkId !== link.id || metadata?.growthosInvoiceId !== invoiceId || metadata?.growthosOrganizationId !== organizationId || session.amount_total !== link.amountCents || session.currency !== "usd") throw new StripeConnectError("Stripe session does not match this reserved collection.", "held");
  if (!link.checkoutSessionId) {
    const [bound] = await db.update(invoicePaymentLinksTable).set({ checkoutSessionId: session.id, checkoutUrl: session.url, expiresAt: new Date(session.expires_at * 1000) }).where(and(eq(invoicePaymentLinksTable.id, link.id), isNull(invoicePaymentLinksTable.checkoutSessionId))).returning();
    if (!bound) throw new StripeConnectError("Collection changed; refresh before reviewing it again.", "held");
    link = bound;
  }
  if (session.payment_status === "paid") {
    await recordPaid(link, session);
  } else if (session.status === "complete") {
    await transition(link.id, ["open", "needs_reconciliation"], { state: "processing", detail: "Bank payment submitted; waiting for it to clear.", paidAt: null });
  } else {
    if (options.expire && session.status === "open") {
      assertDispatchAllowed();
      session = await stripe.checkout.sessions.expire(session.id, {}, { stripeAccount: link.stripeAccountId });
    }
    if (session.status === "expired" && session.payment_status === "unpaid" && session.id === sessionId && session.livemode === false) {
      await transition(link.id, ["open", "needs_reconciliation"], { state: "expired", detail: "Stripe confirmed this Checkout expired without payment.", paidAt: null });
    } else if (session.status === "open" && invoice.version === link.invoiceVersion && invoice.balanceDueCents === link.amountCents) {
      await transition(link.id, ["needs_reconciliation"], { state: "open", detail: "Original sandbox Checkout recovered.", checkoutUrl: session.url, expiresAt: new Date(session.expires_at * 1000) });
    } else throw new StripeConnectError("Stripe has not confirmed a safe resolution. Keep the collection on hold.", "held");
  }
  await recordAudit({ organizationId, actorUserId: userId, action: "payments.invoice_link_reconciled", entityType: "invoice_payment_link", entityId: link.id, metadata: { sessionId, requestedExpiry: options.expire === true } });
  const [current] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
  return linkView(current!);
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

async function recordedEntry(link: InvoicePaymentLink, sourceReference: string): Promise<string | null> {
  const rows = await db.select({ entry: valueEntriesTable, allocation: invoiceReceiptAllocationsTable })
    .from(valueEntriesTable).innerJoin(invoiceReceiptAllocationsTable, and(
      eq(invoiceReceiptAllocationsTable.valueEntryId, valueEntriesTable.id),
      eq(invoiceReceiptAllocationsTable.organizationId, link.organizationId),
      eq(invoiceReceiptAllocationsTable.invoiceId, link.invoiceId),
      eq(invoiceReceiptAllocationsTable.kind, "payment"),
      eq(invoiceReceiptAllocationsTable.amountCents, link.amountCents),
    )).where(and(eq(valueEntriesTable.organizationId, link.organizationId), eq(valueEntriesTable.sourceReference, sourceReference), eq(valueEntriesTable.kind, "payment"), eq(valueEntriesTable.amountCents, link.amountCents))).limit(2);
  if (rows.length !== 1) return null;
  const [reversal] = await db.select({ id: invoiceReceiptAllocationsTable.id }).from(invoiceReceiptAllocationsTable).where(eq(invoiceReceiptAllocationsTable.reversesAllocationId, rows[0]!.allocation.id)).limit(1);
  return reversal ? null : rows[0]!.entry.id;
}

/** Record a Stripe-confirmed payment on the invoice exactly once, or hold it for a human. */
async function recordPaid(link: InvoicePaymentLink, session: Stripe.Checkout.Session): Promise<void> {
  if (link.state === "paid") return;
  const intentId = paymentIntentId(session);
  const amountCents = session.amount_total ?? 0;
  const sourceReference = `stripe:${intentId ?? session.id}`;
  const hold = async (detail: string) => {
    await transition(link.id, ["open", "processing", "expired", "failed", "needs_reconciliation"], {
      state: "needs_reconciliation",
      detail,
      paymentIntentId: intentId,
      paidAt: session.payment_status === "paid" ? link.paidAt ?? new Date() : null,
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
  if (amountCents !== link.amountCents || session.currency !== "usd" || session.payment_status !== "paid") {
    await hold("Stripe reported a payment GrowthOS cannot record automatically. Review it in Stripe and record it by hand.");
    return;
  }
  const finish = async (entryId: string) => transition(link.id, ["open", "processing", "expired", "failed", "needs_reconciliation"], {
    state: "paid", detail: "Paid through Stripe and recorded on the invoice.", paymentIntentId: intentId, recordedValueEntryId: entryId,
    paidAt: link.paidAt ?? new Date(),
  });
  const existing = await recordedEntry(link, sourceReference);
  if (existing) { await finish(existing); return; }
  // Persist one timestamp before attempting the receipt so interrupted replay
  // has the same fingerprint and never assigns the link-creation date to cash.
  if (!link.paidAt) {
    await db.update(invoicePaymentLinksTable).set({ paidAt: new Date() }).where(and(eq(invoicePaymentLinksTable.id, link.id), isNull(invoicePaymentLinksTable.paidAt)));
    const [fresh] = await db.select().from(invoicePaymentLinksTable).where(eq(invoicePaymentLinksTable.id, link.id));
    link = fresh!;
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
        expectedVersion: link.invoiceVersion,
        confirmed: true,
        amountCents,
        sourceReference,
        occurredAt: link.paidAt!.toISOString(),
      },
      undefined,
      { evidence: "stripe_checkout" },
    );
  } catch {
    const committed = await recordedEntry(link, sourceReference);
    if (committed) { await finish(committed); return; }
    await hold("Stripe confirmed this payment, but it could not be applied to the invoice automatically (the invoice changed, the balance differs, or the staff member who created the link is no longer active). Record it by hand.");
    return;
  }
  const entryId = await recordedEntry(link, sourceReference);
  if (!entryId) throw new StripeConnectError("Receipt confirmation is pending; retry delivery.", "held");
  await finish(entryId);
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
  if (event.livemode !== false) throw new StripeConnectWebhookVerificationError();
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
