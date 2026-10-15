import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import { contractorMutation, contractorScheduleError } from "../../middlewares/contractor-mutation";
import { approveServiceCare, bookServiceCareVisit, getServiceCare, recordServiceCareResponse, ServiceCareError } from "../../services/service-care";
import { approveServiceCareSchema, serviceCareBookingSchema, serviceCareResponseSchema } from "../../services/service-care-policy";

const router: IRouter = Router();
const base = "/service-obligations/:id/care";
router.use([base, `${base}/reminder`, `${base}/response`, `${base}/book`], contractorMutation);
router.get(base, requireMember("crm.read"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  const query = z.object({ channel: z.enum(["email", "sms"]).optional(), appointmentType: z.enum(["inspection", "other"]).optional() }).strict().safeParse(req.query);
  if (!id.success || !query.success) { res.status(400).json({ error: "Choose a valid service and channel." }); return; }
  res.set("Cache-Control", "no-store");
  res.json(await getServiceCare(req.member!.organizationId, id.data, query.data.channel, { actorUserId: req.member!.user.id, appointmentType: query.data.appointmentType }));
});
for (const [suffix, schema, work] of [
  ["reminder", approveServiceCareSchema, approveServiceCare],
  ["response", serviceCareResponseSchema, recordServiceCareResponse],
  ["book", serviceCareBookingSchema, bookServiceCareVisit],
] as const) {
  router.post(`${base}/${suffix}`, requireMember("crm.write"), async (req, res) => {
    // These are named human approvals/attestations, not an automation API.
    if (req.get("x-api-key")) { res.status(403).json({ error: "Sign in as an accepted staff member to review this customer action." }); return; }
    const id = z.uuid().safeParse(req.params.id), parsed = schema.safeParse(req.body);
    if (!id.success || !parsed.success) { res.status(400).json({ error: "Review the required service-care details and confirmations." }); return; }
    res.json(await work(req.member!.organizationId, req.member!.user.id, id.data, parsed.data));
  });
}
router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof ServiceCareError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  next(error);
});
router.use(contractorScheduleError);
export default router;
