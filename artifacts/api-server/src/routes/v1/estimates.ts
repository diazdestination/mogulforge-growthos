import { CreateEstimateBody, UpdateEstimateBody } from "@workspace/api-zod";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import { hasPermission } from "../../lib/permissions";
import { CustomerWorkError } from "../../services/returning-customer-contract";
import {
  getEstimateEmailEvidence,
  previewEstimateEmail,
  sendEstimateEmail,
} from "../../services/estimate-delivery";
import {
  EstimateDeliveryError,
  estimateDeliveryPreviewRequestSchema,
  estimateDeliverySendSchema,
  estimateEmailEvidenceSchema,
  estimateEmailPreviewSchema,
} from "../../services/estimate-delivery-contract";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as crm from "../../services/crm";
import { contractorScheduleError } from "../../middlewares/contractor-mutation";

const router: IRouter = Router();

// Scope these privacy and mutation controls to reviewed delivery, preserving CRUD.
router.use("/estimates/:id/delivery", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method === "POST") {
    const configured = process.env.APP_ORIGIN;
    let trusted = false;
    try {
      trusted =
        !!configured &&
        new URL(configured).origin === configured &&
        req.get("origin") === configured;
    } catch {
      /* Fail closed without an explicit origin. */
    }
    if (
      req.headers["x-api-key"] !== undefined ||
      !trusted ||
      ["cross-site", "same-site"].includes(req.get("sec-fetch-site") ?? "")
    ) {
      res
        .status(403)
        .json({
          error:
            "Use your accepted staff session on the trusted GrowthOS page to review estimate email.",
          code: "estimate_access_denied",
        });
      return;
    }
    if (!req.is("application/json")) {
      res
        .status(415)
        .json({ error: "JSON is required.", code: "estimate_invalid_request" });
      return;
    }
  }
  next();
});
function estimateDeliveryMutation(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const member = req.member,
    user = member?.user;
  if (
    !req.user ||
    !user ||
    req.user.id !== user?.id ||
    !user.isActive ||
    !user.emailVerifiedAt ||
    user.id.startsWith("invite:") ||
    !["office", "admin", "owner"].includes(user.role) ||
    !member ||
    !["office", "admin", "owner"].includes(member.role) ||
    !hasPermission(user.role, "crm.write") ||
    !hasPermission(member.role, "crm.write")
  ) {
    res
      .status(403)
      .json({
        error:
          "An accepted, verified, active office, admin or owner session is required.",
        code: "estimate_access_denied",
      });
    return;
  }
  next();
}
const estimateDeliverySafe =
  (work: (req: Request, res: Response, id: string) => Promise<void>) =>
  async (req: Request, res: Response) => {
    try {
      if (
        Object.keys(req.query).length ||
        (req.method === "GET" && req.body !== undefined)
      )
        throw new EstimateDeliveryError(
          400,
          "estimate_invalid_request",
          "This estimate delivery action does not accept query selectors or a read body.",
        );
      await work(req, res, z.uuid().parse(req.params.id));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({
            error: "Review the exact saved estimate fields and confirmation.",
            code: "estimate_invalid_request",
          });
        return;
      }
      if (
        error instanceof CustomerWorkError ||
        error instanceof EstimateDeliveryError
      ) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      res
        .status(503)
        .json({
          error:
            "Estimate delivery is unavailable. Check the original retained evidence before further action.",
          code: "estimate_delivery_unavailable",
        });
    }
  };
function closedEstimateDeliveryResponse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error("Invalid retained estimate delivery projection");
  return result.data;
}
router.get(
  "/estimates/:id/delivery",
  requireMember("crm.read"),
  estimateDeliverySafe(async (req, res, id) => {
    res.json(
      closedEstimateDeliveryResponse(estimateEmailEvidenceSchema,
        await getEstimateEmailEvidence(req.member!.organizationId, id),
      ),
    );
  }),
);
router.post(
  "/estimates/:id/delivery/preview",
  requireMember("crm.write"),
  estimateDeliveryMutation,
  estimateDeliverySafe(async (req, res, id) => {
    const input = estimateDeliveryPreviewRequestSchema.parse(req.body);
    res.json(
      closedEstimateDeliveryResponse(estimateEmailPreviewSchema,
        await previewEstimateEmail(
          req.member!.organizationId,
          { userId: req.member!.user.id, effectiveRole: req.member!.role },
          id,
          input,
        ),
      ),
    );
  }),
);
router.post(
  "/estimates/:id/delivery/send",
  requireMember("crm.write"),
  estimateDeliveryMutation,
  estimateDeliverySafe(async (req, res, id) => {
    const input = estimateDeliverySendSchema.parse(req.body);
    res.json(
      closedEstimateDeliveryResponse(estimateEmailEvidenceSchema,
        await sendEstimateEmail(
          req.member!.organizationId,
          { userId: req.member!.user.id, effectiveRole: req.member!.role },
          id,
          input,
        ),
      ),
    );
  }),
);

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
