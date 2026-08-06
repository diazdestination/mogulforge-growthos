import { Router, type IRouter, type Request, type Response } from 'express';

import { handleWebhook, isBillingEnabled } from '../services/billing';

const router: IRouter = Router();

/**
 * Public Stripe webhook — no auth (Stripe signs the request). Verified against
 * STRIPE_WEBHOOK_SECRET using the raw body captured by the express.json `verify`
 * hook in app.ts. Mounted at /api/billing/webhook.
 */
router.post(
  '/billing/webhook',
  async (req: Request, res: Response): Promise<void> => {
    if (!isBillingEnabled()) {
      res.status(404).end();
      return;
    }
    const sigHeader = req.headers['stripe-signature'];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    try {
      const type = await handleWebhook(
        rawBody ?? JSON.stringify(req.body ?? {}),
        signature,
      );
      res.json({ received: true, type });
    } catch (err) {
      req.log?.warn({ err }, 'stripe webhook rejected');
      res.status(400).json({ error: 'Webhook verification failed' });
    }
  },
);

export default router;
