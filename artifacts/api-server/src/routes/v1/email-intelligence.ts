import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import {
  createEmailIntelligenceSource,
  deleteEmailIntelligenceMessage,
  EmailIntelligenceError,
  getEmailIntelligenceStatus,
  ingestEmailByAlias,
  ingestSyntheticEmail,
  listEmailIntelligenceMessages,
  purgeEmailMessageRawContent,
  reviewEmailIntelligenceFact,
  updateEmailIntelligenceSource,
  verifyEmailWebhookSignature,
  type EmailIntelligencePayload,
} from "../../services/email-intelligence";

const router: IRouter = Router();

function sendError(res: Response, error: unknown): void {
  if (error instanceof EmailIntelligenceError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: "Email Intelligence could not complete that request." });
}

router.get(
  "/email-intelligence",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await getEmailIntelligenceStatus(req.member!.organizationId));
  },
);

router.post(
  "/email-intelligence/source",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(201).json(await createEmailIntelligenceSource({
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
        allowedForwarders: req.body?.allowedForwarders,
      }));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.patch(
  "/email-intelligence/source/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await updateEmailIntelligenceSource({
        organizationId: req.member!.organizationId,
        sourceId: String(req.params.id),
        userId: req.member!.user.id,
        allowedForwarders: req.body?.allowedForwarders,
        retentionDays: req.body?.retentionDays,
        status: req.body?.status,
      }));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  "/email-intelligence/messages",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await listEmailIntelligenceMessages(req.member!.organizationId));
  },
);

router.post(
  "/email-intelligence/test",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await ingestSyntheticEmail(
        req.member!.organizationId,
        req.member!.user.id,
      );
      res.status(201).json({
        duplicate: result.duplicate,
        messageId: result.message?.id ?? null,
        factCount: result.facts.length,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/email-intelligence/facts/:id/review",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await reviewEmailIntelligenceFact({
        organizationId: req.member!.organizationId,
        factId: String(req.params.id),
        userId: req.member!.user.id,
        status: req.body?.status,
      }));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.delete(
  "/email-intelligence/messages/:id/raw",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await purgeEmailMessageRawContent(
        req.member!.organizationId,
        String(req.params.id),
        req.member!.user.id,
      ));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.delete(
  "/email-intelligence/messages/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await deleteEmailIntelligenceMessage(
        req.member!.organizationId,
        String(req.params.id),
        req.member!.user.id,
      ));
    } catch (error) {
      sendError(res, error);
    }
  },
);

/**
 * Provider-neutral intake bridge. The inbound mail provider adapter validates
 * its own event first, then signs the normalized payload for this endpoint.
 */
router.post(
  "/public/email-intelligence/intake/:alias",
  rateLimit({ windowMs: 60_000, max: 240, key: "email-intelligence-intake" }),
  async (req: Request, res: Response): Promise<void> => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyEmailWebhookSignature(rawBody, req.header("x-mogulforge-signature"))) {
      res.status(401).json({ error: "Invalid email intelligence webhook signature." });
      return;
    }
    try {
      const result = await ingestEmailByAlias(
        String(req.params.alias).toLowerCase(),
        req.body as EmailIntelligencePayload,
      );
      res.status(result.duplicate ? 200 : 201).json({
        duplicate: result.duplicate,
        messageId: result.message?.id ?? null,
        factCount: result.facts.length,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

export default router;
