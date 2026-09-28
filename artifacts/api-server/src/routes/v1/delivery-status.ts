import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

import { rateLimit } from "../../lib/rateLimit";
import {
  handleBounce,
  recordTouchDelivery,
} from "../../services/delivery-events";
/**
 * Provider delivery webhooks (public — providers are not CRM users):
 *
 * - POST /public/webhooks/resend  → Resend email events (delivered /
 *   bounced / complained). Verified with the svix signature when
 *   RESEND_WEBHOOK_SECRET is set; accepted unsigned in dev/mock setups.
 * Twilio status callbacks and operation binding live in twilio.ts.
 *
 * Events are correlated to playbook touches by provider message id; hard
 * bounces flip the contact's per-channel do-not-contact flag and suppress
 * the address so nothing keeps sending to it.
 */
const router: IRouter = Router();

/** Svix-style signature check (Resend webhooks are delivered via svix). */
function resendSignatureValid(req: Request): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return true; // dev / not configured: nothing to validate against
  const id = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signatures = req.headers["svix-signature"];
  if (
    typeof id !== "string" ||
    typeof timestamp !== "string" ||
    typeof signatures !== "string"
  ) {
    return false;
  }
  // Reject stale timestamps (replay window: 5 minutes).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
  const payload = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body);
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`, "utf8")
    .digest("base64");
  return signatures.split(" ").some((part) => {
    const sig = part.split(",")[1] ?? "";
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

router.post(
  "/public/webhooks/resend",
  rateLimit({ windowMs: 60_000, max: 120, key: "resend-webhook" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!resendSignatureValid(req)) {
      res.status(403).json({ error: "invalid signature" });
      return;
    }
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    const data = (req.body?.data ?? {}) as {
      email_id?: string;
      to?: string[] | string;
      bounce?: { message?: string };
    };
    const messageId = typeof data.email_id === "string" ? data.email_id : "";
    const to = Array.isArray(data.to) ? data.to[0] : data.to;

    if (messageId) {
      if (type === "email.delivered") {
        await recordTouchDelivery({ providerMessageId: messageId, signal: "delivered" });
      } else if (type === "email.bounced") {
        await handleBounce({
          providerMessageId: messageId,
          channel: "email",
          address: typeof to === "string" ? to : null,
          reason: "hard_bounce",
          source: "resend_webhook",
          detail: data.bounce?.message?.slice(0, 500),
        });
      } else if (type === "email.complained") {
        // Spam complaint = treat as unsubscribe for that address.
        await recordTouchDelivery({ providerMessageId: messageId, signal: "unsubscribed" });
        await handleBounce({
          providerMessageId: messageId,
          channel: "email",
          address: typeof to === "string" ? to : null,
          reason: "unsubscribed",
          source: "resend_webhook",
          detail: "spam complaint",
        });
      }
    }
    // Always 200 — unknown event types are fine, and providers retry non-2xx.
    res.status(200).json({ received: true });
  },
);

export default router;
