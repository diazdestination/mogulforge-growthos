import type { Request, Response, NextFunction } from "express";
import { ScheduleError } from "../services/contractor-scheduling";

export function contractorMutation(req: Request, res: Response, next: NextFunction) {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.get("origin");
  if ((origin && origin !== process.env.APP_ORIGIN) || ["cross-site", "same-site"].includes(req.get("sec-fetch-site") ?? "")) {
    res.status(403).json({ error: "Origin is not allowed.", code: "origin_not_allowed" }); return;
  }
  if (req.method !== "DELETE" && !req.is("application/json")) {
    res.status(415).json({ error: "This change requires JSON.", code: "json_required" }); return;
  }
  next();
}

export function contractorScheduleError(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (error instanceof ScheduleError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  next(error);
}
