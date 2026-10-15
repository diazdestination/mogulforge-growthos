import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  appointmentsTable,
  auditEventsTable,
  db,
  projectsTable,
} from "@workspace/db";
import {
  canonicalSchedulingEnvelope,
  manualSchedulingCommandSchema,
  userIdSchema,
  uuidSchema,
  type ManualSchedulingAck,
  type ManualSchedulingCommand,
  type ManualSourceRef,
  type UUID,
} from "@workspace/scheduling-core";
import type { ScheduleTransaction } from "./contractor-scheduling";
import {
  assertSchedulingActor,
  lockSchedulingConfiguration,
  SchedulingPolicyError,
  type SchedulingActor,
} from "./scheduling-policy";
import {
  MANUAL_SCHEDULING_RECEIPT_ACTION,
  MANUAL_SCHEDULING_REFUSAL_ACTION,
  manualSchedulingBusinessRefusalSchema,
  manualSchedulingReceiptSchema,
  manualSchedulingRefusalCodeSchema,
  manualSchedulingTargetSchema,
  projectManualSchedulingReceipt,
} from "./scheduling-history";

/** Only trusted native callbacks may deliberately translate a proven refusal. */
export class ManualSchedulingRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The reviewed scheduling operation was refused.");
    this.code = manualSchedulingRefusalCodeSchema.parse(code);
  }
}
function invalidBinding(): never {
  throw new SchedulingPolicyError(
    "invalid_scheduling_context",
    "The original scheduling command does not match its reviewed company and source.",
    400,
  );
}
function identityConflict(): never {
  throw new SchedulingPolicyError(
    "operation_identity_conflict",
    "This operation identity cannot be used for this command.",
    409,
  );
}

/** Pure original-wire checks. Never resolve mutable parents or current policy. */
export function validateManualSchedulingCommand(
  actor: SchedulingActor,
  original: unknown,
): ManualSchedulingCommand {
  const command = manualSchedulingCommandSchema.parse(original);
  const source = command.review.context.source;
  if (command.review.context.organizationId !== actor.organizationId || !source)
    invalidBinding();
  if (command.kind === "project_create") {
    if (
      source.sourceKind !== "lead" ||
      source.leadId !== command.body.leadId ||
      source.estimateId !== (command.body.estimateId ?? null)
    )
      invalidBinding();
  } else {
    const body = command.body;
    if (body.leadId !== undefined) {
      if (
        source.sourceKind !== "lead" ||
        source.leadId !== body.leadId ||
        (body.contactId !== undefined && source.contactId !== body.contactId)
      )
        invalidBinding();
    } else if (body.contactId !== undefined) {
      if (
        source.sourceKind !== "direct_customer" ||
        source.contactId !== body.contactId
      )
        invalidBinding();
    } else if (source.sourceKind !== "unlinked_manual") invalidBinding();
    if (source.propertyId !== (body.propertyId ?? null)) invalidBinding();
  }
  return command;
}
function prepare(actor: SchedulingActor, original: unknown) {
  const authority = {
    organizationId: uuidSchema.parse(actor.organizationId),
    userId: userIdSchema.parse(actor.userId),
  };
  const command = validateManualSchedulingCommand(authority, original);
  const payloadSha256 = createHash("sha256")
    .update(
      canonicalSchedulingEnvelope({
        organizationId: authority.organizationId,
        actorUserId: authority.userId,
        kind: command.kind,
        body: command.body,
        review: command.review,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    actor: authority,
    command,
    source: command.review.context.source as ManualSourceRef,
    payloadSha256,
  };
}
type Prepared = ReturnType<typeof prepare>;
type Target = { kind: "appointment" | "project"; id: UUID };
async function targetAvailable(
  tx: ScheduleTransaction,
  organizationId: UUID,
  target: Target,
) {
  const table =
    target.kind === "appointment" ? appointmentsTable : projectsTable;
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(eq(table.organizationId, organizationId), eq(table.id, target.id)),
    )
    .limit(1);
  return Boolean(row);
}
async function lockAndReadReceipt(
  tx: ScheduleTransaction,
  prepared: Prepared,
): Promise<ManualSchedulingAck | null> {
  if (tx === (db as unknown))
    throw new SchedulingPolicyError(
      "scheduling_transaction_required",
      "Manual scheduling requires the caller transaction.",
      503,
    );
  const { actor, command, source, payloadSha256 } = prepared;
  // Global, like audit_events.id. The caller already holds lifecycle/schedule/actor.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`manual-scheduling:${command.operationId}`},0))`,
  );
  const [row] = await tx
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.id, command.operationId));
  if (!row) return null;
  const ack = projectManualSchedulingReceipt(row, false);
  if (
    !ack ||
    ack.organizationId !== actor.organizationId ||
    ack.actorUserId !== actor.userId ||
    ack.kind !== command.kind ||
    ack.payloadSha256 !== payloadSha256 ||
    JSON.stringify(ack.source) !== JSON.stringify(source)
  )
    identityConflict();
  if (ack.target)
    ack.target.available = await targetAvailable(
      tx,
      actor.organizationId,
      ack.target,
    );
  return ack;
}
async function retain(
  tx: ScheduleTransaction,
  prepared: Prepared,
  target: Target | null,
  refusalCode: string | null,
): Promise<ManualSchedulingAck> {
  const { actor, command, source, payloadSha256 } = prepared;
  const recordedAt = new Date().toISOString();
  const metadata = manualSchedulingReceiptSchema.parse({
    formatVersion: 1,
    kind: command.kind,
    source,
    payloadSha256,
    outcome: target ? "committed" : "no_commit_refused",
    target,
    refusalCode,
    recordedAt,
  });
  const [row] = await tx
    .insert(auditEventsTable)
    .values({
      id: command.operationId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: MANUAL_SCHEDULING_RECEIPT_ACTION,
      entityType:
        command.kind === "appointment_create" ? "appointment" : "project",
      entityId: target?.id ?? null,
      metadata,
    })
    .returning();
  if (refusalCode !== null) {
    await tx
      .insert(auditEventsTable)
      .values({
        id: randomUUID(),
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: MANUAL_SCHEDULING_REFUSAL_ACTION,
        entityType:
          command.kind === "appointment_create" ? "appointment" : "project",
        entityId: null,
        metadata: manualSchedulingBusinessRefusalSchema.parse({
          formatVersion: 1,
          source,
          target: null,
          reason: refusalCode,
          recordedAt,
        }),
      });
  }
  const ack = projectManualSchedulingReceipt(row, target !== null);
  if (!ack) throw Error("Stored scheduling receipt failed validation");
  return ack;
}

/** Caller's outer transaction owns lifecycle -> schedule -> accepted actor. */
export async function runManualSchedulingCreate(
  tx: ScheduleTransaction,
  actor: SchedulingActor,
  command: ManualSchedulingCommand,
  create: (tx: ScheduleTransaction) => Promise<Target>,
): Promise<{ ack: ManualSchedulingAck; newlyCreated: boolean }> {
  const prepared = prepare(actor, command);
  const prior = await lockAndReadReceipt(tx, prepared);
  if (prior) return { ack: prior, newlyCreated: false };
  let target: Target;
  try {
    // Drizzle's nested transaction is a SAVEPOINT on the SAME PostgreSQL session.
    // It is deliberately opened after authority/receipt locks so refusal rollback
    // removes callback side effects without releasing permanent-operation custody.
    target = await tx.transaction(async (savepoint) => {
      const result = manualSchedulingTargetSchema.parse(
        await create(savepoint),
      );
      if (
        result.kind !==
          (prepared.command.kind === "appointment_create"
            ? "appointment"
            : "project") ||
        !(await targetAvailable(
          savepoint,
          prepared.actor.organizationId,
          result,
        ))
      )
        throw Error(
          "Native scheduling callback returned an unavailable target",
        );
      return result;
    });
  } catch (error) {
    if (!(error instanceof ManualSchedulingRefusal)) throw error;
    return {
      ack: await retain(tx, prepared, null, error.code),
      newlyCreated: false,
    };
  }
  // Insert failures must escape and roll back the OUTER transaction, not become refusal.
  return { ack: await retain(tx, prepared, target, null), newlyCreated: true };
}

/** Non-creating terminal reconciliation; absence becomes a permanent fence. */
export async function reconcileManualScheduling(
  actor: SchedulingActor,
  original: unknown,
): Promise<ManualSchedulingAck> {
  const prepared = prepare(actor, original);
  return db.transaction(async (tx) => {
    await lockSchedulingConfiguration(tx, prepared.actor.organizationId);
    await assertSchedulingActor(tx, prepared.actor, "crm.write");
    const prior = await lockAndReadReceipt(tx, prepared);
    return prior ?? retain(tx, prepared, null, "original_create_fenced");
  });
}
