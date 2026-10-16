#!/usr/bin/env node
/** Copy the legacy V1 production database into a FRESH, EMPTY V2 database and
 * upgrade it to the reviewed 142-table schema, in ONE target transaction.
 *
 *   SOURCE_DATABASE_URL  V1 legacy database (read-only login recommended)
 *   TARGET_DATABASE_URL  fresh empty V2 database
 *   TARGET_OWNER_ROLE    optional; SET LOCAL ROLE so new objects are owned by it
 *   SOURCE_IDENTITY / TARGET_IDENTITY  REQUIRED pins "<system_identifier>/<database>",
 *                        printed by --identify and recorded in the execution packet.
 *                        Checked before any write and again immediately before COMMIT.
 *                        If identity cannot be read the run fails closed (no override).
 *
 *   node scripts/v2-migration/copy-to-v2.mjs --identify   # identities only, no data, no writes
 *   node scripts/v2-migration/copy-to-v2.mjs --execute
 *
 * Route (reuses reviewed code, see lib.mjs): rebuild the exact legacy-75 schema
 * from the live source catalog, copy every row, add FKs, then apply the same 19
 * pinned SQL steps + 0019 that were rehearsed for the in-place upgrade.
 * Before COMMIT the target is verified against the source snapshot (catalog,
 * per-table row counts and sha256 fingerprints); any mismatch rolls back.
 * Prints a JSON summary only: no row values, no URLs, no credentials.
 *
 * Outcomes / exit codes:
 *   COMMITTED (0)        COMMIT acknowledged by the target.
 *   ROLLED_BACK (1)      verification failed; ROLLBACK acknowledged; COMMIT never sent.
 *   FAILED (1)           error before COMMIT was sent; COMMIT never sent, so the
 *                        server discards the transaction (not proof: rerun refuses
 *                        a non-empty target, and compare/empty-check confirms).
 *   UNKNOWN_OUTCOME (3)  COMMIT was sent but no acknowledgement arrived. The target
 *                        may be committed. NEVER retry and NEVER drop the target;
 *                        reconcile with compare.mjs (see RUNBOOK). */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSchemaCatalog } from '../../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { connect, beginSourceSnapshot, loadReviewedPlan, captureSource, legacySchemaSql, foreignKeySql, readRows,
  tableColumns, verifyTarget, assertCatalogEqual, isEmptyTargetSql, check, q, safeError, readIdentity, assertPinnedIdentities } from './lib.mjs';

export async function assertTargetEmpty(client) {
  const { relations, types } = (await client.query(isEmptyTargetSql)).rows[0];
  check(relations === '0' && types === '0', 'v2_target_not_empty', { relations: Number(relations), types: Number(types) });
}

export const EXIT_CODES = Object.freeze({ COMMITTED: 0, ROLLED_BACK: 1, FAILED: 1, UNKNOWN_OUTCOME: 3 });
export const RECONCILE = 'Run compare.mjs with the same SOURCE/TARGET URLs. MATCH => committed; target has no public tables => not committed; anything else => STOP, preserve evidence, escalate. Do not retry or drop the target.';

/** Read-only: prints both identities so the operator can pin them. */
export async function identify({ sourceUrl, targetUrl } = {}) {
  check(sourceUrl && targetUrl, 'v2_database_url_missing');
  const [s, t] = [await connect(sourceUrl, 'growthos-v2-identify'), await connect(targetUrl, 'growthos-v2-identify')];
  try { return { source: await readIdentity(s), target: await readIdentity(t) }; }
  finally { await Promise.allSettled([s.end(), t.end()]); }
}

export async function copyToV2({ sourceUrl, targetUrl, ownerRole = null, sourceIdentity, targetIdentity } = {}) {
  check(sourceUrl && targetUrl && sourceUrl !== targetUrl, 'v2_source_target_must_differ');
  check(ownerRole === null || /^[a-z_][a-z0-9_-]{0,62}$/.test(ownerRole), 'v2_owner_role_invalid');
  const timings = {}, started = Date.now(), mark = name => { timings[name] = Date.now() - started; };
  const plan = loadReviewedPlan();
  let source, target, commitSent = false, snap, copied = 0, otherSessions, identityCheck;
  try {
    source = await connect(sourceUrl, 'growthos-v2-copy-source');
    target = await connect(targetUrl, 'growthos-v2-copy-target');
    // Mandatory, fail-closed: pinned identities must match and differ (same cluster+db refused).
    identityCheck = await assertPinnedIdentities(source, target, { source: sourceIdentity, target: targetIdentity });
    await assertTargetEmpty(target);
    mark('connected');

    // 1. Source: one consistent READ ONLY snapshot.
    await beginSourceSnapshot(source);
    snap = await captureSource(source, plan);
    check(snap.sequences.length === 0, 'v2_source_sequences_unsupported');
    const rowsByTable = new Map();
    for (const t of snap.catalog.tables) rowsByTable.set(t.name, await readRows(source, snap.catalog, t.name));
    otherSessions = Number((await source.query(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows[0].n);
    await source.query('ROLLBACK');
    mark('sourceRead');

    // 2. Target: everything in ONE transaction.
    await target.query('BEGIN');
    if (ownerRole) await target.query(`SET LOCAL ROLE "${ownerRole}"`); // validated above: no quotes possible
    await target.query("SET LOCAL lock_timeout='10s'");
    await assertTargetEmpty(target);
    await target.query(legacySchemaSql(snap.catalog, { foreignKeys: false }));
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
    check(await readIdentity(target) === targetIdentity, 'v2_target_identity_mismatch'); // re-pin right before COMMIT
    commitSent = true;
    try { await target.query('COMMIT'); }
    catch (e) { return { ...summary('UNKNOWN_OUTCOME', report), error: safeError(e), commitSent: true, reconcile: RECONCILE }; }
    mark('committed');
    return summary('COMMITTED', report);

    function summary(status, report) {
      return { status, identityCheck, commitSent, layoutSha256: snap.layout, sourceTables: snap.catalog.tables.length, rowsCopied: copied,
        sourceOtherSessions: otherSessions, stepsApplied: plan.steps.map(s => ({ name: s.name, sha256: s.sha256 })),
        verification: { ok: report.ok, problems: report.problems, warnings: report.warnings, catalog: report.catalog,
          addedColumnsChecked: report.addedColumnsChecked, sequences: report.sequences, database: report.database },
        tables: report.tables.map(({ table, kind, sourceRows, targetRows, match }) => ({ table, kind, sourceRows, targetRows, match })),
        timingsMs: { ...timings, total: Date.now() - started } };
    }
  } catch (e) {
    // Only reached before COMMIT was sent; best-effort ROLLBACK, the server discards it on disconnect anyway.
    if (!commitSent) { try { await target?.query('ROLLBACK'); } catch {} }
    e.commitSent = commitSent;
    throw e;
  } finally {
    await Promise.allSettled([source?.end(), target?.end()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env, urls = { sourceUrl: env.SOURCE_DATABASE_URL, targetUrl: env.TARGET_DATABASE_URL };
  if (process.argv[2] === '--identify') {
    identify(urls).then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => { console.log(JSON.stringify({ status: 'FAILED', error: safeError(e) }, null, 2)); process.exitCode = 1; });
  } else if (process.argv[2] !== '--execute') { console.error('usage: node copy-to-v2.mjs --identify | --execute (see header)'); process.exitCode = 2; }
  else copyToV2({ ...urls, ownerRole: env.TARGET_OWNER_ROLE || null, sourceIdentity: env.SOURCE_IDENTITY, targetIdentity: env.TARGET_IDENTITY })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exitCode = EXIT_CODES[r.status] ?? 1; })
    .catch(e => { console.log(JSON.stringify({ status: 'FAILED', commitSent: false, error: safeError(e),
      note: 'COMMIT was never sent. Rerun refuses a non-empty target; confirm with compare.mjs or an empty-target check before retrying.' }, null, 2)); process.exitCode = 1; });
}
