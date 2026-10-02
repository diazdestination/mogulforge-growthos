import { Router } from "express";
import { z } from "zod/v4";
import { requireMember } from "../../middlewares/requireMember";
import { contractorTodayQuery, ContractorTodayError, getContractorToday } from "../../services/contractor-today";

const router = Router();
router.get("/contractor/today", requireMember("crm.read"), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const query = contractorTodayQuery.parse(req.query);
    res.json(await getContractorToday(req.member!.organizationId, req.member!.user.id, query, undefined, req.member!.role));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: "Choose a valid calendar date and mine or company scope." }); return; }
    if (error instanceof ContractorTodayError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
});
export default router;
