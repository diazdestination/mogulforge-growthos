import { Router, type IRouter, type Request, type Response } from "express";

import {
  connectWebhookConfigured,
  handleConnectWebhook,
  StripeConnectWebhookVerificationError,
} from "../services/stripe-connect";

const router: IRouter = Router();

/**
 * Public Stripe Connect webhook (events from contractors' connected accounts).
 * Verified against STRIPE_CONNECT_WEBHOOK_SECRET using the raw body captured in
 * app.ts. Mounted at /api/billing/connect-webhook.
 */
router.post("/billing/connect-webhook", async (req: Request, res: Response): Promise<void> => {
  if (!connectWebhookConfigured()) {
    res.status(404).end();
    return;
  }
  const header = req.headers["stripe-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: "Raw webhook body is required" });
    return;
  }
  try {
    res.json({ received: true, type: await handleConnectWebhook(rawBody, signature) });
  } catch (error) {
    if (error instanceof StripeConnectWebhookVerificationError) {
      res.status(400).json({ error: "Webhook verification failed" });
      return;
    }
    req.log?.warn("stripe connect webhook processing failed; redelivery required");
    res.status(503).json({ error: "Webhook processing is pending; retry delivery" });
  }
});

export default router;
