#!/usr/bin/env node
/** Copy the legacy V1 production database into a FRESH, EMPTY V2 database and
 * upgrade it to the reviewed 142-table schema, in ONE target transaction.
 *
 *   SOURCE_DATABASE_URL  V1 legacy database (read-only login recommended)
 *   TARGET_DATABASE_URL  fresh empty V2 database
 *   TARGET_OWNER_ROLE    optional; SET LOCAL ROLE so new objects are owned by it
 *
 *   node scripts/v2-migration/copy-to-v2.mjs --execute
 *
 * Route (reuses reviewed code, see lib.mjs): rebuild the exact legacy-75 schema
 * from the live source catalog, copy every row, add FKs, then apply the same 19
 * pinned SQL steps + 0019 that were rehearsed for the in-place upgrade.
 * Before COMMIT the target is verified against the source snapshot (catalog,
 * per-table row counts and sha256 fingerprints); any mismatch rolls back.
 * Prints a JSON summary only: no row values, no URLs, no credentials. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSchemaCatalog } from '../../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { connect, beginSourceSnapshot, loadReviewedPlan, captureSource, legacySchemaSql, foreignKeySql, readRows,
  tableColumns, verifyTarget, assertCatalogEqual, isEmptyTargetSql, check, q, safeError } from './lib.mjs';

export async function assertTargetEmpty(client) {
  const { relations, types } = (await client.query(isEmptyTargetSql)).rows[0];
  check(relations === '0' && types === '0', 'v2_target_not_empty', { relations: Number(relations), types: Number(types) });
}

export async function copyToV2({ sourceUrl, targetUrl, ownerRole = null } = {}) {
  check(sourceUrl && targetUrl && sourceUrl !== targetUrl, 'v2_source_target_must_differ');
  check(ownerRole === null || /^[a-z_][a-z0-9_-]{0,62}$/.test(ownerRole), 'v2_owner_role_invalid');
  const timings = {}, started = Date.now(), mark = name => { timings[name] = Date.now() - started; };
  const plan = loadReviewedPlan();
  let source, target;
  try {
    source = await connect(sourceUrl, 'growthos-v2-copy-source');
    target = await connect(targetUrl, 'growthos-v2-copy-target');
    // Same server+database is refused even if the URLs are spelled differently.
    const id = async c => (await c.query("SELECT system_identifier::text AS s, current_database() AS d FROM pg_control_system()").catch(() => ({ rows: [{}] }))).rows[0];
    const [sid, tid] = [await id(source), await id(target)];
    check(!(sid.s && sid.s === tid.s && sid.d === tid.d), 'v2_source_target_same_database');
    await assertTargetEmpty(target);
    mark('connected');

    // 1. Source: one consistent READ ONLY snapshot.
    await beginSourceSnapshot(source);
    const snap = await captureSource(source, plan);
    check(snap.sequences.length === 0, 'v2_source_sequences_unsupported');
    const rowsByTable = new Map();
    for (const t of snap.catalog.tables) rowsByTable.set(t.name, await readRows(source, snap.catalog, t.name));
    const otherSessions = Number((await source.query(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows[0].n);
    await source.query('ROLLBACK');
    mark('sourceRead');

    // 2. Target: everything in ONE transaction.
    await target.query('BEGIN');
    if (ownerRole) await target.query(`SET LOCAL ROLE "${ownerRole}"`); // validated above: no quotes possible
    await target.query("SET LOCAL lock_timeout='10s'");
    await assertTargetEmpty(target);
    await target.query(legacySchemaSql(snap.catalog, { foreignKeys: false }));
    let copied = 0;
    for (const t of snap.catalog.tables) {
      const cols = tableColumns(snap.catalog, t.name);
      const sql = `INSERT INTO public.${q(t.name)} (${cols.map(c => q(c.name)).join(',')}) VALUES (${cols.map((c, i) => `$${i + 1}::${c.formatted_type}`).join(',')})`;
      for (const row of rowsByTable.get(t.name)) { await target.query(sql, row); copied++; }
    }
    for (const fk of foreignKeySql(snap.catalog)) await target.query(fk);
    assertCatalogEqual(await collectSchemaCatalog(target), snap.catalog, 'v2_rebuilt_legacy_catalog_mismatch');
    mark('legacyCopied');
    for (const step of plan.steps.slice(0, -1)) await target.query(step.sql);
    assertCatalogEqual(await collectSchemaCatalog(target), snap.catalog142, 'v2_upgraded_catalog_mismatch');
    await target.query(plan.steps.at(-1).sql);
    mark('upgraded');
    const report = await verifyTarget(target, snap);
    if (!report.ok) { await target.query('ROLLBACK'); return summary('ROLLED_BACK', report); }
    await target.query('COMMIT');
    mark('committed');
    return summary('COMMITTED', report);

    function summary(status, report) {
      return { status, layoutSha256: snap.layout, sourceTables: snap.catalog.tables.length, rowsCopied: copied,
        sourceOtherSessions: otherSessions, stepsApplied: plan.steps.map(s => ({ name: s.name, sha256: s.sha256 })),
        verification: { ok: report.ok, problems: report.problems, warnings: report.warnings, catalog: report.catalog,
          addedColumnsChecked: report.addedColumnsChecked, sequences: report.sequences, database: report.database },
        tables: report.tables.map(({ table, kind, sourceRows, targetRows, match }) => ({ table, kind, sourceRows, targetRows, match })),
        timingsMs: { ...timings, total: Date.now() - started } };
    }
  } catch (e) {
    try { await target?.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    await Promise.allSettled([source?.end(), target?.end()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--execute') { console.error('usage: SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node copy-to-v2.mjs --execute'); process.exit(2); }
  copyToV2({ sourceUrl: process.env.SOURCE_DATABASE_URL, targetUrl: process.env.TARGET_DATABASE_URL, ownerRole: process.env.TARGET_OWNER_ROLE || null })
    .then(r => { console.log(JSON.stringify(r, null, 2)); if (r.status !== 'COMMITTED') process.exitCode = 1; })
    .catch(e => { console.log(JSON.stringify({ status: 'FAILED', error: safeError(e) }, null, 2)); process.exitCode = 1; });
}
