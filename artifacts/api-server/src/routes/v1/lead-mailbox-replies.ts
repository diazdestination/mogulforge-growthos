import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation, contractorScheduleError } from "../../middlewares/contractor-mutation";
import { MailboxCommunicationError, listLeadMailboxReplies, reviewLeadMailboxReply, serviceReplyQuery, leadReplyReviewInput } from "../../services/mailbox-communication";
import { MailboxError } from "../../services/mailbox-contract";

const router: IRouter = Router();
const base = "/leads/:id/mailbox-replies";
router.use([base, `${base}/:replyId/review`], contractorMutation);
router.get(base, requireMember("crm.read"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id), query = serviceReplyQuery.safeParse(req.query);
  if (!id.success || !query.success) { res.status(400).json({ error: "Choose a valid opportunity and reply page." }); return; }
  res.set("Cache-Control", "no-store");
  res.json(await listLeadMailboxReplies(req.member!.organizationId, req.member!.user.id, id.data, query.data));
});
router.post(`${base}/:replyId/review`, requireMember("crm.write"), async (req, res) => {
  if (req.get("x-api-key") || !req.user || req.user.id !== req.member!.user.id) { res.status(403).json({ error: "Use your accepted staff session to handle this reply." }); return; }
  const id = z.uuid().safeParse(req.params.id), replyId = z.uuid().safeParse(req.params.replyId), input = leadReplyReviewInput.safeParse(req.body);
  if (!id.success || !replyId.success || !input.success) { res.status(400).json({ error: "Review the exact reply, current version and office note." }); return; }
  res.json(await reviewLeadMailboxReply(req.member!.organizationId, req.member!.user.id, id.data, replyId.data, input.data));
});
router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof MailboxCommunicationError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof MailboxError) { res.status(409).json({ error: "Original mailbox monitoring is paused, changed or unavailable. No review decision was saved." }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
