/** One in-flight cycle per process; the next delay starts AFTER work finishes. */
export function createSchedulerLoop(
  work: () => Promise<unknown>,
  intervalMs = 60_000,
  onError: () => void = () =>
    console.error("[scheduler] cycle failed; inspect runtime health"),
) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000)
    throw new Error("Scheduler interval must be at least one second.");
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const tick = () => {
    inFlight = Promise.resolve()
      .then(work)
      .then(
        () => {},
        () => {
          onError();
        },
      )
      .finally(() => {
        inFlight = undefined;
        if (!stopped) {
          timer = setTimeout(tick, intervalMs);
          timer.unref();
        }
      });
  };
  return {
    start() {
      if (!stopped || inFlight) return;
      stopped = false;
      // Recover due work on startup without waiting for the first interval.
      tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
