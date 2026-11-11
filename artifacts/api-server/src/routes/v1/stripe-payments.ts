import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import QRCode from "qrcode";
import { db } from "@workspace/db";
import { z } from "zod";

import { requireMember } from "../../middlewares/requireMember";
import { assertFieldCollectScope, FieldCollectError } from "../../services/field-collect";
import { InvoiceError } from "../../services/invoice-contract";
import {
  beginStripeConnect,
  createInvoicePaymentLink,
  disconnectStripe,
  getPaymentAccountStatus,
  getPaymentReadiness,
  listInvoicePaymentLinks,
  refreshStripeAccount,
  reconcileInvoicePaymentLink,
  StripeConnectError,
} from "../../services/stripe-connect";

/**
 * BILL card & bank collection. Connecting the company's Stripe account is
 * settings authority from a signed-in human; creating a payment link needs
 * invoice management; members with invoice access can see link state.
 */
const router: IRouter = Router();
const invoiceId = z.string().uuid();

const sessionOnly: RequestHandler = (req, res, next) => {
  if (req.get("x-api-key") || !req.user || req.user.id !== req.member?.user.id) {
    res.status(403).json({ error: "Sign in with your own account to manage payments." });
    return;
  }
  next();
};

function fail(res: Response, error: unknown): void {
  if (error instanceof StripeConnectError) {
    const status =
      error.code === "not_configured" ? 503 : error.code === "not_found" ? 404 : error.code === "provider_failed" ? 502 : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof InvoiceError || error instanceof FieldCollectError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid payment request" });
    return;
  }
  res.status(500).json({ error: "Payment request failed." });
}

router.get("/payments/stripe", requireMember("invoices.read"), async (req: Request, res: Response): Promise<void> => {
  res.json(await getPaymentAccountStatus(req.member!.organizationId));
});

router.post("/payments/stripe/connect", requireMember("settings.manage"), sessionOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await beginStripeConnect(req.member!.organizationId, req.member!.user.id));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/payments/stripe/refresh", requireMember("settings.manage"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await refreshStripeAccount(req.member!.organizationId, req.member!.user.id));
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/payments/stripe", requireMember("settings.manage"), sessionOnly, async (req: Request, res: Response): Promise<void> => {
  res.json({ disconnected: await disconnectStripe(req.member!.organizationId, req.member!.user.id) });
});

router.get("/invoices/:id/payment-links", requireMember("invoices.read"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ links: await listInvoicePaymentLinks(req.member!.organizationId, invoiceId.parse(String(req.params.id))) });
  } catch (error) {
    fail(res, error);
  }
});

async function payLinkQr(organizationId: string, id: string, linkId: string) {
  const link = (await listInvoicePaymentLinks(organizationId, id)).find(item => item.id === linkId);
  if (!link) throw new StripeConnectError("Payment link not found.", "not_found");
  if (link.state !== "open" || !link.url || !/^https:\/\//.test(link.url)) throw new StripeConnectError("This pay link is no longer open. Create a new one for the current balance.", "invalid");
  const qrDataUrl = await QRCode.toDataURL(link.url, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  return { linkId: link.id, url: link.url, amountCents: link.amountCents, expiresAt: link.expiresAt, qrDataUrl };
}

// QR of the open pay link so a customer can pay on their own phone in person.
router.get("/invoices/:id/payment-links/:linkId/qr", requireMember("invoices.read"), async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await payLinkQr(req.member!.organizationId, invoiceId.parse(String(req.params.id)), invoiceId.parse(String(req.params.linkId))));
  } catch (error) {
    fail(res, error);
  }
});

// ---- Field collection (payments.collect): only an invoice linked to the member's own assigned job. ----
function fieldParams(req: Request) {
  return { appointmentId: invoiceId.parse(String(req.params.appointmentId)), id: invoiceId.parse(String(req.params.id)) };
}
const fieldActor = (req: Request) => ({ userId: req.member!.user.id, effectiveRole: req.member!.role });

router.get("/appointments/:appointmentId/invoices/:id/payment-links", requireMember("payments.collect"), async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { appointmentId, id } = fieldParams(req);
    await assertFieldCollectScope(db, req.member!.organizationId, fieldActor(req), id, appointmentId);
    // Readiness lets the tech see why a pay link can't be made (without office invoice access).
    const [links, readiness] = await Promise.all([listInvoicePaymentLinks(req.member!.organizationId, id), getPaymentReadiness(req.member!.organizationId)]);
    res.json({ links, readiness });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/appointments/:appointmentId/invoices/:id/payment-links", requireMember("payments.collect"), sessionOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const { appointmentId, id } = fieldParams(req);
    res.status(201).json({ link: await createInvoicePaymentLink(req.member!.organizationId, req.member!.user.id, id, { appointmentId, effectiveRole: req.member!.role }) });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/appointments/:appointmentId/invoices/:id/payment-links/:linkId/qr", requireMember("payments.collect"), async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { appointmentId, id } = fieldParams(req);
    await assertFieldCollectScope(db, req.member!.organizationId, fieldActor(req), id, appointmentId);
    res.json(await payLinkQr(req.member!.organizationId, id, invoiceId.parse(String(req.params.linkId))));
  } catch (error) {
    fail(res, error);
  }
});

router.post("/invoices/:id/payment-links", requireMember("invoices.manage"), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = invoiceId.parse(String(req.params.id));
    res.status(201).json({ link: await createInvoicePaymentLink(req.member!.organizationId, req.member!.user.id, id) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/invoices/:id/payment-links/:linkId/reconcile", requireMember("invoices.manage"), sessionOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    // The service also checks the session prefix against the configured mode.
    const options = z.object({ checkoutSessionId: z.string().regex(/^cs_(?:test|live)_[A-Za-z0-9_]+$/).max(200).optional(), expire: z.boolean().optional() }).strict().parse(req.body ?? {});
    res.json({ link: await reconcileInvoicePaymentLink(req.member!.organizationId, req.member!.user.id, invoiceId.parse(String(req.params.id)), invoiceId.parse(String(req.params.linkId)), options) });
  } catch (error) { fail(res, error); }
});

export default router;
