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
  smartSiteAcquisitionBatchSchema,
  smartSiteAnalyticsOptOutSchema,
} from "../../services/smart-site-contract";
import {
  authenticateSmartSite,
  captureSmartSiteAcquisitionEvents,
  captureSmartSiteInquiry,
  createSmartSite,
  listSmartSites,
  rotateSmartSiteKey,
  smartSiteLaunchReadiness,
  smartSiteAcquisitionOverview,
  smartSiteMeasurementStatus,
  smartSiteOverview,
  SmartSiteError,
  optOutSmartSiteVisitor,
  updateSmartSite,
  updateSmartSiteMeasurement,
} from "../../services/smart-sites";
import {
  assignSmartSiteLead,
  recordSmartSiteAttempt,
  setResponseTarget,
  smartSiteFollowup,
} from "../../services/smart-site-followup";

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
        res
          .status(err.status)
          .json({ error: err.code, ...(err.details ?? {}) });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({
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
router.get(
  "/smart-sites/acquisition",
  requireMember("crm.read"),
  safe(async (req, res) => {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .parse(req.query.days);
    res.json(
      await smartSiteAcquisitionOverview(req.member!.organizationId, days),
    );
  }),
);
router.get(
  "/smart-sites/launch-readiness",
  requireMember("crm.read"),
  safe(async (req, res) => {
    res.json(await smartSiteLaunchReadiness(req.member!.organizationId));
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
    const body = z
      .object({
        isActive: z.boolean(),
        confirmedLaunch: z.literal(true).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await updateSmartSite(
        req.member!.organizationId,
        req.member!.user.id,
        idSchema.parse(req.params.id),
        body.isActive,
        body.confirmedLaunch === true,
      ),
    );
  }),
);
router.patch(
  "/smart-sites/:id/measurement",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    const body = z
      .object({
        enabled: z.boolean(),
        retentionDays: z.number().int().min(30).max(365),
      })
      .strict()
      .parse(req.body);
    res.json(
      await updateSmartSiteMeasurement(
        req.member!.organizationId,
        req.member!.user.id,
        idSchema.parse(req.params.id),
        body,
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
    const rawReceivedAt = req.header("x-smart-site-received-at");
    let receivedAt: Date | undefined;
    if (rawReceivedAt) {
      const value = Date.parse(rawReceivedAt);
      if (
        !Number.isFinite(value) ||
        value < Date.now() - 30 * 86400_000 ||
        value > Date.now() + 300_000
      )
        throw new SmartSiteError("invalid_site_received_at");
      receivedAt = new Date(Math.min(value, Date.now()));
    }
    const result = await captureSmartSiteInquiry(
      site,
      normalizeSmartSiteIntake(req.body),
      receivedAt,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

router.get(
  "/public/smart-sites/:id/acquisition-status",
  rateLimit({
    windowMs: 60_000,
    max: 60,
    key: "smart-site-acquisition-status",
  }),
  safe(async (req, res) => {
    if (req.headers.origin) {
      res.status(403).json({ error: "server_to_server_only" });
      return;
    }
    const site = await authenticateSmartSite(
      idSchema.parse(req.params.id),
      (req.header("authorization") ?? "").replace(/^Bearer /, ""),
      { requireActive: false },
    );
    res.json(smartSiteMeasurementStatus(site));
  }),
);

router.post(
  "/public/smart-sites/:id/acquisition-events",
  rateLimit({ windowMs: 60_000, max: 120, key: "smart-site-acquisition" }),
  safe(async (req, res) => {
    if (req.headers.origin) {
      res.status(403).json({ error: "server_to_server_only" });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 20_000) {
      res.status(413).json({ error: "request_too_large" });
      return;
    }
    const site = await authenticateSmartSite(
      idSchema.parse(req.params.id),
      (req.header("authorization") ?? "").replace(/^Bearer /, ""),
    );
    res
      .status(202)
      .json(
        await captureSmartSiteAcquisitionEvents(
          site,
          smartSiteAcquisitionBatchSchema.parse(req.body),
        ),
      );
  }),
);

router.post(
  "/public/smart-sites/:id/analytics-opt-out",
  rateLimit({ windowMs: 60_000, max: 30, key: "smart-site-analytics-opt-out" }),
  safe(async (req, res) => {
    if (req.headers.origin) {
      res.status(403).json({ error: "server_to_server_only" });
      return;
    }
    const site = await authenticateSmartSite(
      idSchema.parse(req.params.id),
      (req.header("authorization") ?? "").replace(/^Bearer /, ""),
      { requireActive: false },
    );
    const input = smartSiteAnalyticsOptOutSchema.parse(req.body);
    res.json(await optOutSmartSiteVisitor(site, input.visitorId));
  }),
);

router.get(
  "/smart-sites/follow-up",
  requireMember("crm.read"),
  safe(async (req, res) => {
    res.json(await smartSiteFollowup(req.member!.organizationId));
  }),
);
router.patch(
  "/smart-sites/:id/response-target",
  requireMember("settings.manage"),
  safe(async (req, res) => {
    const input = z
      .object({ minutes: z.number().int().min(5).max(10080) })
      .strict()
      .parse(req.body);
    res.json(
      await setResponseTarget(
        req.member!.organizationId,
        req.member!.user.id,
        idSchema.parse(req.params.id),
        input.minutes,
      ),
    );
  }),
);
router.patch(
  "/smart-sites/leads/:id/owner",
  requireMember("crm.write"),
  safe(async (req, res) => {
    const input = z
      .object({
        assignedUserId: z.string().min(1).max(128).nullable(),
        expectedOwnerId: z.string().min(1).max(128).nullable(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await assignSmartSiteLead(
        req.member!.organizationId,
        req.member!.user.id,
        idSchema.parse(req.params.id),
        input.assignedUserId,
        input.expectedOwnerId,
      ),
    );
  }),
);
router.post(
  "/smart-sites/leads/:id/contact-attempts",
  requireMember("crm.write"),
  safe(async (req, res) => {
    if (req.header("x-api-key"))
      throw new SmartSiteError("staff_session_required", 403);
    const input = z
      .object({
        requestId: z.uuid(),
        channel: z.enum(["phone", "email", "sms"]),
        outcome: z.string().max(30),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const result = await recordSmartSiteAttempt(
      req.member!.organizationId,
      req.member!.user.id,
      idSchema.parse(req.params.id),
      input,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

export default router;
