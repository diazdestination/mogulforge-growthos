import { afterEach, expect, it, vi } from "vitest";
import { createSchedulerLoop } from "./scheduler-loop";

afterEach(() => vi.useRealTimers());
it("starts immediately and cannot overlap a slow cycle", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const loop = createSchedulerLoop(work, 1_000);
  loop.start();
  loop.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(work).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(work).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(work).toHaveBeenCalledTimes(2);
  const stopped = loop.stop();
  finish();
  await stopped;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(work).toHaveBeenCalledTimes(2);
});
it("drains in-flight work before shutdown completes", async () => {
  let finish!: () => void;
  const loop = createSchedulerLoop(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  loop.start();
  await Promise.resolve();
  let drained = false;
  const stopping = loop.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await stopping;
  expect(drained).toBe(true);
});
it("recovers after a rejected cycle without exposing the original exception", async () => {
  vi.useFakeTimers();
  const work = vi
    .fn()
    .mockRejectedValueOnce(new Error("SECRET_PROVIDER_TOKEN"))
    .mockResolvedValue(undefined);
  const report = vi.fn();
  const loop = createSchedulerLoop(work, 1_000, report);
  loop.start();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(work).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledExactlyOnceWith();
  await loop.stop();
});
it("rejects unsafe timing configuration", () => {
  expect(() => createSchedulerLoop(async () => {}, 0)).toThrow("at least");
  expect(() => createSchedulerLoop(async () => {}, Number.NaN)).toThrow(
    "at least",
  );
});
