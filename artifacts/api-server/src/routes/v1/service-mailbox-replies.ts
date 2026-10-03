import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation, contractorScheduleError } from "../../middlewares/contractor-mutation";
import { MailboxCommunicationError, listServiceMailboxReplies, reviewServiceMailboxReply, serviceReplyQuery, serviceReplyReviewInput } from "../../services/mailbox-communication";
import { MailboxError } from "../../services/mailbox-contract";

const router: IRouter = Router();
const base = "/service-obligations/:id/mailbox-replies";
router.use([base, `${base}/:replyId/review`], contractorMutation);
router.get(base, requireMember("crm.read"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id), query = serviceReplyQuery.safeParse(req.query);
  if (!id.success || !query.success) { res.status(400).json({ error: "Choose a valid service and reply page." }); return; }
  res.set("Cache-Control", "no-store");
  res.json(await listServiceMailboxReplies(req.member!.organizationId, req.member!.user.id, id.data, query.data));
});
router.post(`${base}/:replyId/review`, requireMember("crm.write"), async (req, res) => {
  if (req.get("x-api-key")) { res.status(403).json({ error: "An accepted staff member must review service replies." }); return; }
  const id = z.uuid().safeParse(req.params.id), replyId = z.uuid().safeParse(req.params.replyId), input = serviceReplyReviewInput.safeParse(req.body);
  if (!id.success || !replyId.success || !input.success) { res.status(400).json({ error: "Review the reply, current version and office note." }); return; }
  res.json(await reviewServiceMailboxReply(req.member!.organizationId, req.member!.user.id, id.data, replyId.data, input.data));
});
router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof MailboxCommunicationError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  // Read-connector errors deliberately do not disclose credentials or mail text.
  if (error instanceof MailboxError) { res.status(409).json({ error: "The original mailbox is paused, changed or unavailable. No review action was saved." }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
