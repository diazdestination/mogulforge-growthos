// Acceptance fixture only: no providers, no real customer data, never a server entrypoint.
import { db, pool, scheduledActionsTable, crmTasksTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { runDurableAction } from "../services/durable-execution";
import { processScheduledWork } from "../services/automation";
import { runSchedulerCycle } from "../services/scheduler-runtime";

const [mode, org, actionId, schedulerName] = process.argv.slice(2);
if (
  process.env.NODE_ENV !== "test" ||
  new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" ||
  !schedulerName.startsWith("restart-qa-")
)
  throw new Error("This worker is restricted to isolated loopback tests.");
async function main() {
  try {
    const result = await runSchedulerCycle(
      async (observe) => {
        if (mode === "resume") {
          await processScheduledWork(org, observe);
          return;
        }
        const [item] = await db
          .select()
          .from(scheduledActionsTable)
          .where(
            and(
              eq(scheduledActionsTable.organizationId, org),
              eq(scheduledActionsTable.id, actionId),
            ),
          );
        if (!item || item.action.type !== "create_task")
          throw new Error("Synthetic action required");
        await observe("scheduled-actions", "running");
        await runDurableAction({
          organizationId: org,
          actionKey: `scheduled:${item.id}`,
          kind: item.action.type,
          payload: { action: item.action, context: item.context },
          execute: async () => {
            // Simulate an effect committed outside the receipt transaction, followed
            // by a process crash before its completion acknowledgement is saved.
            await db
              .insert(crmTasksTable)
              .values({
                organizationId: org,
                title: String(item.action.params.title),
              });
            process.send?.({ phase: "effect-recorded" });
            await new Promise<void>(() => {});
            return {
              state: "succeeded",
              detail: "Unreachable before forced termination",
            };
          },
        });
      },
      { name: schedulerName },
    );
    if (result !== "idle")
      throw new Error("Replacement cycle did not finish cleanly");
    process.send?.({ phase: "resumed" });
  } finally {
    await pool.end();
    process.disconnect?.();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
