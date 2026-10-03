import { createHash } from "node:crypto";
import {
  db,
  revenueExecutionsTable as executions,
  revenueExecutionEventsTable as events,
  type ExecutionState,
} from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";
import { lockReplyLead } from "./response-correlation";
import { lockContractorSchedule } from "./contractor-scheduling";
import { acquireNurtureLocks } from "./source-outreach-ownership";
import { reserveContactTouch, type ContactTouchClaim } from "./contact-touch-claim";
import { sourceNurtureStepsTable } from "../../../../lib/db/src/schema/source-nurture";

// Sorting makes retries independent of JSON key order. Only the digest is retained.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function runDurableAction(input: {
  organizationId: string;
  actionKey: string;
  kind: string;
  payload: unknown;
  actorUserId?: string | null;
  leadId?: string | null;
  appointmentId?: string | null;
  /** Exact original service approval; serializes pending allowance with ownership. */
  serviceCare?: { approvalId: string; scheduledActionId: string };
  /** Shared allowance for an exact original server-resolved effect. */
  contactTouch?: ContactTouchClaim;
  sourceNurture?: { stepId: string };
  execute: () => Promise<{ state: "succeeded" | "blocked"; detail: string }>;
}) {
  const fingerprint = createHash("sha256")
    .update(canonical(input.payload))
    .digest("hex");
  const claimed = await db.transaction(async (tx) => {
    let claimActor = input.actorUserId;
    if (input.contactTouch || input.serviceCare || input.sourceNurture) await acquireNurtureLocks(tx, input.organizationId, input.leadId ? [input.leadId] : []);
    const [prior] = await tx.select().from(executions).where(and(eq(executions.organizationId, input.organizationId), eq(executions.actionKey, input.actionKey)));
    if (!prior && input.contactTouch) {
      if (input.contactTouch.organizationId !== input.organizationId || input.contactTouch.logicalKey !== input.actionKey) throw new Error("Invalid shared allowance identity.");
      const allowance = await reserveContactTouch(tx, input.contactTouch);
      if (!allowance.created) throw new Error("An earlier allowance owns this effect. Reconciliation is required.");
    }
    if (!prior && input.sourceNurture) {
      const { assertNurtureStepCurrent, nurtureTouch } = await import("./source-nurture-authority");
      const current = await assertNurtureStepCurrent(tx, input.organizationId, input.sourceNurture.stepId, { phase: "claim" });
      if (input.kind !== "source_nurture_email" || input.actionKey !== `scheduled:${current.scheduled.id}` || fingerprint !== current.executionFingerprint || input.leadId !== current.item.leadId) throw new Error("Invalid nurture claim identity.");
      const allowance = await reserveContactTouch(tx, nurtureTouch(current));
      if (!allowance.created) throw new Error("An earlier allowance owns this effect. Reconciliation is required.");
      await tx.update(sourceNurtureStepsTable).set({ claimedAt: new Date(), reason: null }).where(and(eq(sourceNurtureStepsTable.organizationId, input.organizationId), eq(sourceNurtureStepsTable.id, current.step.id)));
      claimActor = current.plan.approvedByUserId;
    }
    if (input.serviceCare) {
      const { lockServiceStanding } = await import("./service-standing-policy");
      await lockServiceStanding(tx, input.organizationId);
      if (!prior) {
        if (input.kind !== "service_care_reminder" || input.actionKey !== `scheduled:${input.serviceCare.scheduledActionId}`) throw new Error("Invalid service claim context.");
        const { checkServiceClaimBudget } = await import("./service-care-claim");
        const claim = await checkServiceClaimBudget(tx, input.organizationId, input.serviceCare.approvalId, input.serviceCare.scheduledActionId);
        const allowance = await reserveContactTouch(tx, { organizationId: input.organizationId, logicalKey: input.actionKey, contactId: claim.contact.id, address: claim.approval.snapshot.recipient,
          channel: claim.approval.snapshot.channel, sourceKind: "service", payload: input.payload });
        if (!allowance.created) throw new Error("An earlier allowance owns this effect. Reconciliation is required.");
      }
    }
    if (input.appointmentId) await lockContractorSchedule(tx, input.organizationId);
    if (input.leadId) await lockReplyLead(tx, input.organizationId, input.leadId);
    const [row] = await tx
      .insert(executions)
      .values({
        organizationId: input.organizationId,
        actionKey: input.actionKey,
        kind: input.kind,
        fingerprint,
        actorUserId: claimActor,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })
      .onConflictDoNothing()
      .returning();
    if (row)
      await tx.insert(events).values({
        organizationId: row.organizationId,
        executionId: row.id,
        state: "processing",
        detail: "Execution ownership acquired.",
        actorUserId: claimActor,
      });
    return row;
  });
  if (!claimed) {
    const [existing] = await db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.organizationId, input.organizationId),
          eq(executions.actionKey, input.actionKey),
        ),
      );
    if (!existing || existing.fingerprint !== fingerprint)
      throw new Error("Action retry conflicts with its original payload.");
    // Never reclaim an expired external effect. It may already have happened.
    if (
      existing.state === "processing" &&
      existing.expiresAt.getTime() < Date.now()
    ) {
      await transitionExecution(
        existing.id,
        input.organizationId,
        "processing",
        "indeterminate",
        "Interrupted execution: reconcile the result before any new action.",
        null,
      );
      return readExecution(existing.id, input.organizationId);
    }
    return existing;
  }
  try {
    const result = await input.execute();
    return (
      (await transitionExecution(
        claimed.id,
        input.organizationId,
        "processing",
        result.state,
        result.detail,
        input.actorUserId ?? null,
      )) ?? (await readExecution(claimed.id, input.organizationId))
    );
  } catch {
    // Error text can contain provider credentials/customer content. Store a safe code-level explanation.
    return (
      (await transitionExecution(
        claimed.id,
        input.organizationId,
        "processing",
        "indeterminate",
        "Execution interrupted. The effect may have occurred; automatic replay is blocked.",
        input.actorUserId ?? null,
      )) ?? (await readExecution(claimed.id, input.organizationId))
    );
  }
}

async function readExecution(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(executions)
    .where(
      and(eq(executions.id, id), eq(executions.organizationId, organizationId)),
    );
  if (!row)
    throw new Error(
      "Execution receipt is unavailable; do not replay the action.",
    );
  return row;
}

async function transitionExecution(
  id: string,
  org: string,
  from: ExecutionState,
  state: ExecutionState,
  detail: string,
  actor: string | null,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(executions)
      .set({ state, detail: detail.slice(0, 1000), completedAt: new Date() })
      .where(
        and(
          eq(executions.id, id),
          eq(executions.organizationId, org),
          eq(executions.state, from),
        ),
      )
      .returning();
    if (row)
      await tx.insert(events).values({
        organizationId: org,
        executionId: id,
        state,
        detail: detail.slice(0, 1000),
        actorUserId: actor,
      });
    return row;
  });
}

export async function expireInterruptedActions(organizationId: string) {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.organizationId, organizationId),
        eq(executions.state, "processing"),
        lt(executions.expiresAt, new Date()),
      ),
    )
    .limit(100);
  for (const row of rows)
    await transitionExecution(
      row.id,
      organizationId,
      "processing",
      "indeterminate",
      "Execution exceeded its ownership window. Check the underlying result; do not resend blindly.",
      null,
    );
}

export async function reconcileExecution(
  org: string,
  id: string,
  actor: string,
  state: "confirmed_succeeded" | "confirmed_not_performed",
  evidence: string,
) {
  // An attestation never requeues a send, changes a proposal, or claims provider verification.
  return transitionExecution(
    id,
    org,
    "indeterminate",
    state,
    `Operator-recorded reconciliation: ${evidence}`,
    actor,
  );
}
