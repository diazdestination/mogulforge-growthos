import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { callieHuman } from "../../middlewares/callie-human";
import { rateLimit } from "../../lib/rateLimit";
import { contractorScheduleError } from "../../middlewares/contractor-mutation";
import { approveCalliePolicy, CallieError, calliePolicyApprovalInputSchema, calliePolicyPreviewInputSchema, getCalliePolicy, previewCalliePolicy } from "../../services/callie-policy";
import { assertCallieStaff, bookCallieVisit, CallieOfficeError, getCallieOfficeDetail, listCallieOffice, reviewCallieCaller, updateCallieOffice } from "../../services/callie-office";
import { callieBookingSchema, callieCallerReviewSchema, callieListQuery, callieOfficeActionSchema } from "../../services/callie-office-contract";

const router: IRouter = Router();
const base = "/communications/callie";
router.use(base, callieHuman);
router.get(`${base}/policy`, requireMember("crm.read"), async (req, res) => {
  if (Object.keys(req.query).length) { res.status(400).json({ error: "Unknown policy query." }); return; }
  await assertCallieStaff(req.member!.organizationId, req.member!.user.id);
  res.set("Cache-Control", "no-store").json(await getCalliePolicy(req.member!.organizationId));
});
router.post(`${base}/policy/preview`, requireMember("settings.manage"), rateLimit({ windowMs: 60_000, max: 15, key: "callie-policy-preview" }), async (req, res) => {
  const input = calliePolicyPreviewInputSchema.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Review the exact owners, hours and standing policy." }); return; }
  res.set("Cache-Control", "no-store").json(await previewCalliePolicy(req.member!.organizationId, req.member!.user.id, input.data));
});
router.post(`${base}/policy/approve`, requireMember("settings.manage"), rateLimit({ windowMs: 60_000, max: 15, key: "callie-policy-approve" }), async (req, res) => {
  const input = calliePolicyApprovalInputSchema.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Review and explicitly approve the unchanged current policy preview." }); return; }
  res.set("Cache-Control", "no-store").json(await approveCalliePolicy(req.member!.organizationId, req.member!.user.id, input.data));
});
router.get(base, requireMember("crm.read"), async (req, res) => {
  const query = callieListQuery.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Choose a valid CALLIE scope and page." }); return; }
  res.set("Cache-Control", "no-store").json(await listCallieOffice(req.member!.organizationId, req.member!.user.id, query.data));
});
router.get(`${base}/:id`, requireMember("crm.read"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success || Object.keys(req.query).length) { res.status(400).json({ error: "Choose one valid company CALLIE request." }); return; }
  res.set("Cache-Control", "no-store").json(await getCallieOfficeDetail(req.member!.organizationId, req.member!.user.id, id.data));
});
router.post(`${base}/:id/office-action`, requireMember("crm.write"), rateLimit({ windowMs: 60_000, max: 30, key: "callie-office" }), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id), input = callieOfficeActionSchema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "Review the current request, owner and office action." }); return; }
  res.json(await updateCallieOffice(req.member!.organizationId, req.member!.user.id, id.data, input.data));
});
router.post(`${base}/:id/review-caller`, requireMember("crm.write"), rateLimit({ windowMs: 60_000, max: 30, key: "callie-review" }), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id), input = callieCallerReviewSchema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "Review and confirm the actual caller and canonical customer." }); return; }
  res.json(await reviewCallieCaller(req.member!.organizationId, req.member!.user.id, id.data, input.data));
});
router.post(`${base}/:id/book`, requireMember("crm.write"), rateLimit({ windowMs: 60_000, max: 20, key: "callie-book" }), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id), input = callieBookingSchema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "Review the current customer and exact agreed appointment, then explicitly confirm it." }); return; }
  res.json(await bookCallieVisit(req.member!.organizationId, req.member!.user.id, id.data, input.data));
});
router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof CallieOfficeError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof CallieError) { res.status(error.statusCode).json({ error: error.code.replaceAll("_", " "), code: error.code }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
