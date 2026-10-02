import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  db,
  organizationsTable,
  scheduledActionsTable as actions,
  revenueExecutionsTable as receipts,
  crmTasksTable,
  schedulerRuntimeTable as runtime,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getSchedulerHealth } from "./scheduler-runtime";

const api = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const diagnostics = new WeakMap<ChildProcess, string>();
function phase(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Worker did not reach ${expected}`));
    }, 20_000);
    const message = (value: unknown) => {
      if ((value as { phase?: string }).phase === expected) {
        cleanup();
        resolve();
      }
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Worker exited before ${expected} (${code}): ${diagnostics.get(child) ?? ""}`,
        ),
      );
    };
    const error = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exit);
      child.off("error", error);
    };
    child.on("message", message);
    child.once("exit", exit);
    child.once("error", error);
  });
}
function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolve) => child.once("exit", resolve));
}
it("restarts after a real worker crash without repeating its committed effect and resumes other due work", async () => {
  if (new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1")
    throw new Error("Loopback test database required");
  const cacheRoot = path.join(api, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const folder = await mkdtemp(path.join(cacheRoot, "scheduler-restart-"));
  const output = path.join(folder, "worker.cjs");
  const name = `restart-qa-${randomUUID()}`;
  const children: ChildProcess[] = [];
  let org: string | undefined;
  try {
    await build({
      entryPoints: [
        path.join(api, "src/test-helpers/scheduler-crash-worker.ts"),
      ],
      outfile: output,
      platform: "node",
      format: "cjs",
      bundle: true,
      packages: "external",
      plugins: [
        {
          name: "bundle-workspace-typescript",
          setup(builder) {
            builder.onResolve(
              { filter: /^(@workspace\/|drizzle-zod$)/ },
              (args) => ({
                path: require.resolve(args.path, { paths: [args.resolveDir] }),
              }),
            );
          },
        },
      ],
    });
    const [tenant] = await db
      .insert(organizationsTable)
      .values({ name: "Restart acceptance QA", slug: name })
      .returning();
    org = tenant.id;
    const [interrupted, waiting] = await db
      .insert(actions)
      .values(
        ["Interrupted effect", "Resumed due work"].map((title) => ({
          organizationId: tenant.id,
          action: {
            type: "create_task" as const,
            params: { title: `${name}: ${title}` },
          },
          context: {},
          runAt: new Date(0),
        })),
      )
      .returning();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
      ),
    );
    Object.assign(env, {
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL!,
      SESSION_SECRET: "restart-test-only-never-deploy",
      OBJECT_STORAGE_PROVIDER: "postgres",
      LOG_LEVEL: "silent",
    });
    const worker = (mode: string) => {
      const options = {
        cwd: api,
        env,
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"] as [
          "ignore",
          "pipe",
          "pipe",
          "ipc",
        ],
        windowsHide: true,
      };
      const child = fork(
        output,
        [mode, tenant.id, interrupted.id, name],
        options,
      );
      // Consume output to avoid filling a pipe; failures surface through phase/exit.
      child.stdout?.resume();
      child.stderr?.on("data", (chunk) =>
        diagnostics.set(
          child,
          `${diagnostics.get(child) ?? ""}${String(chunk)}`.slice(-4_000),
        ),
      );
      children.push(child);
      return child;
    };
    const first = worker("interrupt");
    await phase(first, "effect-recorded");
    first.kill("SIGKILL");
    await exited(first);
    const [held] = await db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.organizationId, tenant.id),
          eq(receipts.actionKey, `scheduled:${interrupted.id}`),
        ),
      );
    expect(held.state).toBe("processing");
    // Advance the receipt deadline rather than sleep for its 15-minute window.
    await db
      .update(receipts)
      .set({ expiresAt: new Date(0) })
      .where(eq(receipts.id, held.id));
    const replacement = worker("resume");
    await phase(replacement, "resumed");
    expect(await exited(replacement)).toBe(0);
    const effects = await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.organizationId, tenant.id));
    expect(effects.map((row) => row.title).sort()).toEqual(
      [interrupted.action.params.title, waiting.action.params.title].sort(),
    );
    const [saved] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, held.id));
    expect(saved.state).toBe("indeterminate");
    const [failed] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, interrupted.id));
    const [done] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, waiting.id));
    expect(failed.status).toBe("failed");
    expect(done.status).toBe("done");
    // A crash-held effect must be visible through the same aggregate used by
    // platform operations, without requiring operators to inspect raw tables
    // or exposing the synthetic task title in the health response.
    const health = await getSchedulerHealth();
    expect(health.queue.failed).toBeGreaterThanOrEqual(1);
    expect(health.executionsNeedingReview).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(health)).not.toContain(name);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited(child);
    }
    await db.delete(runtime).where(eq(runtime.name, name));
    await deleteTestOrgs(org);
    // Only the exact mkdtemp-owned folder under this project's ignored cache.
    if (path.dirname(folder) !== cacheRoot)
      throw new Error("Unexpected test artifact path");
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
