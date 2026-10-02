import { createHash } from "node:crypto";
import * as schema from "@workspace/db";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { REVIEWED_FLY_PROVIDER_METADATA } from "./data-lifecycle-inventory-provider-contract";
import {
  DATA_LIFECYCLE_BLOCKERS,
  DATA_LIFECYCLE_CATALOG,
  DATA_LIFECYCLE_CATALOG_VERSION,
  DATA_LIFECYCLE_EXPECTED_TABLES,
  DATA_LIFECYCLE_ROW_LIMIT,
  type InventoryCatalogEntry,
} from "./data-lifecycle-inventory-catalog";

type ColumnShape = { name: string; type: string; notNull: boolean };
type ForeignKeyShape = {
  columns: string[]; foreignSchema: string; foreignTable: string;
  foreignColumns: string[]; onDelete: string; onUpdate: string; validated: boolean;
};
export type InventoryTableShape = {
  schema: string; name: string; kind: string; rls: boolean;
  columns: ColumnShape[]; primaryKey: string[]; foreignKeys: ForeignKeyShape[];
  owner?: string; viewDefinition?: string | null;
  extensions?: Array<{ name: string; version: string }>;
};

/**
 * Only the checked-in scripts/docker-parity-init.sql fixture is reviewed.
 * This is NOT a pg_stat_* allowlist or evidence of a hosted extension's shape.
 * The optional relation is metadata-only and never enters tenant count SQL.
 */
export const REVIEWED_PROVIDER_METADATA = {
  contract: "docker_parity_provider_monitor_v1",
  table: {
    schema: "public", name: "pg_stat_monitor", kind: "v", rls: false,
    owner: "fly_provider",
    columns: [
      { name: "observed_at", type: "timestamp with time zone", notNull: false },
      { name: "source", type: "text", notNull: false },
    ],
    primaryKey: [], foreignKeys: [],
    extensions: [],
    viewDefinition: "SELECT clock_timestamp() AS observed_at, 'provider-managed'::text AS source;",
  } satisfies InventoryTableShape,
} as const;
const normalizeViewDefinition = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim();
const REVIEWED_PROVIDER_METADATA_CONTRACTS = [REVIEWED_PROVIDER_METADATA, REVIEWED_FLY_PROVIDER_METADATA];

function normalizeType(value: string): string {
  return value.replace(/^varchar/, "character varying")
    .replace(/^timestamp$/, "timestamp without time zone")
    .replace(/,\s+/g, ",");
}
function canonical(shape: InventoryTableShape): InventoryTableShape {
  return {
    schema: shape.schema, name: shape.name, kind: shape.kind, rls: shape.rls,
    columns: shape.columns.map((c) => ({ name: c.name, type: normalizeType(c.type), notNull: c.notNull }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    primaryKey: shape.primaryKey,
    foreignKeys: shape.foreignKeys.map((f) => ({
      columns: f.columns, foreignSchema: f.foreignSchema, foreignTable: f.foreignTable,
      foreignColumns: f.foreignColumns, onDelete: f.onDelete, onUpdate: f.onUpdate, validated: f.validated,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

/** Source metadata only; no database reads and no automatic classifications. */
export function getDataLifecycleSourceSchema(): InventoryTableShape[] {
  return (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable))
    .map((table) => {
      const config = getTableConfig(table);
      return canonical({
        schema: config.schema ?? "public", name: config.name, kind: "r", rls: false,
        columns: config.columns.map((c) => ({ name: c.name, type: c.getSQLType(), notNull: c.notNull })),
        primaryKey: [
          ...config.columns.filter((c) => c.primary).map((c) => c.name),
          ...config.primaryKeys.flatMap((key) => key.columns.map((c) => c.name)),
        ],
        foreignKeys: config.foreignKeys.map((key) => {
          const reference = key.reference();
          const foreign = getTableConfig(reference.foreignTable);
          return {
            columns: reference.columns.map((c) => c.name),
            foreignSchema: foreign.schema ?? "public", foreignTable: foreign.name,
            foreignColumns: reference.foreignColumns.map((c) => c.name),
            onDelete: key.onDelete ?? "no action", onUpdate: key.onUpdate ?? "no action", validated: true,
          };
        }),
      });
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export function validateDataLifecycleSchema(
  deployed: InventoryTableShape[],
  source = getDataLifecycleSourceSchema(),
): { matched: boolean; reasons: string[]; providerMetadataExclusions: string[] } {
  const reasons = new Set<string>();
  const providerMetadataExclusions = new Set<string>();
  const catalogNames = DATA_LIFECYCLE_CATALOG.map((entry) => entry.table).sort();
  const sourceNames = source.map((table) => table.name).sort();
  if (catalogNames.length !== DATA_LIFECYCLE_EXPECTED_TABLES ||
      new Set(catalogNames).size !== catalogNames.length ||
      JSON.stringify(sourceNames) !== JSON.stringify(catalogNames)) reasons.add("catalog_source_mismatch");
  const sourceByName = new Map(source.map((table) => [`${table.schema}.${table.name}`, table]));
  for (const entry of DATA_LIFECYCLE_CATALOG) {
    const table = sourceByName.get(`public.${entry.table}`);
    const column = entry.selector === "organization_id" ? "organization_id"
      : entry.selector === "organization_primary_key" ? "id"
      : entry.selector === "user_organization" ? "user_id" : null;
    if (!table || (column && !table.columns.some((c) => c.name === column))) reasons.add("catalog_source_mismatch");
  }
  const deployedByName = new Map<string, InventoryTableShape>();
  for (const table of deployed) {
    const key = `${table.schema}.${table.name}`;
    if (deployedByName.has(key)) reasons.add("unclassified_relation");
    deployedByName.set(key, table);
    if (!sourceByName.has(key)) {
      const candidates = REVIEWED_PROVIDER_METADATA_CONTRACTS.filter((contract) => key === `${contract.table.schema}.${contract.table.name}`);
      if (!candidates.length) reasons.add("unclassified_relation");
      else {
        const match = candidates.find(({ table: reviewed }) => table.owner === reviewed.owner &&
          JSON.stringify(table.extensions ?? []) === JSON.stringify(reviewed.extensions) &&
          normalizeViewDefinition(table.viewDefinition) === normalizeViewDefinition(reviewed.viewDefinition) &&
          JSON.stringify(canonical(table)) === JSON.stringify(canonical(reviewed)));
        if (match) providerMetadataExclusions.add(match.contract);
        else reasons.add("provider_metadata_unverified");
      }
    }
  }
  for (const [key, expected] of sourceByName) {
    const actual = deployedByName.get(key);
    if (!actual) reasons.add("missing_relation");
    else if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) reasons.add("schema_drift");
  }
  return { matched: reasons.size === 0, reasons: [...reasons].sort(), providerMetadataExclusions: [...providerMetadataExclusions] };
}

// pg_catalog includes relations the runtime role cannot SELECT. information_schema
// alone can silently omit them. No tenant rows, defaults or content are selected.
const SCHEMA_QUERY = `
SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
  pg_catalog.pg_get_userbyid(c.relowner) AS owner,
  CASE WHEN n.nspname = 'public' AND c.relname = 'pg_stat_monitor' AND c.relkind = 'v'
    THEN pg_catalog.pg_get_viewdef(c.oid, false) ELSE NULL END AS "viewDefinition",
  CASE WHEN n.nspname = 'public' AND c.relname = 'pg_stat_monitor'
    THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('name', e.extname, 'version', e.extversion) ORDER BY e.extname), '[]'::jsonb)
      FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
        AND d.objsubid = 0 AND d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e')
    ELSE '[]'::jsonb END AS extensions,
  (c.relrowsecurity OR c.relforcerowsecurity) AS rls,
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
    'notNull', a.attnotnull) ORDER BY a.attname), '[]'::jsonb)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT coalesce(jsonb_agg(a.attname ORDER BY k.ord), '[]'::jsonb)
    FROM pg_catalog.pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = p.conrelid AND a.attnum = k.num
    WHERE p.conrelid = c.oid AND p.contype = 'p') AS "primaryKey",
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'columns', (SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(f.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.num),
    'foreignSchema', fn.nspname, 'foreignTable', fc.relname,
    'foreignColumns', (SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(f.confkey) WITH ORDINALITY k(num, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.num),
    'validated', f.convalidated,
    'onDelete', CASE f.confdeltype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END,
    'onUpdate', CASE f.confupdtype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END
    )), '[]'::jsonb) FROM pg_catalog.pg_constraint f
    JOIN pg_catalog.pg_class fc ON fc.oid = f.confrelid JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE f.conrelid = c.oid AND f.contype = 'f') AS "foreignKeys"
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY n.nspname, c.relname LIMIT 256`;

// Identifiers come only from the explicit source-controlled catalog above.
function countFragment(entry: InventoryCatalogEntry, index: number): string {
  const from = `"public"."${entry.table}" t`;
  const where = entry.selector === "organization_primary_key" ? `t."id" = $1::uuid`
    : entry.selector === "user_organization" ? `EXISTS (SELECT 1 FROM "public"."users" u WHERE u."id" = t."user_id" AND u."organization_id" = $1::uuid)`
    : `t."organization_id" = $1::uuid`;
  return `SELECT ${index} AS entry, count(*)::integer AS count FROM (SELECT 1 FROM ${from} WHERE ${where} LIMIT ${DATA_LIFECYCLE_ROW_LIMIT + 1}) bounded`;
}

export type InventoryTablePreview = InventoryCatalogEntry & {
  rowCount: number | null;
  countStatus: "exact_in_snapshot" | "at_least_limit" | "excluded";
};
export type DataLifecycleInventory = {
  catalogVersion: string;
  status: "bounded_preview" | "blocked";
  complete: false; exportReady: false; deletionReady: false;
  coverage: {
    classifiedTables: number; sourceSchemaHash: string;
    deployedSchema: "matched" | "blocked"; reasons: string[];
    countedTables: number; excludedTables: number;
    providerMetadataExclusions: string[];
  };
  limits: { rowsPerTable: number; countQueryMs: number; totalMs: number };
  tables: InventoryTablePreview[];
  blockers: Array<{ code: string; detail: string }>;
};

export type InventoryClient = {
  connect(): Promise<unknown>;
  query(config: { text: string; values?: unknown[]; query_timeout: number }): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
  on(event: "error", callback: () => void): unknown;
};

const CONNECT_MS = 2_000, QUERY_MS = 5_000, TOTAL_MS = 12_000, CLOSE_MS = 500;
export class DataLifecycleInventoryUnavailable extends Error {
  constructor() { super("Data lifecycle inventory is unavailable"); }
}
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DataLifecycleInventoryUnavailable()), ms);
  })]).finally(() => clearTimeout(timer));
}

/**
 * A dedicated connection bounds acquisition and cannot leak READ ONLY/session
 * settings into application writes. No providers, DDL, row data, decryptors,
 * audit INSERTs, lifecycle mutations, or shared row counts are used here.
 */
export function createDataLifecycleInventoryReader({
  createClient = () => new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: CONNECT_MS,
    query_timeout: QUERY_MS + 500,
  }),
}: { createClient?: () => InventoryClient } = {}) {
  let running = false, cleanupBlocked = false;
  return async (organizationId: string): Promise<DataLifecycleInventory> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId) || running || cleanupBlocked) {
      throw new DataLifecycleInventoryUnavailable();
    }
    running = true;
    let client: InventoryClient | undefined, expired = false, failed = false;
    try {
      const source = getDataLifecycleSourceSchema();
      const result: DataLifecycleInventory = {
        catalogVersion: DATA_LIFECYCLE_CATALOG_VERSION, status: "blocked",
        complete: false, exportReady: false, deletionReady: false,
        coverage: {
          classifiedTables: DATA_LIFECYCLE_CATALOG.length,
          sourceSchemaHash: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
          deployedSchema: "blocked", reasons: [], countedTables: 0,
          excludedTables: DATA_LIFECYCLE_CATALOG.filter((e) => e.selector === "excluded").length,
          providerMetadataExclusions: [],
        },
        limits: { rowsPerTable: DATA_LIFECYCLE_ROW_LIMIT, countQueryMs: QUERY_MS, totalMs: TOTAL_MS },
        tables: [], blockers: DATA_LIFECYCLE_BLOCKERS.map((b) => ({ ...b })),
      };
      const sourceCoverage = validateDataLifecycleSchema(source, source);
      if (!sourceCoverage.matched) {
        result.coverage.reasons = sourceCoverage.reasons;
        return result;
      }
      client = createClient();
      client.on("error", () => { failed = true; });
      const selected = client;
      const query = async (text: string, values?: unknown[]) => {
        if (expired || failed) throw new DataLifecycleInventoryUnavailable();
        const response = await selected.query({ text, values, query_timeout: QUERY_MS + 500 });
        if (expired || failed) throw new DataLifecycleInventoryUnavailable();
        return response;
      };
      await bounded((async () => {
        await selected.connect();
        await query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await query("SET LOCAL statement_timeout = '5000ms'");
        await query("SET LOCAL lock_timeout = '500ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
        const live = await query(SCHEMA_QUERY);
        const coverage = validateDataLifecycleSchema(live.rows as InventoryTableShape[], source);
        result.coverage.reasons = coverage.reasons;
        if (!coverage.matched) return;
        result.coverage.providerMetadataExclusions = coverage.providerMetadataExclusions;
        if (coverage.providerMetadataExclusions.length) result.blockers.push({
          code: "reviewed_provider_metadata_excluded",
          detail: "Provider monitoring metadata matches a separately pinned exclusion contract. No monitoring rows were read. Unmatched owners, definitions, column shapes, extension membership or versions block preview; provider contents remain outside this inventory.",
        });
        const counted = DATA_LIFECYCLE_CATALOG.filter((entry) => entry.selector !== "excluded");
        const counts = await query(`${counted.map(countFragment).join("\nUNION ALL\n")}\nORDER BY entry`, [organizationId]);
        const rows = counts.rows as Array<{ entry: number; count: number }>;
        if (rows.length !== counted.length || rows.some((row, i) => row.entry !== i || !Number.isInteger(row.count) || row.count < 0 || row.count > DATA_LIFECYCLE_ROW_LIMIT + 1)) {
          throw new DataLifecycleInventoryUnavailable();
        }
        const byTable = new Map(counted.map((entry, i) => [entry.table, rows[i]!.count]));
        result.tables = DATA_LIFECYCLE_CATALOG.map((entry) => {
          const count = byTable.get(entry.table);
          return { ...entry, rowCount: count === undefined ? null : Math.min(count, DATA_LIFECYCLE_ROW_LIMIT),
            countStatus: count === undefined ? "excluded" : count > DATA_LIFECYCLE_ROW_LIMIT ? "at_least_limit" : "exact_in_snapshot" };
        });
        result.status = "bounded_preview";
        result.coverage.deployedSchema = "matched";
        result.coverage.countedTables = counted.length;
        if (rows.some((row) => row.count > DATA_LIFECYCLE_ROW_LIMIT)) result.blockers.push({ code: "row_limit_reached", detail: "At least one table reached the preview limit. Its count is a lower bound, not a complete count." });
        await query("ROLLBACK");
      })(), TOTAL_MS);
      if (failed) throw new DataLifecycleInventoryUnavailable();
      return result;
    } catch {
      // SQL/driver errors can contain rows, credentials or hostnames. The route
      // only receives this fixed failure; no raw exception is logged here.
      throw new DataLifecycleInventoryUnavailable();
    } finally {
      expired = true;
      if (client) {
        cleanupBlocked = true;
        const closing = Promise.resolve().then(() => client!.end()).then(() => { cleanupBlocked = false; }, () => undefined);
        try { await bounded(closing, CLOSE_MS); } catch { /* Remain blocked until a successful close. */ }
      }
      running = false;
      if (cleanupBlocked) throw new DataLifecycleInventoryUnavailable();
    }
  };
}

export const getDataLifecycleInventory = createDataLifecycleInventoryReader();
