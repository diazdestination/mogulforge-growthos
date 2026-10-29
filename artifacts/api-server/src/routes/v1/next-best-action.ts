import { Router } from "express";
import { requireMember } from "../../middlewares/requireMember";
import { listTodayActions } from "../../services/next-best-action";

const router = Router();

router.get("/next-best-action/today-actions", requireMember("crm.read"), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
  const actions = await listTodayActions(req.member!.organizationId, { limit });
  res.json({ actions });
});

export default router;
