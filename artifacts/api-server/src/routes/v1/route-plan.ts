import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { requireMember } from "../../middlewares/requireMember";
import { geocoderEnabled, getRoutePlan, locateDayStops, RoutePlanError } from "../../services/route-plan";

/** SCHED route plan: read for any member; filling in map locations writes property coordinates. */
const router: IRouter = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Choose a valid date." });
    return;
  }
  if (error instanceof RoutePlanError) {
    res.status(error.code === "not_found" ? 404 : 400).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: "Route plan request failed." });
}

router.get("/route-plan", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  try {
    const query = {
      date: typeof req.query.date === "string" ? req.query.date : "",
      ...(typeof req.query.userId === "string" && req.query.userId ? { userId: req.query.userId } : {}),
    };
    res.json({ ...(await getRoutePlan(req.member!.organizationId, req.member!.user.id, query)), geocoderEnabled: geocoderEnabled() });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/route-plan/locate", requireMember("crm.write"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await locateDayStops(req.member!.organizationId, req.member!.user.id, req.body ?? {}));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
