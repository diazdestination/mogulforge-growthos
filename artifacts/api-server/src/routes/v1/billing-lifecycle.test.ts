import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { db, organizationsTable, usersTable, billingCheckoutsTable } from '@workspace/db';
import { eq, inArray } from 'drizzle-orm';
import express, { type Request } from 'express';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { deleteTestOrgs } from '../../test-helpers/delete-test-orgs';

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
let server: Server; let origin: string;
let orgA: string; let orgB: string; let owner: string; let viewer: string; let operator: string;
const secret = 'whsec_synthetic_http_billing_only';
const signer = new Stripe('sk_test_synthetic_only');
beforeAll(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
  vi.stubEnv('STRIPE_PRICE_ID', 'price_beta');
  vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{"price_beta":"beta"}');
  const nonce = randomUUID();
  const orgs = await db.insert(organizationsTable).values([
    { name: 'Billing HTTP A', slug: `billing-http-a-${nonce}`, stripeCustomerId: `cus_a_${nonce}`, stripeSubscriptionId: `sub_a_${nonce}`, subscriptionStatus: 'canceled' },
    { name: 'Billing HTTP B', slug: `billing-http-b-${nonce}`, stripeCustomerId: 'cus_http_other', stripeSubscriptionId: 'sub_http_other', subscriptionStatus: 'canceled' },
  ]).returning();
  [orgA, orgB] = orgs.map((org) => org.id);
  [owner, viewer, operator] = [`billing-http-owner-${nonce}`, `billing-http-viewer-${nonce}`, `billing-http-platform-${nonce}`];
  await db.insert(usersTable).values([{ id: owner, organizationId: orgA, role: 'owner' }, { id: viewer, organizationId: orgA, role: 'viewer' }, { id: operator, isPlatformAdmin: true }]);
  const { default: billingRouter } = await import('./billing');
  const { default: webhookRouter } = await import('../billing-webhook');
  const app = express();
  app.use(express.json({ verify: (req, _res, body) => { if (!req.headers['x-synthetic-omit-raw']) (req as Request & { rawBody?: Buffer }).rawBody = body; } }));
  app.use((req, _res, next) => {
    const id = req.header('x-synthetic-user');
    req.isAuthenticated = (() => Boolean(id)) as Request['isAuthenticated'];
    if (id) req.user = { id, email: null, firstName: null, lastName: null, profileImageUrl: null };
    next();
  });
  app.use(billingRouter); app.use(webhookRouter);
  server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Synthetic server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('APP_ORIGIN', origin);
});
beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  await db.update(usersTable).set({ organizationId: null }).where(inArray(usersTable.id, [owner, viewer, operator]));
  await deleteTestOrgs(orgA, orgB); await db.delete(usersTable).where(inArray(usersTable.id, [owner, viewer, operator])); vi.unstubAllEnvs();
});
async function post(path: string, user: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-user': user, ...headers }, body: JSON.stringify(body) });
}
const replacement = { subscriptionId: 'sub_http_other', reason: 'Approved synthetic replacement request' };
it('denies unauthenticated, viewer, tenant-owner and API-key operator mutations before provider reads', async () => {
  const path = `/platform/orgs/${orgB}/billing/replacement`;
  expect((await post(path, '', replacement)).status).toBe(401);
  expect((await post(path, owner, replacement)).status).toBe(403);
  expect((await post(path, viewer, replacement)).status).toBe(403);
  expect((await post(path, operator, replacement, { 'x-api-key': 'synthetic' })).status).toBe(403);
  expect(provider.retrieve).not.toHaveBeenCalled();
});
it('rejects cross-site requests, forged terms and company overrides without provider effects', async () => {
  for (const path of ['/billing/checkout', '/billing/portal', `/platform/orgs/${orgB}/billing/replacement`, `/platform/orgs/${orgB}/billing/reconcile`]) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'x-synthetic-user': operator, 'content-type': 'text/plain' }, body: '{}' });
    expect(response.status).toBe(415);
  }
  expect((await post(`/platform/orgs/${orgB}/billing/replacement`, operator, replacement, { origin: 'https://attacker.example.test' })).status).toBe(403);
  expect((await post('/billing/checkout', owner, {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  expect((await post('/BILLING/CHECKOUT/', owner, {}, { origin: 'https://attacker.example.test' })).status).toBe(403);
  expect((await post(`/PLATFORM/ORGS/${orgB}/BILLING/REPLACEMENT/`, operator, replacement, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  expect((await post('/billing/checkout', owner, { organizationId: orgB, priceId: 'price_fake', trialDays: 730 })).status).toBe(400);
  expect((await post('/billing/portal?organizationId=' + orgB, owner)).status).toBe(400);
  expect((await post(`/platform/orgs/${orgB}/billing/replacement`, operator, { ...replacement, organizationId: orgA })).status).toBe(400);
  expect(provider.retrieve).not.toHaveBeenCalled(); expect(provider.checkout).not.toHaveBeenCalled();
});
it('authorizes only the named platform target and status remains tenant-scoped', async () => {
  provider.retrieve.mockResolvedValue({ id: 'sub_http_other', customer: 'cus_http_other', status: 'canceled', metadata: { organizationId: orgB } });
  const response = await post(`/platform/orgs/${orgB}/billing/replacement`, operator, replacement, { origin });
  expect(response.status).toBe(200);
  expect(await db.select().from(billingCheckoutsTable).where(eq(billingCheckoutsTable.organizationId, orgA))).toHaveLength(0);
  expect(await db.select().from(billingCheckoutsTable).where(eq(billingCheckoutsTable.organizationId, orgB))).toHaveLength(1);
  const status = await fetch(`${origin}/billing?organizationId=${orgB}`, { headers: { 'x-synthetic-user': owner } });
  expect(await status.json()).toMatchObject({ checkout: null, canCheckout: false });
  expect(status.headers.get('cache-control')).toBe('no-store');
  expect(provider.checkout).not.toHaveBeenCalled(); expect(provider.customer).not.toHaveBeenCalled();
});
it('protects reconciliation with active operator auth, strict shape and tenant-scoped lookup', async () => {
  const [attempt] = await db.select().from(billingCheckoutsTable).where(eq(billingCheckoutsTable.organizationId, orgB));
  const body = { attemptId: attempt.id, customerId: 'cus_not_evidence', reason: 'Synthetic operator reconciliation' };
  expect((await post(`/platform/orgs/${orgB}/billing/reconcile`, owner, body)).status).toBe(403);
  expect((await post(`/platform/orgs/${orgB}/billing/reconcile`, operator, { ...body, force: true })).status).toBe(400);
  expect((await post(`/platform/orgs/${orgA}/billing/reconcile`, operator, body)).status).toBe(409);
  expect(provider.retrieve).not.toHaveBeenCalled();
});
it('requires manager access to checkout and preserves a stable bound-subscription error', async () => {
  expect((await post('/billing/checkout', viewer)).status).toBe(403);
  const response = await post('/billing/checkout', owner);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'subscription_already_bound' });
  expect(provider.customer).not.toHaveBeenCalled(); expect(provider.checkout).not.toHaveBeenCalled();
});
it('distinguishes bad signature/raw-body verification from retryable authenticated processing failure', async () => {
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_http_other', customer: 'cus_http_other' } } });
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret });
  const webhook = (sig: string, headers: Record<string, string> = {}) => fetch(`${origin}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig, ...headers }, body: payload });
  expect((await webhook('invalid')).status).toBe(400);
  expect((await webhook(signature, { 'x-synthetic-omit-raw': '1' })).status).toBe(400);
  expect(provider.retrieve).not.toHaveBeenCalled();
  provider.retrieve.mockRejectedValue(new Error('SYNTHETIC_PROVIDER_INTERNAL_DETAILS_MUST_NOT_ESCAPE'));
  const failed = await webhook(signature);
  expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('SYNTHETIC_PROVIDER_INTERNAL_DETAILS');
  provider.retrieve.mockResolvedValue({ id: 'sub_http_other', customer: 'cus_http_other', status: 'canceled', metadata: { organizationId: orgB }, items: { data: [{ price: { id: 'price_beta' }, quantity: 1 }] } });
  expect((await webhook(signature)).status).toBe(200);
});
