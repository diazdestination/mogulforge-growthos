import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pool } from "@workspace/db";
import { expect, it } from "vitest";

it("preserves representative legacy rows and tenant identity when applying the reviewed additive delta", async () => {
  const schema = `swarm_upgrade_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE organizations (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE leads (id text PRIMARY KEY, organization_id text NOT NULL, created_at timestamptz NOT NULL, estimated_value_cents integer);
      CREATE TABLE lead_imports (id text PRIMARY KEY, imported integer NOT NULL);
      INSERT INTO organizations VALUES ('a', 'Legacy A'), ('b', 'Legacy B');
      INSERT INTO leads VALUES ('old-a', 'a', '2025-01-01Z', 125000), ('old-a2', 'a', '2025-01-02Z', NULL);
      INSERT INTO lead_imports VALUES ('old-batch', 2);
    `);
    const delta = await readFile(new URL("../../../../reports/staging-schema-preview-2026-10-01/0003_swarm-foundation.sql", import.meta.url), "utf8");
    await client.query(delta);
    expect((await client.query("SELECT name, entitlements FROM organizations WHERE id = 'a'")).rows).toEqual([{ name: "Legacy A", entitlements: null }]);
    expect((await client.query("SELECT estimated_value_cents, imported_history, import_source_key FROM leads WHERE id = 'old-a'")).rows).toEqual([{ estimated_value_cents: 125000, imported_history: null, import_source_key: null }]);
    expect((await client.query("SELECT imported, updated, conflicts, source_key, snapshot_as_of FROM lead_imports")).rows).toEqual([{ imported: 2, updated: 0, conflicts: 0, source_key: null, snapshot_as_of: null }]);
    await client.query("INSERT INTO leads (id, organization_id, created_at, import_source_key, external_opportunity_id) VALUES ('new-a', 'a', now(), 'source', 'job'), ('new-b', 'b', now(), 'source', 'job')");
    await client.query("SAVEPOINT duplicate_identity");
    await expect(client.query("INSERT INTO leads (id, organization_id, created_at, import_source_key, external_opportunity_id) VALUES ('duplicate', 'a', now(), 'source', 'job')")).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_identity");
    expect((await client.query("SELECT COUNT(*)::int AS count FROM leads")).rows[0].count).toBe(4);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
