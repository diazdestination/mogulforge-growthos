// One namespace for the real scheduler and its shared pool. No server bootstrap.
export { startAutomationScheduler, stopAutomationScheduler } from "../artifacts/api-server/src/services/scheduler";
export { pool } from "../lib/db/src/index";
