import { Router, type IRouter, type Request, type Response } from 'express';

import { BillingWebhookVerificationError, handleWebhook, isBillingEnabled } from '../services/billing';

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
    if (!rawBody) {
      res.status(400).json({ error: 'Raw webhook body is required' });
      return;
    }
    try {
      const type = await handleWebhook(
        rawBody,
        signature,
      );
      res.json({ received: true, type });
    } catch (err) {
      if (err instanceof BillingWebhookVerificationError) {
        res.status(400).json({ error: 'Webhook verification failed' });
        return;
      }
      // A valid event with a transient/database/reconciliation failure needs redelivery.
      // Provider errors can contain request data; do not put the raw error in logs.
      req.log?.warn('stripe webhook processing failed; redelivery required');
      res.status(503).json({ error: 'Webhook processing is pending; retry delivery' });
    }
  },
);

export default router;
