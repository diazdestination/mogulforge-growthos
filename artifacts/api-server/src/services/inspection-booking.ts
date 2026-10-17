/** Inspection compatibility wrappers and the common offer/admission gate. */
import { randomUUID } from "node:crypto";
import { appointmentsTable, db } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type {
  ManualSourceRef,
  SchedulingCandidate,
  SchedulingMutationReview,
} from "@workspace/scheduling-core";
import {
  appointmentCustomer,
  assertOperationalStaff,
  assertScheduleInterval,
  type ScheduleTransaction,
} from "./contractor-scheduling";
import {
  nativeSchedulingCandidate,
  prepareNativeSchedulingAdmission,
  type ServerSchedulingAuthority,
} from "./scheduling-admission";
import {
  lockSchedulingConfiguration,
  projectSchedulingEvidence,
  SchedulingPolicyError,
} from "./scheduling-policy";

type AppointmentInsert = typeof appointmentsTable.$inferInsert;
export type AppointmentRow = typeof appointmentsTable.$inferSelect;

/** No independent population/count approximation: offers and writes use Task5's evidence and limits. */
export async function prepareInspectionInTransaction(
  tx: ScheduleTransaction,
  options: {
    organizationId: string;
    candidate: SchedulingCandidate;
    before?: SchedulingCandidate | null;
    authority?: ServerSchedulingAuthority;
    review?: SchedulingMutationReview | null;
  },
) {
  await assertOperationalStaff(
    tx,
    options.organizationId,
    options.candidate.resourceUserIds,
  );
  return prepareNativeSchedulingAdmission(
    tx,
    options.organizationId,
    options.authority,
    options.before ?? null,
    options.candidate,
    options.review ?? null,
  );
}

async function sourceFor(
  tx: ScheduleTransaction,
  values: AppointmentInsert,
): Promise<ManualSourceRef> {
  const contactId = await appointmentCustomer(
    tx,
    values.organizationId,
    values,
    { requireCoherentLeadProperty: true },
  );
  return {
    sourceKind: values.leadId
      ? "lead"
      : contactId
        ? "direct_customer"
        : "unlinked_manual",
    leadId: values.leadId ?? null,
    contactId,
    propertyId: values.propertyId ?? null,
    estimateId: null,
  };
}
function capacityConflict(error: unknown) {
  return (
    error instanceof SchedulingPolicyError &&
    error.code === "inspection_capacity_conflict"
  );
}

export async function insertInspectionIfAvailable(
  values: AppointmentInsert & { scheduledStart: Date },
): Promise<AppointmentRow | null> {
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, values.organizationId);
    return insertInspectionInTransaction(tx, values);
  });
}

/** Caller owns lifecycle/schedule. Actorless legacy compatibility never creates protected authority. */
export async function insertInspectionInTransaction(
  tx: ScheduleTransaction,
  values: AppointmentInsert & { scheduledStart: Date },
): Promise<AppointmentRow | null> {
  const end =
    values.scheduledEnd ??
    new Date(values.scheduledStart.getTime() + 2 * 3600000);
  assertScheduleInterval(values.scheduledStart, end);
  const source = await sourceFor(tx, values),
    id = values.id ?? randomUUID();
  const candidate: SchedulingCandidate = {
    kind: "appointment",
    id,
    startAt: values.scheduledStart.toISOString(),
    endAt: end.toISOString(),
    type: values.type ?? "inspection",
    status: values.status ?? "scheduled",
    resourceUserIds: values.assignedUserId ? [values.assignedUserId] : [],
    source,
    reservation: null,
  };
  try {
    const admission = await prepareInspectionInTransaction(tx, {
      organizationId: values.organizationId,
      candidate,
    });
    return (
      await tx
        .insert(appointmentsTable)
        .values({
          ...values,
          id,
          contactId: source.contactId,
          scheduledEnd: end,
          schedulingReservation: admission.snapshot,
        })
        .returning()
    )[0];
  } catch (error) {
    if (capacityConflict(error)) return null;
    throw error;
  }
}

export async function updateInspectionIfAvailable(
  organizationId: string,
  appointmentId: string,
  set: Partial<AppointmentInsert>,
  window: { start: Date; end?: Date | null },
): Promise<AppointmentRow | null | "conflict"> {
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, organizationId);
    return updateInspectionInTransaction(
      tx,
      organizationId,
      appointmentId,
      set,
      window,
    );
  });
}

export async function updateInspectionInTransaction(
  tx: ScheduleTransaction,
  organizationId: string,
  appointmentId: string,
  set: Partial<AppointmentInsert>,
  window: { start: Date; end?: Date | null },
): Promise<AppointmentRow | null | "conflict"> {
  const where = and(
    eq(appointmentsTable.organizationId, organizationId),
    eq(appointmentsTable.id, appointmentId),
  );
  const [current] = await tx
    .select()
    .from(appointmentsTable)
    .where(where)
    .for("update");
  if (!current) return null;
  const { guardWorkdayAppointment } = await import("./workday-guards");
  await guardWorkdayAppointment(
    tx,
    organizationId,
    appointmentId,
    current,
    set,
  );
  const end = window.end ?? new Date(window.start.getTime() + 2 * 3600000);
  assertScheduleInterval(window.start, end);
  if (
    projectSchedulingEvidence("appointment", current).schedulingEvidence ===
    "invalid"
  )
    throw new SchedulingPolicyError(
      "invalid_reservation_snapshot",
      "Review the original scheduling evidence.",
    );
  const values = {
    ...current,
    ...set,
    organizationId,
    id: appointmentId,
    scheduledStart: window.start,
    scheduledEnd: end,
  };
  const source = await sourceFor(tx, values);
  const before = nativeSchedulingCandidate(
    "appointment",
    current,
    await sourceFor(tx, current),
  );
  const candidate = nativeSchedulingCandidate(
    "appointment",
    { ...values, schedulingReservation: null },
    source,
  );
  try {
    const admission = await prepareInspectionInTransaction(tx, {
      organizationId,
      candidate,
      before,
    });
    return (
      (
        await tx
          .update(appointmentsTable)
          .set({
            ...set,
            scheduledStart: window.start,
            scheduledEnd: end,
            schedulingReservation: admission.snapshot,
          })
          .where(where)
          .returning()
      )[0] ?? null
    );
  } catch (error) {
    if (capacityConflict(error)) return "conflict";
    throw error;
  }
}
