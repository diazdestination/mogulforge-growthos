import { Router, type Response } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { CustomerLifecycleHoldError } from "../../services/customer-lifecycle";
import {
  getSchedulingReviewContext,
  readSchedulingPolicy,
  saveSchedulingPolicy,
  schedulingReviewQuerySchema,
  SchedulingPolicyError,
} from "../../services/scheduling-policy";

const router = Router();
export function schedulingError(error: unknown, res: Response): boolean {
  if (
    error instanceof SchedulingPolicyError ||
    error instanceof CustomerLifecycleHoldError
  ) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof z.ZodError) {
    res
      .status(400)
      .json({
        error: "Choose a valid scheduling source, target and booking scope.",
        code: "invalid_scheduling_context",
      });
    return true;
  }
  return false;
}
router.get(
  "/settings/scheduling-policy",
  requireMember("crm.read"),
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(
        await readSchedulingPolicy({
          organizationId: req.member!.organizationId,
          userId: req.member!.user.id,
        }),
      );
    } catch (error) {
      if (!schedulingError(error, res)) throw error;
    }
  },
);
router.put(
  "/settings/scheduling-policy",
  requireMember("settings.manage"),
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(
        await saveSchedulingPolicy(
          {
            organizationId: req.member!.organizationId,
            userId: req.member!.user.id,
          },
          req.body,
        ),
      );
    } catch (error) {
      if (!schedulingError(error, res)) throw error;
    }
  },
);
router.get(
  "/scheduling/review-context",
  requireMember("crm.read"),
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(
        await getSchedulingReviewContext(
          {
            organizationId: req.member!.organizationId,
            userId: req.member!.user.id,
          },
          schedulingReviewQuerySchema.parse(req.query),
        ),
      );
    } catch (error) {
      if (!schedulingError(error, res)) throw error;
    }
  },
);
// POST /scheduling/operations/reconcile is frozen in OpenAPI; Task4 owns its
// retained receipt implementation. No GET or temporary handler asserts no-commit.
export default router;
