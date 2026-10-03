import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import { CapabilityAccessError } from "../../services/entitlements";
import { CustomerLifecycleHoldError } from "../../services/customer-lifecycle";
import { SourceAdoptionError } from "../../services/source-adoption-contract";
import { SourceNurtureError } from "../../services/source-nurture-contract";
import {
  approveSourceNurture, getSourceNurture, listSourceNurture,
  previewSourceNurture, startSourceNurture, stopSourceNurture,
} from "../../services/source-nurture";

const router: IRouter = Router();
router.use("/source-nurture", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  // Reject even a blank API-key header before any key resolver is invoked.
  if (req.headers["x-api-key"] !== undefined) {
    res.status(403).json({ code: "nurture_staff_session_required", error: "Use an accepted staff session to review nurture authority and evidence." });
    return;
  }
  if (Object.keys(req.query).some(key => req.method !== "GET" || req.path !== "/" || !["bucket", "offset"].includes(key))) {
    res.status(400).json({ code: "nurture_invalid_request", error: "Only the bounded index bucket and offset are accepted." });
    return;
  }
  if (!["GET", "HEAD"].includes(req.method)) {
    let configured: string | null = null;
    try { configured = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* Missing origin cannot authorize review. */ }
    const origin = req.header("origin"), site = req.header("sec-fetch-site");
    const bearer = /^Bearer \S+$/.test(req.header("authorization") ?? "");
    if (!configured || (site && !["same-origin", "none"].includes(site)) || (origin !== undefined ? origin !== configured : !bearer)) {
      res.status(403).json({ code: "nurture_trusted_origin_required", error: "Review this action from the trusted signed-in GrowthOS page." });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ code: "nurture_json_required", error: "An exact JSON review is required." });
      return;
    }
  }
  next();
});

const safe = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    const user = req.member?.user;
    if (!req.user || req.user.id !== user?.id || !user.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:"))
      throw new SourceNurtureError(403, "nurture_staff_session_required", "Use your accepted active company staff session.");
    if (req.params.id) z.uuid().parse(req.params.id);
    res.json(await fn(req));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ code: "nurture_invalid_request", error: "Review the exact fields, dates, version and confirmation. Unknown fields are not accepted." });
      return;
    }
    if (error instanceof SourceNurtureError || error instanceof SourceAdoptionError || error instanceof CapabilityAccessError || error instanceof CustomerLifecycleHoldError) {
      res.status(error.status).json({ code: error.code, error: error.message });
      return;
    }
    res.status(503).json({ code: "nurture_operation_unavailable", error: "The result could not be confirmed. Refresh saved evidence; do not create another sequence to retry an uncertain effect." });
  }
};
const query = z.object({
  bucket: z.enum(["attention", "waiting", "history"]).default("attention"),
  offset: z.string().regex(/^\d{1,6}$/).transform(Number).refine(value => value <= 100_000).default(0),
}).strict();
router.get("/source-nurture", requireMember("crm.read"), safe(req => {
  const input = query.parse(req.query);
  return listSourceNurture(req.member!.organizationId, input.bucket, input.offset);
}));
router.get("/source-nurture/:id", requireMember("crm.read"), safe(req => getSourceNurture(req.member!.organizationId, String(req.params.id))));
const limiter = rateLimit({ windowMs: 60_000, max: 30, key: "source-nurture-review" });
router.post("/source-nurture/preview", requireMember("settings.manage"), limiter,
  safe(req => previewSourceNurture(req.member!.organizationId, req.member!.user.id, req.body)));
for (const [name, work] of Object.entries({ approve: approveSourceNurture, start: startSourceNurture, stop: stopSourceNurture })) {
  router.post(`/source-nurture/:id/${name}`, requireMember("settings.manage"), limiter,
    safe(req => work(req.member!.organizationId, req.member!.user.id, String(req.params.id), req.body)));
}
export default router;
