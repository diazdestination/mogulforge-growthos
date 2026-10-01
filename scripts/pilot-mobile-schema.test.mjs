import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reviewedSchema } from "./pilot-staging-bootstrap.mjs";

const requireApi = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { PGlite } = requireApi("@electric-sql/pglite");
const tableNames = ["email_sender_preferences", "microsoft_connections", "staff_push_deliveries", "staff_push_policies", "staff_push_subscriptions"];
let database, previousCount, sql;
beforeAll(async () => {
  database = await PGlite.create();
  await database.exec(await reviewedSchema());
  previousCount = (await database.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n;
  sql = await readFile(new URL("../reports/staging-schema-preview-2026-10-01/0002_mobile-microsoft-pilot.sql", import.meta.url), "utf8");
  await database.exec(sql);
}, 25000);
afterAll(async () => { await database?.close(); });

it("applies only five additive tables to the original reviewed pilot schema", async () => {
  expect([...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(tableNames);
  expect(sql).not.toMatch(/\bDROP\s|\bTRUNCATE\s|\bUPDATE\s+"|\bDELETE\s+FROM/i);
  const count = (await database.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n;
  expect(count).toBe(previousCount + 5);
  const indexes = await database.query("SELECT indexname FROM pg_indexes WHERE tablename=ANY($1::text[])", [tableNames]);
  expect(indexes.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining([
    "email_sender_preferences_org_user_uniq", "microsoft_connections_org_user_uniq", "staff_push_lead_device_uq", "staff_push_endpoint_uq",
  ]));
});

it("session removal invalidates enrolled devices without deleting the historical subscription", async () => {
  const org = (await database.query("INSERT INTO organizations(name,slug) VALUES('SYNTHETIC mobile schema','synthetic-mobile-schema') RETURNING id")).rows[0].id;
  const user = (await database.query("INSERT INTO users(organization_id,role,email) VALUES($1,'owner','synthetic-schema@example.invalid') RETURNING id", [org])).rows[0].id;
  await database.query("INSERT INTO sessions(sid,sess,expire) VALUES('synthetic-schema-session','{}',now()+interval '1 day')");
  await database.query("INSERT INTO staff_push_subscriptions(organization_id,user_id,session_id,endpoint_hash,expires_at) VALUES($1,$2,'synthetic-schema-session','synthetic-hash',now()+interval '1 day')", [org, user]);
  await database.query("DELETE FROM sessions WHERE sid='synthetic-schema-session'");
  const rows = (await database.query("SELECT session_id FROM staff_push_subscriptions WHERE organization_id=$1", [org])).rows;
  expect(rows).toEqual([{ session_id: null }]);
});
