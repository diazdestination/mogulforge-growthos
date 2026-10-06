import type { Request, Response, NextFunction } from "express";

/** CALLIE staff authority is a human session, never an API-key enrollment hook. */
export function callieHuman(req: Request, res: Response, next: NextFunction) {
  if (Object.prototype.hasOwnProperty.call(req.headers, "x-api-key")) { res.status(403).json({ error: "Sign in as accepted company staff.", code: "human_session_required" }); return; }
  if (["GET", "HEAD"].includes(req.method)) return next();
  let configuredOrigin: string | null = null;
  try { configuredOrigin = new URL(process.env.APP_ORIGIN ?? "").origin; } catch { /* Missing trusted origin fails closed. */ }
  const origin = req.get("origin"), site = req.get("sec-fetch-site"), bearer = /^Bearer \S+$/.test(req.get("authorization") ?? "");
  if (!configuredOrigin || (site && !["same-origin", "none"].includes(site)) || (origin !== undefined ? origin !== configuredOrigin : !bearer)) {
    res.status(403).json({ error: "Use the signed-in company application to review this action.", code: "human_approval_required" }); return;
  }
  if (!req.is("application/json")) { res.status(415).json({ error: "This action requires JSON.", code: "json_required" }); return; }
  next();
}
