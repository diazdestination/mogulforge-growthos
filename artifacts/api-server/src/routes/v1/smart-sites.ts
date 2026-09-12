import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import {
  SMART_SITE_PROFILES,
  normalizeSmartSiteIntake,
} from "../../services/smart-site-contract";
import {
  authenticateSmartSite,
  captureSmartSiteInquiry,
  createSmartSite,
  listSmartSites,
  rotateSmartSiteKey,
  smartSiteOverview,
  SmartSiteError,
  updateSmartSite,
} from "../../services/smart-sites";

const router = Router();
const idSchema = z.uuid();
const createSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    siteKey: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    profile: z.string().max(60),
  })
  .strict();
const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, _next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SmartSiteError) {
        res.status(err.status).json({ error: err.code });
        return;
      }
      if (err instanceof z.ZodError) {
        res
          .status(400)
          .json({
            error: "invalid_request",
            fields: err.issues.map((i) => i.path.join(".")),
          });
        return;
      }
      const code =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") {
        res.status(409).json({ error: "site_key_already_exists" });
        return;
      }
      // Database errors can contain submitted values; never echo or log them here.
      res.status(503).json({ error: "smart_site_unavailable" });
    }
  };

router.get(
  "/smart-sites/profiles",
  requireMember("crm.read"),
  safe(async (_req, res) => {
    res.json(SMART_SITE_PROFILES);
  }),
);
router.get(
  "/smart-sites",
  requireMember("crm.read"),
  safe(async (req, res) => {
    res.json(await listSmartSites(req.member!.organizationId));
  }),
);
router.get(
  "/smart-sites/overview",
  requireMember("crm.read"),
  safe(async (req, res) => {
    res.json(await smartSiteOverview(req.member!.organizationId));
  }),
);
router.post(
  "/smart-sites",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    res
      .status(201)
      .json(
        await createSmartSite(
          req.member!.organizationId,
          req.member!.user.id,
          createSchema.parse(req.body),
        ),
      );
  }),
);
router.patch(
  "/smart-sites/:id",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    const body = z.object({ isActive: z.boolean() }).strict().parse(req.body);
    res.json(
      await updateSmartSite(
        req.member!.organizationId,
        req.member!.user.id,
        idSchema.parse(req.params.id),
        body.isActive,
      ),
    );
  }),
);
router.post(
  "/smart-sites/:id/rotate-key",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    res.json(
      await rotateSmartSiteKey(
        req.member!.organizationId,
        req.member!.user.id,
        idSchema.parse(req.params.id),
      ),
    );
  }),
);
router.post(
  "/public/smart-sites/:id/intake",
  rateLimit({ windowMs: 60_000, max: 60, key: "smart-site-intake" }),
  safe(async (req, res) => {
    if (req.headers.origin) {
      res.status(403).json({ error: "server_to_server_only" });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16_000) {
      res.status(413).json({ error: "request_too_large" });
      return;
    }
    const site = await authenticateSmartSite(
      idSchema.parse(req.params.id),
      (req.header("authorization") ?? "").replace(/^Bearer /, ""),
    );
    const result = await captureSmartSiteInquiry(
      site,
      normalizeSmartSiteIntake(req.body),
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

export default router;
