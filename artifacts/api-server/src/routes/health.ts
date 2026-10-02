import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkReadiness } from "../lib/readiness";
import { releaseIdentity } from "../lib/release-identity";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ready = await checkReadiness();
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    database: ready ? "reachable" : "unavailable",
    release: releaseIdentity(),
  });
});

export default router;
