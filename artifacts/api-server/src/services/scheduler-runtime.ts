import { randomUUID } from "node:crypto";
import {
  db,
  pool,
  schedulerRuntimeTable as runtime,
  scheduledActionsTable as actions,
  revenueExecutionsTable as executions,
  webhookDeliveriesTable as deliveries,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export const SCHEDULER_NAME = "automation";
export const SCHEDULER_STALE_MS = 5 * 60_000;
export const SCHEDULER_STAGES = [
  "mailbox-replies",
  "scheduled-actions",
  "missed-call-care",
  "callie-intake",
  "service-watch",
  "staff-lead-notifications",
  "reactivation-drain",
  "webhook-retries",
  "webhook-secret-cleanup",
  "abandoned-chat-sweep",
  "portal-credential-cleanup",
  "email-intelligence-retention",
  "service-reply-retention",
  "lead-reply-retention",
  "api-key-expiry-reminders",
  "upload-cleanup",
] as const;
export type SchedulerStage = (typeof SCHEDULER_STAGES)[number];
export type StageObserver = (
  stage: SchedulerStage,
  phase: "running" | "succeeded" | "failed",
) => Promise<void>;

/**
 * The session lock serializes cycles across rolling deploys and multiple machines.
 * Requires direct PostgreSQL or session pooling, not transaction-mode PgBouncer.
 * The lock is NOT an exactly-once guarantee: durable action receipts remain the
 * safety boundary if a process/connection dies while an external effect is in flight.
 */
export async function runSchedulerCycle(
  work: (observe: StageObserver) => Promise<void>,
  {
    name = SCHEDULER_NAME,
    ownerId = randomUUID(),
    intervalMs = 60_000,
  }: { name?: string; ownerId?: string; intervalMs?: number } = {},
): Promise<"idle" | "degraded" | "busy"> {
  const client = await pool.connect();
  let owned = false;
  let connectionLost = false;
  const lost = () => {
    connectionLost = true;
  };
  client.on("error", lost);
  const failedStages: string[] = [];
  try {
    const acquireQuery = {
      text: "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      values: [`growthos:scheduler:${name}`],
      query_timeout: 5_000,
    };
    const result = await client.query<{ acquired: boolean }>(acquireQuery);
    owned = result.rows[0]?.acquired === true;
    if (!owned) return "busy";
    const now = new Date();
    await db
      .insert(runtime)
      .values({
        name,
        ownerId,
        state: "running",
        intervalMs,
        startedAt: now,
        heartbeatAt: now,
      })
      .onConflictDoUpdate({
        target: runtime.name,
        set: {
          ownerId,
          state: "running",
          intervalMs,
          startedAt: now,
          heartbeatAt: now,
          currentStage: null,
          failedStages: [],
        },
      });
    const observe: StageObserver = async (stage, phase) => {
      if (connectionLost)
        throw new Error("Scheduler ownership connection was lost.");
      if (phase === "failed") failedStages.push(stage);
      const [heartbeat] = await db
        .update(runtime)
        .set({
          heartbeatAt: new Date(),
          currentStage: phase === "running" ? stage : null,
          failedStages: [...failedStages],
        })
        .where(and(eq(runtime.name, name), eq(runtime.ownerId, ownerId)))
        .returning({ name: runtime.name });
      // A lost/replaced runtime row must stop stage progression at this
      // observer boundary, even if the lock connection emitted no error.
      if (!heartbeat)
        throw new Error("Scheduler runtime ownership was lost.");
    };
    try {
      await work(observe);
      if (connectionLost)
        throw new Error("Scheduler ownership connection was lost.");
    } catch {
      failedStages.push("cycle-interrupted");
      // No error objects: DB/provider exceptions can contain customer data or keys.
      console.error(
        "[scheduler] cycle interrupted; review background work health",
      );
    }
    const state = failedStages.length ? "degraded" : "idle";
    // Never overwrite a replacement owner's heartbeat after losing the lock.
    if (!connectionLost)
      await db
        .update(runtime)
        .set({
          state,
          completedAt: new Date(),
          heartbeatAt: new Date(),
          currentStage: null,
          failedStages,
        })
        .where(and(eq(runtime.name, name), eq(runtime.ownerId, ownerId)));
    return state;
  } finally {
    if (owned && !connectionLost) {
      try {
        const unlockQuery = {
          text: "SELECT pg_advisory_unlock(hashtext($1))",
          values: [`growthos:scheduler:${name}`],
          query_timeout: 5_000,
        };
        await client.query(unlockQuery);
      } catch {
        connectionLost = true;
      }
    }
    client.removeListener("error", lost);
    // A timed-out acquire could have obtained the lock server-side. Destroy any
    // connection whose ownership was never confirmed, so it cannot leak a lock.
    client.release(connectionLost || !owned);
  }
}

export async function markSchedulerStopped(ownerId: string) {
  await db
    .update(runtime)
    .set({ state: "stopped", currentStage: null, heartbeatAt: new Date() })
    .where(and(eq(runtime.name, SCHEDULER_NAME), eq(runtime.ownerId, ownerId)));
}

export function schedulerHealth(
  row: typeof runtime.$inferSelect | undefined,
  now = new Date(),
) {
  if (!row) return "not_observed" as const;
  if (row.state === "stopped") return "stopped" as const;
  if (now.getTime() - row.heartbeatAt.getTime() > SCHEDULER_STALE_MS)
    return "stale" as const;
  if (row.state === "degraded" || row.failedStages.length)
    return "degraded" as const;
  return row.state === "running" ? ("running" as const) : ("healthy" as const);
}

/** Secret-free aggregate health. Route must require a platform-admin SESSION. */
export async function getSchedulerHealth() {
  const [row] = await db
    .select()
    .from(runtime)
    .where(eq(runtime.name, SCHEDULER_NAME));
  const [queue] = await db
    .select({
      pending: sql<number>`count(*) FILTER (WHERE ${actions.status} = 'pending')::int`,
      due: sql<number>`count(*) FILTER (WHERE ${actions.status} = 'pending' AND ${actions.runAt} <= now())::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${actions.status} = 'failed')::int`,
      oldestDueAt: sql<
        string | null
      >`min(${actions.runAt}) FILTER (WHERE ${actions.status} = 'pending' AND ${actions.runAt} <= now())`,
    })
    .from(actions);
  const [receipts] = await db
    .select({
      needingReview: sql<number>`count(*) FILTER (WHERE ${executions.state} = 'indeterminate' OR (${executions.state} = 'processing' AND ${executions.expiresAt} < now()))::int`,
    })
    .from(executions);
  const [webhooks] = await db
    .select({
      failed: sql<number>`count(*) FILTER (WHERE ${deliveries.status} = 'failed')::int`,
    })
    .from(deliveries);
  return {
    serverNow: new Date().toISOString(),
    health: schedulerHealth(row),
    staleAfterSeconds: SCHEDULER_STALE_MS / 1_000,
    heartbeatAt: row?.heartbeatAt.toISOString() ?? null,
    startedAt: row?.startedAt.toISOString() ?? null,
    completedAt: row?.completedAt?.toISOString() ?? null,
    intervalSeconds: row ? row.intervalMs / 1_000 : null,
    currentStage: row?.currentStage ?? null,
    failedStages: row?.failedStages ?? [],
    queue,
    executionsNeedingReview: receipts.needingReview,
    failedWebhookDeliveries: webhooks.failed,
    boundary:
      "Runtime health is not delivery proof. Review uncertain actions in the owning client's Revenue Desk before taking any new action. Failed counts include historical records.",
  };
}
