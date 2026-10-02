// Never reads .env or accepts an existing database/provider configuration.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const database = path.resolve(api, "../../lib/db");
const selectedTests = process.argv.slice(2);
const pg = await PGlite.create();
const server = new PGLiteSocketServer({
  db: pg,
  host: "127.0.0.1",
  port: 0,
  maxConnections: 20,
});
await server.start();
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
  ),
);
Object.assign(env, {
  NODE_ENV: "test",
  DATABASE_URL: `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`,
  SESSION_SECRET: "synthetic-scheduler-session-never-deploy",
  APP_ORIGIN: "https://growth.example",
  OBJECT_STORAGE_PROVIDER: "postgres",
  SCHEDULER_TEST_BACKEND: "pglite",
  NO_COLOR: "1",
  LOG_LEVEL: "silent",
});
async function run(file, args, cwd) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (status !== 0)
    throw new Error(`Isolated scheduler check failed (${status}).`);
}
try {
  await run(
    path.join(database, "node_modules/drizzle-kit/bin.cjs"),
    ["push", "--force", "--config", "drizzle.config.ts"],
    database,
  );
  await run(
    path.join(api, "node_modules/vitest/vitest.mjs"),
    [
      "run",
      "--maxWorkers",
      "1",
      "--no-file-parallelism",
      ...(selectedTests.length ? selectedTests : [
      "src/services/scheduler-loop.test.ts",
      "src/services/scheduler-autostart.test.ts",
      "src/services/scheduler-runtime.test.ts",
      "src/services/scheduler-stage-isolation.test.ts",
      "src/services/scheduled-action-recovery.test.ts",
      "src/services/scheduler-restart.test.ts",
      "src/services/durable-execution.test.ts",
      "src/routes/v1/runtime-health.test.ts",
      "src/routes/v1/route-inventory.test.ts",
      ]),
    ],
    api,
  );
  console.log(selectedTests.length
    ? "PASS: selected synthetic isolated API checks. No production or provider acceptance is implied."
    : "PASS: synthetic local scheduler checks. Independent-session advisory lock exclusion is checked in CI on PostgreSQL, not by PGlite. No production or provider acceptance is implied.");
} finally {
  await server.stop();
  await pg.close();
}
