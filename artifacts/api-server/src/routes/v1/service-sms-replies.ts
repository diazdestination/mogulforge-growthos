import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation, contractorScheduleError } from "../../middlewares/contractor-mutation";
import { listServiceSmsReplies, reviewServiceSmsReply, ServiceSmsError } from "../../services/service-sms";
import { serviceSmsReplyQuery, serviceSmsReplyReviewInput } from "../../services/service-sms-policy";

const router: IRouter = Router(), base = "/service-obligations/:id/sms-replies";
router.use([base, `${base}/:replyId/review`], contractorMutation);
router.get(base, requireMember("crm.read"), async (req, res) => {
  if (req.get("x-api-key")) { res.status(403).json({ error: "Sign in as an accepted staff member to read service replies." }); return; }
  const id = z.uuid().safeParse(req.params.id), query = serviceSmsReplyQuery.safeParse(req.query);
  if (!id.success || !query.success) { res.status(400).json({ error: "Choose a valid service and reply page." }); return; }
  res.set("Cache-Control", "no-store");
  res.json(await listServiceSmsReplies(req.member!.organizationId, req.member!.user.id, id.data, query.data));
});
router.post(`${base}/:replyId/review`, requireMember("crm.write"), async (req, res) => {
  if (req.get("x-api-key")) { res.status(403).json({ error: "An accepted staff member must review service replies." }); return; }
  const id = z.uuid().safeParse(req.params.id), replyId = z.uuid().safeParse(req.params.replyId), input = serviceSmsReplyReviewInput.safeParse(req.body);
  if (!id.success || !replyId.success || !input.success) { res.status(400).json({ error: "Review the reply, current version and office note." }); return; }
  res.json(await reviewServiceSmsReply(req.member!.organizationId, req.member!.user.id, id.data, replyId.data, input.data));
});
router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof ServiceSmsError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } next(error);
});
router.use(contractorScheduleError);
export default router;
