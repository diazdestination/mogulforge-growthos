import { Router, type IRouter } from "express";
import { getDataLifecycleInventory } from "../../services/data-lifecycle-inventory";
import { requireDataLifecycleInventoryMember } from "../../services/data-lifecycle-inventory-session";

const router: IRouter = Router();
router.get("/data-lifecycle/inventory", requireDataLifecycleInventoryMember, async (req, res) => {
  if (Object.keys(req.query).length || (req.body !== undefined && (typeof req.body !== "object" || req.body === null || Object.keys(req.body).length))) {
    res.status(400).json({ error: "Inventory does not accept request selectors" });
    return;
  }
  try {
    // A platform-admin flag/Launchpad selection confers no alternate tenant.
    const inventory = await getDataLifecycleInventory(req.dataLifecycleInventoryMember!.organizationId);
    res.status(inventory.status === "blocked" ? 409 : 200).json(inventory);
  } catch {
    res.status(503).json({ error: "Data lifecycle inventory is unavailable", code: "inventory_unavailable" });
  }
});

export default router;
