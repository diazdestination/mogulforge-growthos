import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SELECT-only admission check. Never creates, reconciles or migrates a schema. */
export async function verifyBetaColumns(client, expected) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
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
    try { await verifyBetaColumns(client, expected); }
    finally { client.release(); }
    console.log('Beta schema column check passed; no schema or application data was changed.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Connection errors can contain credentials or provider details.
    console.error('Beta schema preflight refused deployment. Verify database connectivity and provision the current schema on the confirmed fresh database. No schema changes were attempted.');
    process.exitCode = 1;
  });
}
