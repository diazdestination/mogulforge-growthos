import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  beginGmailOAuth,
  completeGmailOAuth,
  disconnectGmail,
  getGmailStatus,
} from "../../services/gmail-oauth";

const router: IRouter = Router();

router.get(
  "/integrations/gmail",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await getGmailStatus(req.member!.organizationId, req.member!.user.id));
  },
);

router.post(
  "/integrations/gmail/connect",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authorizationUrl = await beginGmailOAuth({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        returnPath:
          typeof req.body?.returnPath === "string" ? req.body.returnPath : "/settings?gmail=pending",
      });
      res.json({ authorizationUrl });
    } catch (error) {
      res.status(503).json({
        error: error instanceof Error ? error.message : "Gmail OAuth is unavailable",
      });
    }
  },
);

router.get(
  "/integrations/gmail/callback",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
      res.redirect(`/settings?gmail=denied&reason=${encodeURIComponent(error)}`);
      return;
    }
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code) {
      res.redirect("/settings?gmail=failed&reason=missing_response");
      return;
    }
    try {
      const completed = await completeGmailOAuth({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        state,
        code,
      });
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "integration.gmail_connected",
        entityType: "gmail_connection",
        metadata: { email: completed.email },
      });
      const separator = completed.returnPath.includes("?") ? "&" : "?";
      res.redirect(`${completed.returnPath}${separator}gmail=connected`);
    } catch (callbackError) {
      const reason = callbackError instanceof Error ? callbackError.message : "connection_failed";
      res.redirect(`/settings?gmail=failed&reason=${encodeURIComponent(reason.slice(0, 160))}`);
    }
  },
);

router.delete(
  "/integrations/gmail",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const disconnected = await disconnectGmail(
      req.member!.organizationId,
      req.member!.user.id,
    );
    if (disconnected) {
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "integration.gmail_disconnected",
        entityType: "gmail_connection",
      });
    }
    res.json({ disconnected });
  },
);

export default router;

