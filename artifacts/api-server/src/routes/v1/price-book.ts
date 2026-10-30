import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { requireMember } from "../../middlewares/requireMember";
import {
  createPriceBookItem,
  deletePriceBookItem,
  listPriceBookItems,
  PriceBookError,
  previewEstimateMargin,
  updatePriceBookItem,
} from "../../services/price-book";

/**
 * ESTI price book. Every member can read prices and preview margin on a draft;
 * changing the company's prices is settings authority.
 */
const router: IRouter = Router();
const itemId = z.string().uuid();

function fail(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid price book request", issues: error.issues.slice(0, 5) });
    return;
  }
  if (error instanceof PriceBookError) {
    res.status(error.code === "not_found" ? 404 : 409).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: "Price book request failed." });
}

router.get("/price-book/items", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  const includeInactive = req.query.includeInactive === "true";
  res.json({ items: await listPriceBookItems(req.member!.organizationId, { includeInactive }) });
});

router.post("/price-book/items", requireMember("settings.manage"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(201).json({ item: await createPriceBookItem(req.member!.organizationId, req.member!.user.id, req.body) });
  } catch (error) {
    fail(res, error);
  }
});

router.patch("/price-book/items/:id", requireMember("settings.manage"), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = itemId.parse(String(req.params.id));
    res.json({ item: await updatePriceBookItem(req.member!.organizationId, req.member!.user.id, id, req.body) });
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/price-book/items/:id", requireMember("settings.manage"), async (req: Request, res: Response): Promise<void> => {
  const id = itemId.safeParse(String(req.params.id));
  const deleted = id.success ? await deletePriceBookItem(req.member!.organizationId, req.member!.user.id, id.data) : false;
  if (!deleted) {
    res.status(404).json({ error: "Price book item not found." });
    return;
  }
  res.json({ deleted: true });
});

router.post("/price-book/margin-preview", requireMember("crm.read"), async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await previewEstimateMargin(req.member!.organizationId, req.body));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
