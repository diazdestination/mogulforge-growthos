import {
  db,
  zapierActionExecutionsTable,
  type ZapierActionExecution,
  type ZapierExecutionState,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { recordAudit } from "../audit";
import { runDurableAction } from "../durable-execution";
import { outboundDeliveryHeld } from "../outbound-hold";
import {
  findZapierCandidate,
  getZapierCapability,
  summarizeZapierInput,
  type ZapierCapabilityDefinition,
} from "./zapier-capabilities";
import {
  getZapierBinding,
  getZapierPolicy,
  defaultPolicyFor,
  markZapierConnectionUsed,
  requireZapierServerUrl,
} from "./zapier-connection";
import {
  canonicalJson,
  sha256Hex,
  summarizeZapierResult,
  withZapierMcpSession,
  ZapierMcpError,
  ZAPIER_META_TOOLS,
} from "./zapier-mcp-client";

export { summarizeZapierResult };

/**
 * The execution ledger is the only path from a specialist to a Zapier action.
 *
 * Invariants (mirroring the claim-execution and durable-execution seams):
 * - One ledger row per (organization, idempotency key). A replay with a
 *   different request digest is rejected; an identical replay returns the
 *   original receipt and performs nothing.
 * - Writes are owned by a durable execution receipt. A thrown or timed-out
 *   write becomes `indeterminate` and is never retried automatically.
 * - Policy `off` blocks, `approve` parks writes for a human, `auto` runs
 *   inside the daily budget. Reads never wait for approval but are budgeted.
 * - The staging outbound hold blocks every write at the dispatch point.
 */

export class ZapierExecutionError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "conflict" | "not_found" | "not_pending",
  ) {
    super(message);
    this.name = "ZapierExecutionError";
  }
}

type PreparedRequest = {
  definition: ZapierCapabilityDefinition;
  app: string;
  action: string;
  zapierConnectionId: string | null;
  params: Record<string, unknown>;
  requestDigest: string;
  requestSummary: Record<string, unknown>;
};

async function prepareRequest(organizationId: string, capability: string, input: unknown): Promise<PreparedRequest | { blocked: string }> {
  const definition = getZapierCapability(capability);
  if (!definition) throw new ZapierExecutionError("Unknown Zapier capability.", "invalid_input");
  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ZapierExecutionError(`Invalid input for ${definition.key}: ${parsed.error.issues[0]?.message ?? "schema"}`, "invalid_input");
  }
  const binding = await getZapierBinding(organizationId, definition.key);
  if (!binding) return { blocked: "This capability is not bound to a Zapier action yet." };
  const candidate = findZapierCandidate(definition, {
    app: binding.zapierApp,
    appName: binding.zapierAppName,
    action: binding.zapierAction,
    actionName: binding.zapierActionName,
  });
  if (!candidate) return { blocked: "The bound action is no longer a reviewed match for this capability." };
  const params = candidate.toParams(parsed.data, binding.bindingConfig);
  const requestDigest = sha256Hex(
    canonicalJson({ capability: definition.key, app: binding.zapierApp, action: binding.zapierAction, params }),
  );
  return {
    definition,
    app: binding.zapierApp,
    action: binding.zapierAction,
    zapierConnectionId: binding.zapierConnectionId,
    params,
    requestDigest,
    requestSummary: summarizeZapierInput(definition, parsed.data),
  };
}

const COUNTED_STATES: ZapierExecutionState[] = ["executing", "succeeded", "indeterminate", "pending_approval"];

async function usedToday(organizationId: string, capability: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, organizationId),
        eq(zapierActionExecutionsTable.capability, capability),
        gte(zapierActionExecutionsTable.createdAt, startOfDay),
        inArray(zapierActionExecutionsTable.state, COUNTED_STATES),
      ),
    );
  return row?.count ?? 0;
}

async function readExecution(organizationId: string, id: string): Promise<ZapierActionExecution> {
  const [row] = await db
    .select()
    .from(zapierActionExecutionsTable)
    .where(and(eq(zapierActionExecutionsTable.organizationId, organizationId), eq(zapierActionExecutionsTable.id, id)));
  if (!row) throw new ZapierExecutionError("Zapier execution not found.", "not_found");
  return row;
}

async function transition(
  organizationId: string,
  id: string,
  from: ZapierExecutionState[],
  patch: Partial<typeof zapierActionExecutionsTable.$inferInsert> & { state: ZapierExecutionState },
): Promise<ZapierActionExecution | null> {
  const [row] = await db
    .update(zapierActionExecutionsTable)
    .set(patch)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, organizationId),
        eq(zapierActionExecutionsTable.id, id),
        inArray(zapierActionExecutionsTable.state, from),
      ),
    )
    .returning();
  return row ?? null;
}

export type ZapierActionRequest = {
  organizationId: string;
  capability: string;
  input: unknown;
  /** Caller-stable key, e.g. `invoice:${invoiceId}:v${version}`. */
  idempotencyKey: string;
  requestedByUserId?: string | null;
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
};

export type ZapierActionOutcome = {
  execution: ZapierActionExecution;
  /** Present only for reads that ran in this call; never persisted. */
  value?: unknown;
};

/**
 * Request a specialist action. Returns the ledger row in its resulting state:
 * blocked, pending_approval, succeeded, failed, or indeterminate.
 */
export async function requestZapierAction(request: ZapierActionRequest): Promise<ZapierActionOutcome> {
  const prepared = await prepareRequest(request.organizationId, request.capability, request.input);
  const definition = getZapierCapability(request.capability)!;
  const idempotencyKey = request.idempotencyKey.trim().slice(0, 200);
  if (!idempotencyKey) throw new ZapierExecutionError("An idempotency key is required.", "invalid_input");

  if ("blocked" in prepared) {
    const execution = await insertOrReuse(request, definition, idempotencyKey, {
      app: "unbound",
      action: "unbound",
      requestDigest: sha256Hex(canonicalJson({ capability: definition.key, blocked: prepared.blocked })),
      requestSummary: {},
      state: "blocked",
      detail: prepared.blocked,
      errorCode: "unbound",
    });
    return { execution: execution.execution };
  }

  const policy = (await getZapierPolicy(request.organizationId, definition.key)) ?? defaultPolicyFor(definition);
  if (policy.mode === "off") {
    const execution = await insertOrReuse(request, definition, idempotencyKey, {
      app: prepared.app,
      action: prepared.action,
      requestDigest: prepared.requestDigest,
      requestSummary: prepared.requestSummary,
      state: "blocked",
      detail: `${definition.specialistId.toUpperCase()} is switched off for this capability.`,
      errorCode: "policy_off",
    });
    return { execution: execution.execution };
  }

  const used = await usedToday(request.organizationId, definition.key);
  if (used >= policy.dailyBudget) {
    const execution = await insertOrReuse(request, definition, idempotencyKey, {
      app: prepared.app,
      action: prepared.action,
      requestDigest: prepared.requestDigest,
      requestSummary: prepared.requestSummary,
      state: "blocked",
      detail: `Daily budget of ${policy.dailyBudget} reached for this capability.`,
      errorCode: "budget_exhausted",
    });
    return { execution: execution.execution };
  }

  const needsApproval = definition.direction === "write" && policy.mode === "approve";
  const inserted = await insertOrReuse(request, definition, idempotencyKey, {
    app: prepared.app,
    action: prepared.action,
    requestDigest: prepared.requestDigest,
    requestSummary: prepared.requestSummary,
    state: needsApproval ? "pending_approval" : "executing",
    detail: needsApproval ? "Waiting for a human to approve this action." : "Executing.",
    errorCode: null,
  });
  if (inserted.reused) return { execution: inserted.execution };
  if (needsApproval) {
    await recordAudit({
      organizationId: request.organizationId,
      actorUserId: request.requestedByUserId ?? null,
      action: "zapier.action_requested",
      entityType: "zapier_action_execution",
      entityId: inserted.execution.id,
      metadata: { capability: definition.key, app: prepared.app, action: prepared.action },
    });
    return { execution: inserted.execution };
  }
  return execute(inserted.execution, prepared, request.requestedByUserId ?? null);
}

async function insertOrReuse(
  request: ZapierActionRequest,
  definition: ZapierCapabilityDefinition,
  idempotencyKey: string,
  values: {
    app: string;
    action: string;
    requestDigest: string;
    requestSummary: Record<string, unknown>;
    state: ZapierExecutionState;
    detail: string;
    errorCode: string | null;
  },
): Promise<{ execution: ZapierActionExecution; reused: boolean }> {
  const [row] = await db
    .insert(zapierActionExecutionsTable)
    .values({
      organizationId: request.organizationId,
      specialistId: definition.specialistId,
      capability: definition.key,
      direction: definition.direction,
      zapierApp: values.app,
      zapierAction: values.action,
      idempotencyKey,
      requestDigest: values.requestDigest,
      requestSummary: values.requestSummary,
      state: values.state,
      detail: values.detail,
      errorCode: values.errorCode,
      linkedEntityType: request.linkedEntityType ?? null,
      linkedEntityId: request.linkedEntityId ?? null,
      requestedByUserId: request.requestedByUserId ?? null,
      startedAt: values.state === "executing" ? new Date() : null,
      completedAt: values.state === "blocked" ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { execution: row, reused: false };
  const [existing] = await db
    .select()
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, request.organizationId),
        eq(zapierActionExecutionsTable.idempotencyKey, idempotencyKey),
      ),
    );
  if (!existing) throw new ZapierExecutionError("Zapier execution receipt is unavailable; do not replay.", "conflict");
  // A blocked receipt may be retried once the block is lifted; anything that
  // may have reached Zapier is final.
  if (existing.state === "blocked" && values.state !== "blocked") {
    const [reopened] = await db
      .update(zapierActionExecutionsTable)
      .set({
        zapierApp: values.app,
        zapierAction: values.action,
        requestDigest: values.requestDigest,
        requestSummary: values.requestSummary,
        state: values.state,
        detail: values.detail,
        errorCode: null,
        startedAt: values.state === "executing" ? new Date() : null,
        completedAt: null,
      })
      .where(and(eq(zapierActionExecutionsTable.id, existing.id), eq(zapierActionExecutionsTable.state, "blocked")))
      .returning();
    if (reopened) return { execution: reopened, reused: false };
  }
  if (existing.requestDigest !== values.requestDigest && existing.state !== "blocked") {
    throw new ZapierExecutionError("This action was already requested with a different payload.", "conflict");
  }
  return { execution: existing, reused: true };
}

async function execute(
  execution: ZapierActionExecution,
  prepared: PreparedRequest,
  actorUserId: string | null,
): Promise<ZapierActionOutcome> {
  const { organizationId } = execution;
  if (prepared.definition.direction === "write" && outboundDeliveryHeld()) {
    const blocked = await transition(organizationId, execution.id, ["executing"], {
      state: "blocked",
      detail: "Outbound actions are disabled by the staging safety hold.",
      errorCode: "outbound_hold",
      completedAt: new Date(),
    });
    return { execution: blocked ?? (await readExecution(organizationId, execution.id)) };
  }

  let serverUrl: string;
  let serverMode: "agentic" | "managed" | "unknown";
  try {
    const resolved = await requireZapierServerUrl(organizationId);
    serverUrl = resolved.serverUrl;
    serverMode = resolved.connection.serverMode;
  } catch (error) {
    const blocked = await transition(organizationId, execution.id, ["executing"], {
      state: "blocked",
      detail: "Zapier is not connected for this organization.",
      errorCode: error instanceof ZapierMcpError ? error.code : "not_configured",
      completedAt: new Date(),
    });
    return { execution: blocked ?? (await readExecution(organizationId, execution.id)) };
  }

  let value: unknown = undefined;
  let digest: string | null = null;
  let failure: ZapierMcpError | null = null;

  const callZapier = async (): Promise<{ state: "succeeded" | "blocked"; detail: string }> => {
    try {
      const result = await withZapierMcpSession(serverUrl, async (session) => {
        if (serverMode === "managed") return session.callTool(prepared.action, prepared.params);
        const tool = prepared.definition.direction === "write" ? ZAPIER_META_TOOLS.executeWrite : ZAPIER_META_TOOLS.executeRead;
        const args: Record<string, unknown> = {
          selected_api: prepared.app,
          action: prepared.action,
          params: prepared.params,
        };
        if (prepared.zapierConnectionId) args.connection_id = prepared.zapierConnectionId;
        return session.callTool(tool, args);
      });
      value = result.value;
      digest = result.digest;
      if (result.isError) {
        failure = new ZapierMcpError("Zapier reported the action failed.", "tool_failed");
        return { state: "blocked", detail: "Zapier reported the action failed." };
      }
      return { state: "succeeded", detail: "Zapier action completed." };
    } catch (error) {
      failure = error instanceof ZapierMcpError ? error : new ZapierMcpError("Zapier call failed.", "tool_failed");
      if (failure.indeterminate) throw failure; // durable kernel records indeterminate
      return { state: "blocked", detail: failure.message };
    }
  };

  let finalState: ZapierExecutionState;
  let detail: string;
  let durableExecutionId: string | null = null;
  if (prepared.definition.direction === "write") {
    const receipt = await runDurableAction({
      organizationId,
      actionKey: `zapier:${execution.id}`,
      kind: `zapier.${prepared.definition.key}`,
      payload: { capability: prepared.definition.key, app: prepared.app, action: prepared.action, digest: prepared.requestDigest },
      actorUserId,
      execute: callZapier,
    });
    durableExecutionId = receipt.id;
    finalState =
      receipt.state === "succeeded" ? "succeeded" : receipt.state === "indeterminate" ? "indeterminate" : "failed";
    detail = receipt.detail ?? "";
  } else {
    try {
      const outcome = await callZapier();
      finalState = outcome.state === "succeeded" ? "succeeded" : "failed";
      detail = outcome.detail;
    } catch (error) {
      finalState = "indeterminate";
      detail = error instanceof Error ? error.message : "Zapier read interrupted.";
    }
  }

  await markZapierConnectionUsed(organizationId, failure);
  const updated = await transition(organizationId, execution.id, ["executing"], {
    state: finalState,
    detail: detail.slice(0, 1000),
    errorCode: failure ? (failure as ZapierMcpError).code : null,
    responseDigest: digest,
    resultSummary: summarizeZapierResult(value),
    durableExecutionId,
    completedAt: new Date(),
  });
  await recordAudit({
    organizationId,
    actorUserId,
    action: `zapier.action_${finalState}`,
    entityType: "zapier_action_execution",
    entityId: execution.id,
    metadata: { capability: prepared.definition.key, app: prepared.app, action: prepared.action, errorCode: failure ? (failure as ZapierMcpError).code : null },
  });
  const final = updated ?? (await readExecution(organizationId, execution.id));
  return finalState === "succeeded" && prepared.definition.direction === "read" ? { execution: final, value } : { execution: final };
}

export async function approveZapierAction(input: {
  organizationId: string;
  executionId: string;
  userId: string;
}): Promise<ZapierActionExecution> {
  const existing = await readExecution(input.organizationId, input.executionId);
  if (existing.state !== "pending_approval") {
    throw new ZapierExecutionError("Only a pending action can be approved.", "not_pending");
  }
  // The request is re-derived from the linked entity by the specialist flow
  // that created it; the ledger stores only digests. Approval therefore
  // re-prepares through the flow registry.
  const { rebuildZapierRequestInput } = await import("./zapier-specialist-flows");
  const rebuilt = await rebuildZapierRequestInput(existing);
  const prepared = await prepareRequest(input.organizationId, existing.capability, rebuilt);
  if ("blocked" in prepared) {
    const blocked = await transition(input.organizationId, existing.id, ["pending_approval"], {
      state: "blocked",
      detail: prepared.blocked,
      errorCode: "unbound",
      completedAt: new Date(),
    });
    return blocked ?? existing;
  }
  if (prepared.requestDigest !== existing.requestDigest) {
    const blocked = await transition(input.organizationId, existing.id, ["pending_approval"], {
      state: "blocked",
      detail: "The underlying record changed since this action was requested. Request it again.",
      errorCode: "stale_request",
      completedAt: new Date(),
    });
    return blocked ?? existing;
  }
  const claimed = await transition(input.organizationId, existing.id, ["pending_approval"], {
    state: "executing",
    detail: "Approved; executing.",
    approvedByUserId: input.userId,
    approvedAt: new Date(),
    startedAt: new Date(),
  });
  if (!claimed) throw new ZapierExecutionError("Only a pending action can be approved.", "not_pending");
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "zapier.action_approved",
    entityType: "zapier_action_execution",
    entityId: existing.id,
    metadata: { capability: existing.capability },
  });
  return (await execute(claimed, prepared, input.userId)).execution;
}

export async function rejectZapierAction(input: {
  organizationId: string;
  executionId: string;
  userId: string;
  reason?: string;
}): Promise<ZapierActionExecution> {
  const rejected = await transition(input.organizationId, input.executionId, ["pending_approval"], {
    state: "rejected",
    detail: (input.reason?.trim() || "Rejected by a human reviewer.").slice(0, 500),
    approvedByUserId: input.userId,
    approvedAt: new Date(),
    completedAt: new Date(),
  });
  if (!rejected) throw new ZapierExecutionError("Only a pending action can be rejected.", "not_pending");
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: "zapier.action_rejected",
    entityType: "zapier_action_execution",
    entityId: rejected.id,
    metadata: { capability: rejected.capability },
  });
  return rejected;
}

export async function listZapierExecutions(
  organizationId: string,
  filters: { state?: ZapierExecutionState; capability?: string; limit?: number } = {},
): Promise<ZapierActionExecution[]> {
  const conditions = [eq(zapierActionExecutionsTable.organizationId, organizationId)];
  if (filters.state) conditions.push(eq(zapierActionExecutionsTable.state, filters.state));
  if (filters.capability) conditions.push(eq(zapierActionExecutionsTable.capability, filters.capability));
  return db
    .select()
    .from(zapierActionExecutionsTable)
    .where(and(...conditions))
    .orderBy(desc(zapierActionExecutionsTable.createdAt))
    .limit(Math.min(Math.max(filters.limit ?? 50, 1), 200));
}

export async function getZapierExecution(organizationId: string, id: string): Promise<ZapierActionExecution> {
  return readExecution(organizationId, id);
}
