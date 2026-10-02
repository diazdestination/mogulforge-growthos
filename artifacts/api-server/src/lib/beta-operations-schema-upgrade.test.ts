import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pool } from "@workspace/db";
import { expect, it } from "vitest";

it("adds billing/lifecycle ledgers without changing legacy company state and enforces one active checkout", async () => {
  const schema = `beta_upgrade_${randomUUID().replaceAll("-", "")}`;
  const org = randomUUID(), other = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query("CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL, subscription_status text); CREATE TABLE users (id varchar PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id));");
    await client.query("INSERT INTO organizations VALUES ($1, 'Legacy A', 'active'), ($2, 'Legacy B', null)", [org, other]);
    await client.query("INSERT INTO users VALUES ('owner-a', $1)", [org]);
    const delta = (await readFile(new URL("../../../../reports/staging-schema-preview-2026-10-01/0004_beta-operations.sql", import.meta.url), "utf8"))
      .replaceAll('REFERENCES "public".', `REFERENCES "${schema}".`);
    await client.query(delta);
    expect((await client.query("SELECT name, subscription_status FROM organizations ORDER BY name")).rows)
      .toEqual([{ name: "Legacy A", subscription_status: "active" }, { name: "Legacy B", subscription_status: null }]);
    expect((await client.query("SELECT count(*)::int AS count FROM customer_lifecycle")).rows[0].count).toBe(0);
    const insert = "INSERT INTO billing_checkouts (organization_id, intent, price_id, plan_id, success_url, cancel_url, provider_configuration_hash) VALUES ($1, 'initial', 'price_synthetic', 'beta', 'https://example.invalid/success', 'https://example.invalid/cancel', 'synthetic-hash')";
    await client.query(insert, [org]); await client.query(insert, [other]);
    await client.query("SAVEPOINT duplicate");
    // The generated UUID is trusted test data. Simple-protocol failures keep
    // the disposable PGlite socket's recovery in sync with real PostgreSQL.
    await expect(client.query(insert.replace("$1", `'${org}'`))).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate");
    await client.query("UPDATE billing_checkouts SET state = 'expired' WHERE organization_id = $1", [org]);
    await client.query(insert, [org]);
    expect((await client.query("SELECT count(*)::int AS count FROM billing_checkouts")).rows[0].count).toBe(3);
    await client.query("SAVEPOINT invalid_lifecycle");
    await expect(client.query(`INSERT INTO customer_lifecycle (organization_id,state,reason) VALUES ('${org}','unknown','synthetic')`)).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT invalid_lifecycle");
  } finally { await client.query("ROLLBACK"); client.release(); }
});
