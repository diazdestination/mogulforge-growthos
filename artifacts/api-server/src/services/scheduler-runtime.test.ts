import { randomUUID } from "node:crypto";
import { db, schedulerRuntimeTable as runtime } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import {
  runSchedulerCycle,
  schedulerHealth,
  SCHEDULER_STALE_MS,
} from "./scheduler-runtime";

const names: string[] = [];
const testName = () => {
  const name = `qa-${randomUUID()}`;
  names.push(name);
  return name;
};
afterAll(async () => {
  if (names.length)
    await db.delete(runtime).where(inArray(runtime.name, names));
});
it("records stage progress, completion and a redacted failure without swallowing later stages", async () => {
  const name = testName();
  const result = await runSchedulerCycle(
    async (observe) => {
      await observe("scheduled-actions", "running");
      const [running] = await db
        .select()
        .from(runtime)
        .where(eq(runtime.name, name));
      expect(running.state).toBe("running");
      expect(running.currentStage).toBe("scheduled-actions");
      await observe("scheduled-actions", "failed");
      await observe("webhook-retries", "running");
      await observe("webhook-retries", "succeeded");
    },
    { name },
  );
  expect(result).toBe("degraded");
  const [saved] = await db.select().from(runtime).where(eq(runtime.name, name));
  expect(saved.failedStages).toEqual(["scheduled-actions"]);
  expect(saved.completedAt).toBeInstanceOf(Date);
  expect(saved.currentStage).toBeNull();
  expect(schedulerHealth(saved)).toBe("degraded");
  expect(
    schedulerHealth({
      ...saved,
      heartbeatAt: new Date(Date.now() - SCHEDULER_STALE_MS - 1_000),
    }),
  ).toBe("stale");
  expect(schedulerHealth({ ...saved, state: "stopped" })).toBe("stopped");
  expect(schedulerHealth(undefined)).toBe("not_observed");
  await runSchedulerCycle(async () => {}, { name });
  const [recovered] = await db
    .select()
    .from(runtime)
    .where(eq(runtime.name, name));
  expect(schedulerHealth(recovered)).toBe("healthy");
  expect(recovered.failedStages).toEqual([]);
});
it("records an unexpected interruption without leaking raw errors", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const name = testName();
  try {
    await runSchedulerCycle(
      async () => {
        throw new Error("SECRET_CUSTOMER_CONTENT");
      },
      { name },
    );
    const [saved] = await db
      .select()
      .from(runtime)
      .where(eq(runtime.name, name));
    expect(saved.failedStages).toEqual(["cycle-interrupted"]);
    expect(JSON.stringify(saved)).not.toContain("SECRET");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET");
  } finally {
    spy.mockRestore();
  }
});
// PGlite's socket adapter does not provide independent PostgreSQL sessions.
// This check is mandatory in CI, where the service is real PostgreSQL.
it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "excludes a concurrent process and releases ownership for the next cycle",
  async () => {
    const name = testName();
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = runSchedulerCycle(
      async () => {
        started();
        await blocked;
      },
      { name, ownerId: "first" },
    );
    await entered;
    try {
      const effect = vi.fn(async () => {});
      expect(await runSchedulerCycle(effect, { name, ownerId: "second" })).toBe(
        "busy",
      );
      expect(effect).not.toHaveBeenCalled();
      const [saved] = await db
        .select()
        .from(runtime)
        .where(eq(runtime.name, name));
      expect(saved.ownerId).toBe("first");
    } finally {
      finish();
      await first;
    }
    expect(
      await runSchedulerCycle(async () => {}, { name, ownerId: "replacement" }),
    ).toBe("idle");
  },
);
