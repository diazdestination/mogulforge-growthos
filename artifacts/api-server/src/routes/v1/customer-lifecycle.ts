import { Router, type IRouter } from "express";
import { requireMember } from "../../middlewares/requireMember";
import { CustomerLifecycleError, getCustomerLifecycleStatus, transitionCustomerLifecycle } from "../../services/customer-lifecycle";
import { exportCustomerLifecycle } from "../../services/customer-lifecycle-export";

const router: IRouter = Router();
// Reject API-key authentication before its resolver or usage counters run.
router.use("/customer-lifecycle", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.headers["x-api-key"] !== undefined) { res.status(403).json({ error: "An owner or administrator session is required." }); return; }
  if (Object.keys(req.query).length) { res.status(400).json({ error: "Company selectors are not accepted." }); return; }
  // Exports and state reads also contain private company data. Credentialed
  // cross-origin reads must be rejected even when the session cookie is sent.
  // Server clients may omit Origin but still need an authenticated owner session.
  let allowedOrigin: string | undefined;
  try { allowedOrigin = new URL(process.env.APP_ORIGIN ?? process.env.APP_URL ?? "").origin; } catch { /* Unconfigured origins are not trusted. */ }
  if ((req.headers.origin && req.headers.origin !== allowedOrigin) || req.headers["sec-fetch-site"] === "cross-site") {
    res.status(403).json({ error: "This origin is not allowed." }); return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (!req.is("application/json")) { res.status(415).json({ error: "JSON is required." }); return; }
  }
  next();
});
const failure = (error: unknown, res: import("express").Response) => {
  if (error instanceof CustomerLifecycleError) res.status(error.status).json({ error: error.message, code: error.code });
  else res.status(503).json({ error: "Company lifecycle is unavailable. Refresh before trying another action.", code: "customer_lifecycle_unavailable" });
};
router.get("/customer-lifecycle", requireMember("settings.manage"), async (req, res) => {
  try { res.json(await getCustomerLifecycleStatus(req.member!.organizationId)); }
  catch (error) { failure(error, res); }
});
router.post("/customer-lifecycle/transition", requireMember("settings.manage"), async (req, res) => {
  try { res.json(await transitionCustomerLifecycle(req.member!.organizationId, req.member!.user.id, req.body)); }
  catch (error) { failure(error, res); }
});
router.get("/customer-lifecycle/export", requireMember("settings.manage"), async (req, res) => {
  try {
    const result = await exportCustomerLifecycle(req.member!.organizationId, req.member!.user.id);
    res.setHeader("Content-Disposition", `attachment; filename="growthos-core-export-${result.exportId}.json"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.json(result);
  } catch (error) { failure(error, res); }
});
export default router;
