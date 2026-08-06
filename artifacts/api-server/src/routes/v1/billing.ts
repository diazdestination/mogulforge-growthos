import { db, organizationsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';

import { requireMember } from '../../middlewares/requireMember';
import {
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  isBillingEnabled,
} from '../../services/billing';

const router: IRouter = Router();

function getOrigin(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  return `${Array.isArray(proto) ? proto[0] : proto}://${host}`;
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
    const origin = getOrigin(req);
    try {
      const url = await createCheckoutSession(org, {
        successUrl: `${origin}/settings?billing=success`,
        cancelUrl: `${origin}/settings?billing=cancel`,
        trialDays: 14,
      });
      res.json({ url });
    } catch (err) {
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
      const url = await createPortalSession(org, `${getOrigin(req)}/settings`);
      res.json({ url });
    } catch (err) {
      req.log?.error({ err }, 'stripe portal session failed');
      res.status(500).json({ error: 'Could not open billing portal' });
    }
  },
);

export default router;
