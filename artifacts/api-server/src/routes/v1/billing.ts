import { db, organizationsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod/v4';

import { requireMember } from '../../middlewares/requireMember';
import { requirePlatformAdmin } from './orgs';
import { assignEntitlements, CapabilityAccessError, entitlementAssignmentSchema, getEntitlements } from '../../services/entitlements';
import {
  BillingCheckoutConflictError,
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  isBillingEnabled,
} from '../../services/billing';

const router: IRouter = Router();

/** Stripe return URLs must come from trusted deployment config, never Host headers. */
export function billingReturnUrls(): {
  successUrl: string;
  cancelUrl: string;
  portalUrl: string;
} {
  const configured =
    process.env.APP_ORIGIN?.trim() || process.env.APP_URL?.trim();
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('APP_ORIGIN is required for billing return URLs');
  }
  let url: URL;
  try {
    url = new URL(configured || 'http://localhost:5000');
  } catch {
    throw new Error('Billing return origin is invalid');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Billing return origin is invalid');
  }
  const origin = url.origin;
  return {
    successUrl: `${origin}/settings?billing=success`,
    cancelUrl: `${origin}/settings?billing=cancel`,
    portalUrl: `${origin}/settings`,
  };
}

async function loadOrg(orgId: string) {
  const [org] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  return org;
}

// Current subscription/billing state for the caller's org.
router.get(
  '/billing',
  requireMember('settings.manage'),
  async (req: Request, res: Response): Promise<void> => {
    const org = await loadOrg(req.member!.organizationId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    res.json(getBillingStatus(org));
  },
);

// Capability state is readable by members; it does not reveal Stripe IDs or
// permit customer-supplied plan values to change server-owned access.
router.get('/billing/entitlements', requireMember('crm.read'), async (req: Request, res: Response): Promise<void> => {
  res.json(await getEntitlements(req.member!.organizationId));
});

// Reuses the explicitly cross-organization platform-operator identity model.
// Ordinary tenant admins and API keys cannot enroll or upgrade a company.
router.post('/platform/orgs/:id/entitlements', requirePlatformAdmin, async (req: Request, res: Response): Promise<void> => {
  const orgId = z.uuid().safeParse(req.params.id);
  const assignment = entitlementAssignmentSchema.safeParse(req.body);
  if (!orgId.success || !assignment.success) {
    res.status(400).json({ error: 'Provide a valid organization, known plan, explicit grants and a scope-change reason.' });
    return;
  }
  try {
    res.json(await assignEntitlements(orgId.data, req.sessionUser!.id, assignment.data));
  } catch (error) {
    if (error instanceof CapabilityAccessError) {
      res.status(error.reason === 'organization_missing' ? 404 : error.status).json({ error: error.message, code: error.code, reason: error.reason });
      return;
    }
    throw error;
  }
});

// Start a Stripe Checkout for the subscription. Returns a URL to redirect to.
router.post(
  '/billing/checkout',
  requireMember('settings.manage'),
  async (req: Request, res: Response): Promise<void> => {
    if (!isBillingEnabled()) {
      res.status(400).json({ error: 'Billing is not configured' });
      return;
    }
    const org = await loadOrg(req.member!.organizationId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    try {
      const returnUrls = billingReturnUrls();
      const url = await createCheckoutSession(org, {
        successUrl: returnUrls.successUrl,
        cancelUrl: returnUrls.cancelUrl,
        trialDays: 14,
      });
      res.json({ url });
    } catch (err) {
      if (err instanceof BillingCheckoutConflictError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      req.log?.error({ err }, 'stripe checkout session failed');
      res.status(500).json({ error: 'Could not start checkout' });
    }
  },
);

// Open the Stripe customer portal (manage/cancel subscription, update card).
router.post(
  '/billing/portal',
  requireMember('settings.manage'),
  async (req: Request, res: Response): Promise<void> => {
    if (!isBillingEnabled()) {
      res.status(400).json({ error: 'Billing is not configured' });
      return;
    }
    const org = await loadOrg(req.member!.organizationId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    try {
      const url = await createPortalSession(org, billingReturnUrls().portalUrl);
      res.json({ url });
    } catch (err) {
      req.log?.error({ err }, 'stripe portal session failed');
      res.status(500).json({ error: 'Could not open billing portal' });
    }
  },
);

export default router;
