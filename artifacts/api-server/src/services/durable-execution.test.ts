import { randomUUID } from "node:crypto";
import {
  db,
  organizationsTable,
  revenueExecutionsTable as executions,
  revenueExecutionEventsTable as events,
  scheduledActionsTable,
  crmTasksTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  runDurableAction,
  expireInterruptedActions,
  reconcileExecution,
} from "./durable-execution";
import { processScheduledWork } from "./automation";

let org: string, other: string;
beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1")
    throw new Error("Local DB only");
  [org, other] = (
    await db
      .insert(organizationsTable)
      .values(
        [1, 2].map((i) => ({
          name: `Execution test ${i}`,
          slug: `execution-${randomUUID()}`,
        })),
      )
      .returning()
  ).map((r) => r.id);
});
afterAll(async () => {
  await deleteTestOrgs(org, other);
});

describe("durable execution ownership", () => {
  it("returns the current receipt when a late worker finishes after reconciliation", async () => {
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const actionKey = randomUUID();
    const running = runDurableAction({
      organizationId: org,
      actionKey,
      kind: "test",
      payload: {},
      execute: async () => {
        started();
        await blocked;
        return { state: "succeeded", detail: "Late completion" };
      },
    });
    await entered;
    const [receipt] = await db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.organizationId, org),
          eq(executions.actionKey, actionKey),
        ),
      );
    await db
      .update(executions)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(executions.id, receipt.id));
    await expireInterruptedActions(org);
    await reconcileExecution(
      org,
      receipt.id,
      "local-qa",
      "confirmed_succeeded",
      "Operator checked the fictional downstream record.",
    );
    release();
    expect((await running).state).toBe("confirmed_succeeded");
  });
  it("excludes a later worker even after the first worker started its effect", async () => {
    let release!: () => void,
      started!: () => void,
      count = 0;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const input = {
      organizationId: org,
      actionKey: `test:${randomUUID()}`,
      kind: "send_email",
      payload: { b: 2, a: 1 },
      execute: async () => {
        count++;
        started();
        await blocked;
        return {
          state: "succeeded" as const,
          detail: "Provider acceptance recorded, not delivery.",
        };
      },
    };
    const first = runDurableAction(input);
    await entered;
    const second = await runDurableAction({
      ...input,
      payload: { a: 1, b: 2 },
    });
    expect(second.state).toBe("processing");
    expect(count).toBe(1);
    release();
    const result = await first;
    expect(result.state).toBe("succeeded");
    expect((await runDurableAction(input)).state).toBe("succeeded");
    expect(count).toBe(1);
    expect(
      await db.select().from(events).where(eq(events.executionId, result.id)),
    ).toHaveLength(2);
  });
  it("holds ambiguous effects and removes sensitive exception text", async () => {
    let count = 0;
    const input = {
      organizationId: org,
      actionKey: `test:${randomUUID()}`,
      kind: "send_email",
      payload: { lead: "fictional" },
      execute: async () => {
        count++;
        throw new Error("SECRET_PROVIDER_TOKEN do not persist");
      },
    };
    const result = await runDurableAction(input);
    expect(result.state).toBe("indeterminate");
    expect(result.detail).not.toContain("SECRET");
    await runDurableAction(input);
    expect(count).toBe(1);
    expect(
      await reconcileExecution(
        other,
        result.id,
        "qa",
        "confirmed_succeeded",
        "Checked fictional provider record",
      ),
    ).toBeUndefined();
    expect(
      (
        await reconcileExecution(
          org,
          result.id,
          "qa",
          "confirmed_succeeded",
          "Checked fictional provider record",
        )
      )?.state,
    ).toBe("confirmed_succeeded");
    await runDurableAction(input);
    expect(count).toBe(1);
  });
  it("expires stuck ownership without replay and rejects payload changes", async () => {
    const actionKey = `test:${randomUUID()}`;
    const result = await runDurableAction({
      organizationId: org,
      actionKey,
      kind: "test",
      payload: {},
      execute: async () => ({ state: "succeeded", detail: "ok" }),
    });
    await db
      .update(executions)
      .set({ state: "processing", expiresAt: new Date(Date.now() - 1) })
      .where(eq(executions.id, result.id));
    await expireInterruptedActions(org);
    const [row] = await db
      .select()
      .from(executions)
      .where(eq(executions.id, result.id));
    expect(row.state).toBe("indeterminate");
    await expect(
      runDurableAction({
        organizationId: org,
        actionKey,
        kind: "test",
        payload: { changed: true },
        execute: async () => ({ state: "succeeded", detail: "not allowed" }),
      }),
    ).rejects.toThrow("conflicts");
  });
  it("allows the same logical key in different tenants, without sharing receipts", async () => {
    const actionKey = randomUUID();
    const run = (organizationId: string) =>
      runDurableAction({
        organizationId,
        actionKey,
        kind: "test",
        payload: {},
        execute: async () => ({
          state: "succeeded",
          detail: "Tenant-local effect",
        }),
      });
    const a = await run(org),
      b = await run(other);
    expect(a.id).not.toBe(b.id);
  });
  it("executes a scheduled task once across concurrent and later scheduler passes", async () => {
    const title = `One task ${randomUUID()}`;
    const [item] = await db
      .insert(scheduledActionsTable)
      .values({
        organizationId: org,
        action: { type: "create_task", params: { title } },
        context: { event: "qa.scheduled" },
        runAt: new Date(Date.now() - 10_000),
      })
      .returning();
    await Promise.all([processScheduledWork(org), processScheduledWork(org)]);
    await processScheduledWork(org);
    expect(
      await db
        .select()
        .from(crmTasksTable)
        .where(
          and(
            eq(crmTasksTable.organizationId, org),
            eq(crmTasksTable.title, title),
          ),
        ),
    ).toHaveLength(1);
    const [saved] = await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.id, item.id));
    expect(saved.status).toBe("done");
    expect(saved.attempts).toBe(1);
  });
});
