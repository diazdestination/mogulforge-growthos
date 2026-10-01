/** One-time, pinned schema bootstrap for the EMPTY isolated pilot database.
 * Never accepts a URL, password, app name, cluster, or SQL path from arguments.
 * Default is read-only inspection; --apply-reviewed-schema is an explicit write.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRestoreProxy } from "./restore-drill-connection.mjs";

const execute = promisify(execFile);
const requireApi = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
export const PILOT_CLUSTER = "zp2wjrejd2zodn4q";
export const PILOT_DATABASE = "growthos_staging";
export const REVIEWED_SCHEMA = [
  ["0000_isolated-staging-initial.sql", "b27d33a59a8a0f083fefe3271936d197309db5d683bd4254bbd28d7bc7315a10"],
  ["0001_pilot-email-sender.sql", "8d2d49f344e4900e5304d1f7b23ce23b929121f9af04362d50902a692605883f"],
];
const tableCountSql = `SELECT count(*)::int AS total FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'pg_stat_%'`;

export function assertBootstrapInventory(status, machines) {
  if (status.data?.id !== PILOT_CLUSTER || status.data?.name !== "mogulforge-growthos-staging-db" ||
      status.data?.status !== "ready" || status.credentials?.user !== "fly-user" ||
      !status.credentials?.password) throw new Error("pilot_cluster_identity_invalid");
  const uri = new URL(status.credentials.pgbouncer_uri);
  if (uri.hostname !== `pgbouncer.${PILOT_CLUSTER}.flympg.net`)
    throw new Error("pilot_cluster_host_invalid");
  if (!Array.isArray(machines) || machines.length !== 1 ||
      machines[0].id !== "8d96936a03d058" || machines[0].state !== "stopped")
    throw new Error("pilot_app_must_remain_stopped");
}

export async function reviewedSchema() {
  const chunks = [];
  for (const [name, hash] of REVIEWED_SCHEMA) {
    // Git may check out CRLF on Windows. Pin canonical LF source bytes.
    const bytes = Buffer.from((await readFile(new URL(`../reports/staging-schema-preview-2026-09-30/${name}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n"));
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("pilot_schema_hash_mismatch");
    chunks.push(bytes.toString("utf8"));
  }
  return chunks.join("\n");
}

export async function bootstrapClient(client, { apply = false, sql, emit = console.log } = {}) {
  let transaction = false;
  try {
    await client.connect();
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const identity = (await client.query("SELECT current_database() AS database, session_user AS login")).rows[0];
    if (identity?.database !== PILOT_DATABASE || identity?.login !== "fly-user")
      throw new Error("pilot_database_identity_invalid");
    // Serialize cooperative bootstrap runs; the emptiness check still fails closed.
    if (apply) await client.query("SELECT pg_advisory_xact_lock(846322101)");
    const before = (await client.query(tableCountSql)).rows[0]?.total;
    if (!Number.isInteger(before)) throw new Error("pilot_table_count_invalid");
    if (apply) {
      if (before !== 0) throw new Error("pilot_database_not_empty");
      if (!sql) throw new Error("pilot_schema_missing");
      await client.query(sql);
      const after = (await client.query(tableCountSql)).rows[0]?.total;
      if (after !== 90) throw new Error("pilot_schema_table_count_mismatch");
      await client.query("COMMIT");
      transaction = false;
      emit(JSON.stringify({ check: "pilot_schema_bootstrap", cluster: PILOT_CLUSTER,
        database: PILOT_DATABASE, applied: true, tables: after, files: REVIEWED_SCHEMA,
        appStarted: false, providersCalled: false }));
    } else {
      emit(JSON.stringify({ check: "pilot_database_inspection", cluster: PILOT_CLUSTER,
        database: PILOT_DATABASE, tables: before, readOnly: true }));
    }
  } finally {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply-reviewed-schema"))
    throw new Error("pilot_argument_invalid");
  const apply = args[0] === "--apply-reviewed-schema";
  const cli = async (args) => JSON.parse((await execute("fly", args, {
    windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
  })).stdout);
  const [status, machines] = await Promise.all([
    cli(["mpg", "status", PILOT_CLUSTER, "--json"]),
    cli(["machine", "list", "-a", "mogulforge-growthos-staging", "--json"]),
  ]);
  assertBootstrapInventory(status, machines);
  const sql = await reviewedSchema();
  const proxy = await startRestoreProxy(PILOT_CLUSTER);
  try {
    const { Client } = requireApi("pg");
    const client = new Client({ host: proxy.host, port: proxy.port,
      user: status.credentials.user, password: status.credentials.password,
      database: PILOT_DATABASE, ssl: false, connectionTimeoutMillis: 10000 });
    await bootstrapClient(client, { apply, sql });
  } finally { await proxy.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never echo CLI output, driver messages, URLs, credentials, or SQL payloads.
    const label = /^pilot_[a-z_]+$/.test(error.message || "") ? error.message : "operation_failed";
    console.error(`PILOT_BOOTSTRAP_FAILED:${label}`);
    process.exitCode = 1;
  });
}
