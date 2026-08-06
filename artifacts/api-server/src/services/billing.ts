import Stripe from 'stripe';
import { db, organizationsTable, type Organization } from '@workspace/db';
import { eq } from 'drizzle-orm';

/**
 * Stripe billing — entirely OPTIONAL.
 *
 * With no STRIPE_SECRET_KEY the module is a no-op: `isBillingEnabled()` is false,
 * the paywall never enforces, and the app runs as a free/unlimited beta.
 *
 * Env:
 *   STRIPE_SECRET_KEY     enables billing
 *   STRIPE_PRICE_ID       the subscription price to sell (enables checkout)
 *   STRIPE_WEBHOOK_SECRET verifies incoming webhooks
 *   BILLING_ENFORCE=true  actually gate access on subscription status (default: off)
 */
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe: Stripe | null = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

const ACTIVE_STATUSES = new Set(['trialing', 'active']);

export function isBillingEnabled(): boolean {
  return stripe !== null;
}

/** Whether access should actually be blocked for non-subscribers. Off unless
 *  billing is configured AND BILLING_ENFORCE=true — so beta is never gated. */
export function isPaywallEnforced(): boolean {
  return isBillingEnabled() && process.env.BILLING_ENFORCE === 'true';
}

export function hasActiveAccess(org: Pick<Organization, 'subscriptionStatus'>): boolean {
  if (!isPaywallEnforced()) return true;
  return !!org.subscriptionStatus && ACTIVE_STATUSES.has(org.subscriptionStatus);
}

export interface BillingStatus {
  enabled: boolean;
  enforced: boolean;
  canCheckout: boolean;
  status: string | null;
  planTier: string | null;
  trialEndsAt: string | null;
  hasAccess: boolean;
}

export function getBillingStatus(org: Organization): BillingStatus {
  return {
    enabled: isBillingEnabled(),
    enforced: isPaywallEnforced(),
    canCheckout: isBillingEnabled() && !!PRICE_ID,
    status: org.subscriptionStatus ?? null,
    planTier: org.planTier ?? null,
    trialEndsAt: org.trialEndsAt ? org.trialEndsAt.toISOString() : null,
    hasAccess: hasActiveAccess(org),
  };
}

function requireStripe(): Stripe {
  if (!stripe) throw new Error('Billing is not configured (STRIPE_SECRET_KEY unset)');
  return stripe;
}

/** Get or create the Stripe customer for an org and persist its id. */
async function ensureCustomer(org: Organization): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const s = requireStripe();
  const customer = await s.customers.create({
    name: org.name,
    metadata: { organizationId: org.id, slug: org.slug },
  });
  await db
    .update(organizationsTable)
    .set({ stripeCustomerId: customer.id })
    .where(eq(organizationsTable.id, org.id));
  return customer.id;
}

export async function createCheckoutSession(
  org: Organization,
  opts: { successUrl: string; cancelUrl: string; trialDays?: number },
): Promise<string> {
  const s = requireStripe();
  if (!PRICE_ID) throw new Error('No STRIPE_PRICE_ID configured');
  const customerId = await ensureCustomer(org);
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    subscription_data: opts.trialDays
      ? { trial_period_days: opts.trialDays, metadata: { organizationId: org.id } }
      : { metadata: { organizationId: org.id } },
    metadata: { organizationId: org.id },
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

export async function createPortalSession(
  org: Organization,
  returnUrl: string,
): Promise<string> {
  const s = requireStripe();
  const customerId = await ensureCustomer(org);
  const session = await s.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

/** Persist subscription state from a Stripe Subscription onto its org. */
async function syncSubscription(sub: Stripe.Subscription): Promise<void> {
  const orgId =
    (sub.metadata?.organizationId as string | undefined) ??
    (await orgIdForCustomer(sub.customer));
  if (!orgId) return;
  const priceId = sub.items.data[0]?.price?.id ?? null;
  await db
    .update(organizationsTable)
    .set({
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      planTier: priceId,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    })
    .where(eq(organizationsTable.id, orgId));
}

async function orgIdForCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer,
): Promise<string | null> {
  const customerId = typeof customer === 'string' ? customer : customer.id;
  const [org] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.stripeCustomerId, customerId));
  return org?.id ?? null;
}

/** Verify + handle a Stripe webhook. Returns the event type handled. */
export async function handleWebhook(
  rawBody: Buffer | string,
  signature: string | undefined,
): Promise<string> {
  const s = requireStripe();
  if (!WEBHOOK_SECRET) throw new Error('No STRIPE_WEBHOOK_SECRET configured');
  if (!signature) throw new Error('Missing stripe-signature header');
  const event = s.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
        const sub = await s.subscriptions.retrieve(subId);
        await syncSubscription(sub);
      }
      break;
    }
    default:
      break;
  }
  return event.type;
}
