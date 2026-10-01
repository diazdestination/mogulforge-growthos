import { Router, type IRouter, type RequestHandler } from "express";
import { z } from "zod/v4";

import { requireMember } from "../../middlewares/requireMember";
import {
  getManualSmsDrafts,
  MANUAL_SMS_TEMPLATE_IDS,
  prepareManualSmsDraft,
} from "../../services/manual-sms";

const router: IRouter = Router();
const leadIdSchema = z.uuid();
const prepareSchema = z.object({
  templateId: z.enum(MANUAL_SMS_TEMPLATE_IDS),
  confirmedServiceReply: z.literal(true),
}).strict();

const requireHumanSession: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.get("x-api-key") || !req.isAuthenticated?.()) {
    res.status(401).json({ error: "Sign in to prepare a manual text reply" });
    return;
  }
  next();
};

router.get("/leads/:id/manual-sms", requireHumanSession, requireMember("crm.write"), async (req, res) => {
  const parsed = leadIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid lead ID" });
    return;
  }
  const member = req.member!;
  const result = await getManualSmsDrafts({
    organizationId: member.organizationId,
    leadId: parsed.data,
    staffFirstName: member.user.firstName,
  });
  if (!result) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(result);
});

// The route name expresses intent only: this records PREPARATION,
// not whether a native composer opened, nor whether a customer was contacted.
router.post("/leads/:id/manual-sms/draft-opened", requireHumanSession, requireMember("crm.write"), async (req, res) => {
  const id = leadIdSchema.safeParse(req.params.id);
  const body = prepareSchema.safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ error: "Choose a valid template and confirm this is a requested service reply" });
    return;
  }
  const member = req.member!;
  const result = await prepareManualSmsDraft({
    organizationId: member.organizationId,
    actorUserId: member.user.id,
    staffFirstName: member.user.firstName,
    leadId: id.data,
    templateId: body.data.templateId,
  });
  if (!result) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.status(result.allowed ? 200 : 409).json(result);
});

export default router;
