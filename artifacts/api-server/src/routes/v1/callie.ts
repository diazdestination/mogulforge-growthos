import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { callieHuman } from "../../middlewares/callie-human";
import { rateLimit } from "../../lib/rateLimit";
import { contractorScheduleError } from "../../middlewares/contractor-mutation";
import { approveCalliePolicy, CallieError, calliePolicyApprovalInputSchema, calliePolicyPreviewInputSchema, getCalliePolicy, previewCalliePolicy } from "../../services/callie-policy";
import { assertCallieStaff, bookCallieVisit, CallieOfficeError, getCallieOfficeDetail, getCallieSchedulingContext, listCallieOffice, reviewCallieCaller, updateCallieOffice } from "../../services/callie-office";
import { callieBookingSchema, callieCallerReviewSchema, callieListQuery, callieOfficeActionSchema, callieSchedulingContextQuerySchema } from "../../services/callie-office-contract";
import { CallieReceptionError, callieReceptionApprovalInputSchema, callieReceptionBindingInputSchema, callieReceptionPreviewInputSchema } from "../../services/callie-reception-contract";
import { approveCallieReception, getCallieReception, previewCallieReception, saveCallieReceptionBinding } from "../../services/callie-reception-policy";
import { receiveReceptionPostCall, runCallieReceptionTool } from "../../services/callie-reception-runtime";

const router: IRouter = Router();
const base = "/communications/callie";
router.use(base, callieHuman);
router.get(`${base}/reception`, requireMember("crm.read"), async (req, res) => {
  if (Object.keys(req.query).length) { res.status(400).json({ error: "Unknown reception query." }); return; }
  await assertCallieStaff(req.member!.organizationId, req.member!.user.id);
  res.set("Cache-Control", "no-store").json(await getCallieReception(req.member!.organizationId));
});
router.post(`${base}/reception/binding`, requireMember("settings.manage"), rateLimit({ windowMs: 60_000, max: 10, key: "callie-reception-binding" }), async (req, res) => {
  const input = callieReceptionBindingInputSchema.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Review the non-secret reception binding." }); return; }
  res.set("Cache-Control", "no-store").json(await saveCallieReceptionBinding(req.member!.organizationId, req.member!.user.id, input.data));
});
router.post(`${base}/reception/policy/preview`, requireMember("settings.manage"), rateLimit({ windowMs: 60_000, max: 15, key: "callie-reception-preview" }), async (req, res) => {
  const input = callieReceptionPreviewInputSchema.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Review exact reception owners, facts, limits and targets." }); return; }
  res.set("Cache-Control", "no-store").json(await previewCallieReception(req.member!.organizationId, req.member!.user.id, input.data));
});
router.post(`${base}/reception/policy/approve`, requireMember("settings.manage"), rateLimit({ windowMs: 60_000, max: 15, key: "callie-reception-approve" }), async (req, res) => {
  const input = callieReceptionApprovalInputSchema.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Approve only the exact current reception review." }); return; }
  res.set("Cache-Control", "no-store").json(await approveCallieReception(req.member!.organizationId, req.member!.user.id, input.data));
});
router.post("/public/callie/reception/:sessionId/tool", rateLimit({ windowMs: 60_000, max: 90, key: "callie-reception-tool" }), async (req, res) => {
  if (!req.is("application/json") || Object.keys(req.query).length || !z.uuid().safeParse(req.params.sessionId).success || JSON.stringify(req.body ?? {}).length > 8000) { res.status(400).end(); return; }
  res.set("Cache-Control", "no-store").json(await runCallieReceptionTool(String(req.params.sessionId), req.get("x-callie-capability") ?? "", req.body));
});
router.post("/public/callie/reception/post-call", rateLimit({ windowMs: 60_000, max: 120, key: "callie-reception-evidence" }), async (req, res) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!req.is("application/json") || Object.keys(req.query).length || !raw) { res.status(400).end(); return; }
  res.set("Cache-Control", "no-store").json(await receiveReceptionPostCall(raw, req.get("elevenlabs-signature") ?? ""));
});
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
router.get(`${base}/:id/scheduling-context`, requireMember("crm.read"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id), query = callieSchedulingContextQuerySchema.safeParse(req.query);
  if (!id.success || !query.success) { res.status(400).json({ error: "Choose the actual visit type and explicit customer property." }); return; }
  res.set("Cache-Control", "no-store").json(await getCallieSchedulingContext(req.member!.organizationId, req.member!.user.id, id.data, query.data));
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
  if (error instanceof CallieReceptionError) { res.status(error.status).json({ error: error.code.replaceAll("_", " "), code: error.code }); return; }
  if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid bounded CALLIE request.", code: "invalid_callie_request" }); return; }
  if (error instanceof CallieOfficeError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof CallieError) { res.status(error.statusCode).json({ error: error.code.replaceAll("_", " "), code: error.code }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
