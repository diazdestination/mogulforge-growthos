// Import through one tsx namespace so the probe can close the scheduler's pool.
// Do not import scheduler.ts, automation.ts, app.ts, or any provider here.
export { runSchedulerCycle, schedulerHealth } from "../artifacts/api-server/src/services/scheduler-runtime";
export { pool } from "../lib/db/src/index";
