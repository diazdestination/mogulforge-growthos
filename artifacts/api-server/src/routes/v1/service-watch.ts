import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation, contractorScheduleError } from "../../middlewares/contractor-mutation";
import { getServiceWatch, listServiceWatch, ServiceWatchError, updateServiceWatch } from "../../services/service-watch";
import { serviceWatchCommand, serviceWatchQuery } from "../../services/service-watch-policy";

const router: IRouter = Router();
const detail = "/service-obligations/:id/watch";
router.use(["/service-watch", detail], contractorMutation);
router.get("/service-watch", requireMember("crm.read"), async (req, res) => {
  const query = serviceWatchQuery.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Choose a valid watch scope and page." }); return; }
  res.set("Cache-Control", "no-store").json(await listServiceWatch(req.member!.organizationId, req.member!.user.id, query.data));
});
router.get(detail, requireMember("crm.read"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success || Object.keys(req.query).length) { res.status(400).json({ error: "Choose one valid company service." }); return; }
  res.set("Cache-Control", "no-store").json(await getServiceWatch(req.member!.organizationId, req.member!.user.id, id.data));
});
router.patch(detail, requireMember("crm.write"), async (req, res) => {
  if (req.get("x-api-key")) { res.status(403).json({ error: "Sign in as accepted staff to review the office plan." }); return; }
  const id = z.uuid().safeParse(req.params.id), command = serviceWatchCommand.safeParse(req.body);
  if (!id.success || !command.success) { res.status(400).json({ error: "Review the current exception, responsible staff and required office plan." }); return; }
  res.json(await updateServiceWatch(req.member!.organizationId, req.member!.user.id, id.data, command.data));
});
router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof ServiceWatchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
