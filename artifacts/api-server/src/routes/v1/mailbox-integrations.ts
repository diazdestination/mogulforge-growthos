import { Router, type IRouter, type RequestHandler } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import {
  beginMailboxOAuth,
  completeMailboxOAuth,
  disableMailboxConnector,
  getMailboxStatus,
  setLeadMonitoringApproval,
} from "../../services/mailbox-connector";
import { MailboxError } from "../../services/mailbox-contract";
import { recordAudit } from "../../services/audit";

const router: IRouter = Router();
const session: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (
    req.get("x-api-key") ||
    !req.user ||
    req.user.id !== req.member?.user.id
  ) {
    res.status(403).json({
      error: "Use your own accepted staff session to manage mailbox reading.",
    });
    return;
  }
  next();
};
const mutation: RequestHandler = (req, res, next) => {
  const origin = req.get("origin"),
    site = req.get("sec-fetch-site");
  if (
    (origin && origin !== process.env.APP_ORIGIN) ||
    site === "cross-site" ||
    site === "same-site" ||
    (!origin && !/^Bearer [^\s]+$/.test(req.get("authorization") ?? ""))
  ) {
    res.status(403).json({
      error: "Use the trusted GrowthOS page to approve mailbox reading.",
    });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "JSON approval required." });
    return;
  }
  next();
};
const actor = (req: Parameters<RequestHandler>[0]) => ({
  organizationId: req.member!.organizationId,
  userId: req.member!.user.id,
});
const failure = (res: Parameters<RequestHandler>[1], error: unknown) =>
  res
    .status(
      error instanceof z.ZodError
        ? 400
        : error instanceof MailboxError
          ? error.status
          : 503,
    )
    .json({
      code:
        error instanceof MailboxError
          ? error.code
          : "mailbox_request_unavailable",
      error: "Mailbox reply monitoring needs review. No email was sent.",
    });
router.post(
  "/mailbox/microsoft/lead-monitoring",
  requireMember("crm.write"),
  session,
  mutation,
  async (req, res) => {
    try {
      res.json(await setLeadMonitoringApproval(actor(req), req.body));
    } catch (e) {
      failure(res, e);
    }
  },
);
router.get(
  "/mailbox/microsoft",
  requireMember("crm.write"),
  session,
  async (req, res) => {
    try {
      if (Object.keys(req.query).length)
        throw new MailboxError("mailbox_request_invalid", 400);
      res.json(
        await getMailboxStatus(actor(req).organizationId, actor(req).userId),
      );
    } catch (e) {
      failure(res, e);
    }
  },
);
router.post(
  "/mailbox/microsoft/connect",
  requireMember("crm.write"),
  session,
  mutation,
  async (req, res) => {
    try {
      const authorizationUrl = await beginMailboxOAuth(actor(req), req.body);
      await recordAudit({
        ...actor(req),
        actorUserId: actor(req).userId,
        action: "mailbox.read_opt_in_started",
        entityType: "mailbox_connector",
        metadata: {
          policyVersion: 1,
          scopes: ["Mail.Read", "User.Read", "offline_access"],
          historicalCrawl: false,
        },
      });
      res.json({ authorizationUrl });
    } catch (e) {
      failure(res, e);
    }
  },
);
router.get(
  "/mailbox/microsoft/callback",
  requireMember("crm.write"),
  session,
  async (req, res) => {
    try {
      if (
        req.query.error ||
        typeof req.query.state !== "string" ||
        typeof req.query.code !== "string"
      )
        throw new MailboxError("mailbox_oauth_denied");
      const done = await completeMailboxOAuth(
        actor(req),
        req.query.state,
        req.query.code,
      );
      await recordAudit({
        organizationId: actor(req).organizationId,
        actorUserId: actor(req).userId,
        action: "mailbox.read_opt_in_completed",
        entityType: "mailbox_connector",
        metadata: { policyVersion: 1, newForwardOnlyStart: true },
      });
      res.redirect(`${done.returnPath}?mailbox=connected`);
    } catch {
      res.redirect("/account?mailbox=failed");
    }
  },
);
router.post(
  "/mailbox/microsoft/disable",
  requireMember("crm.write"),
  session,
  mutation,
  async (req, res) => {
    try {
      const result = await disableMailboxConnector(actor(req), req.body);
      await recordAudit({
        organizationId: actor(req).organizationId,
        actorUserId: actor(req).userId,
        action: "mailbox.read_disabled",
        entityType: "mailbox_connector",
        metadata: { remoteConsentRevoked: false },
      });
      res.json(result);
    } catch (e) {
      failure(res, e);
    }
  },
);
export default router;
