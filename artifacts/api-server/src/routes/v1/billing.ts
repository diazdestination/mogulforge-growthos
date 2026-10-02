import { db, organizationsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod/v4';

import { requireMember } from '../../middlewares/requireMember';
import { requirePlatformAdmin } from './orgs';
import { assignEntitlements, CapabilityAccessError, entitlementAssignmentSchema, getEntitlements } from '../../services/entitlements';
import {
  BillingOperationError,
  createCheckoutSession,
  createPortalSession,
  getBillingOverview,
  isBillingEnabled,
} from '../../services/billing';
import { authorizeReplacement, billingReconcileSchema, reconcileCheckout, replacementSchema } from '../../services/billing-checkout';

const router: IRouter = Router();

// Billing uses an authenticated human session. Cross-origin browser requests
// cannot authorize a checkout or change operator-controlled billing scope.
router.use((req, res, next) => {
  const path = req.path.toLowerCase().replace(/\/$/, '');
  if (!path.startsWith('/billing') && !/^\/platform\/orgs\/[^/]+\/(?:billing|entitlements)(?:\/|$)/.test(path)) { next(); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    if (req.headers['x-api-key'] !== undefined) { res.status(403).json({ error: 'Billing changes require an authenticated session.' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: 'JSON is required for billing changes.' }); return; }
    let allowedOrigin: string | null = null;
    try { allowedOrigin = new URL(billingReturnUrls().portalUrl).origin; } catch { /* Invalid config cannot authorize an Origin. */ }
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== allowedOrigin)) {
      res.status(403).json({ error: 'This origin is not allowed.' }); return;
    }
    if (['/billing/checkout', '/billing/portal'].includes(path)
      && (Object.keys(req.query).length || !z.object({}).strict().safeParse(req.body ?? {}).success)) {
      res.status(400).json({ error: 'Billing terms and company identity are selected by the server.' }); return;
    }
  }
  next();
});

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
    res.json(await getBillingOverview(org));
  },
);

// Capability state is readable by members; it does not reveal Stripe IDs or
// permit customer-supplied plan values to change server-owned access.
router.get('/billing/entitlements', requireMember('crm.read'), async (req: Request, res: Response): Promise<void> => {
  res.json(await getEntitlements(req.member!.organizationId));
});

// Explicit platform-only cancellation verification/recovery, never browser plan selection.
router.post('/platform/orgs/:id/billing/replacement', requirePlatformAdmin, async (req: Request, res: Response): Promise<void> => {
  const orgId = z.uuid().safeParse(req.params.id);
  const input = replacementSchema.safeParse(req.body);
  if (!orgId.success || !input.success) {
    res.status(400).json({ error: 'Provide the linked subscription and a replacement authorization reason.' });
    return;
  }
  try {
    res.json(await authorizeReplacement(orgId.data, req.sessionUser!.id, input.data, billingReturnUrls()));
  } catch (error) {
    if (error instanceof BillingOperationError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    req.log?.warn('stripe replacement verification failed');
    res.status(503).json({ error: 'Could not verify the canceled subscription. Refresh its provider status before retrying authorization.' });
  }
});
router.post('/platform/orgs/:id/billing/reconcile', requirePlatformAdmin, async (req: Request, res: Response): Promise<void> => {
  const orgId = z.uuid().safeParse(req.params.id);
  const input = billingReconcileSchema.safeParse(req.body);
  if (!orgId.success || !input.success) {
    res.status(400).json({ error: 'Provide a checkout attempt, its provider record and a reconciliation reason.' });
    return;
  }
  try {
    res.json(await reconcileCheckout(orgId.data, req.sessionUser!.id, input.data));
  } catch (error) {
    if (error instanceof BillingOperationError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    req.log?.warn('stripe checkout reconciliation failed');
    res.status(503).json({ error: 'Could not verify the provider record. Keep the checkout on hold and retry reconciliation after reviewing Stripe.' });
  }
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
      });
      res.json({ url });
    } catch (err) {
      if (err instanceof BillingOperationError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      req.log?.error('stripe checkout session failed');
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
      if (err instanceof BillingOperationError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      req.log?.error('stripe portal session failed');
      res.status(500).json({ error: 'Could not open billing portal' });
    }
  },
);

export default router;
