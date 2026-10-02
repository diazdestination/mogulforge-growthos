import Stripe from 'stripe';
import { auditEventsTable, db, organizationsTable, type Organization } from '@workspace/db';
import { and, eq, sql } from 'drizzle-orm';
import { mappedPlanForPrice, resolveEntitlements, type EntitlementStatus } from './entitlements';

/**
 * Stripe billing — entirely OPTIONAL.
 *
 * With no STRIPE_SECRET_KEY online billing is disabled and the general paywall
 * does not enforce. Explicitly assigned capability policies still apply.
 *
 * Env:
 *   STRIPE_SECRET_KEY     enables billing
 *   STRIPE_PRICE_ID       the subscription price to sell (enables checkout)
 *   STRIPE_PLAN_PRICE_MAP JSON allowlist from Stripe price IDs to beta/growth/scale
 *   STRIPE_WEBHOOK_SECRET verifies incoming webhooks
 *   BILLING_ENFORCE=true  actually gate access on subscription status (default: off)
 */
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Provider reads occur inside the tenant reconciliation lock. Bound network time
// and let Stripe redeliver failed webhooks instead of retrying while holding it.
const stripe: Stripe | null = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { timeout: 10_000, maxNetworkRetries: 0 }) : null;

const ACTIVE_STATUSES = new Set(['trialing', 'active']);

export function isBillingEnabled(): boolean {
  return stripe !== null;
}

/** Optional general subscription paywall; capability policies are independent. */
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
  hasSubscription: boolean;
  entitlements: EntitlementStatus;
}

export function getBillingStatus(org: Organization): BillingStatus {
  return {
    enabled: isBillingEnabled(),
    enforced: isPaywallEnforced(),
    canCheckout: isBillingEnabled() && !org.stripeSubscriptionId && !!mappedPlanForPrice(PRICE_ID ?? null),
    status: org.subscriptionStatus ?? null,
    planTier: org.planTier ?? null,
    trialEndsAt: org.trialEndsAt ? org.trialEndsAt.toISOString() : null,
    hasAccess: hasActiveAccess(org),
    hasSubscription: Boolean(org.stripeSubscriptionId),
    entitlements: resolveEntitlements(org),
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
  // A canceled subscription remains bound until an operator reconciles its
  // replacement. Creating another would charge a subscription sync cannot bind.
  if (org.stripeSubscriptionId) throw new BillingCheckoutConflictError();
  const s = requireStripe();
  if (!PRICE_ID) throw new Error('No STRIPE_PRICE_ID configured');
  if (!mappedPlanForPrice(PRICE_ID)) throw new Error('The checkout price has no approved internal plan mapping');
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

async function orgIdForCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer,
): Promise<string | null> {
  const customerId = typeof customer === 'string' ? customer : customer.id;
  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.stripeCustomerId, customerId));
  return orgs.length === 1 ? orgs[0].id : null;
}

export class BillingCheckoutConflictError extends Error {
  readonly status = 409;
  readonly code = 'subscription_already_bound';
  constructor() {
    super('This company already has a linked subscription. Manage it in the billing portal or contact your GrowthOS operator before starting another subscription.');
    this.name = 'BillingCheckoutConflictError';
  }
}

/**
 * Stripe deliveries can be duplicated or arrive out of order. Serialize per
 * tenant, retrieve current provider state while holding that lock, and persist
 * the state plus dedupe audit atomically. No event snapshot can rewind access.
 */
async function syncSubscriptionEvent(event: Stripe.Event, subscriptionId: string, customer: string | Stripe.Customer | Stripe.DeletedCustomer): Promise<void> {
  const orgId = await orgIdForCustomer(customer);
  if (!orgId) throw new Error('Stripe customer is not bound to exactly one organization');
  const customerId = typeof customer === 'string' ? customer : customer.id;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true), set_config('statement_timeout', '15000ms', true), set_config('idle_in_transaction_session_timeout', '20000ms', true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${orgId}`}, 0))`);
    const [seen] = await tx.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(
      eq(auditEventsTable.organizationId, orgId),
      eq(auditEventsTable.action, 'billing.subscription_synced'),
      sql`${auditEventsTable.metadata}->>'stripeEventId' = ${event.id}`,
    )).limit(1);
    if (seen) return;
    const [org] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (!org || org.stripeCustomerId !== customerId) throw new Error('Stripe customer binding changed');
    if (org.stripeSubscriptionId && org.stripeSubscriptionId !== subscriptionId) {
      throw new Error('Another subscription is bound to this organization; operator reconciliation is required');
    }
    // Retrieve after acquiring the lock: retrieving outside it allows an older
    // response to overwrite a later one under concurrent webhook delivery.
    const sub = await requireStripe().subscriptions.retrieve(subscriptionId);
    const actualCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    if (actualCustomerId !== customerId || (sub.metadata?.organizationId && sub.metadata.organizationId !== orgId)) {
      throw new Error('Stripe subscription organization does not match its bound customer');
    }
    const priceId = sub.items.data.length === 1 && sub.items.data[0].quantity === 1
      ? sub.items.data[0].price.id : null;
    const mappedPlan = mappedPlanForPrice(priceId);
    // Only explicitly enrolled Stripe-managed tenants follow mapped prices.
    // Null/legacy and manual grants never change merely because an event arrives.
    const entitlements = org.entitlements?.version === 1 && org.entitlements.source === 'stripe' && mappedPlan
      ? { ...org.entitlements, planId: mappedPlan }
      : org.entitlements;
    await tx.update(organizationsTable).set({
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      planTier: priceId,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      entitlements,
    }).where(eq(organizationsTable.id, orgId));
    await tx.insert(auditEventsTable).values({
      organizationId: orgId,
      action: 'billing.subscription_synced',
      entityType: 'organization',
      entityId: orgId,
      metadata: { stripeEventId: event.id, eventType: event.type, subscriptionId: sub.id, status: sub.status, priceId, mappedPlan, mappingStatus: mappedPlan ? 'known' : 'unmapped', previousEntitlements: org.entitlements, entitlements },
    });
  });
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
    case 'customer.subscription.deleted': {
      const snapshot = event.data.object as Stripe.Subscription;
      await syncSubscriptionEvent(event, snapshot.id, snapshot.customer);
      break;
    }
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription && session.customer) {
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
        await syncSubscriptionEvent(event, subId, session.customer);
      }
      break;
    }
    default:
      break;
  }
  return event.type;
}
