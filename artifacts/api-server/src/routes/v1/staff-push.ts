import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import { getSessionId } from "../../lib/auth";
import { requireMember } from "../../middlewares/requireMember";
import {
  getStaffLeadAlertCoverage,
  getStaffPushPolicy,
  getStaffPushStatus,
  listStaffPushDeliveries,
  registerStaffPush,
  revokeStaffPush,
  saveStaffPushPolicy,
  StaffPushError,
} from "../../services/staff-push";
import { isPushEndpointAllowed } from "../../services/staff-push-policy";

const router: IRouter = Router();

/** A machine API key is never a device owner's notification consent/session. */
function sessionOnly(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  if (req.header("x-api-key") || !req.isAuthenticated() || !getSessionId(req)) {
    res.status(401).json({ error: "active_staff_session_required" });
    return;
  }
  const origin = req.header("origin");
  if (origin && origin !== process.env.APP_ORIGIN) {
    res.status(403).json({ error: "same_origin_required" });
    return;
  }
  next();
}
function failure(error: unknown, res: Response) {
  if (error instanceof StaffPushError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  // Suppress database parameters, endpoints/keys and raw crypto/provider errors.
  res
    .status(503)
    .json({ error: "staff_notifications_temporarily_unavailable" });
}

/** Exact coverage is private staff evidence, never an API-key reporting surface. */
function coverageSession(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  if (Object.prototype.hasOwnProperty.call(req.headers, "x-api-key")) {
    res.status(403).json({ error: "active_staff_session_required" });
    return;
  }
  if (!req.isAuthenticated() || !getSessionId(req)) {
    res.status(401).json({ error: "active_staff_session_required" });
    return;
  }
  const origin = req.get("origin"),
    site = req.get("sec-fetch-site");
  if (
    (origin !== undefined && (!origin || origin !== process.env.APP_ORIGIN)) ||
    (site !== undefined && !["same-origin", "none"].includes(site))
  ) {
    res.status(403).json({ error: "same_origin_required" });
    return;
  }
  next();
}

const coveragePermission = requireMember("settings.manage");
// Preserve the permission introspection tag while redacting authorization-store errors.
const coverageMember = Object.assign(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await coveragePermission(req, res, next);
    } catch (error) {
      failure(error, res);
    }
  },
  { requiredPermission: coveragePermission.requiredPermission },
);

router.get(
  "/staff-push/leads/:leadId/coverage",
  coverageSession,
  coverageMember,
  async (req, res) => {
    const leadId = z.uuid().safeParse(req.params.leadId);
    if (
      !leadId.success ||
      !z.object({}).strict().safeParse(req.query).success
    ) {
      res.status(400).json({ error: "invalid_coverage_request" });
      return;
    }
    try {
      res.json(
        await getStaffLeadAlertCoverage(
          req.member!.organizationId,
          req.member!.user.id,
          leadId.data,
          {
            sessionId: getSessionId(req)!,
            effectiveRole: req.member!.role,
          },
        ),
      );
    } catch (error) {
      failure(error, res);
    }
  },
);

router.get(
  "/staff-push/status",
  sessionOnly,
  requireMember("crm.read"),
  async (req, res) => {
    try {
      res.json(
        await getStaffPushStatus(
          req.member!.organizationId,
          req.member!.user.id,
          getSessionId(req)!,
        ),
      );
    } catch (error) {
      failure(error, res);
    }
  },
);
router.post(
  "/staff-push/subscriptions",
  sessionOnly,
  requireMember("crm.read"),
  async (req, res) => {
    try {
      res
        .status(201)
        .json(
          await registerStaffPush(
            req.member!.organizationId,
            req.member!.user.id,
            getSessionId(req)!,
            req.body,
          ),
        );
    } catch (error) {
      failure(error, res);
    }
  },
);
router.post(
  "/staff-push/subscriptions/revoke",
  sessionOnly,
  requireMember("crm.read"),
  async (req, res) => {
    const input = z
      .object({ endpoint: z.string().refine(isPushEndpointAllowed).optional() })
      .strict()
      .safeParse(req.body ?? {});
    if (!input.success) {
      res.status(400).json({ error: "invalid_device_revocation" });
      return;
    }
    try {
      res.json({
        revoked: await revokeStaffPush(
          req.member!.organizationId,
          req.member!.user.id,
          getSessionId(req)!,
          input.data.endpoint,
        ),
      });
    } catch (error) {
      failure(error, res);
    }
  },
);
router.get(
  "/staff-push/policy",
  sessionOnly,
  requireMember("settings.manage"),
  async (req, res) => {
    try {
      res.json({
        policy: await getStaffPushPolicy(req.member!.organizationId),
      });
    } catch (error) {
      failure(error, res);
    }
  },
);
router.put(
  "/staff-push/policy",
  sessionOnly,
  requireMember("settings.manage"),
  async (req, res) => {
    try {
      res.json({
        policy: await saveStaffPushPolicy(
          req.member!.organizationId,
          req.member!.user.id,
          req.body,
        ),
      });
    } catch (error) {
      failure(error, res);
    }
  },
);
router.get(
  "/staff-push/deliveries",
  sessionOnly,
  requireMember("settings.manage"),
  async (req, res) => {
    try {
      res.json({
        receipts: await listStaffPushDeliveries(req.member!.organizationId),
        meaning: "provider_accepted_not_received_or_read",
      });
    } catch (error) {
      failure(error, res);
    }
  },
);

export default router;
