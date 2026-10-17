import { schedulingReviewQuerySchema, type SchedulingReviewQuery } from "@workspace/scheduling-core";
export { schedulingReviewQuerySchema, type SchedulingReviewQuery } from "@workspace/scheduling-core";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  projectsTable,
  propertiesTable,
  usersTable,
  type InspectionAvailabilitySettings,
} from "@workspace/db";
import {
  appointmentTypes,
  effectiveReservation,
  policySaveInputSchema,
  reservationSnapshotSchema,
  schedulingPolicySchema,
  schedulingReviewContextSchema,
  timeZoneSchema,
  uuidSchema,
  type ISO,
  type ManualSourceRef,
  type PolicyReadResult,
  type PolicySaveInput,
  type ReservationSnapshot,
  type SchedulingCandidate,
  type SchedulingPolicy,
  type SchedulingReviewContext,
  type UUID,
  type UserId,
} from "@workspace/scheduling-core";
import { customerWorkRootsTable } from "../../../../lib/db/src/schema/customer-work";
import { hasPermission, type Permission } from "../lib/permissions";
import {
  lockContractorSchedule,
  type ScheduleTransaction,
} from "./contractor-scheduling";
import {
  CustomerLifecycleHoldError,
  getCustomerLifecycleStatus,
} from "./customer-lifecycle";
import {
  initializeOrgSettings,
  normalizeInspectionAvailability,
} from "./settings";

/** Server context only. Never accepted from a request body. */
export type SchedulingActor = { organizationId: UUID; userId: UserId };
export type SchedulingBookingScope = {
  reservationKind: "appointment" | "project";
  appointmentType?: (typeof appointmentTypes)[number];
};
export class SchedulingPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
function fail(code: string, message: string, status = 409): never {
  throw new SchedulingPolicyError(code, message, status);
}
function stale(): never {
  return fail(
    "stale_scheduling_review",
    "Scheduling settings or this work changed. Refresh and review the current schedule before saving.",
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");
function transactionOnly(tx: ScheduleTransaction) {
  if (tx === (db as unknown))
    fail(
      "scheduling_transaction_required",
      "Scheduling reads require the caller transaction.",
      503,
    );
}
export function validateCompanyTimeZone(value: unknown): string {
  const parsed = timeZoneSchema.safeParse(value);
  if (!parsed.success)
    fail(
      "invalid_scheduling_policy",
      "The company timezone is invalid. Ask a platform administrator to correct it before scheduling.",
    );
  return parsed.data;
}
/** Enclosing order for config writers; no nested transaction or global reader. */
export async function lockSchedulingConfiguration(
  tx: ScheduleTransaction,
  org: string,
  requireActive = true,
) {
  transactionOnly(tx);
  await tx.execute(
    sql`SELECT set_config('lock_timeout','3000ms',true),set_config('statement_timeout','10000ms',true)`,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`},0))`,
  );
  if (
    requireActive &&
    !(await getCustomerLifecycleStatus(org, tx)).automationAllowed
  )
    throw new CustomerLifecycleHoldError();
  await lockContractorSchedule(tx, org);
}
export async function assertSchedulingActor(
  tx: ScheduleTransaction,
  actor: SchedulingActor,
  permission: Permission,
  platform = false,
  options: { readOnly?: true } = {},
) {
  transactionOnly(tx);
  // Internal Reader use only: callers cannot opt out of writer locks unless
  // PostgreSQL itself confirms this transaction cannot write.
  if (options.readOnly) {
    const mode = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS read_only`);
    if (mode.rows[0]?.read_only !== "on")
      fail("scheduling_transaction_required", "Nonlocking actor validation requires a read-only transaction.", 503);
  }
  const query = tx
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, actor.userId),
        platform
          ? undefined
          : eq(usersTable.organizationId, actor.organizationId),
      ),
    );
  const [user] = await (options.readOnly ? query : query.for("share"));
  if (
    !user?.isActive ||
    !user.emailVerifiedAt ||
    user.id.startsWith("invite:") ||
    (platform ? !user.isPlatformAdmin : !hasPermission(user.role, permission))
  ) {
    fail(
      "scheduling_access_denied",
      "An accepted, verified, active staff account with the current permission is required.",
      403,
    );
  }
  return user;
}
function inspectionEvidence(raw: unknown, companyTimeZone: string) {
  const effective = normalizeInspectionAvailability(raw);
  if (
    !Number.isSafeInteger(effective.maxBookingsPerWindow) ||
    effective.maxBookingsPerWindow < 1
  )
    fail(
      "invalid_scheduling_policy",
      "Inspection availability has an unsafe booking limit. Review inspection settings.",
    );
  const sourceState =
    raw == null
      ? ("legacy_default" as const)
      : canonical(raw) === canonical(effective)
        ? ("recorded" as const)
        : ("legacy_normalized" as const);
  return {
    effective,
    context: {
      ruleTimeZone: effective.timezone,
      sourceState,
      availabilityDigest: digest({ effective, sourceState, companyTimeZone }),
    },
  };
}
function policyDigest(
  value: Omit<SchedulingPolicy, "digest">,
  inspection: ReturnType<typeof inspectionEvidence>,
) {
  return digest({
    policy: value,
    inspection: inspection.context,
    effectiveInspection: inspection.effective,
  });
}
function checkedPolicy(
  raw: unknown,
  companyTimeZone: string,
  inspection: ReturnType<typeof inspectionEvidence>,
): SchedulingPolicy | null {
  if (raw == null) return null;
  const parsed = schedulingPolicySchema.safeParse(raw);
  if (!parsed.success)
    fail(
      "invalid_scheduling_policy",
      "Saved scheduling configuration is invalid. Review its retained evidence before admitting work.",
    );
  const { digest: savedDigest, ...content } = parsed.data;
  if (
    content.timeZone !== companyTimeZone ||
    savedDigest !== policyDigest(content, inspection)
  )
    fail(
      "invalid_scheduling_policy",
      "Saved scheduling configuration does not match its company or inspection context. Review the configuration.",
    );
  return parsed.data;
}
type NativeRow =
  typeof appointmentsTable.$inferSelect | typeof projectsTable.$inferSelect;
const instant = (date: Date | string | null | undefined): ISO | null =>
  date == null ? null : new Date(date).toISOString();
/** Closed fingerprint: no notes, raw JSON, or client-provided metadata escapes. */
export function schedulingTargetFingerprint(
  kind: "appointment" | "project",
  row: NativeRow,
): string {
  const appointment =
    kind === "appointment"
      ? (row as typeof appointmentsTable.$inferSelect)
      : null;
  const project =
    kind === "project" ? (row as typeof projectsTable.$inferSelect) : null;
  const raw = row.schedulingReservation as unknown;
  const revision =
    raw && typeof raw === "object" && "reservationRevision" in raw
      ? raw.reservationRevision
      : null;
  return digest({
    kind,
    id: row.id,
    version: instant(row.updatedAt),
    startAt: instant(row.scheduledStart),
    endAt: instant(row.scheduledEnd),
    type: appointment?.type ?? "project",
    status: row.status,
    leadId: row.leadId,
    contactId: appointment?.contactId ?? null,
    propertyId: appointment?.propertyId ?? null,
    estimateId: project?.estimateId ?? null,
    customerWorkId: project?.customerWorkId ?? null,
    resources: [
      ...(appointment
        ? appointment.assignedUserId
          ? [appointment.assignedUserId]
          : []
        : project!.crewUserIds),
    ].sort(),
    reservationRevision: revision,
  });
}
export function projectSchedulingEvidence(
  kind: "appointment" | "project",
  row: NativeRow,
) {
  const parsed = reservationSnapshotSchema.safeParse(row.schedulingReservation);
  const bound =
    parsed.success &&
    parsed.data.target.kind === kind &&
    parsed.data.target.id === row.id &&
    activeSnapshotAgrees(kind, row, parsed.data);
  return {
    schedulingReservation: bound ? parsed.data : null,
    schedulingEvidence:
      row.schedulingReservation == null
        ? ("legacy" as const)
        : bound
          ? ("versioned" as const)
          : ("invalid" as const),
    schedulingTargetFingerprint: schedulingTargetFingerprint(kind, row),
  };
}
/** Reuse core normalization without loading policy or assigning source authority.
 * This local math candidate is never returned as a review/command source. */
export function activeSnapshotAgrees(
  kind: "appointment" | "project",
  row: { id: string; scheduledStart: Date | null; scheduledEnd: Date | null; status: string; type?: string; assignedUserId?: string | null; crewUserIds?: string[] },
  snapshot: ReservationSnapshot,
): boolean {
  try {
    const appointment =
      kind === "appointment"
        ? (row as typeof appointmentsTable.$inferSelect)
        : null;
    const project =
      kind === "project" ? (row as typeof projectsTable.$inferSelect) : null;
    const candidate: SchedulingCandidate = {
      kind,
      id: row.id,
      startAt: instant(row.scheduledStart),
      endAt: instant(row.scheduledEnd),
      type: appointment?.type ?? "project",
      status: row.status,
      resourceUserIds: appointment
        ? appointment.assignedUserId
          ? [appointment.assignedUserId]
          : []
        : project!.crewUserIds,
      source: {
        sourceKind: "unlinked_manual",
        leadId: null,
        contactId: null,
        propertyId: null,
        estimateId: null,
      },
      reservation: snapshot,
    };
    const actual = effectiveReservation(candidate);
    // Terminal and date-cleared releases retain their historical interval/staff.
    if (actual === null) return true;
    const recorded = effectiveReservation({
      ...candidate,
      startAt: snapshot.startAt,
      endAt: snapshot.endAt,
      resourceUserIds: snapshot.resourceUserIds,
    });
    return canonical(actual) === canonical(recorded);
  } catch {
    return false;
  }
}
async function targetRow(
  tx: ScheduleTransaction,
  org: string,
  kind: "appointment" | "project",
  id: string,
) {
  if (kind === "appointment")
    return (
      await tx
        .select()
        .from(appointmentsTable)
        .where(
          and(
            eq(appointmentsTable.organizationId, org),
            eq(appointmentsTable.id, id),
          ),
        )
        .for("share")
    )[0];
  return (
    await tx
      .select()
      .from(projectsTable)
      .where(
        and(eq(projectsTable.organizationId, org), eq(projectsTable.id, id)),
      )
      .for("share")
  )[0];
}
/** Caller owns lifecycle/schedule for admission. This function never initializes settings.
 * A supplied candidate supplies proposed scope/source; an existing row supplies ORIGINAL version/fingerprint.
 */
export async function readSchedulingContext(
  tx: ScheduleTransaction,
  orgId: UUID,
  target?: SchedulingCandidate,
  bookingScope?: SchedulingBookingScope,
): Promise<{
  policy: SchedulingPolicy | null;
  context: SchedulingReviewContext;
  effectiveInspection: InspectionAvailabilitySettings;
}> {
  transactionOnly(tx);
  const original = target
    ? await targetRow(tx, orgId, target.kind, target.id)
    : undefined;
  const [org] = await tx
    .select({ timezone: organizationsTable.timezone })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) fail("organization_missing", "Company not found.", 404);
  const companyTimeZone = validateCompanyTimeZone(org.timezone);
  const [settings] = await tx
    .select({
      schedulingPolicy: orgSettingsTable.schedulingPolicy,
      inspectionAvailability: orgSettingsTable.inspectionAvailability,
    })
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, orgId));
  const inspection = inspectionEvidence(
    settings?.inspectionAvailability,
    companyTimeZone,
  );
  const policy = checkedPolicy(
    settings?.schedulingPolicy,
    companyTimeZone,
    inspection,
  );
  const scope =
    bookingScope ??
    (target
      ? {
          reservationKind: target.kind,
          ...(target.kind === "appointment"
            ? {
                appointmentType:
                  target.type as (typeof appointmentTypes)[number],
              }
            : {}),
        }
      : undefined);
  if (
    scope &&
    ((scope.reservationKind === "project" &&
      scope.appointmentType !== undefined) ||
      (target && scope.reservationKind !== target.kind) ||
      (scope.appointmentType !== undefined &&
        !appointmentTypes.includes(scope.appointmentType)))
  )
    fail(
      "invalid_scheduling_context",
      "Choose a consistent reservation kind and appointment type.",
      400,
    );
  const usesInspection =
    scope?.reservationKind === "appointment" &&
    (scope.appointmentType ??
      (original && "type" in original ? original.type : "inspection")) ===
      "inspection";
  const context = schedulingReviewContextSchema.parse({
    organizationId: orgId,
    policyRevision: policy?.revision ?? 0,
    policyDigest: policy?.digest ?? null,
    companyTimeZone,
    inspection: usesInspection ? inspection.context : null,
    applicableRules: {
      newTravelGapMinutes: policy?.enabled ? policy.minimumTravelGapMinutes : 0,
      companyCeiling: policy?.enabled ? policy.maxConcurrentReservations : null,
      inspectionCeiling: usesInspection
        ? inspection.effective.maxBookingsPerWindow
        : null,
    },
    source: target?.source ?? null,
    targetVersion: original ? instant(original.updatedAt) : null,
    targetFingerprint: original
      ? schedulingTargetFingerprint(target!.kind, original)
      : null,
  });
  return { policy, context, effectiveInspection: inspection.effective };
}
/** Task5 calls after source/member locks, passing the REAL proposed candidate and scope. */
export async function revalidateSchedulingContext(
  tx: ScheduleTransaction,
  org: string,
  reviewed: SchedulingReviewContext,
  candidate?: SchedulingCandidate,
  bookingScope?: SchedulingBookingScope,
) {
  const parsed = schedulingReviewContextSchema.safeParse(reviewed);
  if (!parsed.success) stale();
  const current = await readSchedulingContext(tx, org, candidate, bookingScope);
  if (canonical(current.context) !== canonical(parsed.data)) stale();
  return current;
}
export async function readSchedulingPolicy(
  actor: SchedulingActor,
): Promise<PolicyReadResult> {
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, actor.organizationId, false);
    await assertSchedulingActor(tx, actor, "crm.read");
    const { policy, context } = await readSchedulingContext(
      tx,
      actor.organizationId,
    );
    return { policy, context };
  });
}
function nextRevision(policy: SchedulingPolicy | null) {
  const revision = (policy?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision))
    fail(
      "invalid_scheduling_policy",
      "The saved scheduling revision cannot advance safely. Review retained configuration.",
    );
  return revision;
}
async function writePolicy(
  tx: ScheduleTransaction,
  actor: SchedulingActor,
  previous: SchedulingPolicy | null,
  values: Pick<
    SchedulingPolicy,
    | "enabled"
    | "minimumTravelGapMinutes"
    | "maxConcurrentReservations"
    | "durationPresets"
  >,
  companyTimeZone: string,
  rawInspection: unknown,
  action: string,
) {
  const content = {
    formatVersion: 1 as const,
    revision: nextRevision(previous),
    enabled: values.enabled,
    minimumTravelGapMinutes: values.minimumTravelGapMinutes,
    maxConcurrentReservations: values.maxConcurrentReservations,
    durationPresets: values.durationPresets,
    timeZone: companyTimeZone,
    updatedAt: new Date().toISOString(),
    updatedByUserId: actor.userId,
  };
  const policy = schedulingPolicySchema.parse({
    ...content,
    digest: policyDigest(
      content,
      inspectionEvidence(rawInspection, companyTimeZone),
    ),
  });
  await tx
    .update(orgSettingsTable)
    .set({ schedulingPolicy: policy })
    .where(eq(orgSettingsTable.organizationId, actor.organizationId));
  await tx.insert(auditEventsTable).values({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action,
    entityType: "org_settings",
    entityId: actor.organizationId,
    metadata: { previousPolicy: previous, policy },
  });
  return policy;
}
export async function saveSchedulingPolicy(
  actor: SchedulingActor,
  input: PolicySaveInput,
): Promise<PolicyReadResult> {
  const parsed = policySaveInputSchema.safeParse(input);
  if (!parsed.success)
    fail(
      "invalid_scheduling_policy",
      "Review the scheduling values. Server revision, timezone, digest and actor metadata cannot be supplied.",
      400,
    );
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, actor.organizationId);
    await assertSchedulingActor(tx, actor, "settings.manage");
    const settings = await initializeOrgSettings(tx, actor.organizationId);
    const current = await readSchedulingContext(tx, actor.organizationId);
    if (
      parsed.data.expectedRevision !== current.context.policyRevision ||
      parsed.data.expectedCompanyTimeZone !== current.context.companyTimeZone
    )
      stale();
    const knownIds = new Set(
      current.policy?.durationPresets.map((preset) => preset.id),
    );
    if (
      parsed.data.durationPresets.some(
        (preset) => preset.id !== null && !knownIds.has(preset.id),
      )
    )
      fail(
        "invalid_scheduling_policy",
        "New presets must request a server ID; existing preset IDs must come from this saved policy.",
        400,
      );
    await writePolicy(
      tx,
      actor,
      current.policy,
      {
        enabled: parsed.data.enabled,
        minimumTravelGapMinutes: parsed.data.minimumTravelGapMinutes,
        maxConcurrentReservations: parsed.data.maxConcurrentReservations,
        durationPresets: parsed.data.durationPresets.map((preset) => ({
          ...preset,
          id: preset.id ?? randomUUID(),
        })),
      },
      current.context.companyTimeZone,
      settings.inspectionAvailability,
      "scheduling.policy_saved",
    );
    const { policy, context } = await readSchedulingContext(
      tx,
      actor.organizationId,
    );
    return { policy, context };
  });
}
/** Existing settings writer calls while holding the enclosing config locks. */
export async function advanceSchedulingInspectionPolicy(
  tx: ScheduleTransaction,
  actor: SchedulingActor,
  previous: SchedulingPolicy | null,
  companyTimeZone: string,
  rawInspection: unknown,
) {
  if (previous)
    await writePolicy(
      tx,
      actor,
      previous,
      previous,
      companyTimeZone,
      rawInspection,
      "scheduling.inspection_changed",
    );
}
export async function setSchedulingCompanyTimeZone(
  actor: SchedulingActor,
  orgId: UUID,
  zone: string,
  expectedZone: string,
  name?: string,
): Promise<void> {
  validateCompanyTimeZone(zone);
  // The expected value is an exact compare token, including a malformed legacy
  // zone. An administrator must be able to repair unconfigured legacy data.
  if (typeof expectedZone !== "string") stale();
  await db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, orgId);
    await assertSchedulingActor(tx, actor, "settings.manage", true);
    const [org] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .for("update");
    if (!org) fail("organization_missing", "Company not found.", 404);
    const [settings] = await tx
      .select()
      .from(orgSettingsTable)
      .where(eq(orgSettingsTable.organizationId, orgId))
      .for("update");
    if (org.timezone !== expectedZone) stale();
    const previous =
      settings?.schedulingPolicy == null
        ? null
        : (await readSchedulingContext(tx, orgId)).policy;
    await tx
      .update(organizationsTable)
      .set({ timezone: zone, ...(name === undefined ? {} : { name }) })
      .where(eq(organizationsTable.id, orgId));
    if (previous)
      await writePolicy(
        tx,
        { organizationId: orgId, userId: actor.userId },
        previous,
        previous,
        zone,
        settings?.inspectionAvailability,
        "scheduling.company_timezone_changed",
      );
    await tx.insert(auditEventsTable).values({
      organizationId: orgId,
      actorUserId: actor.userId,
      action: "organization.timezone_updated",
      entityType: "organization",
      entityId: orgId,
      metadata: {
        previousTimeZone: expectedZone,
        timeZone: zone,
        policyRevision: previous ? previous.revision + 1 : 0,
      },
    });
    if (name !== undefined)
      await tx.insert(auditEventsTable).values({
        organizationId: orgId,
        actorUserId: actor.userId,
        action: "organization.updated",
        entityType: "organization",
        entityId: orgId,
        metadata: { name },
      });
  });
}

async function sourceForQuery(
  tx: ScheduleTransaction,
  org: string,
  query: SchedulingReviewQuery,
): Promise<ManualSourceRef> {
  let contactId: string | null = null,
    leadId: string | null = null;
  if (query.sourceKind === "lead") {
    const [lead] = await tx
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, org),
          eq(leadsTable.id, query.sourceId!),
        ),
      )
      .for("share");
    if (!lead)
      fail(
        "scheduling_source_missing",
        "The selected source is unavailable in this company.",
        404,
      );
    leadId = lead.id;
    contactId = lead.contactId;
    if (
      query.propertyId &&
      lead.propertyId &&
      query.propertyId !== lead.propertyId
    )
      fail(
        "customer_reference_mismatch",
        "Choose the property belonging to this source.",
        400,
      );
  } else if (query.sourceKind === "direct_customer")
    contactId = query.sourceId!;
  if (contactId) {
    const [contact] = await tx
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, org),
          eq(contactsTable.id, contactId),
        ),
      )
      .for("share");
    if (!contact)
      fail(
        "scheduling_source_missing",
        "The selected customer is unavailable in this company.",
        404,
      );
  }
  if (query.propertyId) {
    const [property] = await tx
      .select()
      .from(propertiesTable)
      .where(
        and(
          eq(propertiesTable.organizationId, org),
          eq(propertiesTable.id, query.propertyId),
        ),
      )
      .for("share");
    if (!property || property.contactId !== contactId)
      fail(
        "customer_reference_mismatch",
        "Choose this customer's property.",
        400,
      );
  }
  if (query.estimateId) {
    const [estimate] = await tx
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.organizationId, org),
          eq(estimatesTable.id, query.estimateId),
        ),
      )
      .for("share");
    if (!estimate || estimate.leadId !== leadId)
      fail(
        "estimate_lead_mismatch",
        "Choose an estimate belonging to this source.",
        400,
      );
    if (estimate.customerWorkId) {
      const [root] = await tx
        .select()
        .from(customerWorkRootsTable)
        .where(
          and(
            eq(customerWorkRootsTable.organizationId, org),
            eq(customerWorkRootsTable.id, estimate.customerWorkId),
          ),
        )
        .for("share");
      if (
        !root ||
        root.contactId !== contactId ||
        root.propertyId !== (query.propertyId ?? null)
      )
        fail(
          "customer_reference_mismatch",
          "Choose the original returning-work customer and property.",
          400,
        );
    }
  }
  return {
    sourceKind: query.sourceKind,
    leadId,
    contactId,
    propertyId: query.propertyId ?? null,
    estimateId: query.estimateId ?? null,
  };
}
export async function getSchedulingReviewContext(
  actor: SchedulingActor,
  query: SchedulingReviewQuery,
): Promise<SchedulingReviewContext> {
  return db.transaction(tx => getSchedulingReviewContextInTransaction(tx, actor, query));
}
export async function getSchedulingReviewContextInTransaction(tx: ScheduleTransaction, actor: SchedulingActor, query: SchedulingReviewQuery): Promise<SchedulingReviewContext> {
  const parsed = schedulingReviewQuerySchema.parse(query);
  transactionOnly(tx);
    await lockSchedulingConfiguration(tx, actor.organizationId, false);
    await assertSchedulingActor(tx, actor, "crm.read");
    const row = parsed.targetId
      ? await targetRow(
          tx,
          actor.organizationId,
          parsed.targetKind!,
          parsed.targetId,
        )
      : undefined;
    if (parsed.targetId && !row)
      fail(
        "scheduling_target_missing",
        "The original reservation is unavailable in this company.",
        404,
      );
    const source = await sourceForQuery(tx, actor.organizationId, parsed);
    let candidate: SchedulingCandidate | undefined;
    if (row) {
      const appointment =
        parsed.targetKind === "appointment"
          ? (row as typeof appointmentsTable.$inferSelect)
          : null;
      const project =
        parsed.targetKind === "project"
          ? (row as typeof projectsTable.$inferSelect)
          : null;
      // Only an original lead-linked legacy row may resolve its absent stored
      // contact through that same lead. A truly unlinked target stays unlinked.
      const originalLeadContactFallback =
        appointment?.contactId === null &&
        appointment.leadId !== null &&
        appointment.leadId === source.leadId;
      if (
        row.leadId !== source.leadId ||
        (appointment &&
          ((!originalLeadContactFallback &&
            appointment.contactId !== source.contactId) ||
            appointment.propertyId !== source.propertyId)) ||
        (project && project.estimateId !== source.estimateId)
      )
        fail(
          "customer_reference_mismatch",
          "Review the original reservation source and property.",
          400,
        );
      if (project?.customerWorkId) {
        const [root] = await tx
          .select()
          .from(customerWorkRootsTable)
          .where(
            and(
              eq(customerWorkRootsTable.organizationId, actor.organizationId),
              eq(customerWorkRootsTable.id, project.customerWorkId),
            ),
          )
          .for("share");
        if (
          !root ||
          root.contactId !== source.contactId ||
          root.propertyId !== source.propertyId
        )
          fail(
            "customer_reference_mismatch",
            "Review the original returning-work source.",
            400,
          );
      }
      const evidence = projectSchedulingEvidence(parsed.targetKind!, row);
      if (evidence.schedulingEvidence === "invalid")
        fail(
          "invalid_reservation_snapshot",
          "Saved reservation evidence is invalid. Review retained history before changing its schedule.",
        );
      candidate = {
        kind: parsed.targetKind!,
        id: row.id,
        startAt: instant(row.scheduledStart),
        endAt: instant(row.scheduledEnd),
        resourceUserIds: appointment
          ? appointment.assignedUserId
            ? [appointment.assignedUserId]
            : []
          : project!.crewUserIds,
        type: appointment?.type ?? "project",
        status: row.status,
        source,
        reservation: evidence.schedulingReservation,
      };
    }
    const result = await readSchedulingContext(
      tx,
      actor.organizationId,
      candidate,
      {
        reservationKind: parsed.reservationKind,
        appointmentType: parsed.appointmentType,
      },
    );
    return { ...result.context, source };
}
