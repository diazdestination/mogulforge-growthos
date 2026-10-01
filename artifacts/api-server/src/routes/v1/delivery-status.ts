import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

import { rateLimit } from "../../lib/rateLimit";
import {
  handleBounce,
  recordTouchDelivery,
} from "../../services/delivery-events";
import { isSafeMailbox } from "../../services/providers";
/**
 * Provider delivery webhooks (public — providers are not CRM users):
 *
 * - POST /public/webhooks/resend  → Resend email events (delivered /
 *   bounced / complained). Every environment requires a valid Svix signature
 *   over the original request bytes. Missing signing configuration fails shut.
 * Twilio status callbacks and operation binding live in twilio.ts.
 *
 * Events are correlated to playbook touches by provider message id; hard
 * bounces flip the contact's per-channel do-not-contact flag and suppress
 * the address so nothing keeps sending to it.
 */
const router: IRouter = Router();

function strictBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64");
  return value === canonical ||
    (!value.includes("=") && value === canonical.replace(/=+$/, ""))
    ? bytes
    : null;
}

/** Svix v1 HMAC verification; no JSON reserialization or unsigned dev bypass. */
export function resendSignatureValid(req: Request): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret?.startsWith("whsec_")) return false;
  const key = strictBase64(secret.slice("whsec_".length));
  if (!key || key.length < 16) return false;
  const id = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signatures = req.headers["svix-signature"];
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
    typeof timestamp !== "string" ||
    !/^[1-9]\d{0,10}$/.test(timestamp) ||
    typeof signatures !== "string" ||
    signatures.length > 4096
  ) {
    return false;
  }
  // Reject stale timestamps (replay window: 5 minutes).
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer })
    .rawBody;
  if (!Buffer.isBuffer(rawBody)) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`, "utf8")
    .update(rawBody)
    .digest();
  return signatures.split(" ").some((part) => {
    const [version, encoded, extra] = part.split(",");
    if (version !== "v1" || !encoded || extra !== undefined) return false;
    const candidate = strictBase64(encoded);
    return Boolean(
      candidate &&
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected),
    );
  });
}

const DELIVERY_EVENTS = new Set([
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.delivery_delayed",
  "email.failed",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

router.post(
  "/public/webhooks/resend",
  rateLimit({ windowMs: 60_000, max: 120, key: "resend-webhook" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!resendSignatureValid(req)) {
      res.status(403).json({ error: "invalid signature" });
      return;
    }
    // Process precisely the authenticated bytes, never an independently
    // modified req.body. Express has already validated the JSON syntax.
    const payload = record(
      JSON.parse(
        (req as Request & { rawBody: Buffer }).rawBody.toString("utf8"),
      ),
    );
    const type = payload?.type;
    if (typeof type !== "string") {
      res.status(400).json({ error: "invalid event" });
      return;
    }
    if (!DELIVERY_EVENTS.has(type)) {
      res.status(200).json({ received: true });
      return;
    }
    const data = record(payload?.data);
    const messageId = data?.email_id;
    const recipients = Array.isArray(data?.to) ? data.to : [data?.to];
    if (
      typeof messageId !== "string" ||
      !messageId ||
      messageId.length > 200 ||
      recipients.length !== 1 ||
      typeof recipients[0] !== "string" ||
      !isSafeMailbox(recipients[0])
    ) {
      res.status(400).json({ error: "invalid delivery correlation" });
      return;
    }
    const correlation = {
      provider: "resend" as const,
      providerMessageId: messageId,
      channel: "email" as const,
      address: recipients[0],
    };
    const bounceType = record(data?.bounce)?.type;
    if (type === "email.delivered") {
      await recordTouchDelivery({ ...correlation, signal: "delivered" });
    } else if (type === "email.complained") {
      await handleBounce({
        ...correlation,
        reason: "unsubscribed",
        source: "resend_webhook",
        detail: "spam complaint",
      });
    } else if (type === "email.bounced" && bounceType === "Permanent") {
      await handleBounce({
        ...correlation,
        reason: "hard_bounce",
        source: "resend_webhook",
        detail: "Resend reported a permanent bounce",
      });
    } else {
      // Temporary/unknown bounces, quota errors and delayed delivery never
      // permanently suppress a recipient. A later delivery can recover them.
      await recordTouchDelivery({
        ...correlation,
        signal:
          type === "email.delivery_delayed" || bounceType === "Transient"
            ? "delayed"
            : "failed",
        detail: "Resend delivery requires review; recipient is not suppressed",
      });
    }
    // ACK only after durable effects succeed. Express returns 5xx on errors so
    // the provider can retry; repeated terminal transitions are idempotent.
    res.status(200).json({ received: true });
  },
);

export default router;
