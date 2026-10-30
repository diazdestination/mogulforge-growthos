import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { requireMember } from "../../middlewares/requireMember";
import { InvoiceError } from "../../services/invoice-contract";
import {
  beginStripeConnect,
  createInvoicePaymentLink,
  disconnectStripe,
  getPaymentAccountStatus,
  listInvoicePaymentLinks,
  refreshStripeAccount,
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
  if (error instanceof InvoiceError) {
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
    res.json(await refreshStripeAccount(req.member!.organizationId));
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

router.post("/invoices/:id/payment-links", requireMember("invoices.manage"), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = invoiceId.parse(String(req.params.id));
    res.status(201).json({ link: await createInvoicePaymentLink(req.member!.organizationId, req.member!.user.id, id) });
  } catch (error) {
    fail(res, error);
  }
});

export default router;
