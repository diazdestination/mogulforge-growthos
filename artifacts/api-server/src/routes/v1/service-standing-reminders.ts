import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation, contractorScheduleError } from "../../middlewares/contractor-mutation";
import { approveServiceStanding, disableServiceStanding, getServiceStanding, previewServiceStanding, ServiceStandingError } from "../../services/service-standing-policy";
import { serviceStandingApprovalInputSchema, serviceStandingDisableInputSchema, serviceStandingPreviewInputSchema } from "../../services/service-standing-contract";

const router: IRouter = Router(), base = "/service-obligations/:id/standing-reminders";
router.use([base, `${base}/preview`, `${base}/approve`, `${base}/disable`], (req, res, next) => {
  if (req.get("x-api-key")) { res.status(403).json({ error: "Sign in as an accepted company member." }); return; }
  next();
});
router.use([base, `${base}/preview`, `${base}/approve`, `${base}/disable`], contractorMutation);
router.get(base, requireMember("crm.read"), async (req, res) => {
  if (!req.member!.user.emailVerifiedAt || req.member!.user.id.startsWith("invite:")) { res.status(403).json({ error: "An accepted verified membership is required." }); return; }
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success || Object.keys(req.query).length) { res.status(400).json({ error: "Choose a valid service." }); return; }
  res.set("Cache-Control", "no-store");
  res.json(await getServiceStanding(req.member!.organizationId, id.data));
});
for (const [suffix, schema, work] of [
  ["preview", serviceStandingPreviewInputSchema, previewServiceStanding],
  ["approve", serviceStandingApprovalInputSchema, approveServiceStanding],
  ["disable", serviceStandingDisableInputSchema, disableServiceStanding],
] as const) router.post(`${base}/${suffix}`, requireMember("settings.manage"), async (req, res) => {
  if (!req.member!.user.emailVerifiedAt || req.member!.user.id.startsWith("invite:")) { res.status(403).json({ error: "An accepted verified membership is required." }); return; }
  if (req.get("x-api-key")) { res.status(403).json({ error: "An owner or administrator must sign in to review standing authority." }); return; }
  const id = z.uuid().safeParse(req.params.id), input = schema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "Review the exact policy, source, agreement and confirmation." }); return; }
  res.set("Cache-Control", "no-store");
  res.json(await work(req.member!.organizationId, req.member!.user.id, id.data, input.data));
});
router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof ServiceStandingError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid standing policy details." }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
