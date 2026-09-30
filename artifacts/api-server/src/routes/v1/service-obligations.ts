import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireMember } from "../../middlewares/requireMember";
import {
  createServiceObligation,
  importServiceCustomers,
  listServiceObligations,
  updateServiceObligation,
} from "../../services/service-obligations";

const router: IRouter = Router();
const kind = z.enum(["warranty_check", "maintenance", "service_plan"]);
const date = z.string().trim().min(8).max(20);
const mapping = z.object({
  firstName: z.number().int().min(0).max(200).optional(),
  lastName: z.number().int().min(0).max(200).optional(),
  email: z.number().int().min(0).max(200).optional(),
  phone: z.number().int().min(0).max(200).optional(),
  equipmentLabel: z.number().int().min(0).max(200).optional(),
  kind: z.number().int().min(0).max(200).optional(),
  dueDate: z.number().int().min(0).max(200).optional(),
  externalRef: z.number().int().min(0).max(200).optional(),
  notes: z.number().int().min(0).max(200).optional(),
}).strict();

router.get("/service-obligations", requireMember("crm.read"), async (req, res) => {
  res.json(await listServiceObligations(req.member!.organizationId));
});

router.post("/service-obligations", requireMember("crm.write"), async (req, res) => {
  const parsed = z.object({
    contactId: z.uuid(),
    propertyId: z.uuid().nullable().optional(),
    kind,
    equipmentLabel: z.string().trim().min(1).max(160),
    dueDate: date,
    noticeDays: z.number().int().min(0).max(365).default(30),
    source: z.string().trim().min(1).max(80).optional(),
    externalRef: z.string().trim().max(160).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid service obligation" });
    return;
  }
  const result = await createServiceObligation(req.member!.organizationId, req.member!.user.id, parsed.data);
  if ("error" in result) {
    res.status(result.error.endsWith("not_found") ? 404 : 409).json(result);
    return;
  }
  res.status(201).json(result);
});

router.patch("/service-obligations/:id", requireMember("crm.write"), async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  const parsed = z.object({
    status: z.enum(["active", "completed", "cancelled"]).optional(),
    dueDate: date.optional(),
    appointmentId: z.uuid().nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!id.success || !parsed.success) {
    res.status(400).json({ error: "Invalid service obligation update" });
    return;
  }
  const result = await updateServiceObligation(req.member!.organizationId, req.member!.user.id, id.data, parsed.data);
  if ("error" in result) {
    res.status(result.error === "not_found" ? 404 : 409).json(result);
    return;
  }
  res.json(result);
});

router.post("/service-obligations/import", requireMember("crm.write"), async (req, res) => {
  const parsed = z.object({
    csv: z.string().min(1).max(5_000_000),
    mapping,
    hasHeader: z.boolean().default(true),
    source: z.string().trim().min(1).max(80).default("housecall-pro"),
    defaultKind: kind.optional(),
    defaultEquipmentLabel: z.string().trim().min(1).max(160).optional(),
    noticeDays: z.number().int().min(0).max(365).default(30),
    /** Preview is the default; committing customer records requires explicit true. */
    commit: z.literal(true).optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid customer/service CSV import" });
    return;
  }
  const result = await importServiceCustomers(req.member!.organizationId, req.member!.user.id, {
    ...parsed.data,
    commit: parsed.data.commit === true,
  });
  if ("error" in result) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

export default router;
