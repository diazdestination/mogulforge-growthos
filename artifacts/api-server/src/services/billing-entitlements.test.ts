import { randomUUID } from 'node:crypto';
import { auditEventsTable, db, organizationsTable, type OrganizationEntitlements } from '@workspace/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { deleteTestOrgs } from '../test-helpers/delete-test-orgs';
import { resolveEntitlements } from './entitlements';

const provider = vi.hoisted(() => ({ retrieve: vi.fn(), customer: vi.fn(), checkout: vi.fn(), portal: vi.fn() }));
vi.mock('stripe', async (importOriginal) => {
  const { default: ActualStripe } = await importOriginal<typeof import('stripe')>();
  return { default: class {
    webhooks = new ActualStripe('sk_test_synthetic_only').webhooks;
    subscriptions = { retrieve: provider.retrieve };
    customers = { create: provider.customer };
    checkout = { sessions: { create: provider.checkout } };
    billingPortal = { sessions: { create: provider.portal } };
  } };
});

const orgIds: string[] = [];
const secret = 'whsec_synthetic_entitlements_test_only';
let billing: typeof import('./billing');
const signer = new Stripe('sk_test_synthetic_only');
beforeAll(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
  vi.stubEnv('STRIPE_PRICE_ID', 'price_growth');
  billing = await import('./billing');
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{"price_beta":"beta","price_growth":"growth","price_scale":"scale"}');
});
afterAll(async () => { await deleteTestOrgs(...orgIds); vi.unstubAllEnvs(); });
async function fixture(managed = true) {
  const nonce = randomUUID().replaceAll('-', '');
  const entitlements: OrganizationEntitlements = { version: 1, planId: 'growth', source: 'stripe', grants: [] };
  const [org] = await db.insert(organizationsTable).values({ name: 'Billing test', slug: `billing-${nonce}`, stripeCustomerId: `cus_${nonce}`, stripeSubscriptionId: `sub_${nonce}`, subscriptionStatus: 'active', planTier: 'price_growth', entitlements: managed ? entitlements : null }).returning();
  orgIds.push(org.id);
  return org;
}
function subscription(org: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}) {
  return { id: org.stripeSubscriptionId!, object: 'subscription', customer: org.stripeCustomerId!, status: 'active', metadata: { organizationId: org.id }, items: { data: [{ price: { id: 'price_growth' }, quantity: 1 }] }, trial_end: null, ...patch };
}
async function deliver(snapshot: ReturnType<typeof subscription>, eventId = `evt_${randomUUID()}`, eventType = 'customer.subscription.updated') {
  const payload = JSON.stringify({ id: eventId, object: 'event', type: eventType, data: { object: snapshot } });
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret });
  return billing.handleWebhook(payload, signature);
}
async function read(orgId: string) {
  return (await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId)))[0];
}

describe('signed Stripe state synchronization', () => {
  it('verifies the signature before reads/writes and rejects a missing signature', async () => {
    await expect(billing.handleWebhook('{}', 'invalid')).rejects.toThrow();
    await expect(billing.handleWebhook('{}', undefined)).rejects.toThrow('Missing stripe-signature');
    expect(provider.retrieve).not.toHaveBeenCalled();
  });
  it('deduplicates an event and reconciles current subscription state instead of old event snapshots', async () => {
    const org = await fixture();
    const oldSnapshot = subscription(org, { items: { data: [{ price: { id: 'price_scale' }, quantity: 1 }] } });
    const latest = subscription(org, { items: { data: [{ price: { id: 'price_beta' }, quantity: 1 }] } });
    provider.retrieve.mockResolvedValue(latest);
    const eventId = `evt_${randomUUID()}`;
    await deliver(oldSnapshot, eventId);
    await deliver(oldSnapshot, eventId);
    expect(provider.retrieve).toHaveBeenCalledTimes(1);
    const saved = await read(org.id);
    expect(saved.entitlements?.planId).toBe('beta');
    expect(resolveEntitlements(saved).capabilities['revenue.autopilot'].allowed).toBe(false);
    const audit = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org.id), eq(auditEventsTable.action, 'billing.subscription_synced')));
    expect(audit).toHaveLength(1);
    // An even older delivery cannot restore scale because current state is retrieved again.
    await deliver(oldSnapshot);
    expect((await read(org.id)).entitlements?.planId).toBe('beta');
  });
  it('fails closed for unknown prices while recording a reconcilable billing state', async () => {
    const org = await fixture();
    provider.retrieve.mockResolvedValue(subscription(org, { items: { data: [{ price: { id: 'price_unknown' }, quantity: 1 }] } }));
    await deliver(subscription(org));
    const saved = await read(org.id);
    expect(saved.planTier).toBe('price_unknown');
    expect(saved.entitlements?.planId).toBe('growth');
    expect(resolveEntitlements(saved).capabilities['revenue.autopilot']).toMatchObject({ allowed: false, reason: 'unmapped_price' });
  });
  it('resolves a known upgrade to the stable internal plan and preserves explicit grant evidence', async () => {
    const org = await fixture();
    provider.retrieve.mockResolvedValue(subscription(org, { status: 'trialing', items: { data: [{ price: { id: 'price_scale' }, quantity: 1 }] } }));
    await deliver(subscription(org), undefined, 'customer.subscription.created');
    const saved = await read(org.id);
    expect(saved.entitlements).toEqual({ version: 1, planId: 'scale', source: 'stripe', grants: [] });
    expect(resolveEntitlements(saved).capabilities['revenue.autopilot'].allowed).toBe(true);
    vi.stubEnv('BILLING_ENFORCE', 'true');
    expect(billing.hasActiveAccess(saved)).toBe(true);
    expect(billing.hasActiveAccess({ subscriptionStatus: 'past_due' })).toBe(false);
    vi.stubEnv('BILLING_ENFORCE', 'false');
    expect(billing.hasActiveAccess({ subscriptionStatus: 'past_due' })).toBe(true);
  });
  it('does not silently migrate legacy tenants or overwrite explicitly assigned manual grants', async () => {
    const legacy = await fixture(false);
    provider.retrieve.mockResolvedValue(subscription(legacy));
    await deliver(subscription(legacy));
    expect((await read(legacy.id)).entitlements).toBeNull();
    const manual = await fixture();
    const grants: OrganizationEntitlements = { version: 1, planId: 'beta', source: 'manual', grants: ['revenue.autopilot'] };
    await db.update(organizationsTable).set({ entitlements: grants }).where(eq(organizationsTable.id, manual.id));
    provider.retrieve.mockResolvedValue(subscription(manual, { status: 'canceled' }));
    await deliver(subscription(manual));
    expect((await read(manual.id)).entitlements).toEqual(grants);
  });
  it('keeps scheduled cancellation active until current status actually ends, then blocks automation', async () => {
    const org = await fixture();
    provider.retrieve.mockResolvedValue(subscription(org, { cancel_at_period_end: true }));
    await deliver(subscription(org));
    expect(resolveEntitlements(await read(org.id)).capabilities['revenue.autopilot'].allowed).toBe(true);
    provider.retrieve.mockResolvedValue(subscription(org, { status: 'canceled' }));
    await deliver(subscription(org), undefined, 'customer.subscription.deleted');
    expect(resolveEntitlements(await read(org.id)).capabilities['revenue.autopilot'].reason).toBe('billing_inactive');
  });
  it('rejects cross-tenant metadata and leaves no audit or partial state on a failed retrieval', async () => {
    const org = await fixture();
    const other = await fixture();
    provider.retrieve.mockResolvedValue(subscription(org, { metadata: { organizationId: other.id } }));
    await expect(deliver(subscription(org))).rejects.toThrow('does not match');
    expect((await read(other.id)).planTier).toBe('price_growth');
    provider.retrieve.mockRejectedValue(new Error('Synthetic provider outage'));
    await expect(deliver(subscription(org))).rejects.toThrow('Synthetic provider outage');
    expect(await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, org.id))).toHaveLength(0);
  });
  it('does not rebind another subscription or accept an ambiguous multi-item plan', async () => {
    const org = await fixture();
    await expect(deliver(subscription(org, { id: 'sub_other' }))).rejects.toThrow('Another subscription');
    expect(provider.retrieve).not.toHaveBeenCalled();
    provider.retrieve.mockResolvedValue(subscription(org, { items: { data: [{ price: { id: 'price_growth' }, quantity: 1 }, { price: { id: 'price_scale' }, quantity: 1 }] } }));
    await deliver(subscription(org));
    expect(resolveEntitlements(await read(org.id)).capabilities['revenue.autopilot'].reason).toBe('unmapped_price');
  });
  it('blocks an unmapped checkout before creating a customer or any checkout side effect', async () => {
    const org = await fixture();
    org.stripeSubscriptionId = null;
    vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{}');
    expect(billing.getBillingStatus(org).canCheckout).toBe(false);
    await expect(billing.createCheckoutSession(org, { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' })).rejects.toThrow('approved internal plan mapping');
    expect(provider.customer).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
  });
  it.each(['active', 'canceled'])('blocks another checkout for a %s bound subscription before any provider call', async (status) => {
    const org = await fixture();
    org.subscriptionStatus = status;
    expect(billing.getBillingStatus(org)).toMatchObject({ canCheckout: false, hasSubscription: true });
    await expect(billing.createCheckoutSession(org, { successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' })).rejects.toMatchObject({ status: 409, code: 'subscription_already_bound' });
    expect(provider.customer).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.retrieve).not.toHaveBeenCalled();
    expect(provider.portal).not.toHaveBeenCalled();
  });
});
