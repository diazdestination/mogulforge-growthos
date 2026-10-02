import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import {
  buildRevenueRecoveryBriefing,
  executeBieProposal,
  generateBieProposals,
  getAutopilotPolicy,
  listBieProposals,
  listBieSources,
  reviewBieProposal,
  runAutopilot,
  runRevenueRecoveryBriefing,
  updateAutopilotPolicy,
} from "../../services/bie";
import type { BieActionType, BieAutopilotPolicy } from "@workspace/db";
import { z } from "zod/v4";
import { assertCapabilityForActor, CapabilityAccessError } from "../../services/entitlements";

const router: IRouter = Router();

const ACTION_TYPES: BieActionType[] = [
  "create_task",
  "change_stage",
  "send_email",
];

router.get(
  "/bie/briefing",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await buildRevenueRecoveryBriefing(req.member!.organizationId));
  },
);

router.post(
  "/bie/briefing/run",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await runRevenueRecoveryBriefing(
        req.member!.organizationId,
        req.member!.user.id,
      ),
    );
  },
);

router.get(
  "/bie/sources",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await listBieSources(req.member!.organizationId));
  },
);

router.get(
  "/bie/actions",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await listBieProposals(req.member!.organizationId));
  },
);

router.post(
  "/bie/actions/generate",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    res
      .status(201)
      .json(
        await generateBieProposals(
          req.member!.organizationId,
          req.member!.user.id,
        ),
      );
  },
);

for (const decision of ["approve", "reject"] as const) {
  router.post(
    `/bie/actions/:id/${decision}`,
    requireMember("crm.write"),
    async (req: Request, res: Response): Promise<void> => {
      const input = z
        .object({ expectedPayload: z.record(z.string(), z.unknown()) })
        .strict()
        .safeParse(req.body);
      if (decision === "approve" && !input.success) {
        res
          .status(400)
          .json({
            error: "Refresh the proposal and approve the exact saved content.",
          });
        return;
      }
      const result = await reviewBieProposal(
        req.member!.organizationId,
        String(req.params.id),
        req.member!.user.id,
        decision,
        input.success ? input.data.expectedPayload : undefined,
      );
      if (!result) {
        res
          .status(409)
          .json({
            error:
              "Proposal changed, is unavailable, or was already reviewed. Refresh and review its current content.",
          });
        return;
      }
      res.json(result);
    },
  );
}

router.post(
  "/bie/actions/:id/execute",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const result = await executeBieProposal(
      req.member!.organizationId,
      String(req.params.id),
      req.member!.user.id,
    );
    if (!result) {
      res
        .status(404)
        .json({
          error: "Action proposal was not found or has not been approved.",
        });
      return;
    }
    res.json(result);
  },
);

router.get(
  "/bie/autopilot",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await getAutopilotPolicy(req.member!.organizationId));
  },
);

router.put(
  "/bie/autopilot",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const patch: Partial<BieAutopilotPolicy> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (
      typeof body.dailyEmailCap === "number" &&
      Number.isFinite(body.dailyEmailCap)
    ) {
      patch.dailyEmailCap = body.dailyEmailCap;
    }
    if (Array.isArray(body.allowedActions)) {
      patch.allowedActions = body.allowedActions.filter(
        (value: unknown): value is BieActionType =>
          typeof value === "string" &&
          ACTION_TYPES.includes(value as BieActionType),
      );
    }
    if (typeof body.pauseReason === "string")
      patch.pauseReason = body.pauseReason.slice(0, 500);
    if (body.pauseReason === null) patch.pauseReason = null;
    try {
      res.json(await updateAutopilotPolicy(req.member!.organizationId, req.member!.user.id, patch));
    } catch (error) {
      if (!(error instanceof CapabilityAccessError)) throw error;
      res.status(error.status).json({ error: error.message, code: error.code, capability: error.capability, reason: error.reason });
    }
  },
);

// Explicit owner/admin trigger for a future scheduler. The worker itself is
// intentionally not started until the organization enables a policy.
router.post(
  "/bie/autopilot/run",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      await assertCapabilityForActor(req.member!.organizationId, req.member!.user.id, "revenue.autopilot", "settings.manage");
      res.json(await runAutopilot(req.member!.organizationId));
    } catch (error) {
      if (!(error instanceof CapabilityAccessError)) throw error;
      res.status(error.status).json({ error: error.message, code: error.code, capability: error.capability, reason: error.reason });
    }
  },
);

export default router;
