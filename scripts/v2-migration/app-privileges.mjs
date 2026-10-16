#!/usr/bin/env node
/** Go/no-go check that the APP login can use every expected table and enum type on V2.
 *
 *   APP_DATABASE_URL=<V2 URL as the app login> node scripts/v2-migration/app-privileges.mjs
 *
 * The expected inventory is the reviewed 142-table catalog (not what the login can see):
 * each expected public table is looked up by name in pg_class (visible regardless of grants)
 * and SELECT, INSERT, UPDATE and DELETE are checked SEPARATELY by relation OID. Also checks
 * database CONNECT, schema USAGE and USAGE on every expected enum type, and reports public
 * tables outside the expected inventory. Exit 0 only with zero gaps. Names only, no data. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, loadReviewedPlan, safeError } from './lib.mjs';

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

export async function appPrivilegeGaps(client, { tables, enums }) {
  const gaps = [];
  const base = (await client.query(`SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS connect,
    has_schema_privilege(current_user, 'public', 'USAGE') AS usage`)).rows[0];
  if (!base.connect) gaps.push({ object: 'database', privilege: 'CONNECT' });
  if (!base.usage) gaps.push({ object: 'schema', name: 'public', privilege: 'USAGE' });
  const tableRows = (await client.query(`SELECT t.name, p.privilege, c.oid IS NOT NULL AS present,
      CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user, c.oid, p.privilege) END AS granted
    FROM unnest($1::text[]) AS t(name) CROSS JOIN unnest($2::text[]) AS p(privilege)
    LEFT JOIN pg_class c ON c.relnamespace = 'public'::regnamespace AND c.relname = t.name AND c.relkind IN ('r','p')
    ORDER BY 1, 2`, [tables, PRIVILEGES])).rows;
  for (const r of tableRows) if (!r.granted) gaps.push({ object: r.present ? 'table' : 'missing-table', name: r.name, privilege: r.privilege });
  const typeRows = (await client.query(`SELECT e.name, t.oid IS NOT NULL AS present,
      CASE WHEN t.oid IS NULL THEN false ELSE has_type_privilege(current_user, t.oid, 'USAGE') END AS granted
    FROM unnest($1::text[]) AS e(name) LEFT JOIN pg_type t ON t.typnamespace = 'public'::regnamespace AND t.typname = e.name AND t.typtype = 'e'
    ORDER BY 1`, [enums])).rows;
  for (const r of typeRows) if (!r.granted) gaps.push({ object: r.present ? 'type' : 'missing-type', name: r.name, privilege: 'USAGE' });
  const unexpectedTables = (await client.query(`SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace
    AND relkind IN ('r','p') AND NOT relname = ANY($1::text[]) ORDER BY 1`, [tables])).rows.map(r => r.name);
  const login = (await client.query('SELECT session_user::text AS login, current_user::text AS role')).rows[0];
  return { status: gaps.length === 0 && unexpectedTables.length === 0 ? 'OK' : 'GAPS', login,
    checked: { tables: tables.length, privilegesPerTable: PRIVILEGES.length, enums: enums.length }, gaps, unexpectedTables };
}

export async function checkAppPrivileges(url) {
  const plan = loadReviewedPlan();
  const expected = { tables: plan.canonical142.tables.map(t => t.name), enums: plan.canonical142.enums.map(e => e.name) };
  const client = await connect(url, 'growthos-v2-app-privileges');
  try { return await appPrivilegeGaps(client, expected); } finally { await client.end().catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkAppPrivileges(process.env.APP_DATABASE_URL)
    .then(r => { console.log(JSON.stringify(r, null, 2)); if (r.status !== 'OK') process.exitCode = 1; })
    .catch(e => { console.log(JSON.stringify({ status: 'FAILED', error: safeError(e) }, null, 2)); process.exitCode = 1; });
}
