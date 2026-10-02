import { Router, type IRouter, type RequestHandler } from "express";
import { requireMember } from "../../middlewares/requireMember";
import {
  beginMicrosoftOAuth,
  completeMicrosoftOAuth,
  disconnectMicrosoft,
  getMicrosoftStatus,
  MicrosoftMailError,
} from "../../services/microsoft-oauth";
import {
  getUserEmailStatus,
  selectUserEmailProvider,
} from "../../services/user-email";
import { recordAudit } from "../../services/audit";

const router: IRouter = Router();
// API keys cannot bind an interactive mailbox to their creator without the
// creator's signed-in session and one-use actor/org-bound OAuth transaction.
const sessionOnly: RequestHandler = (req, res, next) => {
  if (
    req.get("x-api-key") ||
    !req.user ||
    req.user.id !== req.member?.user.id
  ) {
    res
      .status(403)
      .json({
        error: "Sign in with your own account to manage an email connection.",
      });
    return;
  }
  next();
};
router.get(
  "/integrations/microsoft",
  requireMember("crm.read"),
  sessionOnly,
  async (req, res) => {
    res.json(
      await getMicrosoftStatus(req.member!.organizationId, req.member!.user.id),
    );
  },
);
router.post(
  "/integrations/microsoft/connect",
  requireMember("crm.write"),
  sessionOnly,
  async (req, res) => {
    try {
      const authorizationUrl = await beginMicrosoftOAuth({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        returnPath:
          typeof req.body?.returnPath === "string"
            ? req.body.returnPath
            : "/account",
      });
      res.json({ authorizationUrl });
    } catch {
      res
        .status(503)
        .json({
          error:
            "Microsoft email authorization is unavailable. Ask a platform administrator to check its configuration.",
        });
    }
  },
);
router.get(
  "/integrations/microsoft/callback",
  requireMember("crm.write"),
  sessionOnly,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (typeof req.query.error === "string") {
      res.redirect("/account?microsoft=denied");
      return;
    }
    try {
      const completed = await completeMicrosoftOAuth({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        state: typeof req.query.state === "string" ? req.query.state : "",
        code: typeof req.query.code === "string" ? req.query.code : "",
      });
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "integration.microsoft_connected",
        entityType: "microsoft_connection",
        metadata: { provider: "microsoft" },
      });
      res.redirect(`${completed.returnPath}?microsoft=connected`);
    } catch {
      res.redirect("/account?microsoft=failed");
    }
  },
);
router.delete(
  "/integrations/microsoft",
  requireMember("crm.write"),
  sessionOnly,
  async (req, res) => {
    const result = await disconnectMicrosoft(
      req.member!.organizationId,
      req.member!.user.id,
    );
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "integration.microsoft_disconnected",
      entityType: "microsoft_connection",
      metadata: { remoteConsentRevoked: false },
    });
    res.json(result);
  },
);
router.get(
  "/integrations/email-sender",
  requireMember("crm.read"),
  sessionOnly,
  async (req, res) => {
    res.json(
      await getUserEmailStatus(req.member!.organizationId, req.member!.user.id),
    );
  },
);
router.put(
  "/integrations/email-sender",
  requireMember("crm.write"),
  sessionOnly,
  async (req, res) => {
    const provider = req.body?.provider;
    if (provider !== "gmail" && provider !== "microsoft") {
      res
        .status(400)
        .json({ error: "Choose Gmail or Microsoft 365 / Outlook." });
      return;
    }
    try {
      const selected = await selectUserEmailProvider(
        req.member!.organizationId,
        req.member!.user.id,
        provider,
      );
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "integration.email_sender_selected",
        entityType: "email_sender_preference",
        metadata: { provider },
      });
      res.json(selected);
    } catch (error) {
      res
        .status(409)
        .json({
          error:
            error instanceof MicrosoftMailError
              ? "Microsoft sender requires reconnection."
              : "Connect this mailbox as an active staff member before selecting it.",
        });
    }
  },
);
export default router;
