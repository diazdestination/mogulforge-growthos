import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reviewedSchema } from "./pilot-staging-bootstrap.mjs";
import { fixtureRows } from "./restore-drill-fixture.mjs";
import { trackPgliteSocketCleanup } from "./test-support/pglite-socket-cleanup.mjs";
import { probeFailureEvidence, probePoolOptions, probePreflight, reserveProbeRuntime } from "./pilot-scheduler-probe.mjs";

const requireApi = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { PGlite } = requireApi("@electric-sql/pglite");
const { PGLiteSocketServer, PGLiteSocketHandler } = requireApi("@electric-sql/pglite-socket");
const { Pool } = requireApi("pg");
let database, socketCleanup;
beforeAll(async () => {
  database = await PGlite.create();
  await database.exec(await reviewedSchema());
  for (const slug of ["restore-drill-pilot-a", "restore-drill-pilot-b"]) {
    for (const [table, row] of fixtureRows(slug, "synthetic-test-only")) {
      const keys = Object.keys(row);
      const values = keys.map((key) => ["metadata", "payload", "evidence", "options", "line_items"].includes(key)
        ? JSON.stringify(row[key]) : row[key]);
      await database.query(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, index) => `$${index + 1}`).join(",")})`, values);
    }
  }
}, 20000);
afterAll(async () => {
  if (socketCleanup) await socketCleanup.stop();
  if (database) await database.close();
});

function fixtureClient({ failQueueSql = false } = {}) {
  return { async query(sql, values) {
    if (failQueueSql && sql.includes("AS unsafe_count"))
      return database.query("SELECT pilot_scheduler_deliberately_missing_column");
    const result = await database.query(sql, values);
    // The isolated emulator is named postgres, not Fly's staging database.
    // Only this identity result is adapted; every SQL statement executes.
    if (sql.startsWith("SELECT current_database")) return { rows: [{ ...result.rows[0],
      database: "growthos_staging", login: "growthos-staging-live", role: "growthos-staging-live" }] };
    return result;
  } };
}

it("executes every preflight data query against the complete real schema and two inert fixtures", async () => {
  await expect(probePreflight(fixtureClient())).resolves.toMatchObject({ database: "growthos_staging" });
});

it("refuses a real queued synthetic action without executing or deleting it", async () => {
  const org = (await database.query("SELECT id FROM organizations ORDER BY slug LIMIT 1")).rows[0].id;
  const id = (await database.query(`INSERT INTO scheduled_actions(organization_id, action, run_at)
    VALUES($1, $2, now()) RETURNING id`, [org, JSON.stringify({ type: "create_task", params: { title: "Synthetic probe queue guard" } })])).rows[0].id;
  try {
    await expect(probePreflight(fixtureClient())).rejects.toThrow("pilot_scheduler_queued_or_contactable_work");
    expect((await database.query("SELECT status FROM scheduled_actions WHERE id=$1", [id])).rows[0].status).toBe("pending");
  } finally { await database.query("DELETE FROM scheduled_actions WHERE id=$1", [id]); }
});

it("reports a real SQL error with only its fixed stage and allowlisted SQLSTATE", async () => {
  const error = await probePreflight(fixtureClient({ failQueueSql: true })).catch((value) => value);
  expect(probeFailureEvidence(error)).toEqual({ check: "pilot_scheduler_probe", ok: false,
    error: "pilot_scheduler_operation_failed", stage: "preflight_queues", sqlstate: "42703", failureKind: "database_error" });
  expect(JSON.stringify(probeFailureEvidence(error))).not.toContain("deliberately_missing_column");
});

it("reserves the exact synthetic row through node-postgres bindings and a real socket, without replacing collisions", async () => {
  const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 5 });
  socketCleanup = trackPgliteSocketCleanup(server, PGLiteSocketHandler);
  let pool, client;
  const name = `pilot-scheduler-probe-${randomUUID()}`, owner = `${name}:reserved`;
  try {
    await server.start();
    pool = new Pool({ connectionString: `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`,
      ...probePoolOptions(1, "synthetic-local-probe-reservation") });
    client = await pool.connect();
    await client.query("SET statement_timeout = '8s'");
    await client.query("SELECT pg_try_advisory_lock(hashtext($1))", [`growthos:scheduler:${name}`]);
    await reserveProbeRuntime(client, name, owner);
    const row = (await client.query("SELECT * FROM scheduler_runtime WHERE name=$1", [name])).rows[0];
    expect(row).toMatchObject({ name, owner_id: owner, state: "stopped", failed_stages: [] });
    await expect(reserveProbeRuntime(client, name, "wrong-owner")).rejects.toThrow("pilot_scheduler_probe_row_exists");
    expect((await client.query("SELECT owner_id FROM scheduler_runtime WHERE name=$1", [name])).rows[0].owner_id).toBe(owner);
  } finally {
    if (client) {
      await client.query("DELETE FROM scheduler_runtime WHERE name=$1 AND owner_id=$2", [name, owner]);
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`growthos:scheduler:${name}`]);
      client.release(true);
    }
    if (pool) await pool.end();
    await socketCleanup.stop();
  }
});
