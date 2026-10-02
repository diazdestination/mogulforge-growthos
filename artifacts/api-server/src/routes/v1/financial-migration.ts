import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import { FinancialMigrationError } from "../../services/financial-migration-contract";
import {
  commitFinancialMigration,
  getFinancialMigration,
  listFinancialMigrations,
  previewFinancialMigration,
} from "../../services/financial-migration";

const router: IRouter = Router();
router.use("/financial-migrations", (req, res, next) => {
  res.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
  if (req.get("x-api-key") !== undefined) {
    res
      .status(403)
      .json({
        code: "financial_manager_required",
        error: "Financial reviews require a signed-in owner or administrator.",
      });
    return;
  }
  if (Object.keys(req.query).length) {
    res
      .status(400)
      .json({
        code: "financial_invalid_request",
        error: "Financial migration does not accept query selectors.",
      });
    return;
  }
  let trusted: string | null = null;
  try {
    trusted = new URL(process.env.APP_ORIGIN ?? "").origin;
  } catch {
    /* Unconfigured means held. */
  }
  const origin = req.get("origin"),
    site = req.get("sec-fetch-site"),
    bearer = /^Bearer \S+$/.test(req.get("authorization") ?? "");
  if (
    (origin !== undefined && origin !== trusted) ||
    (site && !["same-origin", "none"].includes(site))
  ) {
    res
      .status(403)
      .json({
        code: "financial_human_approval_required",
        error: "This origin cannot access financial reviews.",
      });
    return;
  }
  if (req.method === "GET") return next();
  if (
    !trusted ||
    (site && !["same-origin", "none"].includes(site)) ||
    (origin !== undefined ? origin !== trusted : !bearer)
  ) {
    res
      .status(403)
      .json({
        code: "financial_human_approval_required",
        error:
          "Use the trusted app and your own signed-in staff session for financial approval.",
      });
    return;
  }
  if (!req.is("application/json")) {
    res
      .status(415)
      .json({
        code: "financial_json_required",
        error: "JSON review is required.",
      });
    return;
  }
  next();
});
const safe =
  (work: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      await work(req, res);
    } catch (error) {
      if (error instanceof FinancialMigrationError) {
        res
          .status(error.status)
          .json({ code: error.code, error: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({
            code: "financial_invalid_request",
            error:
              "Review the exact financial contract and required confirmations.",
          });
        return;
      }
      res
        .status(503)
        .json({
          code: "financial_unavailable",
          error:
            "Financial review is unavailable. Check the same review status before retrying; do not create replacement records.",
        });
    }
  };
router.get(
  "/financial-migrations",
  requireMember("settings.manage"),
  safe(async (req, res) =>
    res.json(
      await listFinancialMigrations(
        req.member!.organizationId,
        req.member!.user.id,
      ),
    ),
  ),
);
router.post(
  "/financial-migrations/preview",
  requireMember("settings.manage"),
  rateLimit({ windowMs: 60_000, max: 15, key: "financial-migration-preview" }),
  safe(async (req, res) =>
    res.json(
      await previewFinancialMigration(
        req.member!.organizationId,
        req.member!.user.id,
        req.body,
      ),
    ),
  ),
);
router.get(
  "/financial-migrations/:id",
  requireMember("settings.manage"),
  safe(async (req, res) =>
    res.json(
      await getFinancialMigration(
        req.member!.organizationId,
        req.member!.user.id,
        z.uuid().parse(req.params.id),
      ),
    ),
  ),
);
router.post(
  "/financial-migrations/:id/commit",
  requireMember("settings.manage"),
  rateLimit({ windowMs: 60_000, max: 15, key: "financial-migration-commit" }),
  safe(async (req, res) =>
    res.json(
      await commitFinancialMigration(
        req.member!.organizationId,
        req.member!.user.id,
        z.uuid().parse(req.params.id),
        req.body,
      ),
    ),
  ),
);
export default router;
