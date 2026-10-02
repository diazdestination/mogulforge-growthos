import Stripe from 'stripe';
import { auditEventsTable, billingCheckoutsTable, db, organizationsTable, type Organization } from '@workspace/db';
import { and, eq, sql } from 'drizzle-orm';
import { mappedPlanForPrice, resolveEntitlements, type EntitlementStatus } from './entitlements';
import { billingStripe as stripe, requireBillingStripe as requireStripe, billingLocked, currentCheckout, checkoutBindingMatches, checkoutStatus, durableCheckout, providerId, verifyCanceledSubscription, BillingOperationError } from './billing-checkout';
export { BillingCheckoutConflictError, BillingOperationError } from './billing-checkout';

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
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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
  canManageBilling: boolean;
  checkout?: Awaited<ReturnType<typeof checkoutStatus>>;
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
    canManageBilling: isBillingEnabled() && Boolean(org.stripeCustomerId),
    entitlements: resolveEntitlements(org),
  };
}

export async function getBillingOverview(org: Organization): Promise<BillingStatus> {
  const status = getBillingStatus(org);
  const checkout = await checkoutStatus(org);
  return { ...status, canCheckout: checkout ? checkout.canContinue : status.canCheckout, checkout };
}

export async function createCheckoutSession(
  org: Organization,
  opts: { successUrl: string; cancelUrl: string; trialDays?: number },
): Promise<string> {
  return durableCheckout(org, opts, async (session) => {
    if (!session.subscription || !session.customer) throw new BillingOperationError('checkout_review_required', 'Checkout needs review by your GrowthOS operator.');
    await syncSubscriptionState(`checkout:${session.id}:complete`, 'checkout.reconciled', providerId(session.subscription), session.customer);
  });
}

export async function createPortalSession(
  org: Organization,
  returnUrl: string,
): Promise<string> {
  const s = requireStripe();
  const [current] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, org.id));
  const customerId = current?.stripeCustomerId;
  if (!customerId) throw new BillingOperationError('billing_customer_missing', 'There is no linked billing account yet. Start the configured checkout or contact your GrowthOS operator.');
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

/**
 * Stripe deliveries can be duplicated or arrive out of order. Serialize per
 * tenant, retrieve current provider state while holding that lock, and persist
 * the state plus dedupe audit atomically. No event snapshot can rewind access.
 */
async function syncSubscriptionState(eventId: string, eventType: string, subscriptionId: string, customer: string | Stripe.Customer | Stripe.DeletedCustomer): Promise<void> {
  const orgId = await orgIdForCustomer(customer);
  if (!orgId) throw new Error('Stripe customer is not bound to exactly one organization');
  const customerId = typeof customer === 'string' ? customer : customer.id;
  await billingLocked(orgId, async (tx) => {
    const [seen] = await tx.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(
      eq(auditEventsTable.organizationId, orgId),
      eq(auditEventsTable.action, 'billing.subscription_synced'),
      sql`${auditEventsTable.metadata}->>'stripeEventId' = ${eventId}`,
    )).limit(1);
    if (seen) return;
    const [org] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (!org || org.stripeCustomerId !== customerId) throw new Error('Stripe customer binding changed');
    const [retired] = await tx.select().from(billingCheckoutsTable).where(and(eq(billingCheckoutsTable.organizationId, orgId), eq(billingCheckoutsTable.replacesSubscriptionId, subscriptionId), eq(billingCheckoutsTable.state, 'completed'))).limit(1);
    if (retired) {
      await tx.insert(auditEventsTable).values({ organizationId: orgId, action: 'billing.subscription_synced', entityType: 'organization', entityId: orgId, metadata: { stripeEventId: eventId, eventType, subscriptionId, disposition: 'retired_subscription_ignored' } });
      return;
    }
    const attempt = await currentCheckout(tx, orgId);
    if (org.stripeSubscriptionId && org.stripeSubscriptionId !== subscriptionId && (!attempt || attempt.intent !== 'replacement' || attempt.replacesSubscriptionId !== org.stripeSubscriptionId || !attempt.sessionAttemptedAt)) {
      throw new Error('Another subscription is bound to this organization; operator reconciliation is required');
    }
    // Retrieve after acquiring the lock: retrieving outside it allows an older
    // response to overwrite a later one under concurrent webhook delivery.
    const sub = await requireStripe().subscriptions.retrieve(subscriptionId);
    const actualCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    if (sub.id !== subscriptionId || actualCustomerId !== customerId || (sub.metadata?.organizationId && sub.metadata.organizationId !== orgId)) {
      throw new Error('Stripe subscription organization does not match its bound customer');
    }
    const priceId = sub.items.data.length === 1 && sub.items.data[0].quantity === 1
      ? sub.items.data[0].price.id : null;
    const mappedPlan = mappedPlanForPrice(priceId);
    if (org.stripeSubscriptionId !== sub.id && attempt) {
      if (!checkoutBindingMatches(org, attempt) || attempt.customerId !== customerId || !attempt.sessionAttemptedAt
        || sub.metadata?.checkoutAttemptId !== attempt.id || sub.metadata?.organizationId !== orgId
        || priceId !== attempt.priceId || mappedPlan !== attempt.planId) {
        throw new BillingOperationError('checkout_review_required', 'The subscription does not match the authorized checkout. Operator reconciliation is required.');
      }
      if (attempt.intent === 'replacement') await verifyCanceledSubscription(org, attempt.replacesSubscriptionId!);
      await tx.update(billingCheckoutsTable).set({ state: 'completed', completedSubscriptionId: sub.id, leaseToken: null, leaseExpiresAt: null, recoveryReason: null }).where(eq(billingCheckoutsTable.id, attempt.id));
      await tx.insert(auditEventsTable).values({ organizationId: orgId, action: 'billing.checkout_completed', entityType: 'organization', entityId: orgId, metadata: { checkoutAttemptId: attempt.id, subscriptionId: sub.id, replacedSubscriptionId: attempt.replacesSubscriptionId } });
    }
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
      metadata: { stripeEventId: eventId, eventType, subscriptionId: sub.id, status: sub.status, priceId, mappedPlan, mappingStatus: mappedPlan ? 'known' : 'unmapped', previousEntitlements: org.entitlements, entitlements },
    });
  });
}

export class BillingWebhookVerificationError extends Error {}

/** Verify + handle a Stripe webhook. Returns the event type handled. */
export async function handleWebhook(
  rawBody: Buffer | string,
  signature: string | undefined,
): Promise<string> {
  const s = requireStripe();
  if (!WEBHOOK_SECRET) throw new Error('No STRIPE_WEBHOOK_SECRET configured');
  if (!signature) throw new BillingWebhookVerificationError('Missing stripe-signature header');
  let event: Stripe.Event;
  try { event = s.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET); }
  catch { throw new BillingWebhookVerificationError('Stripe signature verification failed'); }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const snapshot = event.data.object as Stripe.Subscription;
      await syncSubscriptionState(event.id, event.type, snapshot.id, snapshot.customer);
      break;
    }
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription && session.customer) {
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
        await syncSubscriptionState(event.id, event.type, subId, session.customer);
      }
      break;
    }
    default:
      break;
  }
  return event.type;
}
