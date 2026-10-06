import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation } from "../../middlewares/contractor-mutation";
import { WorkdayError, workdayAssetQuerySchema } from "../../services/contractor-workday-contract";
import { createWorkdayAsset, listWorkdayAssets, updateWorkdayAsset } from "../../services/property-assets";
import { approveWorkdayTemplate, createWorkdayTemplate, getWorkdayTemplate, listWorkdayTemplates, previewWorkdayTemplate, retireWorkdayTemplate, reviseWorkdayTemplate } from "../../services/work-checklists";
import { cancelAppointmentWorkEntry, completeAppointmentWork, correctAppointmentWork, createAppointmentWorkEntry, getAppointmentWork, previewAppointmentWorkCompletion, saveAppointmentWorkEntry } from "../../services/appointment-work";
import { attachAppointmentWorkPhoto, getAppointmentWorkPhoto, reserveAppointmentWorkPhoto } from "../../services/appointment-work-photos";

const router: IRouter = Router();
const guard: RequestHandler = (req, res, next) => {
  res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer");
  if (req.headers["x-api-key"] !== undefined) { res.status(403).json({ code: "workday_staff_required", error: "Use your accepted active company staff session." }); return; }
  let origin: string | null = null; try { origin = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* No supplied origin is trusted without configuration. */ }
  if ((req.header("origin") !== undefined && req.header("origin") !== origin) || (req.header("sec-fetch-site") && !["same-origin", "none"].includes(req.header("sec-fetch-site")!))) { res.status(403).json({ code: "workday_origin_required", error: "Open Visit work in your signed-in GrowthOS workspace." }); return; }
  next();
};
function context(req: Request) {
  const member = req.member!;
  if (!req.user || req.user.id !== member?.user.id || !member.user.isActive || !member.user.emailVerifiedAt || member.user.id.startsWith("invite:")) throw new WorkdayError(403, "workday_staff_required", "Use your accepted active company staff session.");
  for (const value of Object.values(req.params)) z.uuid().parse(value);
  return { org: member.organizationId, actor: { userId: member.user.id, effectiveRole: member.role } };
}
const safe = (work: (req: Request, ctx: ReturnType<typeof context>, res: Response) => Promise<unknown>, query = false, binary = false): RequestHandler => async (req, res) => {
  try {
    const ctx = context(req); if (!query) z.object({}).strict().parse(req.query);
    const result = await work(req, ctx, res); if (!binary) res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ code: "workday_invalid_request", error: "Use the exact saved record, version and reviewed fields." }); return; }
    if (error instanceof WorkdayError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
    res.status(503).json({ code: "workday_unavailable", error: "The work record could not be confirmed. Refresh its saved state before trying a new command." });
  }
};
const reads = [guard, requireMember("crm.read")];
const writes = [guard, requireMember("crm.write"), contractorMutation];
const settings = [guard, requireMember("settings.manage"), contractorMutation];
router.get("/contacts/:id/assets", ...reads, safe((req, c) => listWorkdayAssets(c.org, c.actor, String(req.params.id), workdayAssetQuerySchema.parse(req.query)), true));
router.post("/contacts/:id/assets", ...writes, safe((req, c) => createWorkdayAsset(c.org, c.actor, String(req.params.id), req.body)));
router.patch("/assets/:id", ...writes, safe((req, c) => updateWorkdayAsset(c.org, c.actor, String(req.params.id), req.body)));
router.get("/work-checklists", ...reads, safe((_req, c) => listWorkdayTemplates(c.org, c.actor)));
router.get("/work-checklists/:id", ...reads, safe((req, c) => getWorkdayTemplate(c.org, c.actor, String(req.params.id))));
router.post("/work-checklists", ...settings, safe((req, c) => createWorkdayTemplate(c.org, c.actor, req.body)));
router.post("/work-checklists/:id/revisions", ...settings, safe((req, c) => reviseWorkdayTemplate(c.org, c.actor, String(req.params.id), req.body)));
router.post("/work-checklists/:id/preview", ...settings, safe((req, c) => previewWorkdayTemplate(c.org, c.actor, String(req.params.id), req.body)));
router.post("/work-checklists/:id/approve", ...settings, safe((req, c) => approveWorkdayTemplate(c.org, c.actor, String(req.params.id), req.body)));
router.post("/work-checklists/:id/retire", ...settings, safe((req, c) => retireWorkdayTemplate(c.org, c.actor, String(req.params.id), req.body)));
router.get("/appointments/:id/work", ...reads, safe((req, c) => getAppointmentWork(c.org, c.actor, String(req.params.id))));
router.post("/appointments/:id/work/entries", ...writes, safe((req, c) => createAppointmentWorkEntry(c.org, c.actor, String(req.params.id), req.body)));
router.patch("/appointments/:id/work/entries/:entryId", ...writes, safe((req, c) => saveAppointmentWorkEntry(c.org, c.actor, String(req.params.id), String(req.params.entryId), req.body)));
router.post("/appointments/:id/work/entries/:entryId/cancel", ...writes, safe((req, c) => cancelAppointmentWorkEntry(c.org, c.actor, String(req.params.id), String(req.params.entryId), req.body)));
router.post("/appointments/:id/work/completion-preview", ...writes, safe((req, c) => previewAppointmentWorkCompletion(c.org, c.actor, String(req.params.id), req.body)));
router.post("/appointments/:id/work/complete", ...writes, safe((req, c) => completeAppointmentWork(c.org, c.actor, String(req.params.id), req.body)));
router.post("/appointments/:id/work/completions/:completionId/corrections", ...writes, safe((req, c) => correctAppointmentWork(c.org, c.actor, String(req.params.id), String(req.params.completionId), req.body)));
router.post("/appointments/:id/work/entries/:entryId/photos/request-url", ...writes, safe((req, c) => reserveAppointmentWorkPhoto(c.org, c.actor, String(req.params.id), String(req.params.entryId), req.body)));
router.post("/appointments/:id/work/entries/:entryId/photos", ...writes, safe((req, c) => attachAppointmentWorkPhoto(c.org, c.actor, String(req.params.id), String(req.params.entryId), req.body)));
router.get("/appointments/:id/work/photos/:photoId/content", ...reads, safe(async (req, c, res) => {
  const photo = await getAppointmentWorkPhoto(c.org, c.actor, String(req.params.id), String(req.params.photoId));
  res.set("X-Content-Type-Options", "nosniff"); res.set("Content-Type", photo.contentType); res.set("Content-Disposition", "inline"); res.send(photo.data);
}, false, true));
export default router;
