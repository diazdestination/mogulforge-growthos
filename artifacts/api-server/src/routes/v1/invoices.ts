import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { InvoiceError } from "../../services/invoice-contract";
import {
  allocateInvoiceValue,
  createInvoice,
  getInvoice,
  issueInvoice,
  listInvoices,
  recordInvoicePayment,
  reverseInvoiceAllocation,
  updateInvoice,
  voidInvoice,
} from "../../services/invoices";
import {
  getInvoiceDelivery,
  previewInvoiceDelivery,
  sendInvoiceDelivery,
} from "../../services/invoice-delivery";

const router: IRouter = Router();
router.use("/invoices", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  let allowedOrigin: string | undefined;
  try {
    allowedOrigin = new URL(process.env.APP_ORIGIN ?? process.env.APP_URL ?? "")
      .origin;
  } catch {
    /* An unconfigured origin is not trusted. */
  }
  if (
    (req.headers.origin && req.headers.origin !== allowedOrigin) ||
    ["cross-site", "same-site"].includes(
      String(req.headers["sec-fetch-site"] ?? ""),
    )
  ) {
    res.status(403).json({
      error: "This origin is not allowed.",
      code: "invoice_access_denied",
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["x-api-key"] !== undefined) {
      res.status(403).json({
        error:
          "An authenticated staff session is required for invoice changes.",
        code: "invoice_access_denied",
      });
      return;
    }
    if (!req.is("application/json")) {
      res
        .status(415)
        .json({ error: "JSON is required.", code: "invoice_invalid_request" });
      return;
    }
  }
  next();
});
const safe =
  (work: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      if (req.path !== "/invoices" && Object.keys(req.query).length)
        throw new InvoiceError(
          400,
          "invoice_invalid_request",
          "This invoice action does not accept query selectors.",
        );
      await work(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error:
            "Review invoice fields, whole-cent amounts, quantity precision and confirmation.",
          code: "invoice_invalid_request",
        });
        return;
      }
      if (error instanceof InvoiceError) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      res.status(503).json({
        error:
          "Invoice work is unavailable. Keep the same request identity when checking or retrying the saved action.",
        code: "invoice_unavailable",
      });
    }
  };
const id = (req: Request) => z.uuid().parse(req.params.id);
router.get(
  "/invoices/:id/delivery",
  requireMember("invoices.read"),
  safe(async (req, res) =>
    res.json(
      await getInvoiceDelivery(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/delivery/preview",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await previewInvoiceDelivery(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/delivery/send",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await sendInvoiceDelivery(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.get(
  "/invoices",
  requireMember("invoices.read"),
  safe(async (req, res) =>
    res.json(
      await listInvoices(
        req.member!.organizationId,
        req.member!.user.id,
        req.query,
      ),
    ),
  ),
);
router.get(
  "/invoices/:id",
  requireMember("invoices.read"),
  safe(async (req, res) =>
    res.json(
      await getInvoice(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
      ),
    ),
  ),
);
router.post(
  "/invoices",
  requireMember("invoices.manage"),
  safe(async (req, res) => {
    if (Object.keys(req.query).length)
      throw new InvoiceError(
        400,
        "invoice_invalid_request",
        "Invoice creation does not accept query selectors.",
      );
    const result = await createInvoice(
      req.member!.organizationId,
      req.member!.user.id,
      req.body,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);
router.patch(
  "/invoices/:id",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await updateInvoice(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/issue",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await issueInvoice(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/void",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await voidInvoice(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/payments",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await recordInvoicePayment(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/allocations",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await allocateInvoiceValue(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        req.body,
      ),
    ),
  ),
);
router.post(
  "/invoices/:id/allocations/:allocationId/reverse",
  requireMember("invoices.manage"),
  safe(async (req, res) =>
    res.json(
      await reverseInvoiceAllocation(
        req.member!.organizationId,
        req.member!.user.id,
        id(req),
        z.uuid().parse(req.params.allocationId),
        req.body,
      ),
    ),
  ),
);
export default router;
