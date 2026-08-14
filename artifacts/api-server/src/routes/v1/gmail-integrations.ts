import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  beginGmailOAuth,
  beginGoogleOAuth,
  completeGmailOAuth,
  disconnectGmail,
  getGmailStatus,
} from "../../services/gmail-oauth";
import {
  getGoogleModuleDefinition,
  listGoogleModules,
  setGoogleModuleEnabled,
  type GoogleModuleId,
} from "../../services/google-business-graph";

const router: IRouter = Router();

router.get(
  "/integrations/google/modules",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await listGoogleModules(req.member!.organizationId, req.member!.user.id));
  },
);

router.post(
  "/integrations/google/modules/:module/connect",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const definition = getGoogleModuleDefinition(String(req.params.module));
    if (!definition) {
      res.status(404).json({ error: "Unknown Google integration module" });
      return;
    }
    if (definition.maturity !== "available") {
      res.status(409).json({ error: "This connector requires additional provider/compliance approval before authorization can be enabled." });
      return;
    }
    try {
      const authorizationUrl = await beginGoogleOAuth({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        module: definition.id,
        scopes: definition.scopes,
        returnPath: "/settings",
      });
      res.json({ authorizationUrl });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Google authorization is unavailable" });
    }
  },
);

router.put(
  "/integrations/google/modules/:module",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const definition = getGoogleModuleDefinition(String(req.params.module));
    if (!definition || typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "Invalid Google module change" });
      return;
    }
    try {
      res.json(await setGoogleModuleEnabled({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        module: definition.id as GoogleModuleId,
        enabled: req.body.enabled,
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Could not update module" });
    }
  },
);

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
      await setGoogleModuleEnabled({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        module: completed.module as GoogleModuleId,
        enabled: true,
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
