// Disposable visual QA: an in-memory database, fictional records, no .env,
// no inherited account/provider keys, and an HTTP listener on loopback only.
// Prerequisite: build the API and Command Center. Closing this runner drops
// ONLY its in-memory fixture; it never opens or changes an existing database.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { buildAll } from "../build.mjs";
import { seedCustomerCarePreview } from "./customer-care-preview-fixture.mjs";
import { seedOperationsPreview } from "./operations-preview-fixture.mjs";
import { seedLaunchCommunicationsPreview } from "./launch-communications-preview-fixture.mjs";
import { seedLeadRepliesPreview } from "./lead-replies-preview-fixture.mjs";
import { seedInvoiceRecoveryPreview } from "./invoice-recovery-preview-fixture.mjs";
import { seedCalliePreview } from "./callie-preview-fixture.mjs";
import { seedStandingServicePreview } from "./standing-service-preview-fixture.mjs";
import { seedSourceNurturePreview } from "./source-nurture-preview-fixture.mjs";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const database = path.resolve(api, "../../lib/db");
const storage = await PGlite.create();
const socket = new PGLiteSocketServer({
  db: storage,
  host: "127.0.0.1",
  port: 0,
  maxConnections: 20,
});
await socket.start();
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
  ),
);
Object.assign(env, {
  DATABASE_URL: `postgresql://postgres:synthetic@${socket.getServerConn()}/postgres`,
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: "4192",
  APP_ORIGIN: "http://127.0.0.1:4192",
  STATIC_DIR: path.resolve(api, "../command-center/dist/public"),
  SESSION_SECRET: "synthetic-runtime-preview-never-deploy",
  OBJECT_STORAGE_PROVIDER: "postgres",
  AUTO_MIGRATE: "false",
  LOG_LEVEL: "warn",
  COMMUNICATIONS_ENABLED: "false",
  GROWTHOS_OUTBOUND_HOLD: "true",
  SCHEDULER_AUTOSTART: "false",
  RUNTIME_SYNTHETIC_PREVIEW: "loopback-only",
});
// Disposable encryption for fictional reply-storage readiness only. This is not
// a provider key, is never persisted and does not clear any outbound hold.
if (process.argv.includes("--standing-service"))
  env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = randomBytes(32).toString("hex");
let child;
const cacheRoot = path.join(api, "node_modules/.cache");
await mkdir(cacheRoot, { recursive: true });
const buildDir = await mkdtemp(path.join(cacheRoot, "runtime-preview-"));
try {
  await buildAll({
    entryPoint: path.join(api, "src/test-helpers/runtime-preview-server.ts"),
    outDir: buildDir,
  });
  const code = await new Promise((resolve, reject) => {
    const schema = spawn(
      process.execPath,
      [
        path.join(database, "node_modules/drizzle-kit/bin.cjs"),
        "push",
        "--force",
        "--config",
        "drizzle.config.ts",
      ],
      { cwd: database, env, stdio: "inherit", windowsHide: true },
    );
    schema.once("error", reject);
    schema.once("exit", resolve);
  });
  if (code !== 0) throw new Error("Synthetic schema setup failed");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const {
      rows: [org],
    } = await client.query(
      "INSERT INTO organizations(name,slug) VALUES ('LOCAL RUNTIME QA - fictional','local-runtime-qa') RETURNING id",
    );
    const salt = randomBytes(16).toString("hex");
    const password = "Local-QA-only-2026!";
    const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
    const { rows: [user] } = await client.query(
      "INSERT INTO users(email,first_name,last_name,password_hash,email_verified_at,organization_id,role,is_platform_admin) VALUES ($1,'LOCAL','QA OPERATOR',$2,now(),$3,'owner',true) RETURNING id",
      ["runtime-qa@example.invalid", hash, org.id],
    );
    if (process.argv.includes("--customer-care") || process.argv.includes("--operations") || process.argv.includes("--communications") || process.argv.includes("--lead-replies") || process.argv.includes("--invoice-recovery")) await seedCustomerCarePreview(client, org.id, user.id);
    if (process.argv.includes("--operations")) await seedOperationsPreview(client, org.id, user.id);
    if (process.argv.includes("--communications") || process.argv.includes("--lead-replies")) await seedLaunchCommunicationsPreview(client, org.id, user.id);
    if (process.argv.includes("--lead-replies")) await seedLeadRepliesPreview(client, org.id, user.id);
    if (process.argv.includes("--invoice-recovery")) await seedInvoiceRecoveryPreview(client, org.id, user.id);
    if (process.argv.includes("--callie")) await seedCalliePreview(client, org.id, user.id);
    if (process.argv.includes("--standing-service")) await seedStandingServicePreview(client, org.id, user.id);
    if (process.argv.includes("--source-nurture")) await seedSourceNurturePreview(client, org.id, user.id);
    await client.query(
      "INSERT INTO scheduled_actions(organization_id,action,context,run_at,status,attempts,last_error) VALUES ($1,$2,'{}',now()-interval '1 hour','failed',3,'Synthetic preparation failure for visual QA')",
      [
        org.id,
        JSON.stringify({
          type: "create_task",
          params: { title: "FICTIONAL: operator review required" },
        }),
      ],
    );
    await client.query(
      "INSERT INTO revenue_executions(organization_id,action_key,fingerprint,kind,state,detail,expires_at) VALUES ($1,'synthetic-review','synthetic','create_task','indeterminate','FICTIONAL: interruption fixture, no external effect',now())",
      [org.id],
    );
    console.log(
      "Isolated preview: http://127.0.0.1:4192/\nFixture login: runtime-qa@example.invalid / Local-QA-only-2026!\nThese are disposable local credentials, not a real account. All records are fictional; provider credentials are excluded.",
    );
  } finally {
    await client.end();
  }
  child = spawn(
    process.execPath,
    [path.join(buildDir, "runtime-preview-server.mjs")],
    {
      cwd: api,
      env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => child?.kill(signal));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (status) process.exitCode = status;
} finally {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill();
  await socket.stop();
  await storage.close();
  if (path.dirname(buildDir) !== cacheRoot)
    throw new Error("Unexpected preview artifact path");
  await rm(buildDir, { recursive: true, force: true });
}
