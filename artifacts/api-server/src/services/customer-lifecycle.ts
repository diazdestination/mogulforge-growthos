import { randomUUID } from "node:crypto";
import { auditEventsTable, customerLifecycleTable, db, organizationsTable, usersTable, type CustomerLifecycleState } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";

export class CustomerLifecycleHoldError extends Error {
  readonly status = 423;
  readonly code = "customer_lifecycle_paused";
  constructor() { super("This company's capture, automation and outbound work is paused. An owner or administrator must review its operating status."); }
}
export class CustomerLifecycleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const lifecycleTransitionSchema = z.object({
  action: z.enum(["pause", "resume", "request_offboarding", "cancel_offboarding"]),
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(10).max(500),
  resumeQueuedWork: z.boolean().optional(),
}).strict();
export type CustomerLifecycleStatus = {
  state: CustomerLifecycleState; version: number; automationAllowed: boolean;
  requestId: string | null; requestedAt: string | null; updatedAt: string | null;
  reason: string | null; deletionPerformed: false; billingChanged: false;
};
type LifecycleDb = Pick<typeof db, "select">;
async function statusFromDatabase(organizationId: string, reader: LifecycleDb): Promise<CustomerLifecycleStatus> {
  const [org] = await reader.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!org) throw new CustomerLifecycleError(404, "organization_missing", "Company not found.");
  const [row] = await reader.select().from(customerLifecycleTable).where(eq(customerLifecycleTable.organizationId, organizationId));
  if (row && !["active", "paused", "offboarding_requested"].includes(row.state)) throw new CustomerLifecycleHoldError();
  return {
    state: row?.state ?? "active", version: row?.version ?? 0,
    automationAllowed: !row || row.state === "active",
    requestId: row?.requestId ?? null, requestedAt: row?.requestedAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null, reason: row?.reason ?? null,
    deletionPerformed: false, billingChanged: false,
  };
}
export const getCustomerLifecycleStatus = (organizationId: string, reader: LifecycleDb = db) => statusFromDatabase(organizationId, reader);

/** Recheck at each intake/claim/effect boundary. DB errors propagate; never cache an allow. */
export async function assertCustomerLifecycleActive(organizationId: string): Promise<void> {
  if (!(await getCustomerLifecycleStatus(organizationId)).automationAllowed) throw new CustomerLifecycleHoldError();
}

/** Service-level role recheck also protects direct callers and stale sessions. */
export async function assertLifecycleManager(reader: LifecycleDb, organizationId: string, userId: string) {
  const [user] = await reader.select({ role: usersTable.role }).from(usersTable).where(and(
    eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true),
  ));
  if (!user || !["owner", "admin"].includes(user.role)) throw new CustomerLifecycleError(403, "lifecycle_manager_required", "An active company owner or administrator is required.");
}

export async function transitionCustomerLifecycle(organizationId: string, userId: string, input: unknown) {
  const parsed = lifecycleTransitionSchema.safeParse(input);
  if (!parsed.success) throw new CustomerLifecycleError(400, "invalid_lifecycle_transition", "Choose an action, current version and a reason of 10–500 characters.");
  const command = parsed.data;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true), set_config('statement_timeout', '5000ms', true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${organizationId}`}, 0))`);
    await assertLifecycleManager(tx, organizationId, userId);
    const previous = await statusFromDatabase(organizationId, tx);
    if (previous.version !== command.expectedVersion) throw new CustomerLifecycleError(409, "lifecycle_version_changed", "Company status changed. Refresh and review it before trying again.");
    const valid = command.action === "pause" ? previous.state === "active"
      : command.action === "resume" ? previous.state === "paused"
      : command.action === "request_offboarding" ? previous.state !== "offboarding_requested"
      : previous.state === "offboarding_requested";
    if (!valid) throw new CustomerLifecycleError(409, "lifecycle_transition_unavailable", "This action is unavailable for the company's current status.");
    if (command.action === "resume" && command.resumeQueuedWork !== true) throw new CustomerLifecycleError(400, "queued_work_review_required", "Review pending work and explicitly confirm it may resume.");
    const state: CustomerLifecycleState = command.action === "resume" ? "active"
      : command.action === "request_offboarding" ? "offboarding_requested" : "paused";
    const requestId = command.action === "request_offboarding" ? randomUUID() : previous.requestId;
    const requestedAt = command.action === "request_offboarding" ? new Date()
      : previous.requestedAt ? new Date(previous.requestedAt) : null;
    const next = { organizationId, state, version: previous.version + 1, reason: command.reason,
      requestId, requestedAt, updatedByUserId: userId, updatedAt: new Date() };
    await tx.insert(customerLifecycleTable).values(next).onConflictDoUpdate({ target: customerLifecycleTable.organizationId, set: next });
    await tx.insert(auditEventsTable).values({ organizationId, actorUserId: userId,
      action: `customer_lifecycle.${command.action}`, entityType: "organization", entityId: organizationId,
      metadata: { from: previous.state, to: state, version: next.version, requestId,
        reason: command.reason, resumeQueuedWork: command.action === "resume", deletionPerformed: false, billingChanged: false } });
    return statusFromDatabase(organizationId, tx);
  });
}
