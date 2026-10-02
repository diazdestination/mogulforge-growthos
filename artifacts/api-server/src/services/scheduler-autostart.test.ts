import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createLoop: vi.fn(),
  loopStart: vi.fn(),
  loopStop: vi.fn(async () => {}),
  markStopped: vi.fn(async () => {}),
  runCycle: vi.fn(async () => "idle"),
}));

vi.mock("./automation", () => ({ processScheduledWork: vi.fn() }));
vi.mock("./scheduler-loop", () => ({ createSchedulerLoop: mocks.createLoop }));
vi.mock("./scheduler-runtime", () => ({
  markSchedulerStopped: mocks.markStopped,
  runSchedulerCycle: mocks.runCycle,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.createLoop.mockReturnValue({
    start: mocks.loopStart,
    stop: mocks.loopStop,
  });
});
afterEach(() => vi.unstubAllEnvs());

it("defaults to the existing scheduler behavior when unset", async () => {
  vi.stubEnv("SCHEDULER_AUTOSTART", undefined);
  const scheduler = await import("./scheduler");
  expect(scheduler.parseSchedulerAutostart(undefined)).toBe(true);
  scheduler.startAutomationScheduler();
  expect(mocks.createLoop).toHaveBeenCalledTimes(1);
  expect(mocks.loopStart).toHaveBeenCalledTimes(1);
  await scheduler.stopAutomationScheduler();
  expect(mocks.loopStop).toHaveBeenCalledTimes(1);
  expect(mocks.markStopped).toHaveBeenCalledTimes(1);
});

it("keeps staging scheduler work dormant when explicitly false", async () => {
  vi.stubEnv("SCHEDULER_AUTOSTART", "false");
  const scheduler = await import("./scheduler");
  expect(scheduler.parseSchedulerAutostart("false")).toBe(false);
  scheduler.startAutomationScheduler();
  await scheduler.stopAutomationScheduler();
  expect(mocks.createLoop).not.toHaveBeenCalled();
  expect(mocks.loopStart).not.toHaveBeenCalled();
  expect(mocks.markStopped).not.toHaveBeenCalled();
});

it("accepts explicit true and rejects ambiguous startup settings", async () => {
  vi.stubEnv("SCHEDULER_AUTOSTART", "true");
  const scheduler = await import("./scheduler");
  expect(scheduler.parseSchedulerAutostart("true")).toBe(true);
  for (const value of ["", "FALSE", "0", "off", " yes "])
    expect(() => scheduler.parseSchedulerAutostart(value)).toThrow(
      "SCHEDULER_AUTOSTART",
    );
  vi.resetModules();
  vi.stubEnv("SCHEDULER_AUTOSTART", "off");
  await expect(import("./scheduler")).rejects.toThrow(
    "SCHEDULER_AUTOSTART",
  );
  expect(mocks.createLoop).not.toHaveBeenCalled();
});
