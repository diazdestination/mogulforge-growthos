import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { REVIEWED_FLY_PROVIDER_METADATA } from "./data-lifecycle-inventory-provider-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_LIFECYCLE_CATALOG,
  DATA_LIFECYCLE_ROW_LIMIT,
} from "./data-lifecycle-inventory-catalog";
import {
  createDataLifecycleInventoryReader,
  getDataLifecycleSourceSchema,
  validateDataLifecycleSchema,
  REVIEWED_PROVIDER_METADATA,
  type InventoryClient,
  type InventoryTableShape,
} from "./data-lifecycle-inventory";

const source = getDataLifecycleSourceSchema();
const counted = DATA_LIFECYCLE_CATALOG.filter((entry) => entry.selector !== "excluded");
function fixture(live = structuredClone(source)) {
  const queries: Array<{ text: string; values?: unknown[]; query_timeout: number }> = [];
  const client = {
    connect: vi.fn(async (): Promise<void> => undefined),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
    query: vi.fn(async (query: { text: string; values?: unknown[]; query_timeout: number }) => {
      queries.push(query);
      if (query.text.includes("pg_catalog.pg_class c JOIN")) return { rows: live };
      if (query.text.includes("UNION ALL")) return { rows: counted.map((entry, i) => ({ entry: i, count: entry.table === "contacts" ? DATA_LIFECYCLE_ROW_LIMIT + 1 : 2 })) };
      return { rows: [] };
    }),
  } satisfies InventoryClient;
  const createClient = vi.fn(() => client);
  return { client, createClient, queries, read: createDataLifecycleInventoryReader({ createClient }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("explicit lifecycle schema coverage", () => {
  it("classifies every current source table without automatically adopting new tables", () => {
    expect(source).toHaveLength(142);
    expect(DATA_LIFECYCLE_CATALOG).toHaveLength(142);
    expect(DATA_LIFECYCLE_CATALOG.find(e=>e.table==="audit_events")).toMatchObject({category:"audit",ownership:"direct_org",selector:"organization_id"});
    expect(DATA_LIFECYCLE_CATALOG.find(e=>e.table==="org_settings")).toMatchObject({category:"configuration",ownership:"direct_org",selector:"organization_id"});
    for (const table of ["appointments","projects","org_settings"]) {
      const row=source.find(e=>e.name===table)!;
      expect(row.columns.find(column=>column.name===(table==="org_settings"?"scheduling_policy":"scheduling_reservation"))).toMatchObject({type:"jsonb",notNull:false});
    }
    expect(DATA_LIFECYCLE_CATALOG.find(e => e.table === "staff_lead_alert_coverage")).toEqual({
      table: "staff_lead_alert_coverage", category: "communications", ownership: "direct_org", selector: "organization_id",
    });
    expect(DATA_LIFECYCLE_CATALOG.filter(e=>e.table.startsWith("customer_work_")).map(e=>[e.table,e.category,e.selector])).toEqual([
      ["customer_work_roots","crm","organization_id"], ["customer_work_commands","audit","organization_id"],
    ]);
    expect(validateDataLifecycleSchema(source)).toEqual({ matched: true, reasons: [], providerMetadataExclusions: [] });
    expect(DATA_LIFECYCLE_CATALOG.filter((e) => e.ownership === "direct_org")).toHaveLength(136);
    expect(DATA_LIFECYCLE_CATALOG.filter((e) => e.ownership === "indirect_org").map((e) => e.table)).toEqual(["identity_tokens"]);
    expect(DATA_LIFECYCLE_CATALOG.filter((e) => e.ownership === "shared_exception").map((e) => e.table)).toEqual(["platform_email_dispatches", "platform_email_events", "rate_limit_counters", "scheduler_runtime", "sessions"]);
    expect(validateDataLifecycleSchema(source, [...source, { ...source[0]!, name: "new_source_table" }]).matched).toBe(false);
  });

  it.each([
    ["unknown table", (tables: InventoryTableShape[]) => tables.push({ ...tables[0]!, name: "OTHER_TENANT_SECRET_TABLE" })],
    ["unknown schema", (tables: InventoryTableShape[]) => tables.push({ ...tables[0]!, schema: "unreviewed" })],
    ["missing table", (tables: InventoryTableShape[]) => tables.pop()],
    ["extra column", (tables: InventoryTableShape[]) => tables[0]!.columns.push({ name: "new_column", type: "text", notNull: false })],
    ["changed type", (tables: InventoryTableShape[]) => { tables[0]!.columns[0]!.type = "jsonb"; }],
    ["changed nullability", (tables: InventoryTableShape[]) => { tables[0]!.columns[0]!.notNull = !tables[0]!.columns[0]!.notNull; }],
    ["missing ownership FK", (tables: InventoryTableShape[]) => { tables[0]!.foreignKeys = []; }],
    ["changed FK target", (tables: InventoryTableShape[]) => { tables[0]!.foreignKeys[0]!.foreignTable = "elsewhere"; }],
    ["unvalidated FK", (tables: InventoryTableShape[]) => { tables[0]!.foreignKeys[0]!.validated = false; }],
    ["changed primary key", (tables: InventoryTableShape[]) => { tables[0]!.primaryKey = []; }],
    ["view substitution", (tables: InventoryTableShape[]) => { tables[0]!.kind = "v"; }],
    ["RLS could hide rows", (tables: InventoryTableShape[]) => { tables[0]!.rls = true; }],
  ] as const)("rejects deployed %s before any tenant count", async (_label, mutate) => {
    const live = structuredClone(source);
    mutate(live);
    const { read, queries, client } = fixture(live);
    const result = await read(randomUUID());
    expect(result.status).toBe("blocked");
    expect(result.coverage.deployedSchema).toBe("blocked");
    expect(result.tables).toEqual([]);
    expect(result.coverage.countedTables).toBe(0);
    expect(queries.some((q) => q.text.includes("UNION ALL"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("OTHER_TENANT_SECRET_TABLE");
    expect(client.end).toHaveBeenCalledOnce();
  });
});

describe("explicit provider metadata fixture exception", () => {
  it("accepts only the reviewed optional relation without adding app tables or reading its rows", async () => {
    const provider = structuredClone(REVIEWED_PROVIDER_METADATA.table);
    const { read, queries } = fixture([...structuredClone(source), provider]);
    const result = await read(randomUUID());
    expect(result).toMatchObject({ status: "bounded_preview", complete: false, exportReady: false, deletionReady: false });
    expect(result.coverage).toMatchObject({ classifiedTables: 142, countedTables: 137, excludedTables: 5, providerMetadataExclusions: [REVIEWED_PROVIDER_METADATA.contract] });
    expect(result.tables).toHaveLength(142);
    expect(result.blockers.map((b) => b.code)).toContain("reviewed_provider_metadata_excluded");
    expect(queries.find((q) => q.text.includes("UNION ALL"))!.text).not.toContain("pg_stat_monitor");
  });

  it.each([
    ["another pg_stat name", (t: InventoryTableShape) => { t.name = "pg_stat_unreviewed"; }],
    ["another schema", (t: InventoryTableShape) => { t.schema = "other_schema"; }],
    ["unverified owner", (t: InventoryTableShape) => { t.owner = "app_owner"; }],
    ["missing owner", (t: InventoryTableShape) => { delete t.owner; }],
    ["table instead of view", (t: InventoryTableShape) => { t.kind = "r"; }],
    ["materialized view", (t: InventoryTableShape) => { t.kind = "m"; }],
    ["extra column", (t: InventoryTableShape) => { t.columns.push({ name: "query", type: "text", notNull: false }); }],
    ["different column type", (t: InventoryTableShape) => { t.columns[0]!.type = "text"; }],
    ["different nullability", (t: InventoryTableShape) => { t.columns[0]!.notNull = true; }],
    ["different definition", (t: InventoryTableShape) => { t.viewDefinition = "SELECT created_at AS observed_at, email AS source FROM public.users;"; }],
    ["missing definition", (t: InventoryTableShape) => { delete t.viewDefinition; }],
    ["unexpected extension membership", (t: InventoryTableShape) => { t.extensions = [{ name: "pg_stat_monitor", version: "2.3" }]; }],
  ] as const)("blocks %s before any tenant count", async (_name, mutate) => {
    const provider: InventoryTableShape = structuredClone(REVIEWED_PROVIDER_METADATA.table);
    mutate(provider);
    const { read, queries } = fixture([...structuredClone(source), provider]);
    const result = await read(randomUUID());
    expect(result.status).toBe("blocked");
    expect(result.tables).toEqual([]);
    expect(result.coverage.providerMetadataExclusions).toEqual([]);
    expect(queries.some((q) => q.text.includes("UNION ALL"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SELECT created_at");
  });

  it("matches catalog metadata from the actual checked-in view SQL in an isolated database", async () => {
    const sql = readFileSync(new URL("../../../../scripts/docker-parity-init.sql", import.meta.url), "utf8");
    const createView = sql.match(/CREATE VIEW public\.pg_stat_monitor AS[\s\S]*?;/)?.[0];
    const changeOwner = sql.match(/ALTER VIEW public\.pg_stat_monitor OWNER TO fly_provider;/)?.[0];
    expect(createView).toBeTruthy(); expect(changeOwner).toBeTruthy();
    const database = await PGlite.create();
    await database.exec(`CREATE ROLE fly_provider NOLOGIN; ${createView} ${changeOwner}`);
    const { client } = fixture();
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (query) => {
      if (query.text.includes("pg_catalog.pg_class c JOIN")) {
        const actual = await database.query<InventoryTableShape>(query.text);
        expect(actual.rows).toHaveLength(1);
        return { rows: [...structuredClone(source), ...actual.rows] };
      }
      // The provider view is never executed, including in this test adapter.
      expect(query.text).not.toMatch(/FROM\s+(?:"public"\.)?"?pg_stat_monitor/);
      return original(query);
    });
    try {
      const result = await createDataLifecycleInventoryReader({ createClient: () => client })(randomUUID());
      expect(result.status).toBe("bounded_preview");
      expect(result.coverage.providerMetadataExclusions).toEqual([REVIEWED_PROVIDER_METADATA.contract]);
    } finally { await database.close(); }
  });
});

describe("separately pinned Fly provider metadata", () => {
  it("accepts the exact reviewed 65-column extension contract without reading monitoring rows", async () => {
    const provider = structuredClone(REVIEWED_FLY_PROVIDER_METADATA.table);
    expect(provider.columns).toHaveLength(65);
    expect(provider).toMatchObject({ owner: "postgres", kind: "v", primaryKey: [], foreignKeys: [], extensions: [{ name: "pg_stat_monitor", version: "2.3" }] });
    const { read, queries } = fixture([...structuredClone(source), provider]);
    const result = await read(randomUUID());
    expect(result).toMatchObject({ status: "bounded_preview", complete: false, exportReady: false, deletionReady: false });
    expect(result.coverage).toMatchObject({ classifiedTables: 142, countedTables: 137, excludedTables: 5, providerMetadataExclusions: ["fly_mpg_pg_stat_monitor_2_3_v1"] });
    expect(result.tables).toHaveLength(142);
    const counts = queries.find((q) => q.text.includes("UNION ALL"))!.text;
    expect(counts).not.toContain("pg_stat_monitor");
    expect(counts).not.toContain("pg_stat_monitor_internal");
    expect(JSON.stringify(result)).not.toContain(provider.viewDefinition);
  });

  it.each([
    ["extension version drift", (t: InventoryTableShape) => { t.extensions![0]!.version = "2.4"; }],
    ["extension name drift", (t: InventoryTableShape) => { t.extensions![0]!.name = "unreviewed_extension"; }],
    ["missing extension membership", (t: InventoryTableShape) => { t.extensions = []; }],
    ["unreported extension metadata", (t: InventoryTableShape) => { delete t.extensions; }],
    ["extra extension membership", (t: InventoryTableShape) => { t.extensions!.push({ name: "other", version: "1" }); }],
    ["owner drift", (t: InventoryTableShape) => { t.owner = "fly_provider"; }],
    ["missing column", (t: InventoryTableShape) => { t.columns.pop(); }],
    ["new column", (t: InventoryTableShape) => { t.columns.push({ name: "new_column", type: "text", notNull: false }); }],
    ["column type drift", (t: InventoryTableShape) => { t.columns[0]!.type = "jsonb"; }],
    ["definition drift", (t: InventoryTableShape) => { t.viewDefinition += " -- changed"; }],
    ["kind drift", (t: InventoryTableShape) => { t.kind = "m"; }],
    ["RLS drift", (t: InventoryTableShape) => { t.rls = true; }],
    ["key constraint drift", (t: InventoryTableShape) => { t.primaryKey = ["userid"]; }],
    ["another monitoring relation", (t: InventoryTableShape) => { t.name = "pg_stat_monitor_other"; }],
  ] as const)("blocks %s before any tenant query", async (_name, mutate) => {
    const provider: InventoryTableShape = structuredClone(REVIEWED_FLY_PROVIDER_METADATA.table);
    mutate(provider);
    const { read, queries } = fixture([...structuredClone(source), provider]);
    const result = await read(randomUUID());
    expect(result.status).toBe("blocked");
    expect(result.tables).toEqual([]);
    expect(result.coverage.providerMetadataExclusions).toEqual([]);
    expect(queries.some((q) => q.text.includes("UNION ALL"))).toBe(false);
  });

  it("rejects duplicate same-name relations even when each claims a reviewed contract", () => {
    expect(validateDataLifecycleSchema([...source, REVIEWED_PROVIDER_METADATA.table, REVIEWED_FLY_PROVIDER_METADATA.table])).toMatchObject({ matched: false, reasons: ["unclassified_relation"] });
  });
});

describe("bounded read-only inventory", () => {
  it("uses only a read-only snapshot, bound tenant selectors and capped SELECT 1 counts", async () => {
    const { read, queries, client } = fixture();
    const org = randomUUID();
    const result = await read(org);
    expect(queries[0]!.text).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(queries.at(-1)!.text).toBe("ROLLBACK");
    expect(queries.every((q) => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)/.test(q.text.trim()))).toBe(true);
    const counts = queries.find((q) => q.text.includes("UNION ALL"))!;
    expect(counts.values).toEqual([org]);
    expect(counts.text.match(/LIMIT 10001/g)).toHaveLength(137);
    expect(counts.text.match(/\$1::uuid/g)).toHaveLength(137);
    expect(counts.text).toContain('FROM "public"."users" u WHERE u."id" = t."user_id" AND u."organization_id" = $1::uuid');
    for (const table of ["sessions", "rate_limit_counters", "scheduler_runtime"]) expect(counts.text).not.toContain(`"public"."${table}"`);
    expect(counts.text).not.toMatch(/SELECT\s+\*|encrypted_raw_text|password_hash|data\b|sess\b/);
    expect(result.tables).toHaveLength(142);
    expect(result.coverage.countedTables).toBe(137);
    expect(result.coverage.excludedTables).toBe(5);
    expect(result.tables.find((e) => e.table === "contacts")).toMatchObject({ rowCount: 10_000, countStatus: "at_least_limit" });
    expect(result.tables.find((e) => e.table === "sessions")).toMatchObject({ rowCount: null, countStatus: "excluded" });
    expect(result).toMatchObject({ status: "bounded_preview", complete: false, exportReady: false, deletionReady: false });
    expect(result.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["json_text_links_unresolved", "global_identity_sessions_unresolved", "media_ownership_unresolved", "restricted_email_content", "providers_backups_outside_preview", "row_limit_reached"]));
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("redacts query errors and disposes the connection without partial counts", async () => {
    const { read, client } = fixture();
    client.query.mockRejectedValueOnce(new Error("postgres://CANARY_PASSWORD@host CANARY_ROW_CONTENT"));
    await expect(read(randomUUID())).rejects.toThrow(/^Data lifecycle inventory is unavailable$/);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects malformed internal org IDs before connecting", async () => {
    const { read, createClient } = fixture();
    await expect(read("' OR TRUE --")).rejects.toThrow("unavailable");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects incomplete or unsafe count results", async () => {
    const { read, client } = fixture();
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (q) => q.text.includes("UNION ALL") ? { rows: [{ entry: 0, count: -1 }] } : original(q));
    await expect(read(randomUUID())).rejects.toThrow("unavailable");
  });

  it("bounds the whole read and rejects overlapping work without opening another connection", async () => {
    vi.useFakeTimers();
    const { read, createClient, client } = fixture();
    let resolveConnect!: () => void;
    client.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveConnect = resolve; }));
    const pending = expect(read(randomUUID())).rejects.toThrow("unavailable");
    await expect(read(randomUUID())).rejects.toThrow("unavailable");
    expect(createClient).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(12_001);
    await pending;
    resolveConnect();
    await Promise.resolve();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("blocks future reads after failed cleanup", async () => {
    const { read, createClient, client } = fixture();
    client.end.mockRejectedValueOnce(new Error("CANARY_CLOSE_FAILURE"));
    await expect(read(randomUUID())).rejects.toThrow("unavailable");
    await expect(read(randomUUID())).rejects.toThrow("unavailable");
    expect(createClient).toHaveBeenCalledOnce();
  });
});
