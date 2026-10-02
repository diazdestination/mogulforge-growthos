/** Reuse the authenticated Fly session without exposing credentials.
 * The credential GET matches flyctl's own MPG v2 client; secret staging uses
 * the normal CLI stdin API and NEVER starts or deploys a Machine.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRestoreProxy } from "./restore-drill-connection.mjs";
import {
  assertBootstrapInventory,
  PILOT_CLUSTER,
  PILOT_DATABASE,
} from "./pilot-staging-bootstrap.mjs";

const execute = promisify(execFile);
const requireApi = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const allowedUsers = new Set([
  "growthos-staging-live",
  "growthos-restore-reader",
]);
// One short-lived managed-restore drill, never an alternate app database.
const RECOVERED_PILOT_CLUSTER = "dzx6qo652zg0jpv5";
export async function flyJson(args) {
  return JSON.parse(
    (
      await execute("fly", args, {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
  );
}

export async function pilotCredentials(username) {
  if (!allowedUsers.has(username)) throw new Error("pilot_user_forbidden");
  return credentialsForPinnedUser(PILOT_CLUSTER, username);
}

export async function recoveredPilotReaderCredentials() {
  return credentialsForPinnedUser(
    RECOVERED_PILOT_CLUSTER,
    "growthos-restore-reader",
  );
}

async function credentialsForPinnedUser(cluster, username) {
  // Read only. Token and returned database password never leave this process.
  const { stdout } = await execute("fly", ["auth", "token", "--quiet"], {
    windowsHide: true,
    timeout: 30000,
  });
  const response = await fetch(
    `https://api.fly.io/api/v1/postgresv2/${cluster}/users/${username}/credentials`,
    {
      headers: {
        Authorization: `Bearer ${stdout.trim()}`,
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(`pilot_credential_lookup_failed_${response.status}`);
  const result = await response.json();
  if (
    result?.data?.username !== username ||
    typeof result.data.password !== "string" ||
    !result.data.password
  )
    throw new Error("pilot_credential_identity_invalid");
  const url = new URL(
    `postgresql://pgbouncer.${cluster}.flympg.net/${PILOT_DATABASE}`,
  );
  url.username = username;
  // URL.password preserves a literal percent sign; encode it first so pg can
  // unescape every possible provider password exactly once.
  url.password = encodeURIComponent(result.data.password);
  return {
    username,
    password: result.data.password,
    connectionString: url.toString(),
  };
}

export async function stagePilotSecrets(values) {
  const allowed = new Set([
    "DATABASE_URL",
    "RESTORE_DRILL_READER_DATABASE_URL",
    "RESTORE_DRILL_RECOVERED_READER_DATABASE_URL",
    "RESTORE_DRILL_SYNTHETIC_KEY",
    "RESTORE_DRILL_SESSION_BEARER",
    "RESEND_WEBHOOK_SECRET",
  ]);
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !Object.keys(values).length ||
    Object.entries(values).some(
      ([key, value]) =>
        !allowed.has(key) ||
        typeof value !== "string" ||
        !value ||
        /[\r\n\0]/.test(value),
    )
  )
    throw new Error("pilot_secret_input_invalid");
  // Pin the sink as well as the source: no reusable caller may stage a
  // production URL, administrative login, or query-string host override.
  const databaseSecretTargets = {
    DATABASE_URL: {
      cluster: PILOT_CLUSTER,
      username: "growthos-staging-live",
    },
    RESTORE_DRILL_READER_DATABASE_URL: {
      cluster: PILOT_CLUSTER,
      username: "growthos-restore-reader",
    },
    RESTORE_DRILL_RECOVERED_READER_DATABASE_URL: {
      cluster: RECOVERED_PILOT_CLUSTER,
      username: "growthos-restore-reader",
    },
  };
  for (const [key, { cluster, username }] of Object.entries(
    databaseSecretTargets,
  )) {
    if (!Object.hasOwn(values, key)) continue;
    let url;
    try {
      url = new URL(values[key]);
      decodeURIComponent(url.password);
    } catch {
      throw new Error("pilot_secret_database_target_invalid");
    }
    if (
      url.protocol !== "postgresql:" ||
      url.hostname !== `pgbouncer.${cluster}.flympg.net` ||
      url.username !== username ||
      !url.password ||
      url.pathname !== `/${PILOT_DATABASE}` ||
      url.port ||
      url.href.includes("?") ||
      url.href.includes("#")
    )
      throw new Error("pilot_secret_database_target_invalid");
  }
  const child = spawn(
    "fly",
    ["secrets", "import", "--stage", "--app", "mogulforge-growthos-staging"],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  let inputFailed = false;
  child.stdin.on("error", () => {
    inputFailed = true;
  });
  const completed = new Promise((resolveDone, reject) => {
    child.once("error", () => reject(new Error("pilot_secret_stage_failed")));
    child.once("close", (code) =>
      code === 0 && !inputFailed
        ? resolveDone()
        : reject(new Error("pilot_secret_stage_failed")),
    );
    try {
      child.stdin.end(
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n") + "\n",
      );
    } catch {
      child.kill();
      reject(new Error("pilot_secret_stage_failed"));
    }
  });
  await completed;
}

async function main() {
  const action = process.argv[2] || "--inspect";
  if (
    process.argv.length > 3 ||
    !["--inspect", "--stage-database-secret"].includes(action)
  )
    throw new Error("pilot_argument_invalid");
  const [status, machines] = await Promise.all([
    flyJson(["mpg", "status", PILOT_CLUSTER, "--json"]),
    flyJson([
      "machine",
      "list",
      "--app",
      "mogulforge-growthos-staging",
      "--json",
    ]),
  ]);
  assertBootstrapInventory(status, machines);
  const credential = await pilotCredentials("growthos-staging-live");
  const proxy = await startRestoreProxy(PILOT_CLUSTER);
  const { Client } = requireApi("pg");
  const client = new Client({
    host: proxy.host,
    port: proxy.port,
    user: credential.username,
    password: credential.password,
    database: PILOT_DATABASE,
    ssl: false,
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const identity = (
      await client.query(
        "SELECT current_database() AS database, session_user AS login",
      )
    ).rows[0];
    if (
      identity.database !== PILOT_DATABASE ||
      identity.login !== credential.username
    )
      throw new Error("pilot_session_identity_invalid");
    const schema = (
      await client.query(`SELECT count(*)::int AS total FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'pg_stat_%'`)
    ).rows[0];
    const columns = (
      await client.query(`SELECT count(*)::int AS total FROM information_schema.columns
      WHERE table_schema='public' AND table_name='org_settings' AND column_name='customer_email_sender_user_id'`)
    ).rows[0];
    const unsafe = (
      await client.query(`SELECT count(*)::int AS total FROM organizations
      WHERE slug NOT LIKE 'restore-drill-%' OR name NOT LIKE 'SYNTHETIC RESTORE ONLY%'`)
    ).rows[0];
    if (schema.total !== 90 || columns.total !== 1 || unsafe.total !== 0)
      throw new Error("pilot_database_not_prepared");
    await client.query("ROLLBACK");
    if (action === "--stage-database-secret") {
      await stagePilotSecrets({ DATABASE_URL: credential.connectionString });
    }
    console.log(
      JSON.stringify({
        check: "pilot_staging_connection",
        cluster: PILOT_CLUSTER,
        database: PILOT_DATABASE,
        login: credential.username,
        tables: schema.total,
        staged: action === "--stage-database-secret",
        appStarted: false,
        providersCalled: false,
      }),
    );
  } finally {
    await client.end().catch(() => {});
    await proxy.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `PILOT_CONNECTION_FAILED:${/^pilot_[a-z0-9_]+$/.test(error.message || "") ? error.message : "operation_failed"}`,
    );
    process.exitCode = 1;
  });
}
