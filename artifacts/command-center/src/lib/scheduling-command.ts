import { z } from "zod";
import { ApiError } from "@workspace/api-client-react";
import {
  canonicalSchedulingEnvelope,
  digestSchema,
  isoSchema,
  manualSchedulingAckSchema,
  manualSchedulingCommandSchema,
  manualSourceRefSchema,
  reservationSnapshotSchema,
  schedulingReviewContextSchema,
  userIdSchema,
  uuidSchema,
  type ManualSchedulingAck,
  type ManualSchedulingCommand,
  type ManualSourceRef,
  type SchedulingReviewContext,
} from "@workspace/scheduling-core";
import { ManualSchedulingErrorSchema } from "../../../../lib/api-zod/src/generated/api";
import type {
  IntervalInput,
  SchedulingDraft,
  SchedulingProposalView,
  SchedulingScope,
} from "./scheduling-ui-contract";

export function manualSchedulingSourceKey(source: ManualSourceRef): string {
  const s = manualSourceRefSchema.parse(source);
  return JSON.stringify([
    s.sourceKind,
    s.leadId,
    s.contactId,
    s.propertyId,
    s.estimateId,
  ]);
}
export function freezeSchedulingValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSchedulingValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Browser-safe counterpart of the native receipt's pure original binding.
 * The server module also imports DB/Node code and cannot be loaded by the UI. */
export function freezeManualSchedulingCommand(
  original: unknown,
  scope: SchedulingScope,
  kind: ManualSchedulingCommand["kind"],
  sourceKey: string,
): ManualSchedulingCommand {
  uuidSchema.parse(scope.organizationId);
  userIdSchema.parse(scope.actorUserId);
  const c = manualSchedulingCommandSchema.parse(original);
  const s = c.review.context.source;
  if (
    !s ||
    c.kind !== kind ||
    c.review.context.organizationId !== scope.organizationId ||
    manualSchedulingSourceKey(s) !== sourceKey
  )
    throw new Error("Command scope does not match");
  if (c.kind === "project_create") {
    if (
      s.sourceKind !== "lead" ||
      s.leadId !== c.body.leadId ||
      s.estimateId !== (c.body.estimateId ?? null)
    )
      throw new Error("Project source does not match");
  } else {
    const b = c.body;
    if (
      b.leadId !== undefined
        ? s.sourceKind !== "lead" ||
          s.leadId !== b.leadId ||
          (b.contactId !== undefined && s.contactId !== b.contactId)
        : b.contactId !== undefined
          ? s.sourceKind !== "direct_customer" || s.contactId !== b.contactId
          : s.sourceKind !== "unlinked_manual"
    )
      throw new Error("Appointment source does not match");
    if (s.propertyId !== (b.propertyId ?? null))
      throw new Error("Property does not match");
  }
  // Validate BEFORE serialization: Dates must never be silently coerced to strings.
  return freezeSchedulingValue(
    JSON.parse(JSON.stringify(c)) as ManualSchedulingCommand,
  );
}
export async function manualSchedulingHash(
  command: ManualSchedulingCommand,
  scope: SchedulingScope,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalSchedulingEnvelope({
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      kind: command.kind,
      body: command.body,
      review: command.review,
    }),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
function boundAck(
  value: unknown,
  command: ManualSchedulingCommand,
  scope: SchedulingScope,
  hash: string,
): ManualSchedulingAck | null {
  const parsed = manualSchedulingAckSchema.safeParse(value);
  if (!parsed.success) return null;
  const a = parsed.data;
  return a.operationId === command.operationId &&
    a.organizationId === scope.organizationId &&
    a.actorUserId === scope.actorUserId &&
    a.kind === command.kind &&
    a.payloadSha256 === hash &&
    manualSchedulingSourceKey(a.source) ===
      manualSchedulingSourceKey(command.review.context.source!)
    ? freezeSchedulingValue(a)
    : null;
}
export function manualSchedulingAckFor(
  value: unknown,
  mode: "dispatch" | "reconcile",
  command: ManualSchedulingCommand,
  scope: SchedulingScope,
  hash: string,
): ManualSchedulingAck | null {
  if (value instanceof ApiError) {
    if (value.status !== 409) return null;
    const parsed = ManualSchedulingErrorSchema.safeParse(value.data);
    if (!parsed.success) return null;
    const a = boundAck(parsed.data.schedulingOperation, command, scope, hash);
    if (
      !a ||
      (parsed.data.code === "manual_scheduling_refused"
        ? a.outcome !== "no_commit_refused"
        : a.outcome !== "committed" || a.target?.available !== false)
    )
      return null;
    return a;
  }
  return boundAck(
    mode === "reconcile"
      ? value
      : value && typeof value === "object" && "schedulingOperation" in value
        ? value.schedulingOperation
        : null,
    command,
    scope,
    hash,
  );
}

const custodySchema = z.strictObject({
  formatVersion: z.literal(1),
  organizationId: uuidSchema,
  actorUserId: userIdSchema,
  kind: z.enum(["appointment_create", "project_create"]),
  sourceKey: z.string(),
  command: manualSchedulingCommandSchema,
  payloadSha256: digestSchema,
  ack: manualSchedulingAckSchema.nullable(),
  refusalAcknowledged: z.boolean(),
  retiredOperationIds: z.array(uuidSchema),
});
export type ManualSchedulingCustody = z.infer<typeof custodySchema>;
export async function parseManualSchedulingCustody(
  bytes: string,
  scope: SchedulingScope,
  kind: ManualSchedulingCommand["kind"],
  sourceKey: string,
): Promise<ManualSchedulingCustody> {
  const saved = custodySchema.parse(JSON.parse(bytes));
  if (
    saved.organizationId !== scope.organizationId ||
    saved.actorUserId !== scope.actorUserId ||
    saved.kind !== kind ||
    saved.sourceKey !== sourceKey
  )
    throw new Error("Stored scope does not match");
  const command = freezeManualSchedulingCommand(
    saved.command,
    scope,
    kind,
    sourceKey,
  );
  if ((await manualSchedulingHash(command, scope)) !== saved.payloadSha256)
    throw new Error("Stored hash does not match");
  if (saved.ack && !boundAck(saved.ack, command, scope, saved.payloadSha256))
    throw new Error("Stored acknowledgement does not match");
  if (saved.refusalAcknowledged && saved.ack?.outcome !== "no_commit_refused")
    throw new Error("No refusal to acknowledge");
  if (
    new Set(saved.retiredOperationIds).size !==
      saved.retiredOperationIds.length ||
    saved.retiredOperationIds.includes(command.operationId)
  )
    throw new Error("Stored operation history is invalid");
  return freezeSchedulingValue({ ...saved, command });
}

const draftSchema = z.strictObject({
  startAt: isoSchema.nullable(),
  endAt: isoSchema.nullable(),
  resourceUserIds: z.array(userIdSchema),
});
const intervalSchema = z.strictObject({
  startAt: isoSchema.nullable(),
  endAt: isoSchema.nullable(),
  legacyEffectiveEnd: isoSchema.nullable(),
  reservation: reservationSnapshotSchema.nullable(),
  evidence: z.enum(["legacy", "versioned", "invalid"]),
});
export function buildSchedulingProposalView(args: {
  context: SchedulingReviewContext;
  interval: IntervalInput;
  draft: SchedulingDraft;
  transition: "admission" | "release" | "preserve";
}): SchedulingProposalView | null {
  try {
    const context = schedulingReviewContextSchema.parse(args.context);
    const interval = intervalSchema.parse(args.interval),
      draft = draftSchema.parse(args.draft);
    if (
      interval.evidence === "invalid" ||
      (interval.evidence === "versioned") !== (interval.reservation !== null)
    )
      return null;
    if (!["admission", "release", "preserve"].includes(args.transition))
      return null;
    const admission = args.transition === "admission";
    // A legacy effective end explains the recorded range only. Never put it in a draft.
    const endAt =
      draft.endAt ??
      (!admission &&
      draft.startAt === interval.startAt &&
      interval.endAt === null &&
      interval.evidence === "legacy"
        ? interval.legacyEffectiveEnd
        : null);
    if (
      !draft.startAt ||
      !endAt ||
      Date.parse(endAt) <= Date.parse(draft.startAt)
    )
      return null;
    const saved = interval.reservation;
    if (!admission) {
      if (
        !interval.startAt ||
        Date.parse(draft.startAt) !== Date.parse(interval.startAt) ||
        Date.parse(endAt) !==
          Date.parse(interval.endAt ?? interval.legacyEffectiveEnd ?? "")
      )
        return null;
      if (
        saved &&
        (Date.parse(saved.startAt) !== Date.parse(interval.startAt) ||
          Date.parse(saved.endAt) !== Date.parse(endAt) ||
          draft.resourceUserIds.some(
            (id) => !saved.resourceUserIds.includes(id),
          ) ||
          (args.transition === "preserve" &&
            saved.resourceUserIds.some(
              (id) => !draft.resourceUserIds.includes(id),
            )))
      )
        return null;
    }
    const retained = {
      kind: "held" as const,
      message:
        "Recorded work is retained; no new capacity admission is requested.",
    };
    const gate = (ceiling: number | null) => ({
      kind: ceiling === null ? ("not_configured" as const) : ("held" as const),
      message: ceiling === null ? null : "Rechecked when saving",
    });
    return {
      basis: admission
        ? "new_admission"
        : args.transition === "release"
          ? "saved_release"
          : "saved_preservation",
      startAt: draft.startAt,
      endAt,
      resourceUserIds: [...draft.resourceUserIds],
      appliedTravelGapMinutes: admission
        ? context.applicableRules.newTravelGapMinutes
        : (saved?.minimumTravelGapMinutes ?? 0),
      companyCeiling: admission ? context.applicableRules.companyCeiling : null,
      inspectionCeiling: admission
        ? context.applicableRules.inspectionCeiling
        : null,
      companyGate: admission
        ? gate(context.applicableRules.companyCeiling)
        : { ...retained },
      inspectionGate: admission
        ? gate(context.applicableRules.inspectionCeiling)
        : { ...retained },
    };
  } catch {
    return null;
  }
}
