import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool } from "@workspace/db";
import app from "../app";
import { createSession, deleteSession } from "./auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

let server: Server;
let base: string;
const slugs = [
  `restore-drill-http-a-${randomUUID().slice(0, 8)}`,
  `restore-drill-http-b-${randomUUID().slice(0, 8)}`,
];
const ids: Array<Record<string, string>> = [];
const sessions: string[] = [];
const previousMode = process.env.RESTORE_DRILL_ONLY;
let objectBytes: (slug: string) => Buffer;

async function snapshot(org: string) {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organization_id' ORDER BY table_name",
  );
  const result: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("Unexpected test table name");
    const row = await pool.query<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest FROM ${table} t WHERE organization_id = $1`,
      [org],
    );
    result[table] = row.rows[0].digest;
  }
  return result;
}

beforeAll(async () => {
  const fixtureModule = new URL(
    "../../../../scripts/restore-drill-fixture.mjs",
    import.meta.url,
  ).href;
  const {
    fixtureRows,
    fixtureIds,
    credentialCodec,
    FAKE_REFRESH_TOKEN,
    fixtureObject,
  } = await import(fixtureModule);
  objectBytes = fixtureObject;
  const codec = await credentialCodec(Buffer.alloc(32, 59).toString("base64"));
  for (const slug of slugs) {
    const id = fixtureIds(slug) as Record<string, string>;
    ids.push(id);
    const rows = fixtureRows(
      slug,
      codec.encrypt(FAKE_REFRESH_TOKEN, `${id.organization}:${id.user}:gmail`),
    ) as Array<[string, Record<string, unknown>]>;
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      for (const [table, row] of rows) {
        const keys = Object.keys(row);
        const values = keys.map((key) =>
          ["metadata", "payload", "evidence", "options", "line_items"].includes(
            key,
          )
            ? JSON.stringify(row[key])
            : row[key],
        );
        await writer.query(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`,
          values,
        );
      }
      await writer.query("COMMIT");
    } catch (error) {
      await writer.query("ROLLBACK");
      throw error;
    } finally {
      writer.release();
    }
    sessions.push(
      await createSession({
        user: {
          id: id.user,
          email: `${slug}.operator@example.invalid`,
          firstName: "Synthetic",
          lastName: "Restore",
          profileImageUrl: null,
        },
        access_token: "synthetic-session-no-provider",
      }),
    );
  }
  process.env.RESTORE_DRILL_ONLY = "true";
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60000);

afterAll(async () => {
  if (previousMode === undefined) delete process.env.RESTORE_DRILL_ONLY;
  else process.env.RESTORE_DRILL_ONLY = previousMode;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...ids.map((id) => id.organization));
});

const request = (path: string, tenant = 0, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${sessions[tenant]}`, ...init.headers },
  });

it("reads recovered CRM, Revenue Desk, project-room snapshots and private bytes through the actual app without modifying tenant records", async () => {
  const before = await snapshot(ids[0].organization);
  for (const path of [
    "/api/healthz",
    "/api/auth/user",
    `/api/v1/contacts/${ids[0].contact}`,
    `/api/v1/leads/${ids[0].lead}`,
    `/api/v1/projects/${ids[0].project}`,
    `/api/v1/revenue/rooms/${ids[0].lead}`,
    "/api/v1/revenue/value",
    `/api/v1/revenue/executions/${ids[0].execution}`,
    `/api/v1/revenue/evidence/${ids[0].lead}`,
    "/api/v1/revenue/desk",
  ]) {
    const response = await request(path);
    expect(response.status, path).toBe(200);
    expect(await response.json()).toBeTruthy();
  }
  const object = await request(
    `/api/v1/storage/objects/uploads/${ids[0].object}`,
  );
  expect(object.status).toBe(200);
  expect(
    Buffer.from(await object.arrayBuffer()).equals(objectBytes(slugs[0])),
  ).toBe(true);
  expect(await snapshot(ids[0].organization)).toEqual(before);
});

it("retains tenant boundaries and rejects write, OAuth and public-intake paths in restore mode", async () => {
  for (const path of [
    `/api/v1/contacts/${ids[1].contact}`,
    `/api/v1/leads/${ids[1].lead}`,
    `/api/v1/revenue/rooms/${ids[1].lead}`,
    `/api/v1/storage/objects/uploads/${ids[1].object}`,
  ])
    expect((await request(path)).status, path).toBe(404);
  expect(
    (
      await request(`/api/v1/contacts/${ids[0].contact}`, 0, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: "modified" }),
      })
    ).status,
  ).toBe(405);
  for (const path of [
    "/api/login",
    "/api/logout",
    "/api/callback",
    "/api/dev/login",
    "/api/v1/integrations/google/callback",
    "/api/v1/public/assessments",
  ])
    expect((await request(path)).status, path).toBe(405);
});
