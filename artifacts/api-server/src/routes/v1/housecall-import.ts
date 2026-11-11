import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import { FinancialMigrationError } from "../../services/financial-migration-contract";
import {
  HousecallImportError,
  commitHousecallInvoices,
  importHousecallEstimates,
  importHousecallJobs,
  previewHousecallInvoices,
} from "../../services/housecall-import";
import { financialApprovalGuard } from "./financial-migration";

/** "Move from Housecall Pro": jobs history, estimates, and invoices/open balances. Customers use /lead-imports (customers mode). */
const router: IRouter = Router();
router.use("/housecall-import", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use("/housecall-import/invoices", financialApprovalGuard);

const safe = (work: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, _next: NextFunction) => {
  try {
    res.json(await work(req));
  } catch (error) {
    if (error instanceof HousecallImportError || error instanceof FinancialMigrationError) {
      res.status(error.status).json({ code: error.code, error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ code: "hcp_invalid_request", error: "Check the file, the chosen columns, the export date and the time zone." });
      return;
    }
    res.status(503).json({ code: "hcp_unavailable", error: "The import could not be confirmed. Check your import history before trying again; a repeat import never duplicates records." });
  }
};

router.post(
  "/housecall-import/jobs",
  requireMember("crm.write"),
  rateLimit({ windowMs: 60_000, max: 10, key: "housecall-import-jobs" }),
  safe((req) => importHousecallJobs(req.member!.organizationId, req.member!.user.id, req.body)),
);
router.post(
  "/housecall-import/estimates",
  requireMember("crm.write"),
  rateLimit({ windowMs: 60_000, max: 10, key: "housecall-import-estimates" }),
  safe((req) => importHousecallEstimates(req.member!.organizationId, req.member!.user.id, req.body)),
);
router.post(
  "/housecall-import/invoices/preview",
  requireMember("settings.manage"),
  rateLimit({ windowMs: 60_000, max: 10, key: "housecall-import-invoices-preview" }),
  safe((req) => previewHousecallInvoices(req.member!.organizationId, req.member!.user.id, req.body)),
);
router.post(
  "/housecall-import/invoices/commit",
  requireMember("settings.manage"),
  rateLimit({ windowMs: 60_000, max: 10, key: "housecall-import-invoices-commit" }),
  safe((req) => commitHousecallInvoices(req.member!.organizationId, req.member!.user.id, req.body)),
);

export default router;
