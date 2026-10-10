import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import {
  DetailCorrectionError,
  getCustomerDetailCorrectionReceipt,
  getCustomerDetailSnapshot,
  saveCustomerDetailCorrection,
} from "../../services/customer-detail-corrections";

const router: IRouter = Router();
const idSchema = z.uuid();

function privateResponse(req: Request, res: Response, next: NextFunction): void {
  res.set("Cache-Control", "no-store").set("Pragma", "no-cache").set("Referrer-Policy", "no-referrer");
  let trustedOrigin: string | null = null;
  try { trustedOrigin = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* Missing configuration authorizes no browser origin. */ }
  const origin = req.header("origin"), site = req.header("sec-fetch-site");
  if ((origin !== undefined && origin !== trustedOrigin) || (site && !["same-origin", "none"].includes(site))) {
    res.status(403).json({ error: "Open this review from your signed-in GrowthOS workspace.", code: "detail_correction_origin_required" });
    return;
  }
  next();
}

// These routes record a human staff review. A programmatic key or homeowner
// portal token cannot stand in for the currently authenticated staff member.
function requireStaffSession(req: Request, res: Response, next: NextFunction): void {
  if (Object.hasOwn(req.headers, "x-api-key")) {
    res.status(403).json({ error: "Sign in with a staff account to review customer details." });
    return;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

function context(req: Request) {
  if (!req.user || req.user.id !== req.member?.user.id) throw new DetailCorrectionError(403, "detail_correction_access_denied");
  return {
    organizationId: req.member!.organizationId,
    contactId: String(req.params.id),
    actorUserId: req.member!.user.id,
    effectiveRole: req.member!.role,
  };
}

function refuseInvalidId(req: Request, res: Response): boolean {
  if (idSchema.safeParse(String(req.params.id)).success) return false;
  res.status(400).json({ error: "Invalid customer ID" });
  return true;
}

function respondToError(error: unknown, req: Request, res: Response, mutation: boolean): void {
  if (error instanceof DetailCorrectionError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  req.log?.error({ event: "customer_detail_correction_unconfirmed", operation: mutation ? "save" : "read" }, "Customer detail correction unavailable");
  res.status(503).json({
    error: mutation
      ? "The save result could not be confirmed. Check the saved result before another change."
      : "The customer record is temporarily unavailable.",
    code: mutation ? "detail_correction_unconfirmed" : "detail_correction_unavailable",
  });
}

router.get("/contacts/:id/detail-correction", privateResponse, requireStaffSession, requireMember("crm.read"), async (req, res) => {
  if (refuseInvalidId(req, res)) return;
  if (Object.keys(req.query).some(key => key !== "propertyId")) {
    res.status(400).json({ error: "Use only the selected property for this customer review." }); return;
  }
  const propertyId = req.query.propertyId === undefined ? null : req.query.propertyId;
  if (propertyId !== null && !idSchema.safeParse(propertyId).success) {
    res.status(400).json({ error: "Choose a valid property ID" });
    return;
  }
  try {
    res.json(await getCustomerDetailSnapshot({ ...context(req), propertyId: propertyId as string | null }));
  } catch (error) { respondToError(error, req, res, false); }
});

router.post("/contacts/:id/detail-corrections", privateResponse, requireStaffSession, requireMember("crm.write"), async (req, res) => {
  if (refuseInvalidId(req, res)) return;
  if (Object.keys(req.query).length) { res.status(400).json({ error: "Query selectors are not accepted for this save." }); return; }
  try {
    res.json(await saveCustomerDetailCorrection({ ...context(req), input: req.body }));
  } catch (error) { respondToError(error, req, res, true); }
});

router.get("/contacts/:id/detail-corrections/:requestId", privateResponse, requireStaffSession, requireMember("crm.read"), async (req, res) => {
  if (refuseInvalidId(req, res)) return;
  if (Object.keys(req.query).length) { res.status(400).json({ error: "Query selectors are not accepted for this saved result." }); return; }
  const requestId = idSchema.safeParse(String(req.params.requestId));
  if (!requestId.success) {
    res.status(400).json({ error: "Invalid saved-result ID" });
    return;
  }
  try {
    const receipt = await getCustomerDetailCorrectionReceipt({ ...context(req), requestId: requestId.data });
    if (!receipt) { res.status(404).json({ error: "Saved result not found" }); return; }
    res.json(receipt);
  } catch (error) { respondToError(error, req, res, false); }
});

export default router;
