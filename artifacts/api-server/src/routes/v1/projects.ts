import { CreateProjectBody, UpdateProjectBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as crm from "../../services/crm";
import { z } from "zod";
import {
  contractorMutation,
  contractorScheduleError,
} from "../../middlewares/contractor-mutation";
import {
  createManualScheduledProject,
  manualSchedulingError,
  nativeManualCommand,
} from "../../services/manual-scheduling";
import { projectSchedulingEvidence } from "../../services/scheduling-policy";

const router: IRouter = Router();
router.use(["/projects", "/projects/:id"], contractorMutation);

router.get(
  "/projects",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await crm.listProjects(req.member!.organizationId, {
        contactId:
          typeof req.query.contactId === "string"
            ? req.query.contactId
            : undefined,
        customerWorkId:
          typeof req.query.customerWorkId === "string"
            ? req.query.customerWorkId
            : undefined,
        limit:
          typeof req.query.limit === "string" && req.query.limit !== ""
            ? Number(req.query.limit)
            : undefined,
        offset:
          typeof req.query.offset === "string" && req.query.offset !== ""
            ? Number(req.query.offset)
            : undefined,
        leadId:
          typeof req.query.leadId === "string" ? req.query.leadId : undefined,
        status:
          typeof req.query.status === "string" ? req.query.status : undefined,
      }),
    );
  },
);

router.post(
  "/projects",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const actor = {
      organizationId: req.member!.organizationId,
      userId: req.member!.user.id,
    };
    if (req.body?.operationId !== undefined) {
      let command;
      try {
        command = nativeManualCommand(actor, "project_create", req.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({ error: "Invalid scheduling command" });
          return;
        }
        throw error;
      }
      const result = await createManualScheduledProject(actor, command);
      if (!result.record) {
        res.status(409).json(manualSchedulingError(result.ack));
        return;
      }
      res
        .status(result.newlyCreated ? 201 : 200)
        .json({ ...result.record, schedulingOperation: result.ack });
      return;
    }
    if (req.body?.schedulingReview !== undefined) {
      res
        .status(400)
        .json({
          error:
            "Reviewed scheduling requires the original operation identity.",
          code: "scheduling_operation_required",
        });
      return;
    }
    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid project" });
      return;
    }
    const project = await crm.createProject(
      req.member!.organizationId,
      parsed.data,
      actor,
    );
    if (project === crm.DUPLICATE_ESTIMATE) {
      res.status(409).json({
        error: "A project already exists for this estimate",
      });
      return;
    }
    if (!project) {
      res
        .status(400)
        .json({
          error:
            "Lead, estimate, or crew member not found in your organization",
        });
      return;
    }
    res
      .status(201)
      .json({ ...project, ...projectSchedulingEvidence("project", project) });
  },
);

router.get(
  "/projects/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const project = await crm.getProject(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ ...project, ...projectSchedulingEvidence("project", project) });
  },
);

router.patch(
  "/projects/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateProjectBody.extend({
      expectedUpdatedAt: z.iso.datetime().optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid project update" });
      return;
    }
    const project = await crm.updateProject(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data,
      {
        organizationId: req.member!.organizationId,
        userId: req.member!.user.id,
      },
    );
    if (project === crm.DUPLICATE_ESTIMATE) {
      res.status(409).json({
        error: "A project already exists for this estimate",
      });
      return;
    }
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ ...project, ...projectSchedulingEvidence("project", project) });
  },
);

router.delete(
  "/projects/:id",
  requireMember("crm.delete"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await crm.deleteProject(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (deleted === crm.INVOICE_HISTORY_RETAINED) {
      res
        .status(409)
        .json({
          error:
            "This job is referenced by retained invoice history and cannot be deleted.",
          code: deleted,
        });
      return;
    }
    if (!deleted) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "project.deleted",
      entityType: "project",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

router.use(contractorScheduleError);
export default router;
