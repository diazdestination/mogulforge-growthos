import { createHash, randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { auditEventsTable, billingCheckoutsTable, db, organizationsTable, usersTable, type BillingCheckout, type Organization } from '@workspace/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import { mappedPlanForPrice } from './entitlements';

const secret = process.env.STRIPE_SECRET_KEY;
export const billingStripe = secret ? new Stripe(secret, { timeout: 10_000, maxNetworkRetries: 0 }) : null;
const configurationHash = createHash('sha256').update(secret ?? 'disabled').digest('hex');
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const CURRENT = ['pending', 'open', 'reconcile'] as const;
const LEASE_MS = 90_000;
// Stripe can prune keys after 24 hours. Stop unknown effects with a safety margin.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const AUTHORIZATION_MS = 24 * 60 * 60 * 1000;
export type BillingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CheckoutOptions = { successUrl: string; cancelUrl: string; trialDays?: number };

export class BillingOperationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'BillingOperationError';
  }
}
export class BillingCheckoutConflictError extends BillingOperationError {
  constructor() {
    super('subscription_already_bound', 'This company already has a linked subscription. Manage it in the billing portal or contact your GrowthOS operator before starting another subscription.');
    this.name = 'BillingCheckoutConflictError';
  }
}
const reviewError = () => new BillingOperationError('checkout_review_required', 'Checkout needs a billing review. Contact your GrowthOS operator and ask them to reconcile the pending checkout before trying again.');
const busyError = () => new BillingOperationError('checkout_in_progress', 'Checkout is already being prepared. Wait a moment, refresh billing status, then continue the same checkout.');
export function requireBillingStripe() {
  if (!billingStripe) throw new BillingOperationError('billing_unconfigured', 'Online billing is not configured.', 400);
  return billingStripe;
}
export async function billingLocked<T>(orgId: string, run: (tx: BillingTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true), set_config('statement_timeout', '15000ms', true), set_config('idle_in_transaction_session_timeout', '25000ms', true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${orgId}`}, 0))`);
    return run(tx);
  });
}
async function loadOrg(tx: BillingTx, orgId: string): Promise<Organization> {
  const [org] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) throw new BillingOperationError('organization_missing', 'Organization not found.', 404);
  return org;
}
export async function currentCheckout(tx: BillingTx | typeof db, orgId: string) {
  const [attempt] = await tx.select().from(billingCheckoutsTable).where(and(eq(billingCheckoutsTable.organizationId, orgId), inArray(billingCheckoutsTable.state, [...CURRENT])));
  return attempt;
}
export function providerId(value: string | { id: string }): string { return typeof value === 'string' ? value : value.id; }
export function checkoutBindingMatches(org: Organization, attempt: BillingCheckout): boolean {
  return (attempt.intent === 'initial' ? !org.stripeSubscriptionId : org.stripeSubscriptionId === attempt.replacesSubscriptionId)
    && (!attempt.customerId || org.stripeCustomerId === attempt.customerId);
}
function needsReview(attempt: BillingCheckout): boolean {
  const uncertainAt = !attempt.customerId ? attempt.customerAttemptedAt : !attempt.sessionId ? attempt.sessionAttemptedAt : null;
  return attempt.state === 'reconcile'
    || attempt.providerConfigurationHash !== configurationHash
    || Boolean(uncertainAt && Date.now() - uncertainAt.getTime() >= RETRY_WINDOW_MS)
    || Boolean(attempt.intent === 'replacement' && !attempt.sessionAttemptedAt && attempt.authorizationExpiresAt && attempt.authorizationExpiresAt.getTime() <= Date.now());
}
async function audit(tx: BillingTx, orgId: string, action: string, metadata: Record<string, unknown>, actorUserId?: string) {
  await tx.insert(auditEventsTable).values({ organizationId: orgId, actorUserId, action, entityType: 'organization', entityId: orgId, metadata });
}
async function hold(tx: BillingTx, attempt: BillingCheckout, reason: string) {
  await tx.update(billingCheckoutsTable).set({ state: 'reconcile', recoveryReason: reason, leaseToken: null, leaseExpiresAt: null }).where(eq(billingCheckoutsTable.id, attempt.id));
  await audit(tx, attempt.organizationId, 'billing.checkout_review_required', { checkoutAttemptId: attempt.id, reason });
}

/** UI status contains actions and recovery guidance, never provider IDs or payment URLs. */
export async function checkoutStatus(org: Organization) {
  const attempt = await currentCheckout(db, org.id);
  if (!attempt) return null;
  const review = needsReview(attempt) || !checkoutBindingMatches(org, attempt) || mappedPlanForPrice(attempt.priceId) !== attempt.planId;
  const busy = Boolean(attempt.leaseExpiresAt && attempt.leaseExpiresAt.getTime() > Date.now());
  return {
    state: review ? 'reconcile' : busy ? 'preparing' : attempt.state,
    intent: attempt.intent,
    canContinue: Boolean(billingStripe) && !review && !busy,
    detail: review ? reviewError().message : busy ? busyError().message : attempt.intent === 'replacement'
      ? 'Your operator authorized a replacement for the canceled subscription. Continue to review its terms in Stripe.'
      : 'A checkout is already in progress. Continue the same checkout to review its terms in Stripe.',
  };
}
function checkoutValues(org: Organization, opts: CheckoutOptions) {
  const planId = mappedPlanForPrice(PRICE_ID ?? null);
  if (!PRICE_ID || !planId) throw new BillingOperationError('checkout_unconfigured', 'The checkout price has no approved internal plan mapping. Contact your GrowthOS operator.');
  const trialDays = opts.trialDays ?? 0;
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 730) throw new Error('Invalid configured trial');
  return { organizationId: org.id, priceId: PRICE_ID, planId, successUrl: opts.successUrl, cancelUrl: opts.cancelUrl, trialDays, customerId: org.stripeCustomerId, providerConfigurationHash: configurationHash };
}
async function claimCheckout(orgId: string, opts: CheckoutOptions) {
  const result = await billingLocked(orgId, async (tx) => {
    const org = await loadOrg(tx, orgId);
    let attempt = await currentCheckout(tx, orgId);
    if (!attempt) {
      if (org.stripeSubscriptionId) throw new BillingCheckoutConflictError();
      [attempt] = await tx.insert(billingCheckoutsTable).values({ ...checkoutValues(org, opts), intent: 'initial' }).returning();
      await audit(tx, orgId, 'billing.checkout_started', { checkoutAttemptId: attempt.id, intent: attempt.intent, priceId: attempt.priceId });
    }
    if (attempt.leaseExpiresAt && attempt.leaseExpiresAt.getTime() > Date.now()) return { error: busyError() };
    if (needsReview(attempt) || !checkoutBindingMatches(org, attempt) || mappedPlanForPrice(attempt.priceId) !== attempt.planId) {
      await hold(tx, attempt, 'request_or_binding_needs_review');
      return { error: reviewError() };
    }
    const token = randomUUID();
    const [claimed] = await tx.update(billingCheckoutsTable).set({ leaseToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS) }).where(eq(billingCheckoutsTable.id, attempt.id)).returning();
    return { attempt: claimed, token };
  });
  if ('error' in result) throw result.error;
  return result;
}
async function leased<T>(attempt: BillingCheckout, token: string, run: (tx: BillingTx, fresh: BillingCheckout, org: Organization) => Promise<T>) {
  return billingLocked(attempt.organizationId, async (tx) => {
    const [fresh] = await tx.select().from(billingCheckoutsTable).where(and(eq(billingCheckoutsTable.id, attempt.id), eq(billingCheckoutsTable.organizationId, attempt.organizationId)));
    if (!fresh || fresh.leaseToken !== token || !fresh.leaseExpiresAt || fresh.leaseExpiresAt.getTime() <= Date.now() || !CURRENT.includes(fresh.state as typeof CURRENT[number])) throw busyError();
    const org = await loadOrg(tx, attempt.organizationId);
    if (!checkoutBindingMatches(org, fresh)) throw reviewError();
    return run(tx, fresh, org);
  });
}
async function release(attempt: BillingCheckout, token: string) {
  await db.update(billingCheckoutsTable).set({ leaseToken: null, leaseExpiresAt: null }).where(and(eq(billingCheckoutsTable.id, attempt.id), eq(billingCheckoutsTable.leaseToken, token)));
}
export async function verifyCanceledSubscription(org: Organization, oldId: string) {
  if (org.stripeSubscriptionId !== oldId || !org.stripeCustomerId) throw reviewError();
  const old = await requireBillingStripe().subscriptions.retrieve(oldId);
  if (old.id !== oldId || providerId(old.customer) !== org.stripeCustomerId || (old.metadata?.organizationId && old.metadata.organizationId !== org.id) || old.status !== 'canceled') {
    throw new BillingOperationError('replacement_not_canceled', 'The linked subscription is not verified as canceled for this company. Manage it in the billing portal, then ask your GrowthOS operator to review replacement.');
  }
}
function validateSession(session: Stripe.Checkout.Session, attempt: BillingCheckout) {
  const items = session.line_items?.data;
  if (session.mode !== 'subscription' || !session.customer || providerId(session.customer) !== attempt.customerId
    || session.metadata?.organizationId !== attempt.organizationId || session.metadata?.checkoutAttemptId !== attempt.id
    || session.client_reference_id !== attempt.id
    || (items && (items.length !== 1 || items[0].price?.id !== attempt.priceId || items[0].quantity !== 1))) throw reviewError();
}
async function saveSession(attempt: BillingCheckout, token: string, session: Stripe.Checkout.Session) {
  validateSession(session, attempt);
  await leased(attempt, token, async (tx, fresh) => {
    if (fresh.sessionId && fresh.sessionId !== session.id) throw reviewError();
    await tx.update(billingCheckoutsTable).set({ sessionId: session.id, sessionExpiresAt: new Date(session.expires_at * 1000), state: session.status === 'expired' ? 'expired' : 'open', recoveryReason: null }).where(eq(billingCheckoutsTable.id, attempt.id));
  });
}

/** Persist identities before each POST. A lost response retries the same parameters/key. */
export async function durableCheckout(org: Organization, opts: CheckoutOptions, reconcile: (session: Stripe.Checkout.Session) => Promise<void>): Promise<string> {
  const stripe = requireBillingStripe();
  const claimed = await claimCheckout(org.id, opts);
  let attempt = claimed.attempt;
  const token = claimed.token;
  try {
    if (!attempt.customerId) {
      attempt = await leased(attempt, token, async (tx, fresh) => {
        const [updated] = await tx.update(billingCheckoutsTable).set({ customerAttemptedAt: fresh.customerAttemptedAt ?? new Date() }).where(eq(billingCheckoutsTable.id, fresh.id)).returning();
        return updated;
      });
      const customer = await stripe.customers.create({ metadata: { organizationId: org.id, checkoutAttemptId: attempt.id } }, { idempotencyKey: `growthos:customer:${attempt.id}` });
      if (customer.metadata?.organizationId !== org.id || customer.metadata?.checkoutAttemptId !== attempt.id) throw reviewError();
      attempt = await leased(attempt, token, async (tx, fresh, current) => {
        if (current.stripeCustomerId && current.stripeCustomerId !== customer.id) throw reviewError();
        await tx.update(organizationsTable).set({ stripeCustomerId: customer.id }).where(eq(organizationsTable.id, org.id));
        const [updated] = await tx.update(billingCheckoutsTable).set({ customerId: customer.id }).where(eq(billingCheckoutsTable.id, fresh.id)).returning();
        return updated;
      });
    }
    let session: Stripe.Checkout.Session;
    if (attempt.sessionId) {
      session = await stripe.checkout.sessions.retrieve(attempt.sessionId, { expand: ['line_items'] });
      if (!session.line_items) throw reviewError();
    } else {
      if (attempt.intent === 'replacement') {
        const current = await leased(attempt, token, async (_tx, _fresh, current) => current);
        await verifyCanceledSubscription(current, attempt.replacesSubscriptionId!);
      }
      attempt = await leased(attempt, token, async (tx, fresh) => {
        if (needsReview(fresh) || mappedPlanForPrice(fresh.priceId) !== fresh.planId) throw reviewError();
        const [updated] = await tx.update(billingCheckoutsTable).set({ sessionAttemptedAt: fresh.sessionAttemptedAt ?? new Date() }).where(eq(billingCheckoutsTable.id, fresh.id)).returning();
        return updated;
      });
      const metadata = { organizationId: org.id, checkoutAttemptId: attempt.id };
      session = await stripe.checkout.sessions.create({
        mode: 'subscription', customer: attempt.customerId!, client_reference_id: attempt.id,
        line_items: [{ price: attempt.priceId, quantity: 1 }], success_url: attempt.successUrl, cancel_url: attempt.cancelUrl,
        subscription_data: attempt.trialDays ? { trial_period_days: attempt.trialDays, metadata } : { metadata }, metadata,
      }, { idempotencyKey: `growthos:checkout:${attempt.id}` });
    }
    await saveSession(attempt, token, session);
    if (session.status === 'expired') throw new BillingOperationError('checkout_expired', 'That checkout expired without completion. Refresh billing status to start again; a replacement requires renewed operator authorization.');
    if (session.status === 'complete') {
      await reconcile(session);
      throw new BillingOperationError('checkout_completed', 'Checkout is complete. Refresh billing status to see the linked subscription.');
    }
    if (session.status !== 'open' || !session.url) throw reviewError();
    return session.url;
  } catch (error) {
    if (error instanceof BillingOperationError) {
      if (['checkout_review_required', 'replacement_not_canceled'].includes(error.code)) {
        await billingLocked(attempt.organizationId, async (tx) => {
          const [owned] = await tx.select().from(billingCheckoutsTable).where(and(eq(billingCheckoutsTable.id, attempt.id), eq(billingCheckoutsTable.leaseToken, token)));
          if (owned && CURRENT.includes(owned.state as typeof CURRENT[number])) await hold(tx, owned, error.code);
        });
      }
      throw error;
    }
    throw new BillingOperationError('checkout_retry_available', 'Stripe did not confirm checkout. Refresh billing status and continue the same checkout. If it still cannot continue, ask your GrowthOS operator to review it.', 503);
  } finally { await release(attempt, token); }
}

export const replacementSchema = z.object({ subscriptionId: z.string().regex(/^sub_[A-Za-z0-9_]+$/), reason: z.string().trim().min(10).max(500) }).strict();
export const billingReconcileSchema = z.object({ attemptId: z.uuid(), customerId: z.string().regex(/^cus_[A-Za-z0-9_]+$/).optional(), sessionId: z.string().regex(/^cs_[A-Za-z0-9_]+$/).optional(), reason: z.string().trim().min(10).max(500) }).strict().refine((v) => Boolean(v.customerId || v.sessionId), 'Provide a provider record to reconcile.');
async function requireOperator(tx: BillingTx, operatorId: string) {
  const [operator] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, operatorId), eq(usersTable.isActive, true), eq(usersTable.isPlatformAdmin, true)));
  if (!operator) throw new BillingOperationError('operator_required', 'An active platform operator is required.', 403);
}

/** Read-only provider verification authorizes one checkout; it never cancels or charges. */
export async function authorizeReplacement(orgId: string, operatorId: string, input: unknown, opts: CheckoutOptions) {
  const request = replacementSchema.parse(input);
  return billingLocked(orgId, async (tx) => {
    await requireOperator(tx, operatorId);
    const org = await loadOrg(tx, orgId);
    await verifyCanceledSubscription(org, request.subscriptionId);
    const existing = await currentCheckout(tx, orgId);
    if (existing) {
      // Reauthorization is safe only before any session request was attempted.
      if (existing.intent !== 'replacement' || existing.replacesSubscriptionId !== request.subscriptionId || existing.sessionAttemptedAt || (existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > Date.now())) throw busyError();
      await tx.update(billingCheckoutsTable).set({ state: 'pending', authorizedByUserId: operatorId, authorizationReason: request.reason, authorizationExpiresAt: new Date(Date.now() + AUTHORIZATION_MS), recoveryReason: null }).where(eq(billingCheckoutsTable.id, existing.id));
      await audit(tx, orgId, 'billing.replacement_authorized', { checkoutAttemptId: existing.id, subscriptionId: request.subscriptionId, reason: request.reason }, operatorId);
      return { attemptId: existing.id, state: 'pending' };
    }
    const [attempt] = await tx.insert(billingCheckoutsTable).values({ ...checkoutValues(org, opts), intent: 'replacement', replacesSubscriptionId: request.subscriptionId, authorizedByUserId: operatorId, authorizationReason: request.reason, authorizationExpiresAt: new Date(Date.now() + AUTHORIZATION_MS) }).returning();
    await audit(tx, orgId, 'billing.replacement_authorized', { checkoutAttemptId: attempt.id, subscriptionId: request.subscriptionId, reason: request.reason }, operatorId);
    return { attemptId: attempt.id, state: attempt.state };
  });
}

/** Recover known provider evidence only. Never declare an unknown POST absent or issue a new key. */
export async function reconcileCheckout(orgId: string, operatorId: string, input: unknown) {
  const request = billingReconcileSchema.parse(input);
  return billingLocked(orgId, async (tx) => {
    await requireOperator(tx, operatorId);
    const org = await loadOrg(tx, orgId);
    const [attempt] = await tx.select().from(billingCheckoutsTable).where(and(eq(billingCheckoutsTable.id, request.attemptId), eq(billingCheckoutsTable.organizationId, orgId)));
    if (!attempt || !CURRENT.includes(attempt.state as typeof CURRENT[number]) || !checkoutBindingMatches(org, attempt)) throw reviewError();
    if (attempt.leaseExpiresAt && attempt.leaseExpiresAt.getTime() > Date.now()) throw busyError();
    const stripe = requireBillingStripe();
    let customerId = attempt.customerId;
    if (request.customerId) {
      const customer = await stripe.customers.retrieve(request.customerId);
      if (customer.deleted || customer.id !== request.customerId || customer.metadata?.organizationId !== orgId || customer.metadata?.checkoutAttemptId !== attempt.id
        || (customerId && customerId !== customer.id) || (org.stripeCustomerId && org.stripeCustomerId !== customer.id) || !attempt.customerAttemptedAt) throw reviewError();
      customerId = customer.id;
    }
    if (!customerId) throw reviewError();
    let session: Stripe.Checkout.Session | null = null;
    if (request.sessionId) {
      session = await stripe.checkout.sessions.retrieve(request.sessionId, { expand: ['line_items'] });
      if (!attempt.sessionAttemptedAt || session.id !== request.sessionId || (attempt.sessionId && attempt.sessionId !== session.id) || !session.line_items) throw reviewError();
      validateSession(session, { ...attempt, customerId });
    }
    // A recovered customer never clears uncertainty about a separate session POST.
    if (attempt.sessionAttemptedAt && !attempt.sessionId && !session) throw reviewError();
    await tx.update(organizationsTable).set({ stripeCustomerId: customerId }).where(eq(organizationsTable.id, orgId));
    const state = session?.status === 'expired' ? 'expired' : (session || attempt.sessionId) ? 'open' : 'pending';
    await tx.update(billingCheckoutsTable).set({ customerId, state, sessionId: session?.id ?? attempt.sessionId, sessionExpiresAt: session ? new Date(session.expires_at * 1000) : attempt.sessionExpiresAt, providerConfigurationHash: configurationHash, recoveryReason: null, leaseToken: null, leaseExpiresAt: null }).where(eq(billingCheckoutsTable.id, attempt.id));
    await audit(tx, orgId, 'billing.checkout_reconciled', { checkoutAttemptId: attempt.id, customerId, sessionId: session?.id ?? attempt.sessionId, state, reason: request.reason }, operatorId);
    return { attemptId: attempt.id, state };
  });
}
