import {
  Router,
  type IRouter,
  type Request,
  type RequestHandler,
} from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation } from "../../middlewares/contractor-mutation";
import {
  CustomerWorkError,
  CustomerWorkProjectResultUnavailableError,
  customerWorkProjectUnavailableSchema,
} from "../../services/returning-customer-contract";
import { SchedulingPolicyError } from "../../services/scheduling-policy";
import {
  createCustomerWorkEstimate,
  createCustomerWorkProject,
  updateCustomerWorkEstimate,
  updateCustomerWorkProject,
} from "../../services/returning-customer";
import { ScheduleError } from "../../services/contractor-scheduling";
const router: IRouter = Router();
const guard: RequestHandler = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  let origin: string | null = null;
  try {
    origin = new URL(process.env.APP_ORIGIN ?? "").origin;
  } catch {
    /* held supplied origin */
  }
  if (req.headers["x-api-key"] !== undefined) {
    res
      .status(403)
      .json({
        code: "customer_work_access_denied",
        error: "Use your accepted staff session.",
      });
    return;
  }
  if (
    (req.header("origin") !== undefined && req.header("origin") !== origin) ||
    (req.header("sec-fetch-site") &&
      !["same-origin", "none"].includes(req.header("sec-fetch-site")!))
  ) {
    res
      .status(403)
      .json({
        code: "customer_work_origin_required",
        error: "Open your signed-in GrowthOS workspace.",
      });
    return;
  }
  next();
};
function context(req: Request) {
  const m = req.member!;
  if (
    !req.user ||
    req.user.id !== m?.user.id ||
    !m.user.isActive ||
    !m.user.emailVerifiedAt ||
    m.user.id.startsWith("invite:")
  )
    throw new CustomerWorkError(
      403,
      "customer_work_access_denied",
      "Use your accepted, verified, active staff session.",
    );
  return {
    org: m.organizationId,
    actor: { userId: m.user.id, effectiveRole: m.role },
  };
}
const safe =
  (
    work: (req: Request, c: ReturnType<typeof context>) => Promise<unknown>,
  ): RequestHandler =>
  async (req, res) => {
    try {
      const c = context(req);
      z.object({}).strict().parse(req.query);
      if (req.params.id) z.uuid().parse(req.params.id);
      res.json(await work(req, c));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({
            code: "customer_work_invalid_request",
            error:
              "Use the exact submitted customer, source, saved version and work fields.",
          });
        return;
      }
      if (error instanceof CustomerWorkProjectResultUnavailableError) {
        res
          .status(409)
          .json(
            customerWorkProjectUnavailableSchema.parse({
              code: error.code,
              error: error.message,
              commandOutcome: error.commandOutcome,
            }),
          );
        return;
      }
      if (
        error instanceof CustomerWorkError ||
        error instanceof ScheduleError ||
        error instanceof SchedulingPolicyError
      ) {
        res
          .status(error.status)
          .json({ code: error.code, error: error.message });
        return;
      }
      res
        .status(503)
        .json({
          code: "customer_work_unavailable",
          error:
            "The command result is not confirmed. Keep the exact original request for reconciliation; do not start a new request.",
        });
    }
  };
const writes = [guard, requireMember("crm.write"), contractorMutation];
router.post(
  "/customer-work/estimates",
  ...writes,
  safe((r, c) => createCustomerWorkEstimate(c.org, c.actor, r.body)),
);
router.patch(
  "/customer-work/estimates/:id",
  ...writes,
  safe((r, c) =>
    updateCustomerWorkEstimate(c.org, c.actor, String(r.params.id), r.body),
  ),
);
router.post(
  "/customer-work/projects",
  ...writes,
  safe((r, c) => createCustomerWorkProject(c.org, c.actor, r.body)),
);
router.patch(
  "/customer-work/projects/:id",
  ...writes,
  safe((r, c) =>
    updateCustomerWorkProject(c.org, c.actor, String(r.params.id), r.body),
  ),
);
export default router;
