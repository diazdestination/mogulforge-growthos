import { describe, expect, it } from "vitest";
import { assertBootstrapInventory, bootstrapClient, reviewedSchema } from "./pilot-staging-bootstrap.mjs";

const status = { data: { id: "zp2wjrejd2zodn4q", name: "mogulforge-growthos-staging-db", status: "ready" },
  credentials: { user: "fly-user", password: "fake-only", pgbouncer_uri: "postgres://fly-user:fake@pgbouncer.zp2wjrejd2zodn4q.flympg.net/fly-db" } };
const machines = [{ id: "8d96936a03d058", state: "stopped" }];
function clientStub({ tables = 0, database = "growthos_staging", failSql = false } = {}) {
  const queries = [];
  return { queries, async connect() {}, async end() {}, async query(sql) {
    queries.push(sql);
    if (sql.startsWith("SELECT current_database")) return { rows: [{ database, login: "fly-user" }] };
    if (sql.includes("information_schema.tables")) return { rows: [{ total: queries.includes("DDL") ? 90 : tables }] };
    if (sql === "DDL" && failSql) throw new Error("private driver detail");
    return { rows: [] };
  } };
}

describe("isolated pilot bootstrap", () => {
  it("pins the cluster, host, machine and stopped state", () => {
    expect(() => assertBootstrapInventory(status, machines)).not.toThrow();
    expect(() => assertBootstrapInventory({ ...status, data: { ...status.data, id: "kzpwm0j18eg04nv3" } }, machines)).toThrow();
    expect(() => assertBootstrapInventory(status, [{ ...machines[0], state: "started" }])).toThrow();
    expect(() => assertBootstrapInventory(status, [])).toThrow();
  });
  it("accepts only the pinned source schema bytes", async () => {
    const sql = await reviewedSchema();
    expect(sql.match(/CREATE TABLE /g)).toHaveLength(90);
    expect(sql).toContain('ADD COLUMN "customer_email_sender_user_id"');
  });
  it("inspects read-only by default", async () => {
    const client = clientStub();
    await bootstrapClient(client, { emit: () => {} });
    expect(client.queries[0]).toBe("BEGIN READ ONLY");
    expect(client.queries.at(-1)).toBe("ROLLBACK");
    expect(client.queries).not.toContain("DDL");
  });
  it("rejects an occupied database without applying SQL", async () => {
    const client = clientStub({ tables: 1 });
    await expect(bootstrapClient(client, { apply: true, sql: "DDL", emit: () => {} })).rejects.toThrow("pilot_database_not_empty");
    expect(client.queries).not.toContain("DDL");
    expect(client.queries.at(-1)).toBe("ROLLBACK");
  });
  it("rolls back failures and wrong-session targets", async () => {
    for (const options of [{ database: "production" }, { failSql: true }]) {
      const client = clientStub(options);
      await expect(bootstrapClient(client, { apply: true, sql: "DDL", emit: () => {} })).rejects.toThrow();
      expect(client.queries).not.toContain("COMMIT");
      expect(client.queries.at(-1)).toBe("ROLLBACK");
    }
  });
  it("commits a complete schema and emits no credential", async () => {
    const client = clientStub();
    const lines = [];
    await bootstrapClient(client, { apply: true, sql: "DDL", emit: (line) => lines.push(line) });
    expect(client.queries.at(-1)).toBe("COMMIT");
    expect(lines.join()).not.toMatch(/password|fake-only|postgres:\/\//);
    expect(JSON.parse(lines[0]).tables).toBe(90);
  });
});
