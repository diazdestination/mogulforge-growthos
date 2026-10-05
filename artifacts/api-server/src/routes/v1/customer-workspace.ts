import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { CustomerWorkspaceError, customerWorkspaceSectionQuerySchema } from "../../services/customer-workspace-contract";
import { getCustomerWorkspace, getCustomerWorkspaceAppointment, getCustomerWorkspaceSection } from "../../services/customer-workspace";

const router: IRouter = Router();
// Route-local: existing contact and appointment CRUD retain their own contracts.
const readGuard: RequestHandler = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  // Even an empty key must never reach the resolver's usage/rate-limit writes.
  if (req.headers["x-api-key"] !== undefined) {
    res.status(403).json({ code: "customer_workspace_staff_required", error: "Use your accepted active company staff session." });
    return;
  }
  const origin = req.header("origin"), site = req.header("sec-fetch-site");
  let trusted: string | null = null;
  try { trusted = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* No origin is authorized by missing configuration. */ }
  if ((origin !== undefined && origin !== trusted) || (site && !["same-origin", "none"].includes(site))) {
    res.status(403).json({ code: "customer_workspace_origin_required", error: "Open this record from your signed-in GrowthOS workspace." });
    return;
  }
  next();
};
const safe = (work: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    const user = req.member?.user;
    if (!req.user || req.user.id !== user?.id || !user.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:"))
      throw new CustomerWorkspaceError(403, "customer_workspace_staff_required", "Use your accepted active company staff session.");
    z.uuid().parse(req.params.id);
    res.json(await work(req));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ code: "customer_workspace_invalid_request", error: "Use the exact customer, section and page cursor. Other selectors are not accepted." });
      return;
    }
    if (error instanceof CustomerWorkspaceError) {
      res.status(error.status).json({ code: error.code, error: error.message });
      return;
    }
    res.status(503).json({ code: "customer_workspace_unavailable", error: "This record could not be read. Refresh the workspace before continuing." });
  }
};
const noQuery = z.object({}).strict();
router.get("/contacts/:id/workspace", readGuard, requireMember("crm.read"), safe(req => {
  noQuery.parse(req.query);
  const member = req.member!;
  return getCustomerWorkspace(member.organizationId, member.user.id, String(req.params.id), member.role);
}));
router.get("/contacts/:id/workspace/:section", readGuard, requireMember("crm.read"), safe(req => {
  const input = customerWorkspaceSectionQuerySchema.parse({ ...req.query, section: req.params.section });
  // Section is a path selector only, never a competing query selector.
  z.object({ cursor: z.unknown().optional() }).strict().parse(req.query);
  const member = req.member!;
  return getCustomerWorkspaceSection(member.organizationId, member.user.id, String(req.params.id), input, member.role);
}));
router.get("/appointments/:id", readGuard, requireMember("crm.read"), safe(req => {
  noQuery.parse(req.query);
  const member = req.member!;
  return getCustomerWorkspaceAppointment(member.organizationId, member.user.id, String(req.params.id), member.role);
}));
export default router;
