// Code-only synthetic crash probe. Never import app.ts, index.ts, or scheduler.ts.
export { pool } from "../lib/db/src/index";
export { runDurableAction } from "../artifacts/api-server/src/services/durable-execution";
export { processScheduledWork } from "../artifacts/api-server/src/services/automation";
export { getSchedulerHealth } from "../artifacts/api-server/src/services/scheduler-runtime";
