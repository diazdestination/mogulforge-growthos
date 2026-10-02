import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requirePlatformAdmin } from "./orgs";
import { rateLimit } from "../../lib/rateLimit";
import { SMART_SITE_PROFILES } from "../../services/smart-site-contract";
import {
  clientDraftSchema,
  createClientDraft,
  clientReadiness,
  checkSiteCredential,
} from "../../services/client-onboarding";
import { rotateSmartSiteKey, SmartSiteError } from "../../services/smart-sites";
import {
  createStaffInvitation,
  listStaffInvitations,
  updateStaffInvitation,
  StaffInvitationError,
} from "../../services/staff-invitations";
const router = Router();
const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "GET" && !req.is("application/json"))
        throw new SmartSiteError("json_required", 415);
      // New platform mutations require same-origin browser requests (or a staff session without Origin).
      if (
        req.path.startsWith("/platform/") &&
        req.headers.origin &&
        req.headers.origin !== process.env.APP_ORIGIN
      )
        throw new SmartSiteError("origin_not_allowed", 403);
      await fn(req, res);
    } catch (err) {
      if (
        err instanceof SmartSiteError ||
        err instanceof StaffInvitationError
      ) {
        res.status(err.status).json({ error: err.code });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      // Never echo SQL parameters, tenant records, submitted secrets or exception text.
      res.status(503).json({ error: "onboarding_temporarily_unavailable" });
    }
  };
router.get(
  "/platform/clients/profiles",
  requirePlatformAdmin,
  safe(async (_req, res) => {
    res.json(SMART_SITE_PROFILES);
  }),
);
router.post(
  "/platform/clients",
  requirePlatformAdmin,
  rateLimit({ windowMs: 60_000, max: 20, key: "client-provisioning" }),
  safe(async (req, res) => {
    const result = await createClientDraft(
      req.sessionUser!.id,
      clientDraftSchema.parse(req.body),
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);
router.get(
  "/platform/clients/:orgId/readiness",
  requirePlatformAdmin,
  safe(async (req, res) => {
    res.json(await clientReadiness(z.uuid().parse(req.params.orgId)));
  }),
);
router.post(
  "/platform/clients/:orgId/sites/:siteId/key",
  requirePlatformAdmin,
  safe(async (req, res) => {
    const body = z
      .object({
        confirmed: z.literal(true),
        expectedVersion: z.number().int().min(1),
      })
      .strict()
      .parse(req.body);
    res.json(
      await rotateSmartSiteKey(
        z.uuid().parse(req.params.orgId),
        req.sessionUser!.id,
        z.uuid().parse(req.params.siteId),
        body.expectedVersion,
      ),
    );
  }),
);
router.post(
  "/public/smart-sites/:id/check",
  rateLimit({ windowMs: 60_000, max: 20, key: "site-credential-check" }),
  safe(async (req, res) => {
    if (req.headers.origin)
      throw new SmartSiteError("server_to_server_only", 403);
    z.object({ schemaVersion: z.literal(1) })
      .strict()
      .parse(req.body);
    res.json(
      await checkSiteCredential(
        z.uuid().parse(req.params.id),
        (req.header("authorization") ?? "").replace(/^Bearer /, ""),
      ),
    );
  }),
);

const staffInviteBody = z
  .object({
    requestId: z.uuid(),
    email: z.email().trim().max(254),
    role: z.enum([
      "owner",
      "admin",
      "sales_manager",
      "sales_rep",
      "inspector",
      "production",
      "office",
      "viewer",
    ]),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    confirmed: z.literal(true),
  })
  .strict();
const staffInviteAction = z
  .object({
    expectedVersion: z.number().int().min(1),
    confirmed: z.literal(true),
  })
  .strict();

router.get(
  "/platform/clients/:orgId/invitations",
  requirePlatformAdmin,
  safe(async (req, res) => {
    res.json(
      await listStaffInvitations(
        { userId: req.sessionUser!.id, scope: "platform" },
        z.uuid().parse(req.params.orgId),
      ),
    );
  }),
);
router.post(
  "/platform/clients/:orgId/invitations",
  requirePlatformAdmin,
  rateLimit({ windowMs: 60_000, max: 10, key: "client-staff-invitations" }),
  safe(async (req, res) => {
    const result = await createStaffInvitation(
      { userId: req.sessionUser!.id, scope: "platform" },
      z.uuid().parse(req.params.orgId),
      staffInviteBody.parse(req.body),
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);
router.post(
  "/platform/clients/:orgId/invitations/:invitationId/reissue",
  requirePlatformAdmin,
  safe(async (req, res) => {
    res.json(
      await updateStaffInvitation(
        { userId: req.sessionUser!.id, scope: "platform" },
        z.uuid().parse(req.params.orgId),
        z.uuid().parse(req.params.invitationId),
        { ...staffInviteAction.parse(req.body), action: "reissue" },
      ),
    );
  }),
);
router.post(
  "/platform/clients/:orgId/invitations/:invitationId/revoke",
  requirePlatformAdmin,
  safe(async (req, res) => {
    res.json(
      await updateStaffInvitation(
        { userId: req.sessionUser!.id, scope: "platform" },
        z.uuid().parse(req.params.orgId),
        z.uuid().parse(req.params.invitationId),
        { ...staffInviteAction.parse(req.body), action: "revoke" },
      ),
    );
  }),
);
export default router;
