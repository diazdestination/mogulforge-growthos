import { z } from "zod/v4";
import type { AuditEvent } from "@workspace/db";
import {
  digestSchema,
  isoSchema,
  manualSchedulingAckSchema,
  manualSourceRefSchema,
  uuidSchema,
  type ManualSchedulingAck,
} from "@workspace/scheduling-core";

export const MANUAL_SCHEDULING_RECEIPT_ACTION =
  "scheduling.manual_operation.v1";
export const MANUAL_SCHEDULING_REFUSAL_ACTION =
  "scheduling.operation_refused.v1";
export const manualSchedulingRefusalCodeSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/);
export const manualSchedulingTargetSchema = z.strictObject({
  kind: z.enum(["appointment", "project"]),
  id: uuidSchema,
});

/** Private custody evidence. Never expose this row through ordinary audit lists. */
export const manualSchedulingReceiptSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: z.enum(["appointment_create", "project_create"]),
    source: manualSourceRefSchema,
    payloadSha256: digestSchema,
    outcome: z.enum(["committed", "no_commit_refused"]),
    target: manualSchedulingTargetSchema.nullable(),
    refusalCode: manualSchedulingRefusalCodeSchema.nullable(),
    recordedAt: isoSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.outcome === "committed"
        ? value.target === null || value.refusalCode !== null
        : value.target !== null || value.refusalCode === null
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid terminal receipt outcome",
      });
    if (
      value.target &&
      value.target.kind !==
        (value.kind === "appointment_create" ? "appointment" : "project")
    )
      ctx.addIssue({
        code: "custom",
        message: "Receipt target kind differs from command",
      });
  });
export type ManualSchedulingReceipt = z.infer<
  typeof manualSchedulingReceiptSchema
>;

/** Business refusal evidence carries no operation capability or payload hash. */
export const manualSchedulingBusinessRefusalSchema = z.strictObject({
  formatVersion: z.literal(1),
  source: manualSourceRefSchema,
  target: z.null(),
  reason: manualSchedulingRefusalCodeSchema,
  recordedAt: isoSchema,
});

/** Structural projection only; availability is supplied from a same-org lookup. */
export function projectManualSchedulingReceipt(
  row: AuditEvent,
  available: boolean,
): ManualSchedulingAck | null {
  if (row.action !== MANUAL_SCHEDULING_RECEIPT_ACTION) return null;
  const parsed = manualSchedulingReceiptSchema.safeParse(row.metadata);
  if (!parsed.success) return null;
  const receipt = parsed.data;
  if (
    row.entityType !==
      (receipt.kind === "appointment_create" ? "appointment" : "project") ||
    row.entityId !== (receipt.target?.id ?? null)
  )
    return null;
  const ack = manualSchedulingAckSchema.safeParse({
    operationId: row.id,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    kind: receipt.kind,
    source: receipt.source,
    payloadSha256: receipt.payloadSha256,
    outcome: receipt.outcome,
    target: receipt.target ? { ...receipt.target, available } : null,
    refusalCode: receipt.refusalCode,
  });
  return ack.success ? ack.data : null;
}
