import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import { missedCallCarePolicySchema } from "../../services/missed-call-care-policy";
import { approveMissedCallCare, closeMissedCallCare, listMissedCallCare, MissedCallCareError, previewMissedCallCare, saveMissedCallCarePolicy } from "../../services/missed-call-care";

const router: IRouter = Router();
const version = z.number().int().nonnegative();
/** Human session approval, never an API-key silent enrollment route. */
function humanAction(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("origin"), site = req.header("sec-fetch-site");
  let configuredOrigin: string | null = null;
  try { configuredOrigin = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* No configured origin means no approval. */ }
  // A Basic/garbage Authorization header falls back to cookies in getSessionId;
  // it must never act as a cookie-CSRF bypass. requireMember must also validate
  // the actual bearer session before this optional non-browser path can write.
  const bearer = /^Bearer \S+$/.test(req.header("authorization") ?? "");
  if (req.header("x-api-key") || !configuredOrigin || (site && !["same-origin", "none"].includes(site)) ||
      (origin !== undefined ? origin !== configuredOrigin : !bearer)) {
    res.status(403).json({ error: "A signed-in staff approval is required.", code: "human_approval_required" }); return;
  }
  if (!req.is("application/json")) { res.status(415).json({ error: "JSON approval is required.", code: "json_required" }); return; }
  next();
}
function resultError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof MissedCallCareError) { res.status(error.statusCode).json({ error: error.code, code: error.code }); return; }
  next(error);
}
router.get("/communications/missed-call-care", requireMember("crm.read"), async (req, res, next) => {
  try { res.set("Cache-Control", "no-store").json(await listMissedCallCare(req.member!.organizationId)); }
  catch (error) { resultError(error, res, next); }
});
router.put("/communications/missed-call-care/policy", humanAction, requireMember("settings.manage"),
  rateLimit({ windowMs: 60_000, max: 15, key: "missed-call-care-policy" }), async (req, res, next) => {
    const body = z.object({ expectedVersion: version, policy: missedCallCarePolicySchema, approveTemplate: z.literal(true) }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Review the owners, time zone, hours and message before saving." }); return; }
    try { res.json(await saveMissedCallCarePolicy(req.member!.organizationId, req.member!.user.id, body.data.expectedVersion, body.data.policy)); }
    catch (error) { resultError(error, res, next); }
  });
router.get("/communications/voice/:id/care", requireMember("crm.read"), async (req, res, next) => {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "Invalid call." }); return; }
  try { res.set("Cache-Control", "no-store").json(await previewMissedCallCare(req.member!.organizationId, id.data)); }
  catch (error) { resultError(error, res, next); }
});
router.post("/communications/voice/:id/care/approve", humanAction, requireMember("crm.write"),
  rateLimit({ windowMs: 60_000, max: 20, key: "missed-call-care-approve" }), async (req, res, next) => {
    const id = z.uuid().safeParse(req.params.id), body = z.object({ expectedVersion: version,
      expectedSnapshot: z.record(z.string(), z.unknown()), approve: z.literal(true) }).strict().safeParse(req.body);
    if (!id.success || !body.success) { res.status(400).json({ error: "Review the exact current message and approve it." }); return; }
    try { res.status(202).json(await approveMissedCallCare(req.member!.organizationId, id.data, req.member!.user.id, body.data.expectedVersion, body.data.expectedSnapshot)); }
    catch (error) { resultError(error, res, next); }
  });
router.post("/communications/voice/:id/care/close", humanAction, requireMember("crm.write"), async (req, res, next) => {
  const id = z.uuid().safeParse(req.params.id), body = z.object({ expectedVersion: version, outcome: z.enum(["resolved", "cancelled"]) }).strict().safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: "Choose a current case and outcome." }); return; }
  try { res.json(await closeMissedCallCare(req.member!.organizationId, id.data, req.member!.user.id, body.data.expectedVersion, body.data.outcome)); }
  catch (error) { resultError(error, res, next); }
});
export default router;
