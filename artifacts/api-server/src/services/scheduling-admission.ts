import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  db,
  projectsTable,
} from "@workspace/db";
import { z } from "zod/v4";
import {
  assertTravel,
  classifyReservationTransition,
  effectiveReservation,
  peakConcurrency,
  reservationSnapshotSchema,
  manualSourceRefSchema,
  isoSchema,
  uuidSchema,
  validateWallTime,
  type EffectiveReservation,
  type ManualSourceRef,
  type ReservationSnapshot,
  type SchedulingCandidate,
  type SchedulingMutationReview,
} from "@workspace/scheduling-core";
import type { ScheduleTransaction } from "./contractor-scheduling";
import {
  projectSchedulingEvidence,
  readSchedulingContext,
  revalidateSchedulingContext,
  SchedulingPolicyError,
} from "./scheduling-policy";

export type ServerSchedulingAuthority = {
  organizationId: string;
  actorUserId: string | null;
  origin:
    | "manual"
    | "returning_command"
    | "service_care"
    | "callie"
    | "concierge"
    | "workday";
  sourceId: string | null;
  reviewMode: "reviewed" | "existing_workflow_transaction";
};
export type SchedulingTransition = "admission" | "release" | "preserve";
export const SCHEDULING_TRANSITION_ACTION =
  "scheduling.reservation_transition.v1";
const originSchema = z.enum([
  "manual",
  "returning_command",
  "service_care",
  "callie",
  "concierge",
  "workday",
]);
export const schedulingTransitionSchema = z.strictObject({
  formatVersion: z.literal(1),
  transition: z.enum(["admission", "release", "preserve"]),
  origin: originSchema,
  sourceId: uuidSchema.nullable(),
  source: manualSourceRefSchema.nullable(),
  before: reservationSnapshotSchema.nullable(),
  after: reservationSnapshotSchema.nullable(),
  target: z.strictObject({
    kind: z.enum(["appointment", "project"]),
    id: uuidSchema,
  }),
  invalidHistoricalEvidenceRetained: z.boolean(),
  recordedAt: isoSchema,
});
export function schedulingFailure(
  code: string,
  message = "The reviewed schedule cannot be saved. Refresh and review the affected work.",
  status = 409,
): never {
  throw new SchedulingPolicyError(code, message, status);
}
export const unlinkedSchedulingSource: ManualSourceRef = {
  sourceKind: "unlinked_manual",
  leadId: null,
  contactId: null,
  propertyId: null,
  estimateId: null,
};
type Row =
  typeof appointmentsTable.$inferSelect | typeof projectsTable.$inferSelect;
export function nativeSchedulingCandidate(
  kind: "appointment" | "project",
  row: Row,
  source: ManualSourceRef = unlinkedSchedulingSource,
): SchedulingCandidate {
  const evidence = projectSchedulingEvidence(kind, row);
  return {
    kind,
    id: row.id,
    startAt: row.scheduledStart?.toISOString() ?? null,
    endAt: row.scheduledEnd?.toISOString() ?? null,
    status: row.status,
    type: "type" in row ? row.type : "project",
    resourceUserIds:
      "assignedUserId" in row
        ? row.assignedUserId
          ? [row.assignedUserId]
          : []
        : row.crewUserIds,
    source,
    reservation: evidence.schedulingReservation,
  };
}
export function activeSchedulingCandidate(row: SchedulingCandidate) {
  return (
    row.startAt !== null &&
    (row.kind === "appointment"
      ? ["scheduled", "confirmed"]
      : ["scheduled", "in_progress"]
    ).includes(row.status)
  );
}
function checkedEffective(
  kind: "appointment" | "project",
  row: Row,
): EffectiveReservation {
  if (projectSchedulingEvidence(kind, row).schedulingEvidence === "invalid")
    schedulingFailure("invalid_reservation_snapshot");
  try {
    const value = effectiveReservation(nativeSchedulingCandidate(kind, row));
    if (value) return value;
  } catch {
    /* malformed active database evidence is a domain hold */
  }
  return schedulingFailure("invalid_reservation_snapshot");
}
const MAX = 10000;
/** Each physical query is bounded; the limit applies to the COMBINED logical population. */
async function evidence(
  tx: ScheduleTransaction,
  org: string,
  candidate: EffectiveReservation,
  population: "resource" | "company" | "inspection",
) {
  const from = new Date(candidate.startAt),
    to = new Date(candidate.endAt),
    ids = candidate.resourceUserIds;
  if (population === "resource" && !ids.length) return [];
  const appointments = await tx
    .select()
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, org),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
        isNotNull(appointmentsTable.scheduledStart),
        candidate.kind === "appointment"
          ? ne(appointmentsTable.id, candidate.id)
          : undefined,
        population === "resource"
          ? or(
              inArray(appointmentsTable.assignedUserId, ids),
              ...ids.map(
                (id) =>
                  sql`${appointmentsTable.schedulingReservation}->'resourceUserIds' @> ${JSON.stringify([id])}::jsonb`,
              ),
            )
          : undefined,
        population === "inspection"
          ? eq(appointmentsTable.type, "inspection")
          : undefined,
        population !== "resource"
          ? lt(appointmentsTable.scheduledStart, to)
          : undefined,
        population !== "resource"
          ? gt(
              sql`coalesce(${appointmentsTable.scheduledEnd},${appointmentsTable.scheduledStart}+interval '2 hours')`,
              from,
            )
          : undefined,
      ),
    )
    .orderBy(appointmentsTable.id)
    .limit(MAX + 1);
  const projects =
    population === "inspection"
      ? []
      : await tx
          .select()
          .from(projectsTable)
          .where(
            and(
              eq(projectsTable.organizationId, org),
              inArray(projectsTable.status, ["scheduled", "in_progress"]),
              isNotNull(projectsTable.scheduledStart),
              candidate.kind === "project"
                ? ne(projectsTable.id, candidate.id)
                : undefined,
              population === "resource"
                ? or(
                    ...ids.flatMap((id) => [
                      sql`${projectsTable.crewUserIds} @> ${JSON.stringify([id])}::jsonb`,
                      sql`${projectsTable.schedulingReservation}->'resourceUserIds' @> ${JSON.stringify([id])}::jsonb`,
                    ]),
                  )
                : undefined,
              population !== "resource"
                ? lt(projectsTable.scheduledStart, to)
                : undefined,
              population !== "resource"
                ? gt(
                    sql`coalesce(${projectsTable.scheduledEnd},${projectsTable.scheduledStart}+interval '1 day')`,
                    from,
                  )
                : undefined,
            ),
          )
          .orderBy(projectsTable.id)
          .limit(MAX + 1);
  const keys = new Set([
    ...appointments.map((r) => `appointment:${r.id}`),
    ...projects.map((r) => `project:${r.id}`),
  ]);
  if (keys.size > MAX)
    schedulingFailure(
      "scheduling_coverage_limit",
      "The complete active schedule exceeds the safe review limit. Ask an administrator to review coverage.",
    );
  const rows = [
    ...appointments.map((r) => checkedEffective("appointment", r)),
    ...projects.map((r) => checkedEffective("project", r)),
  ];
  if (population !== "resource") return rows;
  // Validate ALL relevant-resource active evidence before using the bounded gap horizon.
  const horizon = 1440 * 60000;
  return rows.filter(
    (r) =>
      Date.parse(r.startAt) <= to.getTime() + horizon &&
      Date.parse(r.endAt) >= from.getTime() - horizon,
  );
}
/** Actorless compatibility is deliberately separate from ServerSchedulingAuthority. */
export async function prepareNativeSchedulingAdmission(
  tx: ScheduleTransaction,
  org: string,
  authority: ServerSchedulingAuthority | undefined,
  before: SchedulingCandidate | null,
  after: SchedulingCandidate,
  review: SchedulingMutationReview | null,
): Promise<{
  transition: SchedulingTransition;
  snapshot: ReservationSnapshot | null;
}> {
  if (tx === (db as unknown))
    schedulingFailure(
      "scheduling_transaction_required",
      "Scheduling requires the original transaction.",
      503,
    );
  if (authority && authority.organizationId !== org)
    schedulingFailure(
      "scheduling_access_denied",
      "Scheduling authority belongs to another company.",
      403,
    );
  const transition = classifyReservationTransition(before, after);
  if (transition === "preserve")
    return { transition, snapshot: before?.reservation ?? null };
  if (transition === "release") {
    const saved = before?.reservation ?? null;
    if (!saved || !activeSchedulingCandidate(after))
      return { transition, snapshot: saved };
    if (!authority) schedulingFailure("stale_scheduling_review");
    if (!Number.isSafeInteger(saved.reservationRevision + 1))
      schedulingFailure("invalid_reservation_snapshot");
    return {
      transition,
      snapshot: reservationSnapshotSchema.parse({
        ...saved,
        reservationRevision: saved.reservationRevision + 1,
        resourceUserIds: [...new Set(after.resourceUserIds)].sort(),
        lastTransition: {
          kind: "release",
          actorUserId: authority?.actorUserId ?? null,
          at: new Date().toISOString(),
        },
      }),
    };
  }
  const current = review
    ? await revalidateSchedulingContext(tx, org, review.context, after)
    : await readSchedulingContext(tx, org, after);
  if (
    (current.policy || before?.reservation) &&
    (!authority ||
      (!review && authority.reviewMode !== "existing_workflow_transaction"))
  )
    schedulingFailure("stale_scheduling_review");
  if (
    authority?.reviewMode === "existing_workflow_transaction" &&
    (authority.origin === "manual" ||
      authority.origin === "workday" ||
      authority.actorUserId !== null)
  )
    schedulingFailure(
      "scheduling_access_denied",
      "Staff booking requires its reviewed scheduling context.",
      403,
    );
  if (before?.reservation && !current.policy)
    schedulingFailure("invalid_scheduling_policy");
  const candidate = effectiveReservation({ ...after, reservation: null });
  if (!candidate) return { transition, snapshot: before?.reservation ?? null };
  if (review) {
    for (const [instant, wall] of [
      [candidate.startAt, review.startWallTime],
      [candidate.endAt, review.endWallTime],
    ] as const) {
      if (wall) {
        if (wall.timeZone !== current.context.companyTimeZone)
          schedulingFailure("stale_scheduling_review");
        try {
          validateWallTime(instant, wall);
        } catch {
          schedulingFailure(
            "invalid_wall_time",
            "Choose a valid local time and explicit offset.",
          );
        }
      }
    }
    if (review.duration.kind === "preset") {
      const preset = current.policy?.durationPresets.find(
        (p) => p.id === review.duration.preset?.id,
      );
      if (
        !current.policy?.enabled ||
        !preset ||
        preset.label !== review.duration.preset?.label ||
        preset.elapsedMinutes !== review.duration.preset?.elapsedMinutes ||
        Date.parse(candidate.endAt) - Date.parse(candidate.startAt) !==
          preset.elapsedMinutes * 60000
      )
        schedulingFailure("stale_scheduling_review");
    }
    if (review.duration.kind === "preserved_interval") {
      const prior = before ? effectiveReservation(before) : null;
      if (
        !prior ||
        Date.parse(prior.endAt) - Date.parse(prior.startAt) !==
          Date.parse(candidate.endAt) - Date.parse(candidate.startAt)
      )
        schedulingFailure("stale_scheduling_review");
    }
    if (
      review.duration.kind === "inspection_interval" &&
      (after.kind !== "appointment" || after.type !== "inspection")
    )
      schedulingFailure("stale_scheduling_review");
  }
  candidate.savedGapMinutes =
    current.context.applicableRules.newTravelGapMinutes;
  const neighbors = await evidence(tx, org, candidate, "resource");
  // All inputs have been schema/evidence validated above. Only the core domain assertion is translated.
  try {
    assertTravel(candidate, neighbors);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const overlap = neighbors.some(
      (r) =>
        r.resourceUserIds.some((id) =>
          candidate.resourceUserIds.includes(id),
        ) &&
        Date.parse(r.startAt) < Date.parse(candidate.endAt) &&
        Date.parse(candidate.startAt) < Date.parse(r.endAt),
    );
    schedulingFailure(overlap ? "resource_conflict" : "travel_conflict");
  }
  const cap = current.context.applicableRules.companyCeiling;
  if (
    cap !== null &&
    peakConcurrency(candidate, await evidence(tx, org, candidate, "company")) >
      cap
  )
    schedulingFailure("company_capacity_conflict");
  const inspection = current.context.applicableRules.inspectionCeiling;
  if (
    inspection !== null &&
    peakConcurrency(
      candidate,
      await evidence(tx, org, candidate, "inspection"),
    ) > inspection
  )
    schedulingFailure("inspection_capacity_conflict");
  if (!current.policy) return { transition, snapshot: null };
  if (
    !Number.isSafeInteger((before?.reservation?.reservationRevision ?? 0) + 1)
  )
    schedulingFailure("invalid_reservation_snapshot");
  const now = new Date().toISOString();
  return {
    transition,
    snapshot: reservationSnapshotSchema.parse({
      formatVersion: 1,
      reservationRevision: (before?.reservation?.reservationRevision ?? 0) + 1,
      sourcePolicyRevision: current.policy.revision,
      sourcePolicyDigest: current.policy.digest,
      approvedTimeZone: current.context.companyTimeZone,
      inspection: current.context.inspection,
      startAt: candidate.startAt,
      endAt: candidate.endAt,
      resourceUserIds: [...new Set(candidate.resourceUserIds)].sort(),
      minimumTravelGapMinutes: candidate.savedGapMinutes,
      duration: review?.duration ?? { kind: "explicit", preset: null },
      admittedAt: now,
      admittedByUserId: authority?.actorUserId ?? null,
      target: { kind: after.kind, id: after.id },
      lastTransition: {
        kind: "admission",
        actorUserId: authority?.actorUserId ?? null,
        at: now,
      },
    }),
  };
}
export async function prepareSchedulingAdmission(
  tx: ScheduleTransaction,
  authority: ServerSchedulingAuthority,
  before: SchedulingCandidate | null,
  after: SchedulingCandidate,
  review: SchedulingMutationReview | null,
) {
  return prepareNativeSchedulingAdmission(
    tx,
    authority.organizationId,
    authority,
    before,
    after,
    review,
  );
}
export async function appendSchedulingTransition(
  tx: ScheduleTransaction,
  authority: ServerSchedulingAuthority,
  before: ReservationSnapshot | null,
  after: ReservationSnapshot | null,
  target: { kind: "appointment" | "project"; id: string },
  facts?: {
    transition: SchedulingTransition;
    source: ManualSourceRef | null;
    invalidHistoricalEvidenceRetained: boolean;
  },
) {
  if (!facts) {
    if (!after || JSON.stringify(before) === JSON.stringify(after))
      throw Error("Explicit scheduling transition facts are required");
    facts = {
      transition: after.lastTransition.kind,
      source: null,
      invalidHistoricalEvidenceRetained: false,
    };
  }
  const metadata = schedulingTransitionSchema.parse({
    formatVersion: 1,
    ...facts,
    origin: authority.origin,
    sourceId: authority.sourceId,
    before,
    after,
    target,
    recordedAt: new Date().toISOString(),
  });
  await tx
    .insert(auditEventsTable)
    .values({
      id: randomUUID(),
      organizationId: authority.organizationId,
      actorUserId: authority.actorUserId,
      action: SCHEDULING_TRANSITION_ACTION,
      entityType: target.kind,
      entityId: target.id,
      metadata,
    });
}
