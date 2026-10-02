import { createHash, randomUUID } from 'node:crypto';
import * as workspace from '@workspace/db';
import { auditEventsTable, billingCheckoutsTable, db, organizationsTable, usersTable, type BillingCheckout, type Organization } from '@workspace/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { deleteTestOrgs } from '../test-helpers/delete-test-orgs';

const provider = vi.hoisted(() => ({ customerCreate: vi.fn(), customerRetrieve: vi.fn(), sessionCreate: vi.fn(), sessionRetrieve: vi.fn(), subscriptionRetrieve: vi.fn(), portal: vi.fn(), configurations: [] as unknown[] }));
vi.mock('stripe', async (importOriginal) => {
  const { default: ActualStripe } = await importOriginal<typeof import('stripe')>();
  return { default: class {
    constructor(_key: string, opts: unknown) { provider.configurations.push(opts); }
    webhooks = new ActualStripe('sk_test_synthetic_only').webhooks;
    customers = { create: provider.customerCreate, retrieve: provider.customerRetrieve };
    checkout = { sessions: { create: provider.sessionCreate, retrieve: provider.sessionRetrieve } };
    subscriptions = { retrieve: provider.subscriptionRetrieve };
    billingPortal = { sessions: { create: provider.portal } };
  } };
});
const orgIds: string[] = [];
const actorIds: string[] = [];
const customerCache = new Map<string, any>();
const sessionCache = new Map<string, any>();
const opts = { successUrl: 'https://example.test/settings?billing=success', cancelUrl: 'https://example.test/settings?billing=cancel' };
const secret = 'whsec_synthetic_checkout_only';
let billing: typeof import('./billing');
let checkout: typeof import('./billing-checkout');
let operatorId: string;
const signer = new Stripe('sk_test_synthetic_only');

beforeAll(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
  vi.stubEnv('STRIPE_PRICE_ID', 'price_beta');
  billing = await import('./billing');
  checkout = await import('./billing-checkout');
  operatorId = `billing-platform-${randomUUID()}`;
  actorIds.push(operatorId);
  await db.insert(usersTable).values({ id: operatorId, isPlatformAdmin: true, isActive: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  customerCache.clear(); sessionCache.clear();
  vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{"price_beta":"beta","price_growth":"growth"}');
  provider.customerCreate.mockImplementation(async (params, request) => {
    if (!customerCache.has(request.idempotencyKey)) customerCache.set(request.idempotencyKey, { id: `cus_${randomUUID().replaceAll('-', '')}`, metadata: params.metadata });
    return customerCache.get(request.idempotencyKey);
  });
  provider.customerRetrieve.mockImplementation(async (id) => [...customerCache.values()].find((c) => c.id === id));
  provider.sessionCreate.mockImplementation(async (params, request) => {
    if (!sessionCache.has(request.idempotencyKey)) {
      const id = `cs_${randomUUID().replaceAll('-', '')}`;
      sessionCache.set(request.idempotencyKey, { id, mode: 'subscription', metadata: params.metadata, client_reference_id: params.client_reference_id, customer: params.customer, status: 'open', subscription: null, expires_at: Math.floor(Date.now() / 1000) + 86400, url: `https://checkout.stripe.com/c/pay/${id}`, line_items: { data: [{ price: { id: params.line_items[0].price }, quantity: 1 }] } });
    }
    return sessionCache.get(request.idempotencyKey);
  });
  provider.sessionRetrieve.mockImplementation(async (id) => [...sessionCache.values()].find((s) => s.id === id));
  provider.subscriptionRetrieve.mockReset();
  provider.portal.mockResolvedValue({ url: 'https://billing.stripe.com/synthetic' });
});
afterAll(async () => {
  await db.update(usersTable).set({ organizationId: null }).where(inArray(usersTable.id, actorIds));
  await deleteTestOrgs(...orgIds);
  await db.delete(usersTable).where(inArray(usersTable.id, actorIds));
  vi.doUnmock('@workspace/db'); vi.unstubAllEnvs();
});
async function fixture(patch: Partial<Organization> = {}) {
  const [org] = await db.insert(organizationsTable).values({ name: 'Synthetic billing company', slug: `checkout-${randomUUID()}`, ...patch }).returning();
  orgIds.push(org.id); return org;
}
async function readOrg(id: string) { return (await db.select().from(organizationsTable).where(eq(organizationsTable.id, id)))[0]; }
async function attempts(id: string) { return db.select().from(billingCheckoutsTable).where(eq(billingCheckoutsTable.organizationId, id)); }
async function attemptFor(id: string) { return (await attempts(id))[0]; }
function sub(org: Organization, id = org.stripeSubscriptionId!, status = 'canceled', attemptId?: string) {
  return { id, object: 'subscription', customer: org.stripeCustomerId, metadata: { organizationId: org.id, ...(attemptId ? { checkoutAttemptId: attemptId } : {}) }, status, trial_end: null, items: { data: [{ price: { id: 'price_beta' }, quantity: 1 }] } };
}
async function deliver(snapshot: unknown, type = 'customer.subscription.updated', id = `evt_${randomUUID()}`) {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object: snapshot } });
  return billing.handleWebhook(payload, signer.webhooks.generateTestHeaderString({ payload, secret }));
}
async function replacement() {
  const nonce = randomUUID().replaceAll('-', '');
  const org = await fixture({ stripeCustomerId: `cus_${nonce}`, stripeSubscriptionId: `sub_${nonce}`, subscriptionStatus: 'canceled' });
  provider.subscriptionRetrieve.mockResolvedValue(sub(org));
  await checkout.authorizeReplacement(org.id, operatorId, { subscriptionId: org.stripeSubscriptionId, reason: 'Approved synthetic subscription replacement' }, opts);
  return org;
}
async function markOld(attempt: BillingCheckout, phase: 'customerAttemptedAt' | 'sessionAttemptedAt') {
  await db.update(billingCheckoutsTable).set({ [phase]: new Date(Date.now() - 24 * 3600_000) }).where(eq(billingCheckoutsTable.id, attempt.id));
}

describe('durable checkout request identity', () => {
  it('persists markers before POST, snapshots terms and reuses one customer and open session', async () => {
    const org = await fixture();
    const createCustomer = provider.customerCreate.getMockImplementation()!;
    provider.customerCreate.mockImplementation(async (...args) => {
      const stored = await attemptFor(org.id);
      expect(stored.customerAttemptedAt).not.toBeNull(); expect(stored.leaseToken).not.toBeNull();
      return createCustomer(...args);
    });
    const createSession = provider.sessionCreate.getMockImplementation()!;
    provider.sessionCreate.mockImplementation(async (...args) => {
      const stored = await attemptFor(org.id);
      expect(stored.customerId).not.toBeNull(); expect(stored.sessionAttemptedAt).not.toBeNull();
      return createSession(...args);
    });
    const url = await billing.createCheckoutSession(org, opts);
    expect(await billing.createCheckoutSession(org, { ...opts, successUrl: 'https://changed.example.test', trialDays: 14 })).toBe(url);
    expect(provider.customerCreate).toHaveBeenCalledTimes(1); expect(provider.sessionCreate).toHaveBeenCalledTimes(1);
    expect(provider.sessionRetrieve).toHaveBeenCalledTimes(1);
    const stored = await attemptFor(org.id);
    expect(stored).toMatchObject({ state: 'open', trialDays: 0, successUrl: opts.successUrl, leaseToken: null });
    expect(provider.sessionCreate.mock.calls[0][0].subscription_data).not.toHaveProperty('trial_period_days');
    expect(JSON.stringify(stored)).not.toContain(url); expect(JSON.stringify(stored)).not.toContain('sk_test_');
    expect(provider.configurations).toContainEqual({ timeout: 10_000, maxNetworkRetries: 0 });
  });
  it('retries a lost customer response with the same key after the service reloads', async () => {
    const org = await fixture();
    const create = provider.customerCreate.getMockImplementation()!;
    provider.customerCreate.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('synthetic lost response'); });
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_retry_available' });
    const first = provider.customerCreate.mock.calls[0];
    // Recreate the service/client while retaining only durable DB/provider state.
    vi.doMock('@workspace/db', () => workspace); vi.resetModules();
    billing = await import('./billing'); checkout = await import('./billing-checkout');
    await billing.createCheckoutSession(org, opts);
    expect(provider.customerCreate.mock.calls[1]).toEqual(first);
    expect(customerCache.size).toBe(1); expect(sessionCache.size).toBe(1);
    expect(await attempts(org.id)).toHaveLength(1);
  });
  it('retries a lost session response with immutable request parameters and no new customer', async () => {
    const org = await fixture();
    const create = provider.sessionCreate.getMockImplementation()!;
    provider.sessionCreate.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('synthetic timeout'); });
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ status: 503 });
    const first = provider.sessionCreate.mock.calls[0];
    await billing.createCheckoutSession(org, { ...opts, cancelUrl: 'https://changed.example.test', trialDays: 7 });
    expect(provider.sessionCreate.mock.calls[1]).toEqual(first);
    expect(customerCache.size).toBe(1); expect(sessionCache.size).toBe(1);
  });
  it('rejects a concurrent worker while the provider is pending, then reuses its session', async () => {
    const org = await fixture();
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const create = provider.customerCreate.getMockImplementation()!;
    provider.customerCreate.mockImplementationOnce(async (...args) => { entered(); await waiting; return create(...args); });
    const first = billing.createCheckoutSession(org, opts);
    await started;
    try { await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_in_progress' }); }
    finally { release(); }
    await first;
    await billing.createCheckoutSession(org, opts);
    expect(customerCache.size).toBe(1); expect(sessionCache.size).toBe(1);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === 'pglite')('serializes simultaneous initial claims across independent PostgreSQL connections', async () => {
    const org = await fixture();
    const results = await Promise.allSettled([billing.createCheckoutSession(org, opts), billing.createCheckoutSession(org, opts)]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await attempts(org.id)).toHaveLength(1); expect(customerCache.size).toBe(1); expect(sessionCache.size).toBe(1);
  });
  it('honors the durable lease across restart and only takes it over after expiry', async () => {
    const org = await fixture();
    provider.customerCreate.mockRejectedValueOnce(new Error('synthetic process loss'));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toThrow();
    const attempt = await attemptFor(org.id);
    await db.update(billingCheckoutsTable).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 90_000) }).where(eq(billingCheckoutsTable.id, attempt.id));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_in_progress' });
    await db.update(billingCheckoutsTable).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(billingCheckoutsTable.id, attempt.id));
    await billing.createCheckoutSession(org, opts);
    expect(provider.customerCreate.mock.calls[0][1]).toEqual(provider.customerCreate.mock.calls[1][1]);
  });
  it.each(['customerAttemptedAt', 'sessionAttemptedAt'] as const)('holds an uncertain %s beyond the retry window without another POST', async (phase) => {
    const org = await fixture();
    (phase === 'customerAttemptedAt' ? provider.customerCreate : provider.sessionCreate).mockRejectedValueOnce(new Error('synthetic timeout'));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toThrow();
    const attempt = await attemptFor(org.id); await markOld(attempt, phase);
    const calls = [provider.customerCreate.mock.calls.length, provider.sessionCreate.mock.calls.length];
    expect(await billing.getBillingOverview(await readOrg(org.id))).toMatchObject({ canCheckout: false, checkout: { state: 'reconcile' } });
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_review_required' });
    expect([provider.customerCreate.mock.calls.length, provider.sessionCreate.mock.calls.length]).toEqual(calls);
    expect((await attemptFor(org.id)).state).toBe('reconcile');
  });
  it('holds credential/configuration drift and unknown price mapping before another POST', async () => {
    const org = await fixture();
    provider.customerCreate.mockRejectedValueOnce(new Error('synthetic timeout'));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toThrow();
    const attempt = await attemptFor(org.id);
    await db.update(billingCheckoutsTable).set({ providerConfigurationHash: createHash('sha256').update('other-synthetic-key').digest('hex') }).where(eq(billingCheckoutsTable.id, attempt.id));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_review_required' });
    expect(provider.customerCreate).toHaveBeenCalledTimes(1);
    vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{}');
    const unbound = await fixture();
    await expect(billing.createCheckoutSession(unbound, opts)).rejects.toMatchObject({ code: 'checkout_unconfigured' });
    expect(await attempts(unbound.id)).toHaveLength(0);
  });
  it('requires provider-confirmed expiry before a fresh attempt and never creates a customer for the portal', async () => {
    const org = await fixture();
    await expect(billing.createPortalSession(org, opts.cancelUrl)).rejects.toMatchObject({ code: 'billing_customer_missing' });
    expect(provider.customerCreate).not.toHaveBeenCalled(); expect(provider.portal).not.toHaveBeenCalled();
    await billing.createCheckoutSession(org, opts);
    const session = [...sessionCache.values()][0]; session.status = 'expired'; session.url = null;
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_expired' });
    await billing.createCheckoutSession(org, opts);
    expect(await attempts(org.id)).toHaveLength(2); expect(customerCache.size).toBe(1); expect(sessionCache.size).toBe(2);
  });
});

describe('explicit canceled subscription replacement', () => {
  it('denies active, wrong-customer and wrong-company provider state without creating anything', async () => {
    const org = await fixture({ stripeCustomerId: 'cus_canceled_fixture', stripeSubscriptionId: 'sub_canceled_fixture', subscriptionStatus: 'canceled' });
    for (const patch of [{ status: 'active' }, { customer: 'cus_someone_else' }, { metadata: { organizationId: randomUUID() } }]) {
      provider.subscriptionRetrieve.mockResolvedValue({ ...sub(org), ...patch });
      await expect(checkout.authorizeReplacement(org.id, operatorId, { subscriptionId: org.stripeSubscriptionId, reason: 'Synthetic replacement authorization' }, opts)).rejects.toMatchObject({ code: 'replacement_not_canceled' });
    }
    expect(await attempts(org.id)).toHaveLength(0); expect(provider.sessionCreate).not.toHaveBeenCalled();
  });
  it('requires an active platform operator and rejects forged payload fields', async () => {
    const org = await fixture();
    const id = `billing-nonoperator-${randomUUID()}`; actorIds.push(id);
    await db.insert(usersTable).values({ id, organizationId: org.id, role: 'owner' });
    await expect(checkout.authorizeReplacement(org.id, id, { subscriptionId: 'sub_synthetic', reason: 'Synthetic replacement authorization' }, opts)).rejects.toMatchObject({ status: 403 });
    await expect(checkout.authorizeReplacement(org.id, operatorId, { subscriptionId: 'sub_synthetic', reason: 'Synthetic replacement authorization', planId: 'scale' }, opts)).rejects.toThrow();
    expect(provider.subscriptionRetrieve).not.toHaveBeenCalled();
  });
  it('checks cancellation again immediately before new-session creation and leaves the old binding intact', async () => {
    const org = await replacement();
    expect((await billing.getBillingOverview(org)).checkout).toMatchObject({ intent: 'replacement', canContinue: true });
    provider.subscriptionRetrieve.mockResolvedValue(sub(org, org.stripeSubscriptionId!, 'active'));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'replacement_not_canceled' });
    expect(provider.sessionCreate).not.toHaveBeenCalled();
    expect((await readOrg(org.id)).stripeSubscriptionId).toBe(org.stripeSubscriptionId);
    provider.subscriptionRetrieve.mockResolvedValue(sub(org));
    await checkout.authorizeReplacement(org.id, operatorId, { subscriptionId: org.stripeSubscriptionId, reason: 'Reverified synthetic cancellation after review' }, opts);
    await billing.createCheckoutSession(org, opts);
    expect((await readOrg(org.id)).stripeSubscriptionId).toBe(org.stripeSubscriptionId);
    expect(provider.customerCreate).not.toHaveBeenCalled();
  });
  it.each(['expired', 'binding_changed'])('refuses a stale %s replacement grant before a provider mutation', async (reason) => {
    const org = await replacement();
    const attempt = await attemptFor(org.id);
    if (reason === 'expired') await db.update(billingCheckoutsTable).set({ authorizationExpiresAt: new Date(Date.now() - 1) }).where(eq(billingCheckoutsTable.id, attempt.id));
    else await db.update(organizationsTable).set({ stripeSubscriptionId: 'sub_new_binding' }).where(eq(organizationsTable.id, org.id));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_review_required' });
    expect(provider.sessionCreate).not.toHaveBeenCalled();
  });
  it('rebinds only the authorized matching checkout, deduplicates it, and ignores delayed retired events', async () => {
    const org = await replacement(); await billing.createCheckoutSession(org, opts);
    const attempt = await attemptFor(org.id);
    const next = sub(org, 'sub_replacement_new', 'active', attempt.id);
    provider.subscriptionRetrieve.mockImplementation(async (id) => id === org.stripeSubscriptionId ? sub(org) : next);
    const eventId = `evt_${randomUUID()}`;
    await deliver(next, undefined, eventId); await deliver(next, undefined, eventId);
    expect((await readOrg(org.id))).toMatchObject({ stripeSubscriptionId: next.id, subscriptionStatus: 'active', entitlements: null });
    expect(await attemptFor(org.id)).toMatchObject({ state: 'completed', completedSubscriptionId: next.id });
    const calls = provider.subscriptionRetrieve.mock.calls.length;
    await deliver(sub(org), 'customer.subscription.deleted');
    expect(provider.subscriptionRetrieve).toHaveBeenCalledTimes(calls);
    expect((await readOrg(org.id)).stripeSubscriptionId).toBe(next.id);
    const audits = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org.id), eq(auditEventsTable.action, 'billing.checkout_completed')));
    expect(audits).toHaveLength(1);
  });
  it('rejects unrelated subscription IDs, forged attempt metadata, and changed price during replacement', async () => {
    const org = await replacement(); await billing.createCheckoutSession(org, opts);
    const attempt = await attemptFor(org.id);
    for (const candidate of [sub(org, 'sub_unrelated', 'active', randomUUID()), { ...sub(org, 'sub_wrong_price', 'active', attempt.id), items: { data: [{ price: { id: 'price_growth' }, quantity: 1 }] } }]) {
      provider.subscriptionRetrieve.mockResolvedValue(candidate);
      await expect(deliver(candidate)).rejects.toMatchObject({ code: 'checkout_review_required' });
    }
    expect((await readOrg(org.id)).stripeSubscriptionId).toBe(org.stripeSubscriptionId);
  });
});

describe('operator evidence reconciliation', () => {
  it('recovers a lost customer after the retry window using matching provider metadata', async () => {
    const org = await fixture(); const create = provider.customerCreate.getMockImplementation()!;
    provider.customerCreate.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('synthetic lost response'); });
    await expect(billing.createCheckoutSession(org, opts)).rejects.toThrow();
    const attempt = await attemptFor(org.id); await markOld(attempt, 'customerAttemptedAt');
    await checkout.reconcileCheckout(org.id, operatorId, { attemptId: attempt.id, customerId: [...customerCache.values()][0].id, reason: 'Verified synthetic customer request in provider logs' });
    await billing.createCheckoutSession(org, opts);
    expect(provider.customerCreate).toHaveBeenCalledTimes(1); expect(sessionCache.size).toBe(1);
  });
  it('recovers a lost session after the window without creating a second subscription checkout', async () => {
    const org = await fixture(); const create = provider.sessionCreate.getMockImplementation()!;
    provider.sessionCreate.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('synthetic lost response'); });
    await expect(billing.createCheckoutSession(org, opts)).rejects.toThrow();
    const attempt = await attemptFor(org.id); await markOld(attempt, 'sessionAttemptedAt');
    await checkout.reconcileCheckout(org.id, operatorId, { attemptId: attempt.id, sessionId: [...sessionCache.values()][0].id, reason: 'Verified synthetic session request in provider logs' });
    await billing.createCheckoutSession(org, opts);
    expect(provider.sessionCreate).toHaveBeenCalledTimes(1); expect(sessionCache.size).toBe(1);
  });
  it('rejects tenant overrides and mismatched provider evidence without changing either company', async () => {
    const a = await fixture(); const b = await fixture();
    provider.customerCreate.mockRejectedValueOnce(new Error('synthetic timeout'));
    await expect(billing.createCheckoutSession(a, opts)).rejects.toThrow();
    const attempt = await attemptFor(a.id);
    const request = { attemptId: attempt.id, customerId: 'cus_wrong_tenant', reason: 'Synthetic reconciliation verification' };
    await expect(checkout.reconcileCheckout(b.id, operatorId, request)).rejects.toMatchObject({ code: 'checkout_review_required' });
    provider.customerRetrieve.mockResolvedValue({ id: request.customerId, metadata: { organizationId: b.id, checkoutAttemptId: attempt.id } });
    await expect(checkout.reconcileCheckout(a.id, operatorId, request)).rejects.toMatchObject({ code: 'checkout_review_required' });
    expect((await readOrg(a.id)).stripeCustomerId).toBeNull(); expect((await readOrg(b.id)).stripeCustomerId).toBeNull();
  });
  it('reconciles a completed session after missed webhook delivery instead of opening another checkout', async () => {
    const org = await fixture(); await billing.createCheckoutSession(org, opts);
    const attempt = await attemptFor(org.id); const current = await readOrg(org.id);
    const session = [...sessionCache.values()][0]; session.status = 'complete'; session.subscription = 'sub_completed_synthetic'; session.url = null;
    provider.subscriptionRetrieve.mockResolvedValue(sub(current, session.subscription, 'active', attempt.id));
    await expect(billing.createCheckoutSession(org, opts)).rejects.toMatchObject({ code: 'checkout_completed' });
    expect((await readOrg(org.id)).stripeSubscriptionId).toBe(session.subscription);
    expect(await attemptFor(org.id)).toMatchObject({ state: 'completed' });
    expect(provider.sessionCreate).toHaveBeenCalledTimes(1);
  });
});
