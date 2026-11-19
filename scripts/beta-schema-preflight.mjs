import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function expectedBetaIdentity(env = process.env) {
  const database = env.GROWTHOS_PREFLIGHT_EXPECTED_DATABASE;
  const sessionUser = env.GROWTHOS_PREFLIGHT_EXPECTED_SESSION_USER;
  if (env.FLY_APP_NAME !== 'mogulforge-growthos' && database === undefined && sessionUser === undefined) {
    return null;
  }
  if (!database?.trim() || !sessionUser?.trim()) {
    throw new Error('Beta database identity expectations are incomplete.');
  }
  return { database, sessionUser };
}

/** SELECT-only admission check. Never creates, reconciles or migrates a schema. */
export async function verifyBetaColumns(client, expected, identity = null) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
    if (identity !== null) {
      const result = await client.query(
        'SELECT current_database() AS database_name, session_user AS session_user',
      );
      const rows = result?.rows;
      if (!Array.isArray(rows) || rows.length !== 1
          || rows[0]?.database_name !== identity.database || rows[0]?.session_user !== identity.sessionUser) {
        throw new Error('Beta database identity check failed.');
      }
    }
    const { rows } = await client.query(
      'SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema = ANY($1::text[])',
      [[...new Set(expected.map(column => column.schema))]],
    );
    const actual = new Set(rows.map(row => `${row.table_schema}.${row.table_name}.${row.column_name}`));
    const missing = expected.filter(column => !actual.has(`${column.schema}.${column.table}.${column.name}`));
    if (missing.length) throw new Error(`Beta schema is incomplete (${missing.length} missing columns). Provision and verify the confirmed fresh database before deploying.`);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const identity = expectedBetaIdentity();
  // scripts has explicit workspace DB/drizzle dependencies. tsx loads its schema.
  const [{ pool, ...schema }, { is }, { PgTable, getTableConfig }] = await Promise.all([
    import('@workspace/db'), import('drizzle-orm'), import('drizzle-orm/pg-core'),
  ]);
  try {
    pool.options.connectionTimeoutMillis = 15_000;
    const expected = Object.values(schema).filter(table => is(table, PgTable)).flatMap(table => {
      const config = getTableConfig(table);
      return config.columns.map(column => ({ schema: config.schema || 'public', table: config.name, name: column.name }));
    });
    if (expected.length === 0) throw new Error('Schema inventory is unavailable.');
    const client = await pool.connect();
    try { await verifyBetaColumns(client, expected, identity); }
    finally { client.release(); }
    const checks = identity === null ? 'schema column check' : 'database identity and schema column checks';
    console.log(`Beta ${checks} passed. No schema or application data was changed.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Connection errors can contain credentials or provider details.
    console.error('Beta schema preflight refused deployment. Verify database identity configuration, connectivity, and schema on the confirmed fresh database. No schema changes were attempted.');
    process.exitCode = 1;
  });
}
