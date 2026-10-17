import { and, eq } from "drizzle-orm";
import { appointmentsTable, db, projectsTable } from "@workspace/db";
import {
  type ManualSchedulingAck,
  type ManualSchedulingCommand,
} from "@workspace/scheduling-core";
import {
  createAppointmentInTransaction,
  createProjectInTransaction,
  NativeSchedulingDomainError,
} from "./crm";
import { ScheduleError } from "./contractor-scheduling";
import {
  ManualSchedulingRefusal,
  runManualSchedulingCreate,
  validateManualSchedulingCommand,
} from "./manual-scheduling-receipt";
import {
  assertSchedulingActor,
  lockSchedulingConfiguration,
  projectSchedulingEvidence,
  SchedulingPolicyError,
  type SchedulingActor,
} from "./scheduling-policy";
import type { ServerSchedulingAuthority } from "./scheduling-admission";

// Explicit deterministic domain failures only. Authentication, lifecycle, transaction
// misuse, malformed input, SQLSTATEs, unknown errors and code-shaped objects escape.
const schedulingRefusals = new Set([
  "stale_scheduling_review",
  "invalid_scheduling_policy",
  "invalid_reservation_snapshot",
  "scheduling_coverage_limit",
  "resource_conflict",
  "travel_conflict",
  "company_capacity_conflict",
  "inspection_capacity_conflict",
  "invalid_wall_time",
  "ambiguous_wall_time",
]);
const nativeRefusals = new Set([
  "invalid_interval",
  "invalid_assignee",
  "resource_conflict",
  "stale_update",
  "estimate_lead_mismatch",
  "customer_reference_mismatch",
]);
function refuseDomain(error: unknown): never {
  if (
    error instanceof NativeSchedulingDomainError ||
    (error instanceof ScheduleError && nativeRefusals.has(error.code)) ||
    (error instanceof SchedulingPolicyError &&
      schedulingRefusals.has(error.code))
  )
    throw new ManualSchedulingRefusal(error.code);
  throw error;
}
export function nativeManualCommand(
  actor: SchedulingActor,
  kind: ManualSchedulingCommand["kind"],
  wire: Record<string, unknown>,
) {
  const { operationId, schedulingReview, ...body } = wire;
  return validateManualSchedulingCommand(actor, {
    operationId,
    kind,
    body,
    review: schedulingReview,
  });
}
export function manualSchedulingError(ack: ManualSchedulingAck) {
  return {
    error:
      ack.outcome === "no_commit_refused"
        ? "This original scheduling operation was refused. Review the recorded outcome."
        : "The original scheduling operation committed, but its record is no longer available.",
    code:
      ack.outcome === "no_commit_refused"
        ? ("manual_scheduling_refused" as const)
        : ("manual_scheduling_target_unavailable" as const),
    schedulingOperation: ack,
  };
}
async function run(
  actor: SchedulingActor,
  original: ManualSchedulingCommand,
  expected: ManualSchedulingCommand["kind"],
) {
  const command = validateManualSchedulingCommand(actor, original);
  if (command.kind !== expected)
    throw new SchedulingPolicyError(
      "invalid_scheduling_context",
      "Wrong native command kind.",
      400,
    );
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, actor.organizationId);
    await assertSchedulingActor(tx, actor, "crm.write");
    const authority: ServerSchedulingAuthority = {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      origin: "manual",
      sourceId: null,
      reviewMode: "reviewed",
    };
    const result = await runManualSchedulingCreate(
      tx,
      actor,
      command,
      async (callbackTx) => {
        try {
          if (command.kind === "appointment_create") {
            const { scheduledStart, scheduledEnd, ...body } = command.body;
            const record = await createAppointmentInTransaction(
              callbackTx,
              actor.organizationId,
              {
                ...body,
                scheduledStart: new Date(scheduledStart),
                ...(scheduledEnd !== undefined
                  ? { scheduledEnd: new Date(scheduledEnd) }
                  : {}),
                schedulingReview: command.review,
              },
              authority,
            );
            return { kind: "appointment" as const, id: record.id };
          }
          const { scheduledStart, scheduledEnd, ...body } = command.body;
          const record = await createProjectInTransaction(
            callbackTx,
            actor.organizationId,
            {
              ...body,
              ...(scheduledStart !== undefined
                ? { scheduledStart: new Date(scheduledStart) }
                : {}),
              ...(scheduledEnd !== undefined
                ? { scheduledEnd: new Date(scheduledEnd) }
                : {}),
              schedulingReview: command.review,
            },
            authority,
          );
          return { kind: "project" as const, id: record.id };
        } catch (error) {
          return refuseDomain(error);
        }
      },
    );
    const target = result.ack.target;
    // Original ID lookup only; mutable lineage/policy cannot reinterpret custody.
    const appointment =
      target?.kind === "appointment" && target.available
        ? ((
            await tx
              .select()
              .from(appointmentsTable)
              .where(
                and(
                  eq(appointmentsTable.organizationId, actor.organizationId),
                  eq(appointmentsTable.id, target.id),
                ),
              )
          )[0] ?? null)
        : null;
    const project =
      target?.kind === "project" && target.available
        ? ((
            await tx
              .select()
              .from(projectsTable)
              .where(
                and(
                  eq(projectsTable.organizationId, actor.organizationId),
                  eq(projectsTable.id, target.id),
                ),
              )
          )[0] ?? null)
        : null;
    return { ...result, appointment, project };
  });
}
export async function createManualScheduledAppointment(
  actor: SchedulingActor,
  command: ManualSchedulingCommand,
) {
  const value = await run(actor, command, "appointment_create");
  return {
    record: value.appointment
      ? {
          ...value.appointment,
          ...projectSchedulingEvidence("appointment", value.appointment),
        }
      : null,
    ack: value.ack,
    newlyCreated: value.newlyCreated,
  };
}
export async function createManualScheduledProject(
  actor: SchedulingActor,
  command: ManualSchedulingCommand,
) {
  const value = await run(actor, command, "project_create");
  return {
    record: value.project
      ? {
          ...value.project,
          ...projectSchedulingEvidence("project", value.project),
        }
      : null,
    ack: value.ack,
    newlyCreated: value.newlyCreated,
  };
}
