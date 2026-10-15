import { z } from "zod/v4";
import { auditEventsTable, db, type AuditEvent } from "@workspace/db";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ScheduleTransaction } from "./contractor-scheduling";
import { CustomerWorkError } from "./returning-customer-contract";
import {
  schedulingTransitionSchema,
  SCHEDULING_TRANSITION_ACTION,
} from "./scheduling-admission";
import {
  serviceCareBookingSchema,
  careFingerprint,
} from "./service-care-policy";
import {
  callieBookingSchema,
  canonicalCallieBookingInput,
} from "./callie-office-contract";
import { normalizeInspectionAvailability } from "./settings";
import {
  digestSchema,
  isoSchema,
  manualSchedulingAckSchema,
  manualSourceRefSchema,
  uuidSchema,
  userIdSchema,
  timeZoneSchema,
  durationChoiceSchema,
  schedulingPolicySchema,
  schedulingMutationReviewSchema,
  reservationSnapshotSchema,
  type SchedulingPolicy,
  type ReservationSnapshot,
  type ManualSourceRef,
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

// Business presentation is deliberately separate from the custody acknowledgement above.
export { closedPolicyExportSchema, closedReservationExportSchema, closedBusinessSchedulingSummarySchema } from "@workspace/scheduling-core";
import { closedPolicyExportSchema, closedReservationExportSchema, closedBusinessSchedulingSummarySchema, type ClosedPolicyExport, type ClosedReservationExport, type ClosedBusinessSchedulingSummary } from "@workspace/scheduling-core";
export type { ClosedPolicyExport, ClosedReservationExport, ClosedBusinessSchedulingSummary } from "@workspace/scheduling-core";
export type SchedulingProjectionContext = {
  organizationId: string;
  authorizedHistoricalLinks: Set<string>;
  availableTargets: Set<string>;
};
type RecordRow = Record<string, unknown>;
export type SchedulingHistoryEvidence = {
  context: SchedulingProjectionContext;
  events: AuditEvent[];
  commands: RecordRow[];
};
const policyActions = [
  "scheduling.policy_saved",
  "scheduling.inspection_changed",
  "scheduling.company_timezone_changed",
];
const sourceActions = [
  "service.care_visit_booked",
  "voice.callie.visit_booked",
  "customer_work.project_created",
  "customer_work.project_updated",
  "appointment.booked_concierge",
];
const nativeActions = [
  "appointment.created",
  "appointment.updated",
  "project.created",
  "project.updated",
  "project.status_changed",
];
export const SCHEDULING_DELETION_ACTION = "scheduling.reservation_deleted.v1";
export const SCHEDULING_HISTORY_ACTIONS = [
  ...policyActions,
  SCHEDULING_TRANSITION_ACTION,
  SCHEDULING_DELETION_ACTION,
  MANUAL_SCHEDULING_RECEIPT_ACTION,
  ...sourceActions,
];
const knownActions = [
  ...SCHEDULING_HISTORY_ACTIONS,
  MANUAL_SCHEDULING_REFUSAL_ACTION,
  ...nativeActions,
];
export const schedulingDeletionSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    target: manualSchedulingTargetSchema,
    source: manualSourceRefSchema.nullable(),
    before: reservationSnapshotSchema.nullable(),
    after: z.null(),
    rawInvalidEvidence: z.unknown(),
    invalidHistoricalEvidenceRetained: z.boolean(),
    recordedAt: isoSchema,
  })
  .superRefine((m, c) => {
    if (
      m.invalidHistoricalEvidenceRetained
        ? m.before !== null || m.rawInvalidEvidence == null
        : m.rawInvalidEvidence !== null
    )
      c.addIssue({
        code: "custom",
        message: "Invalid retained deletion evidence",
      });
  });
const policyAuditSchema = z.strictObject({
  previousPolicy: schedulingPolicySchema.nullable(),
  policy: schedulingPolicySchema,
});
const conciergeOfferSchema = z.strictObject({
  formatVersion: z.literal(1),
  organizationId: uuidSchema,
  conversationId: uuidSchema,
  appointmentId: uuidSchema,
  label: z.string().min(1).max(500),
  start: isoSchema,
  end: isoSchema,
  source: manualSourceRefSchema,
  sourceFingerprint: digestSchema,
  review: schedulingMutationReviewSchema,
});
const conciergeAuditSchema = z.strictObject({
  conversationId: uuidSchema,
  leadId: uuidSchema.nullable(),
  offer: conciergeOfferSchema,
});
// The original returning-command contract accepts and preserves UUID casing.
const returningRequestIdSchema = z.uuid();
const returningAuditSchema = z.strictObject({
  requestId: returningRequestIdSchema,
  customerWorkId: uuidSchema,
  workVersion: z.number().int().positive(),
  staffRecorded: z.literal(true),
  providerEffect: z.literal(false),
});
const returningCommandSchema = z.object({
  organizationId: uuidSchema,
  actorUserId: userIdSchema,
  requestId: uuidSchema,
  action: z.enum(["project_created", "project_updated"]),
  payloadSha256: digestSchema,
  customerWorkId: uuidSchema,
  projectId: uuidSchema,
  estimateId: z.null(),
  resultVersion: z.number().int().positive(),
});
const key = (kind: string, id: string) => `${kind}:${id}`;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");
export function projectSchedulingPolicyExport(
  policy: SchedulingPolicy | null,
): ClosedPolicyExport | null {
  if (policy === null) return null;
  const p = schedulingPolicySchema.safeParse(policy);
  if (!p.success) return null;
  const { digest: _, updatedByUserId: __, ...closed } = p.data;
  return closedPolicyExportSchema.parse(closed);
}
/** Validate current policy provenance with the exact captured organization/settings snapshot. */
export function projectCurrentSchedulingPolicy(
  raw: unknown,
  zone: unknown,
  inspection: unknown,
) {
  if (raw == null) return { policy: null, state: "unconfigured" as const };
  const parsed = schedulingPolicySchema.safeParse(raw);
  if (!parsed.success || parsed.data.timeZone !== zone)
    return { policy: null, state: "invalid" as const };
  const effective = normalizeInspectionAvailability(inspection);
  const sourceState =
    inspection == null
      ? "legacy_default"
      : same(inspection, effective)
        ? "recorded"
        : "legacy_normalized";
  const context = {
    ruleTimeZone: effective.timezone,
    sourceState,
    availabilityDigest: hash({ effective, sourceState, companyTimeZone: zone }),
  };
  const { digest, ...content } = parsed.data;
  if (
    !Number.isSafeInteger(effective.maxBookingsPerWindow) ||
    effective.maxBookingsPerWindow < 1 ||
    digest !==
      hash({
        policy: content,
        inspection: context,
        effectiveInspection: effective,
      })
  )
    return { policy: null, state: "invalid" as const };
  return {
    policy: projectSchedulingPolicyExport(parsed.data),
    state: "versioned" as const,
  };
}
export function projectReservationExport(
  snapshot: ReservationSnapshot | null,
  authorizedHistoricalLinks: Set<string>,
): ClosedReservationExport | null {
  if (snapshot === null) return null;
  const p = reservationSnapshotSchema.safeParse(snapshot);
  if (!p.success) return null;
  const s = p.data;
  if (
    !authorizedHistoricalLinks.has(key(s.target.kind, s.target.id)) ||
    s.resourceUserIds.some(
      (id) => !authorizedHistoricalLinks.has(key("user", id)),
    )
  )
    return null;
  return closedReservationExportSchema.parse({
    reservationRevision: s.reservationRevision,
    approvedTimeZone: s.approvedTimeZone,
    inspection: s.inspection
      ? { ruleTimeZone: s.inspection.ruleTimeZone }
      : null,
    startAt: s.startAt,
    endAt: s.endAt,
    resourceUserIds: s.resourceUserIds,
    minimumTravelGapMinutes: s.minimumTravelGapMinutes,
    duration: s.duration,
    target: s.target,
  });
}
type Target = z.infer<typeof manualSchedulingTargetSchema>;
type Proof = {
  event: ClosedBusinessSchedulingSummary["event"];
  time: string;
  target: Target | null;
  source: ManualSourceRef | null;
  before: ReservationSnapshot | SchedulingPolicy | null;
  after: ReservationSnapshot | SchedulingPolicy | null;
  reason: string | null;
  origin?: string;
  sourceId?: string | null;
  start?: string;
  end?: string;
  invalid?: boolean;
};
function bound(event: AuditEvent, target: Target) {
  return event.entityType === target.kind && event.entityId === target.id;
}
function snapshotBound(snapshot: ReservationSnapshot | null, target: Target) {
  return snapshot === null || same(snapshot.target, target);
}
function occurredAt(event: AuditEvent) {
  const date = new Date(event.createdAt);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function originalProof(
  event: AuditEvent,
  evidence?: SchedulingHistoryEvidence,
): Proof | null {
  if (
    !uuidSchema.safeParse(event.organizationId).success ||
    !uuidSchema.safeParse(event.id).success
  )
    return null;
  const time = occurredAt(event);
  if (!time) return null;
  const base = {
    time,
    target: null,
    source: null,
    before: null,
    after: null,
    reason: null,
  } as const;
  if (policyActions.includes(event.action)) {
    const p = policyAuditSchema.safeParse(event.metadata);
    if (
      !p.success ||
      event.entityType !== "org_settings" ||
      event.entityId !== event.organizationId ||
      p.data.policy.updatedByUserId !== event.actorUserId
    )
      return null;
    return {
      ...base,
      event: "policy_updated",
      before: p.data.previousPolicy,
      after: p.data.policy,
    };
  }
  if (event.action === MANUAL_SCHEDULING_RECEIPT_ACTION) {
    const ack = projectManualSchedulingReceipt(event, false);
    if (!ack) return null;
    const m = manualSchedulingReceiptSchema.parse(event.metadata);
    return {
      ...base,
      event:
        ack.outcome === "committed"
          ? "operation_committed"
          : "operation_refused",
      time: m.recordedAt,
      target: m.target,
      source: m.source,
      reason: m.refusalCode,
      origin: "manual",
      sourceId: null,
    };
  }
  if (event.action === MANUAL_SCHEDULING_REFUSAL_ACTION) {
    const p = manualSchedulingBusinessRefusalSchema.safeParse(event.metadata);
    if (
      !p.success ||
      !["appointment", "project"].includes(event.entityType) ||
      event.entityId !== null ||
      !userIdSchema.safeParse(event.actorUserId).success
    )
      return null;
    return {
      ...base,
      event: "operation_refused",
      time: p.data.recordedAt,
      source: p.data.source,
      reason: p.data.reason,
    };
  }
  if (event.action === SCHEDULING_TRANSITION_ACTION) {
    const p = schedulingTransitionSchema.safeParse(event.metadata);
    if (
      !p.success ||
      !bound(event, p.data.target) ||
      !snapshotBound(p.data.before, p.data.target) ||
      !snapshotBound(p.data.after, p.data.target)
    )
      return null;
    const m = p.data;
    return {
      ...base,
      event:
        m.transition === "release"
          ? "reservation_released"
          : "reservation_admitted",
      time: m.recordedAt,
      target: m.target,
      source: m.source,
      before: m.before,
      after: m.after,
      reason: m.invalidHistoricalEvidenceRetained
        ? "invalid_historical_evidence"
        : m.transition === "preserve"
          ? "reservation_preserved"
          : null,
      invalid: m.invalidHistoricalEvidenceRetained,
    };
  }
  if (event.action === SCHEDULING_DELETION_ACTION) {
    const p = schedulingDeletionSchema.safeParse(event.metadata);
    if (
      !p.success ||
      event.actorUserId !== null ||
      !bound(event, p.data.target) ||
      !snapshotBound(p.data.before, p.data.target)
    )
      return null;
    return {
      ...base,
      event: "reservation_deleted",
      time: p.data.recordedAt,
      target: p.data.target,
      source: p.data.source,
      before: p.data.before,
      reason: p.data.invalidHistoricalEvidenceRetained
        ? "invalid_historical_evidence"
        : null,
      invalid: p.data.invalidHistoricalEvidenceRetained,
    };
  }
  if (
    event.action === "service.care_visit_booked" ||
    event.action === "voice.callie.visit_booked"
  ) {
    const {
      requestFingerprint,
      appointmentId,
      evidence: attestation,
      noAutomaticResend,
      ...body
    } = raw(event.metadata);
    const callie = event.action === "voice.callie.visit_booked";
    const p = (
      callie ? callieBookingSchema : serviceCareBookingSchema
    ).safeParse(body);
    if (
      !p.success ||
      !uuidSchema.safeParse(event.entityId).success ||
      event.entityType !== (callie ? "callie_intake" : "service_obligation") ||
      !userIdSchema.safeParse(event.actorUserId).success ||
      !uuidSchema.safeParse(appointmentId).success ||
      attestation !==
        (callie
          ? "staff_attested_exact_customer_confirmation"
          : "staff_attested_customer_confirmation") ||
      (callie ? noAutomaticResend !== true : noAutomaticResend !== undefined)
    )
      return null;
    const fingerprint = callie
      ? createHash("sha256")
          .update(canonicalCallieBookingInput(p.data))
          .digest("hex")
      : careFingerprint(p.data);
    if (requestFingerprint !== fingerprint) return null;
    const review = p.data.schedulingReview;
    if (
      review &&
      (review.context.organizationId !== event.organizationId ||
        review.context.targetVersion !== null ||
        review.context.targetFingerprint !== null)
    )
      return null;
    let source = review?.context.source ?? null;
    if (callie) {
      const original = callieBookingSchema.parse(body);
      const expected = {
        sourceKind: original.leadId ? "lead" : "direct_customer",
        leadId: original.leadId,
        contactId: original.contactId,
        propertyId: original.propertyId,
        estimateId: null,
      };
      if (source && !same(source, expected)) return null;
      source = manualSourceRefSchema.parse(expected);
    }
    return {
      ...base,
      event: "operation_committed",
      target: { kind: "appointment", id: appointmentId as string },
      source,
      origin: callie ? "callie" : "service_care",
      sourceId: event.entityId,
      start: p.data.scheduledStart,
      end: p.data.scheduledEnd,
    };
  }
  if (event.action === "appointment.booked_concierge") {
    const p = conciergeAuditSchema.safeParse(event.metadata);
    if (!p.success) return null;
    const { offer } = p.data;
    const target = { kind: "appointment" as const, id: offer.appointmentId };
    if (
      event.actorUserId !== null ||
      !bound(event, target) ||
      offer.organizationId !== event.organizationId ||
      p.data.conversationId !== offer.conversationId ||
      p.data.leadId !== offer.source.leadId ||
      offer.review.context.organizationId !== event.organizationId ||
      !same(offer.review.context.source, offer.source) ||
      offer.review.context.targetVersion !== null ||
      offer.review.context.targetFingerprint !== null
    )
      return null;
    return {
      ...base,
      event: "operation_committed",
      target,
      source: offer.source,
      origin: "concierge",
      sourceId: offer.conversationId,
      start: offer.start,
      end: offer.end,
    };
  }
  if (
    event.action === "customer_work.project_created" ||
    event.action === "customer_work.project_updated"
  ) {
    const p = returningAuditSchema.safeParse(event.metadata);
    if (
      !p.success ||
      event.entityType !== "project" ||
      !uuidSchema.safeParse(event.entityId).success
    )
      return null;
    // Canonicalize only this internal UUID join key, never original metadata/body
    // or case-sensitive actor IDs. PostgreSQL stores request_id in UUID form.
    const requestId = p.data.requestId.toLowerCase();
    const matches = (evidence?.commands ?? [])
      .filter((c) => c.requestId === requestId)
      .map((c) => returningCommandSchema.safeParse(c))
      .filter(
        (c) =>
          c.success &&
          c.data.organizationId === event.organizationId &&
          c.data.actorUserId === event.actorUserId &&
          c.data.requestId === requestId &&
          `customer_work.${c.data.action}` === event.action &&
          c.data.projectId === event.entityId &&
          c.data.customerWorkId === p.data.customerWorkId &&
          c.data.resultVersion === p.data.workVersion,
      );
    if (matches.length !== 1) return null;
    return {
      ...base,
      event: "operation_committed",
      target: { kind: "project", id: event.entityId! },
      origin: "returning_command",
      sourceId: requestId,
    };
  }
  return null;
}
function withOriginalTransition(
  event: AuditEvent,
  p: Proof,
  evidence?: SchedulingHistoryEvidence,
): Proof {
  if (!p.origin || !p.target || !evidence) return p;
  const matches = evidence.events
    .filter(
      (e) =>
        e.action === SCHEDULING_TRANSITION_ACTION &&
        e.organizationId === event.organizationId &&
        e.actorUserId === event.actorUserId &&
        e.entityType === p.target!.kind &&
        e.entityId === p.target!.id,
    )
    .flatMap((e) => {
      const m = schedulingTransitionSchema.safeParse(e.metadata);
      if (
        !m.success ||
        !bound(e, m.data.target) ||
        !same(m.data.target, p.target) ||
        m.data.origin !== p.origin ||
        m.data.sourceId !== p.sourceId ||
        !snapshotBound(m.data.before, p.target!) ||
        !snapshotBound(m.data.after, p.target!) ||
        (p.source && !same(m.data.source, p.source))
      )
        return [];
      if (p.origin !== "returning_command" && m.data.before !== null) return [];
      if (
        m.data.after &&
        ((p.start &&
          new Date(m.data.after.startAt).getTime() !==
            new Date(p.start).getTime()) ||
          (p.end &&
            new Date(m.data.after.endAt).getTime() !==
              new Date(p.end).getTime()))
      )
        return [];
      return [m.data];
    });
  if (matches.length !== 1) return p;
  return {
    ...p,
    source: p.source ?? matches[0].source,
    before: matches[0].before,
    after: matches[0].after,
  };
}
function projection(
  event: AuditEvent,
  context?: SchedulingProjectionContext,
  evidence?: SchedulingHistoryEvidence,
) {
  let p = originalProof(event, evidence);
  if (!p || (context && context.organizationId !== event.organizationId))
    return { summary: null, invalidLinks: false, invalidRecord: true };
  p = withOriginalTransition(event, p, evidence);
  const links = context?.authorizedHistoricalLinks ?? new Set<string>();
  let invalidLinks = false;
  const target =
    p.target && links.has(key(p.target.kind, p.target.id))
      ? {
          ...p.target,
          available:
            context?.availableTargets.has(key(p.target.kind, p.target.id)) ??
            false,
        }
      : null;
  if (p.target && !target) invalidLinks = true;
  const source =
    p.source &&
    Object.entries(p.source).every(
      ([field, id]) =>
        field === "sourceKind" ||
        id === null ||
        links.has(key(field.slice(0, -2), id)),
    )
      ? p.source
      : null;
  if (p.source && !source) invalidLinks = true;
  const project = (value: ReservationSnapshot | SchedulingPolicy | null) => {
    if (value === null) return null;
    if ("reservationRevision" in value) {
      const result = projectReservationExport(value, links);
      if (!result) invalidLinks = true;
      return result;
    }
    return projectSchedulingPolicyExport(value);
  };
  const before = project(p.before),
    after = project(p.after);
  const summary = closedBusinessSchedulingSummarySchema.parse({
    event: p.event,
    occurredAt: p.time,
    target,
    source,
    before,
    after,
    reasonCode: p.reason,
  });
  return { summary, invalidLinks, invalidRecord: false };
}
export function projectSchedulingAudit(
  event: AuditEvent,
  context?: SchedulingProjectionContext,
): ClosedBusinessSchedulingSummary | null {
  return projection(event, context).summary;
}
export function projectSchedulingHistory(evidence: SchedulingHistoryEvidence) {
  const summaries: ClosedBusinessSchedulingSummary[] = [];
  let withheldInvalidLinks = 0,
    withheldInvalidRecords = 0;
  for (const event of evidence.events.filter((e) =>
    SCHEDULING_HISTORY_ACTIONS.includes(e.action),
  )) {
    const p = projection(event, evidence.context, evidence);
    if (p.summary) summaries.push(p.summary);
    if (p.invalidLinks) withheldInvalidLinks++;
    if (p.invalidRecord) withheldInvalidRecords++;
  }
  return {
    summaries,
    coverage: {
      count: summaries.length,
      withheldInvalidLinks,
      withheldInvalidRecords,
    },
  };
}

/** SQL is fixed by this module/caller; parameters remain bound on the original transaction. */
export function schedulingEvidenceSql(text: string, values: unknown[]) {
  const parts = text.split(/(\$\d+)/g);
  return sql.join(
    parts.map((part) =>
      /^\$\d+$/.test(part)
        ? sql`${sql.param(values[Number(part.slice(1)) - 1])}`
        : sql.raw(part),
    ),
    sql``,
  );
}
export type SchedulingEvidenceQuery = (
  text: string,
  values: unknown[],
) => Promise<RecordRow[]>;
const raw = (value: unknown): RecordRow =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordRow)
    : {};
const sourceFields = ["contactId", "leadId", "propertyId", "estimateId"];
function originalSources(m: RecordRow) {
  return [
    m.source,
    raw(m.review).context && raw(raw(m.review).context).source,
    raw(raw(m.schedulingReview).context).source,
    raw(m.offer).source,
    raw(raw(raw(m.offer).review).context).source,
    m,
  ];
}
function candidateLinks(events: AuditEvent[], snapshots: unknown[]) {
  const candidates = new Map<string, Set<string>>();
  const add = (kind: string, id: unknown) => {
    if (typeof id !== "string") return;
    const set = candidates.get(kind) ?? new Set<string>();
    set.add(id);
    candidates.set(kind, set);
  };
  const snapshot = (value: unknown) => {
    const s = raw(value),
      t = raw(s.target);
    if (t.kind === "appointment" || t.kind === "project") add(t.kind, t.id);
    if (Array.isArray(s.resourceUserIds))
      for (const id of s.resourceUserIds) add("user", id);
  };
  for (const e of events) {
    const m = raw(e.metadata);
    if (e.entityType === "appointment" || e.entityType === "project")
      add(e.entityType, e.entityId);
    for (const source of originalSources(m))
      for (const field of sourceFields)
        add(field.slice(0, -2), raw(source)[field]);
    const t = raw(m.target);
    if (t.kind === "appointment" || t.kind === "project") add(t.kind, t.id);
    add("appointment", m.appointmentId);
    add("appointment", raw(m.offer).appointmentId);
    snapshot(m.before);
    snapshot(m.after);
  }
  snapshots.forEach(snapshot);
  return candidates;
}
/** Caller provides its same bounded snapshot reader. No global/current-state read occurs here. */
export async function readSchedulingHistoryEvidence(
  query: SchedulingEvidenceQuery,
  organizationId: string,
  events: AuditEvent[],
  snapshots: unknown[] = [],
  maxRows = 2000,
): Promise<SchedulingHistoryEvidence> {
  const commands = events.some((e) =>
    e.action.startsWith("customer_work.project_"),
  )
    ? await query(
        'SELECT organization_id AS "organizationId", actor_user_id AS "actorUserId", request_id AS "requestId", action, payload_sha256 AS "payloadSha256", customer_work_id AS "customerWorkId", project_id AS "projectId", estimate_id AS "estimateId", result_version AS "resultVersion" FROM public.customer_work_commands WHERE organization_id=$1 AND request_id::text=ANY($2::text[]) ORDER BY id LIMIT $3',
        [
          organizationId,
          events.flatMap((e) => {
            const id = returningRequestIdSchema.safeParse(
              raw(e.metadata).requestId,
            );
            return id.success ? [id.data.toLowerCase()] : [];
          }),
          maxRows + 1,
        ],
      )
    : [];
  const evidence: SchedulingHistoryEvidence = {
    context: {
      organizationId,
      authorizedHistoricalLinks: new Set(),
      availableTargets: new Set(),
    },
    events,
    commands,
  };
  const owners = new Map<string, string>();
  const candidates = candidateLinks(events, snapshots);
  const tables = {
    contact: "contacts",
    lead: "leads",
    property: "properties",
    estimate: "estimates",
    appointment: "appointments",
    project: "projects",
    user: "users",
  };
  for (const [kind, table] of Object.entries(tables)) {
    const ids = [...(candidates.get(kind) ?? [])];
    if (!ids.length) continue;
    const rows = await query(
      `SELECT id, organization_id AS "organizationId" FROM public.${table} WHERE id::text=ANY($1::text[]) ORDER BY id LIMIT $2`,
      [ids, maxRows + 1],
    );
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.organizationId !== "string")
        continue;
      const k = key(kind, row.id);
      owners.set(k, row.organizationId);
      if (row.organizationId === organizationId) {
        evidence.context.authorizedHistoricalLinks.add(k);
        if (kind === "appointment" || kind === "project")
          evidence.context.availableTargets.add(k);
      }
    }
  }
  // A closed original record proves original target ownership even after deletion.
  // An existing foreign owner always overrides that historical claim.
  for (const event of events) {
    if (event.organizationId !== organizationId) continue;
    const p = originalProof(event, evidence);
    if (!p?.target) continue;
    const k = key(p.target.kind, p.target.id);
    if (!owners.has(k) || owners.get(k) === organizationId)
      evidence.context.authorizedHistoricalLinks.add(k);
  }
  return evidence;
}
export async function readSchedulingAuditEvidence(
  tx: ScheduleTransaction,
  org: string,
  events: AuditEvent[],
) {
  const query: SchedulingEvidenceQuery = async (text, values) => {
    const result = await tx.execute(schedulingEvidenceSql(text, values));
    if (result.rows.length > 2000)
      throw new CustomerWorkError(
        503,
        "scheduling_history_unavailable",
        "Scheduling history exceeds its bounded read.",
      );
    return result.rows as RecordRow[];
  };
  const candidates = candidateLinks(events, []),
    targets = [
      ...(candidates.get("project") ?? []),
      ...(candidates.get("appointment") ?? []),
    ];
  const transitions = targets.length
    ? ((await query(
        'SELECT id, organization_id AS "organizationId", actor_user_id AS "actorUserId", action, entity_type AS "entityType", entity_id AS "entityId", metadata, created_at AS "createdAt" FROM public.audit_events WHERE organization_id=$1 AND action=$2 AND entity_id::text=ANY($3::text[]) ORDER BY id LIMIT $4',
        [org, SCHEDULING_TRANSITION_ACTION, targets, 2001],
      )) as unknown as AuditEvent[])
    : [];
  const all = [
    ...new Map(
      [...events, ...transitions].map((event) => [event.id, event]),
    ).values(),
  ];
  return readSchedulingHistoryEvidence(query, org, all);
}
const carrierKeys = new Set([
  "schedulingReservation",
  "schedulingSnapshot",
  "schedulingReview",
  "schedulingOperation",
  "expectedTargetFingerprint",
  "operationId",
]);
function stripCarriers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCarriers);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k, v]) =>
            !carrierKeys.has(k) &&
            !(
              k === "review" &&
              Object.hasOwn(raw(v), "context") &&
              Object.hasOwn(raw(raw(v).context), "policyRevision")
            ),
        )
        .map(([k, v]) => [k, stripCarriers(v)]),
    );
  return value;
}
export function projectSchedulingAuditRow(
  event: AuditEvent,
  evidence: SchedulingHistoryEvidence,
): AuditEvent | null {
  if (event.organizationId !== evidence.context.organizationId) return null;
  if (event.action === MANUAL_SCHEDULING_RECEIPT_ACTION) return null;
  if (nativeActions.includes(event.action)) {
    const metadata = stripCarriers(event.metadata) as RecordRow;
    if (same(metadata, event.metadata)) return event;
    return {
      ...event,
      actorUserId: null,
      entityId:
        event.entityId &&
        evidence.context.authorizedHistoricalLinks.has(
          key(event.entityType, event.entityId),
        )
          ? event.entityId
          : null,
      metadata,
    };
  }
  if (
    !knownActions.includes(event.action) &&
    !event.action.startsWith("scheduling.")
  )
    return event;
  const p = projection(event, evidence.context, evidence);
  if (!p.summary) return null;
  return {
    id: event.id,
    organizationId: event.organizationId,
    actorUserId: null,
    action: event.action,
    entityType:
      p.summary.target?.kind ??
      (p.summary.event === "policy_updated"
        ? "org_settings"
        : event.entityType),
    entityId:
      p.summary.target?.id ??
      (p.summary.event === "policy_updated" ? event.organizationId : null),
    createdAt: event.createdAt,
    metadata: p.summary,
  };
}

/** Conservative retention checks raw, explicit paths even when proof cannot be projected. */
export async function assertNoSchedulingParticipantHistory(
  tx: ScheduleTransaction,
  orgId: string,
  selectedSourceIds: string[],
): Promise<void> {
  if (tx === (db as unknown))
    throw new CustomerWorkError(
      503,
      "scheduling_transaction_required",
      "A caller transaction is required.",
    );
  const ids = [...new Set(selectedSourceIds.map((id) => uuidSchema.parse(id)))];
  if (!ids.length) return;
  uuidSchema.parse(orgId);
  const paths = [
    ...sourceFields.map((k) => [k]),
    ...sourceFields.flatMap((k) => [
      ["source", k],
      ["review", "context", "source", k],
      ["schedulingReview", "context", "source", k],
      ["offer", "source", k],
      ["offer", "review", "context", "source", k],
    ]),
    ["target", "id"],
    ["before", "target", "id"],
    ["after", "target", "id"],
    ["appointmentId"],
    ["offer", "appointmentId"],
  ];
  const tests = paths.map(
    (path) =>
      sql`lower(${auditEventsTable.metadata} #>> ${`{${path.join(",")}}`}::text[]) = ANY(${sql.param(ids)}::text[])`,
  );
  const found = await tx
    .select({ id: auditEventsTable.id })
    .from(auditEventsTable)
    .where(
      sql`${auditEventsTable.action} = ANY(${sql.param(knownActions)}::text[]) AND (lower(${auditEventsTable.entityId}::text) = ANY(${sql.param(ids)}::text[]) OR ${sql.join(tests, sql` OR `)})`,
    )
    .limit(1);
  if (found.length)
    throw new CustomerWorkError(
      409,
      "scheduling_history_retained",
      "These selected records retain original scheduling history and cannot be removed.",
    );
}
export async function retainSchedulingProjectDeletion(
  tx: ScheduleTransaction,
  org: string,
  project: { id: string; schedulingReservation: unknown },
  source: ManualSourceRef | null,
) {
  if (tx === (db as unknown))
    throw new CustomerWorkError(
      503,
      "scheduling_transaction_required",
      "A caller transaction is required.",
    );
  const parsed = reservationSnapshotSchema.safeParse(
    project.schedulingReservation,
  );
  const target = { kind: "project" as const, id: project.id };
  const valid = parsed.success && same(parsed.data.target, target);
  const invalid = project.schedulingReservation != null && !valid;
  const metadata = schedulingDeletionSchema.parse({
    formatVersion: 1,
    target,
    source,
    before: valid ? parsed.data : null,
    after: null,
    rawInvalidEvidence: invalid ? project.schedulingReservation : null,
    invalidHistoricalEvidenceRetained: invalid,
    recordedAt: new Date().toISOString(),
  });
  await tx.insert(auditEventsTable).values({
    organizationId: org,
    actorUserId: null,
    action: SCHEDULING_DELETION_ACTION,
    entityType: "project",
    entityId: project.id,
    metadata,
  });
}
