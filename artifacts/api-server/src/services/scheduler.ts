import { randomUUID } from "node:crypto";
import { processScheduledWork } from "./automation";
import { createSchedulerLoop } from "./scheduler-loop";
import { markSchedulerStopped, runSchedulerCycle } from "./scheduler-runtime";

const ownerId = randomUUID();
let loop: ReturnType<typeof createSchedulerLoop> | undefined;
export function startAutomationScheduler(intervalMs = 60_000) {
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
