import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Platform operational metadata only. Never store job payloads or provider errors. */
export const schedulerRuntimeTable = pgTable("scheduler_runtime", {
  name: text("name").primaryKey(),
  ownerId: text("owner_id").notNull(),
  state: text("state")
    .$type<"running" | "idle" | "degraded" | "stopped">()
    .notNull(),
  intervalMs: integer("interval_ms").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  currentStage: text("current_stage"),
  failedStages: jsonb("failed_stages").$type<string[]>().notNull().default([]),
});
