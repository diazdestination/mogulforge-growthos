import { randomUUID } from "node:crypto";
import { processScheduledWork } from "./automation";
import { createSchedulerLoop } from "./scheduler-loop";
import { markSchedulerStopped, runSchedulerCycle } from "./scheduler-runtime";

/** Unset preserves production behavior; an explicit staging hold is opt-in. */
export function parseSchedulerAutostart(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error('SCHEDULER_AUTOSTART must be "true" or "false" when set.');
}

// Evaluate during module import, before the HTTP server begins listening.
// Ambiguous configuration fails startup instead of silently running work.
const autostartEnabled = parseSchedulerAutostart(
  process.env.SCHEDULER_AUTOSTART,
);
const ownerId = randomUUID();
let loop: ReturnType<typeof createSchedulerLoop> | undefined;
export function startAutomationScheduler(intervalMs = 60_000) {
  if (!autostartEnabled) {
    console.info("[scheduler] autostart disabled by SCHEDULER_AUTOSTART=false");
    return;
  }
  if (loop) return;
  loop = createSchedulerLoop(
    () =>
      runSchedulerCycle((observe) => processScheduledWork(undefined, observe), {
        ownerId,
        intervalMs,
      }),
    intervalMs,
  );
  loop.start();
}
export async function stopAutomationScheduler() {
  if (!loop) return;
  await loop.stop();
  await markSchedulerStopped(ownerId);
  loop = undefined;
}
