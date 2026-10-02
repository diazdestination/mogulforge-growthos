import { randomUUID } from 'node:crypto';
import { auditEventsTable, db, organizationsTable, usersTable, type OrganizationEntitlements } from '@workspace/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { deleteTestOrgs } from '../test-helpers/delete-test-orgs';
import { assignEntitlements, assertCapabilityForActor, getEntitlements, mappedPlanForPrice, resolveEntitlements } from './entitlements';

const orgIds: string[] = [];
const userIds: string[] = [];
const policy = (planId: 'beta' | 'growth' | 'scale', grants: OrganizationEntitlements['grants'] = []): OrganizationEntitlements => ({ version: 1, planId, source: 'manual', grants });

async function fixture() {
  const nonce = randomUUID();
  const [org] = await db.insert(organizationsTable).values({ name: 'Entitlement test', slug: `entitlement-${nonce}` }).returning();
  orgIds.push(org.id);
  const [owner, viewer, operator] = await db.insert(usersTable).values([
    { id: `entitlement-owner-${nonce}`, email: `owner-${nonce}@example.test`, organizationId: org.id, role: 'owner' as const },
    { id: `entitlement-viewer-${nonce}`, email: `viewer-${nonce}@example.test`, organizationId: org.id, role: 'viewer' as const },
    { id: `entitlement-operator-${nonce}`, email: `operator-${nonce}@example.test`, role: 'owner' as const, isPlatformAdmin: true },
  ]).returning();
  userIds.push(owner.id, viewer.id, operator.id);
  return { org, owner, viewer, operator };
}
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (userIds.length) await db.update(usersTable).set({ organizationId: null }).where(inArray(usersTable.id, userIds));
  await deleteTestOrgs(...orgIds);
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe('server-owned plan and capability decisions', () => {
  it('preserves legacy access and only assigns the implemented capability', () => {
    const legacy = resolveEntitlements({ entitlements: null, subscriptionStatus: null, planTier: null });
    expect(legacy).toMatchObject({ mode: 'legacy', planId: null, capabilities: { 'revenue.autopilot': { allowed: true, reason: 'legacy_access' } } });
    expect(resolveEntitlements({ entitlements: policy('beta'), subscriptionStatus: null, planTier: null }).capabilities['revenue.autopilot'].allowed).toBe(false);
    expect(resolveEntitlements({ entitlements: policy('growth'), subscriptionStatus: null, planTier: null }).capabilities['revenue.autopilot'].allowed).toBe(true);
  });
  it('fails closed for malformed stored policies and unknown/malformed price maps', () => {
    expect(resolveEntitlements({ entitlements: { version: 999 } as unknown as OrganizationEntitlements, subscriptionStatus: 'active', planTier: 'price_growth' }).capabilities['revenue.autopilot'].reason).toBe('invalid_policy');
    for (const map of ['invalid-json', '{"price_growth":"invented"}', '{"not_a_price":"growth"}']) {
      vi.stubEnv('STRIPE_PLAN_PRICE_MAP', map);
      expect(mappedPlanForPrice('price_growth')).toBeNull();
    }
    vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{"price_growth":"growth"}');
    expect(mappedPlanForPrice('price_unknown')).toBeNull();
    expect(mappedPlanForPrice('price_growth')).toBe('growth');
  });
  it.each(['past_due', 'canceled', 'incomplete', 'unpaid', null])('pauses Stripe-managed automation for %s even when the general paywall is off', (status) => {
    vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{"price_growth":"growth"}');
    vi.stubEnv('BILLING_ENFORCE', 'false');
    expect(resolveEntitlements({ entitlements: { ...policy('growth'), source: 'stripe' }, subscriptionStatus: status, planTier: 'price_growth' }).capabilities['revenue.autopilot']).toMatchObject({ allowed: false, reason: 'billing_inactive' });
  });
});

describe('explicit tenant scope assignment', () => {
  it('requires a platform operator, rejects browser plan/organization bypasses and writes an atomic scoped audit', async () => {
    const { org, owner, operator } = await fixture();
    const other = await fixture();
    const assignment = { planId: 'beta', source: 'manual', grants: ['revenue.autopilot'], reason: 'Honor the agreed founding beta workflow' };
    await expect(assignEntitlements(org.id, owner.id, assignment)).rejects.toMatchObject({ reason: 'operator_required' });
    await expect(assignEntitlements(org.id, operator.id, { ...assignment, organizationId: other.org.id })).rejects.toThrow();
    await expect(assignEntitlements(org.id, operator.id, { ...assignment, planId: 'enterprise' })).rejects.toThrow();
    const status = await assignEntitlements(org.id, operator.id, assignment);
    expect(status).toMatchObject({ mode: 'managed', planId: 'beta', capabilities: { 'revenue.autopilot': { allowed: true, reason: 'tenant_grant' } } });
    expect((await getEntitlements(other.org.id)).mode).toBe('legacy');
    const audits = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org.id), eq(auditEventsTable.action, 'billing.entitlements_assigned')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: operator.id, metadata: { previous: null, next: policy('beta', ['revenue.autopilot']), reason: assignment.reason } });
    await assignEntitlements(org.id, operator.id, { ...assignment, grants: [], reason: 'Explicitly remove the separately reviewed workflow grant' });
    expect((await getEntitlements(org.id)).capabilities['revenue.autopilot'].allowed).toBe(false);
  });
  it('keeps role, active membership and tenant isolation requirements when a capability is granted', async () => {
    const { org, owner, viewer, operator } = await fixture();
    const other = await fixture();
    await assignEntitlements(org.id, operator.id, { planId: 'growth', source: 'manual', grants: [], reason: 'Synthetic customer scope acceptance' });
    await expect(assertCapabilityForActor(org.id, owner.id, 'revenue.autopilot', 'settings.manage')).resolves.toBeUndefined();
    await expect(assertCapabilityForActor(org.id, viewer.id, 'revenue.autopilot', 'settings.manage')).rejects.toMatchObject({ reason: 'permission_required' });
    await expect(assertCapabilityForActor(org.id, other.owner.id, 'revenue.autopilot', 'settings.manage')).rejects.toMatchObject({ reason: 'permission_required' });
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner.id));
    await expect(assertCapabilityForActor(org.id, owner.id, 'revenue.autopilot', 'settings.manage')).rejects.toMatchObject({ reason: 'permission_required' });
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, operator.id));
    await expect(assignEntitlements(org.id, operator.id, { planId: 'beta', source: 'manual', grants: [], reason: 'Synthetic disabled operator rejection' })).rejects.toMatchObject({ reason: 'operator_required' });
  });
  it('requires a reconciled known price before operator enrollment in Stripe-managed capabilities', async () => {
    const { org, operator } = await fixture();
    vi.stubEnv('STRIPE_PLAN_PRICE_MAP', '{"price_growth":"growth"}');
    const assignment = { planId: 'growth', source: 'stripe', grants: [], reason: 'Synthetic Stripe-managed enrollment' };
    await expect(assignEntitlements(org.id, operator.id, assignment)).rejects.toMatchObject({ reason: 'unmapped_price' });
    await db.update(organizationsTable).set({ planTier: 'price_growth', subscriptionStatus: 'active', stripeCustomerId: `cus_${org.id}`, stripeSubscriptionId: `sub_${org.id}` }).where(eq(organizationsTable.id, org.id));
    expect((await assignEntitlements(org.id, operator.id, assignment)).capabilities['revenue.autopilot'].allowed).toBe(true);
  });
});
