import { randomUUID } from "node:crypto";
import {
  db,
  organizationsTable,
  scheduledActionsTable as actions,
  revenueExecutionsTable as executions,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
vi.mock("./durable-execution", async (original) => ({
  ...(await original<typeof import("./durable-execution")>()),
  runDurableAction: vi.fn(),
}));
import { runDurableAction } from "./durable-execution";
import { processDueScheduledActions } from "./automation";

let org: string;
beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Scheduler recovery QA", slug: `qa-${randomUUID()}` })
    .returning();
  org = row.id;
});
afterAll(async () => {
  await deleteTestOrgs(org);
});
afterEach(() => vi.resetAllMocks());
const queue = async (attempts = 0) =>
  (
    await db
      .insert(actions)
      .values({
        organizationId: org,
        action: { type: "create_task", params: { title: "Synthetic work" } },
        context: {},
        attempts,
        runAt: new Date(0),
      })
      .returning()
  )[0];

it("persists bounded pre-ownership retries and redacts exceptions", async () => {
  const item = await queue();
  vi.mocked(runDurableAction).mockRejectedValue(
    new Error("SECRET_DATABASE_URL"),
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    await db
      .update(actions)
      .set({ runAt: new Date(0) })
      .where(eq(actions.id, item.id));
    const before = Date.now();
    await processDueScheduledActions(org);
    const [saved] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, item.id));
    expect(saved.attempts).toBe(attempt);
    expect(saved.status).toBe(attempt === 3 ? "failed" : "pending");
    expect(saved.runAt.getTime()).toBeGreaterThanOrEqual(
      before + 5 * 2 ** (attempt - 1) * 60_000,
    );
    expect(saved.lastError).not.toContain("SECRET");
  }
  await processDueScheduledActions(org);
  expect(runDurableAction).toHaveBeenCalledTimes(3);
});
it("cannot resurrect work cancelled during a preparation failure", async () => {
  const item = await queue();
  vi.mocked(runDurableAction).mockImplementationOnce(async () => {
    await db
      .update(actions)
      .set({ status: "cancelled" })
      .where(eq(actions.id, item.id));
    throw new Error("Preparation interrupted");
  });
  await processDueScheduledActions(org);
  const [saved] = await db
    .select()
    .from(actions)
    .where(eq(actions.id, item.id));
  expect(saved.status).toBe("cancelled");
  expect(saved.attempts).toBe(0);
});
it("holds a conflicting existing receipt instead of retrying its effect", async () => {
  const item = await queue();
  await db
    .insert(executions)
    .values({
      organizationId: org,
      actionKey: `scheduled:${item.id}`,
      kind: "create_task",
      fingerprint: "conflicting-payload",
      expiresAt: new Date(0),
      state: "indeterminate",
    });
  vi.mocked(runDurableAction).mockRejectedValue(new Error("Payload conflict"));
  await processDueScheduledActions(org);
  const [saved] = await db
    .select()
    .from(actions)
    .where(eq(actions.id, item.id));
  expect(saved.status).toBe("failed");
  expect(saved.lastError).toContain("Automatic replay is blocked");
  expect(saved.attempts).toBe(0);
});
it("does not let twenty live execution owners starve later due work", async () => {
  const held = await db
    .insert(actions)
    .values(
      Array.from({ length: 20 }, () => ({
        organizationId: org,
        action: { type: "create_task" as const, params: {} },
        runAt: new Date(0),
      })),
    )
    .returning();
  await db
    .insert(executions)
    .values(
      held.map((row) => ({
        organizationId: org,
        actionKey: `scheduled:${row.id}`,
        kind: "create_task",
        fingerprint: "held",
        expiresAt: new Date(Date.now() + 60_000),
      })),
    );
  const available = await queue();
  await db
    .update(actions)
    .set({ runAt: new Date(1_000) })
    .where(eq(actions.id, available.id));
  vi.mocked(runDurableAction).mockRejectedValue(
    new Error("Test-only preclaim failure"),
  );
  await processDueScheduledActions(org);
  expect(runDurableAction).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runDurableAction).mock.calls[0][0].actionKey).toBe(
    `scheduled:${available.id}`,
  );
  await db
    .update(actions)
    .set({ status: "cancelled" })
    .where(and(eq(actions.organizationId, org), eq(actions.status, "pending")));
});
