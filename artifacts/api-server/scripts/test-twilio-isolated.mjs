// Dedicated synthetic database: this runner never reads .env or accepts DATABASE_URL.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const database = path.resolve(api, "../../lib/db");
const pg = await PGlite.create();
const server = new PGLiteSocketServer({
  db: pg,
  host: "127.0.0.1",
  port: 0,
  maxConnections: 20,
});
await server.start();
// Deliberately exclude all provider, account, database and hosting credentials.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
  ),
);
Object.assign(env, {
  NODE_ENV: "test",
  DATABASE_URL: `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`,
  SESSION_SECRET: "synthetic-twilio-test-session-never-deploy",
  APP_ORIGIN: "https://growth.example",
  OBJECT_STORAGE_PROVIDER: "postgres",
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
  if (status !== 0) throw new Error(`Isolated check failed (${status}).`);
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
      "src/routes/v1/twilio.test.ts",
      "src/routes/v1/route-inventory.test.ts",
      "src/services/providers.test.ts",
      "src/routes/v1/unsubscribe-flow.test.ts",
    ],
    api,
  );
  console.log(
    "PASS: isolated PGlite database, synthetic identities and intercepted Twilio calls. This is not a live carrier or multi-process PostgreSQL test.",
  );
} finally {
  await server.stop();
  await pg.close();
}
