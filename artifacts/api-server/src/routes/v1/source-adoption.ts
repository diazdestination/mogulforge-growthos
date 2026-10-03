import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import { SourceAdoptionError } from "../../services/source-adoption-contract";
import { CapabilityAccessError } from "../../services/entitlements";
import { approveSourceAdoption, approveSourceOutreach, getSourceAdoption, getSourceOutreach, listSourceAdoptions, previewSourceAdoption, previewSourceOutreach, recordSourceEmailPermission, revokeSourceAdoption, revokeSourceOutreach, sendSourceOutreach } from "../../services/source-adoption";

const router: IRouter = Router();
router.use("/source-adoption", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (Object.keys(req.query).some(key => req.method !== "GET" || req.path !== "/" || !["page", "campaignPage"].includes(key))) {
    res.status(400).json({ code: "source_invalid_request", error: "Only bounded index page selectors are accepted." }); return;
  }
  if (!["GET", "HEAD"].includes(req.method)) {
    let configured: string | null = null;
    try { configured = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* Missing trusted origin denies approval. */ }
    const origin = req.header("origin"), site = req.header("sec-fetch-site"), bearer = /^Bearer \S+$/.test(req.header("authorization") ?? "");
    if (req.headers["x-api-key"] !== undefined || !configured || (site && !["same-origin", "none"].includes(site)) ||
        (origin !== undefined ? origin !== configured : !bearer)) {
      res.status(403).json({ code: "source_human_session_required", error: "A trusted signed-in owner/admin session is required." }); return;
    }
    if (!req.is("application/json")) { res.status(415).json({ code: "source_json_required", error: "JSON review is required." }); return; }
  }
  next();
});
const safe = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, _next: NextFunction) => {
  try {
    if (!req.member?.user.emailVerifiedAt || req.member.user.id.startsWith("invite:")) throw new SourceAdoptionError(403, "source_staff_required", "Accepted active company staff access is required.");
    if (req.params.id) z.uuid().parse(req.params.id); res.json(await fn(req));
  }
  catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ code: "source_invalid_request", error: "Review the exact fields, dates, evidence and confirmation. Unknown fields are not accepted." }); return; }
    if (error instanceof SourceAdoptionError || error instanceof CapabilityAccessError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
    res.status(503).json({ code: "source_operation_unavailable", error: "The operation could not be confirmed. Check its saved status; never repeat an uncertain email with another campaign." });
  }
};
router.get("/source-adoption", requireMember("crm.read"), safe(req => {
  const pagination = z.object({ page: z.string().regex(/^\d{1,6}$/).optional(), campaignPage: z.string().regex(/^\d{1,6}$/).optional() }).strict().parse(req.query);
  return listSourceAdoptions(req.member!.organizationId, Number(pagination.page ?? 0), Number(pagination.campaignPage ?? 0));
}));
router.get("/source-adoption/leads/:id", requireMember("crm.read"), safe(req => getSourceAdoption(req.member!.organizationId, String(req.params.id))));
router.get("/source-adoption/outreach/:id", requireMember("crm.read"), safe(req => getSourceOutreach(req.member!.organizationId, String(req.params.id))));
const limiter = rateLimit({ windowMs: 60_000, max: 30, key: "source-adoption-approval" });
for (const [name, work] of Object.entries({ preview: previewSourceAdoption, approve: approveSourceAdoption, revoke: revokeSourceAdoption, "email-permission": recordSourceEmailPermission })) {
  router.post(`/source-adoption/leads/:id/${name}`, requireMember("settings.manage"), limiter,
    safe(req => work(req.member!.organizationId, req.member!.user.id, String(req.params.id), req.body)));
}
router.post("/source-adoption/outreach/preview", requireMember("settings.manage"), limiter,
  safe(req => previewSourceOutreach(req.member!.organizationId, req.member!.user.id, req.body)));
for (const [name, work] of Object.entries({ approve: approveSourceOutreach, revoke: revokeSourceOutreach, send: sendSourceOutreach })) {
  router.post(`/source-adoption/outreach/:id/${name}`, requireMember("settings.manage"), limiter,
    safe(req => work(req.member!.organizationId, req.member!.user.id, String(req.params.id), req.body)));
}
export default router;
