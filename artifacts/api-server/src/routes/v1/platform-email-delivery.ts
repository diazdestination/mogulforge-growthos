import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { requirePlatformAdmin } from "./orgs";
import { listPlatformEmailDeliveries, PlatformEmailDeliveryError } from "../../services/platform-email-delivery";

const router: IRouter = Router();
const query = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1), invitationId: z.uuid().optional() }).strict();
const platformQuery = query.extend({ organizationId: z.uuid().optional() });

function read(scope: "platform" | "member") {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.header("x-api-key") !== undefined || !req.isAuthenticated() || !req.user?.id) {
      res.status(403).json({ error: "Human session required" });
      return;
    }
    try {
      const platformValues = scope === "platform" ? platformQuery.parse(req.query) : null;
      const values = platformValues ?? query.parse(req.query);
      const result = await listPlatformEmailDeliveries({ ...values, scope, actorUserId: req.user.id,
        organizationId: scope === "member" ? req.member!.organizationId : platformValues?.organizationId });
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ error: "invalid_delivery_filter" }); return; }
      if (!(error instanceof PlatformEmailDeliveryError)) throw error;
      res.status(error.status).json({ error: error.code });
    }
  };
}

router.get("/platform/email-deliveries", requirePlatformAdmin, read("platform"));
router.get("/staff-invitations/email-deliveries", requireMember("users.manage"), read("member"));
export default router;
