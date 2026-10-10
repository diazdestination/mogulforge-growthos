/**
 * Metadata-only PostgreSQL catalog collector. No connections, URLs, credentials,
 * environment reads, DDL, data-table reads, session changes, or file writes.
 * Caller owns an already-authorized connection and READ ONLY transaction.
 * Application tables are public ordinary/partitioned tables, excluding objects
 * owned by extensions. All comparisons are exact; mismatches require review.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const applicationTable = `n.nspname = 'public' AND t.relkind IN ('r', 'p')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = t.oid AND d.deptype = 'e')`;

export const CATALOG_QUERIES = Object.freeze({
  tables: `SELECT n.nspname AS schema, t.relname AS name, t.relkind::text AS kind,
    t.relpersistence::text AS persistence, t.relrowsecurity AS row_security,
    t.relforcerowsecurity AS force_row_security, t.relispartition AS is_partition
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE ${applicationTable} ORDER BY n.nspname, t.relname`,
  columns: `SELECT t.relname AS table_name, a.attname AS name, a.attnum::int AS ordinal,
    tn.nspname AS type_schema, ty.typname AS type_name, a.atttypmod::int AS type_modifier,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
    NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, false) AS default_expression,
    a.attidentity::text AS identity, a.attgenerated::text AS generated,
    cn.nspname AS collation_schema, col.collname AS collation_name
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = ty.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = t.oid AND ad.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation col ON col.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = col.collnamespace
    WHERE ${applicationTable} ORDER BY t.relname, a.attname`,
  constraints: `SELECT t.relname AS table_name, c.conname AS name, c.contype::text AS kind,
    c.condeferrable AS deferrable, c.condeferred AS initially_deferred, c.convalidated AS validated,
    c.connoinherit AS no_inherit, pg_catalog.pg_get_constraintdef(c.oid, false) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, seq)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.seq) AS columns,
    rn.nspname AS referenced_schema, rt.relname AS referenced_table,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, seq)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.seq) AS referenced_columns,
    c.confupdtype::text AS update_action, c.confdeltype::text AS delete_action, c.confmatchtype::text AS match_type
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid
    LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace
    WHERE ${applicationTable} ORDER BY t.relname, c.conname`,
  indexes: `SELECT t.relname AS table_name, ix.relname AS name, am.amname AS method,
    i.indisunique AS is_unique, i.indisprimary AS is_primary, i.indisexclusion AS is_exclusion,
    i.indimmediate AS is_immediate, i.indisvalid AS is_valid, i.indisready AS is_ready, i.indislive AS is_live,
    i.indnullsnotdistinct AS nulls_not_distinct, i.indnkeyatts::int AS key_count, i.indnatts::int AS attribute_count,
    pg_catalog.pg_get_indexdef(i.indexrelid, 0, false) AS definition,
    pg_catalog.pg_get_expr(i.indexprs, i.indrelid, false) AS expressions,
    pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) AS predicate
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid JOIN pg_catalog.pg_am am ON am.oid = ix.relam
    WHERE ${applicationTable} ORDER BY t.relname, ix.relname`,
  enums: `SELECT n.nspname AS schema, ty.typname AS name,
    ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = ty.oid ORDER BY e.enumsortorder) AS labels
    FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace n ON n.oid = ty.typnamespace
    WHERE n.nspname = 'public' AND ty.typtype = 'e'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_type'::regclass
      AND d.objid = ty.oid AND d.deptype = 'e') ORDER BY n.nspname, ty.typname`,
  triggers: `SELECT t.relname AS table_name, tg.tgname AS name, tg.tgenabled::text AS enabled,
    pg_catalog.pg_get_triggerdef(tg.oid, false) AS definition
    FROM pg_catalog.pg_trigger tg JOIN pg_catalog.pg_class t ON t.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE ${applicationTable} AND NOT tg.tgisinternal ORDER BY t.relname, tg.tgname`,
  policies: `SELECT schemaname AS schema, tablename AS table_name, policyname AS name,
    permissive, roles::text[] AS roles, cmd AS command, qual AS using_expression, with_check AS check_expression
    FROM pg_catalog.pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
});

export async function collectSchemaCatalog(client) {
  if (!client || typeof client.query !== 'function') throw new TypeError('catalog_query_client_required');
  const catalog = { formatVersion: 1 };
  for (const [section, sql] of Object.entries(CATALOG_QUERIES)) {
    catalog[section] = (await client.query(sql)).rows;
  }
  return catalog;
}

/** Physical column order differs after additive ALTER versus fresh CREATE.
 * PostgreSQL 18 also exposes redundant NOT NULL rows in pg_constraint; older
 * supported versions expose them only as attnotnull. Capture retains both;
 * logical comparison uses column nullable for that invariant on every version.
 * No CHECK/FK/index/default/type or validity detail is excluded.
 */
export function logicalCatalog(catalog) {
  return {
    ...catalog,
    columns: catalog.columns.map(({ ordinal: _ordinal, ...column }) => column),
    constraints: catalog.constraints.filter((constraint) => constraint.kind !== 'n'),
  };
}

export function catalogDigest(catalog, { physical = false } = {}) {
  return createHash('sha256').update(JSON.stringify(physical ? catalog : logicalCatalog(catalog))).digest('hex');
}

export function catalogDifferences(actual, expected, { physical = false } = {}) {
  const left = physical ? actual : logicalCatalog(actual);
  const right = physical ? expected : logicalCatalog(expected);
  const differences = [];
  if (left.formatVersion !== right.formatVersion) differences.push({ section: 'formatVersion', kind: 'changed' });
  const key = (row) => [row.schema ?? '', row.table_name ?? '', row.name].join('.');
  for (const section of Object.keys(CATALOG_QUERIES)) {
    const actualRows = new Map(left[section].map((row) => [key(row), row]));
    const expectedRows = new Map(right[section].map((row) => [key(row), row]));
    for (const [name, row] of expectedRows) {
      if (!actualRows.has(name)) differences.push({ section, name, kind: 'missing' });
      else if (!isDeepStrictEqual(actualRows.get(name), row)) {
        const current = actualRows.get(name);
        differences.push({ section, name, kind: 'changed', fields: [...new Set([...Object.keys(current), ...Object.keys(row)])].filter((field) => !isDeepStrictEqual(current[field], row[field])) });
      }
    }
    for (const name of actualRows.keys()) if (!expectedRows.has(name)) differences.push({ section, name, kind: 'unexpected' });
  }
  return differences;
}

export function assertCatalogEquivalent(actual, expected, options) {
  const differences = catalogDifferences(actual, expected, options);
  if (differences.length) {
    const error = new Error('catalog_metadata_drift');
    error.differences = differences;
    throw error;
  }
}
