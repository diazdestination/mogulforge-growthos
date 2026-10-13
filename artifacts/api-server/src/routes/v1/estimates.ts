import { CreateEstimateBody, UpdateEstimateBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as crm from "../../services/crm";
import { contractorScheduleError } from "../../middlewares/contractor-mutation";

const router: IRouter = Router();

router.get(
  "/estimates",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await crm.listEstimates(req.member!.organizationId, {
        contactId: typeof req.query.contactId === "string" ? req.query.contactId : undefined,
        customerWorkId: typeof req.query.customerWorkId === "string" ? req.query.customerWorkId : undefined,
        leadId:
          typeof req.query.leadId === "string" ? req.query.leadId : undefined,
        status:
          typeof req.query.status === "string" ? req.query.status : undefined,
        limit:
          typeof req.query.limit === "string" && req.query.limit !== ""
            ? Number(req.query.limit)
            : undefined,
        offset:
          typeof req.query.offset === "string" && req.query.offset !== ""
            ? Number(req.query.offset)
            : undefined,
      }),
    );
  },
);

router.post(
  "/estimates",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateEstimateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid estimate" });
      return;
    }
    const estimate = await crm.createEstimate(
      req.member!.organizationId,
      parsed.data,
      { userId: req.member!.user.id },
    );
    if (!estimate) {
      res.status(400).json({ error: "Lead not found in your organization" });
      return;
    }
    res.status(201).json(estimate);
  },
);

router.get(
  "/estimates/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const estimate = await crm.getEstimate(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!estimate) {
      res.status(404).json({ error: "Estimate not found" });
      return;
    }
    res.json(estimate);
  },
);

router.patch(
  "/estimates/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateEstimateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid estimate update" });
      return;
    }
    const estimate = await crm.updateEstimate(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data,
      { userId: req.member!.user.id },
    );
    if (!estimate) {
      res.status(404).json({ error: "Estimate not found" });
      return;
    }
    res.json(estimate);
  },
);

router.delete(
  "/estimates/:id",
  requireMember("crm.delete"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await crm.deleteEstimate(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (deleted === crm.INVOICE_HISTORY_RETAINED) {
      res.status(409).json({ error: "This estimate is referenced by retained invoice history and cannot be deleted.", code: deleted });
      return;
    }
    if (!deleted) {
      res.status(404).json({ error: "Estimate not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "estimate.deleted",
      entityType: "estimate",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

router.use(contractorScheduleError);
export default router;
