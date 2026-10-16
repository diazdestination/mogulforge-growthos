#!/usr/bin/env node
/** Independent post-copy verification: V1 source (legacy 75 layout) vs V2 target (142).
 *
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... SOURCE_IDENTITY=... TARGET_IDENTITY=... node scripts/v2-migration/compare.mjs
 *   (identity pins are mandatory, same values as for copy-to-v2.mjs)
 *
 * Both sides are read in fresh REPEATABLE READ, READ ONLY snapshots. Checks:
 *  - target catalog equals the reviewed 142-table + 0019 catalog for the source's layout
 *  - every legacy table: same row count and sha256 fingerprint over its original columns
 *    (rows ordered by primary key, values in canonical PostgreSQL text form)
 *  - every new table is empty; columns added to old tables hold their reviewed defaults
 *  - sequences equal (none expected), no identity/generated columns, all constraints
 *    validated and all indexes valid, same encoding (locale difference is a warning)
 * Exit codes: 0 MATCH, 1 MISMATCH/FAILED, 2 TARGET_EMPTY (no non-extension objects in the
 * target: used to reconcile an UNKNOWN_OUTCOME copy as "not committed").
 * Prints JSON with counts/booleans only, never row values. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, beginSourceSnapshot, loadReviewedPlan, captureSource, verifyTarget, isEmptyTargetSql, safeError, assertPinnedIdentities } from './lib.mjs';
export const EXIT_CODES = Object.freeze({ MATCH: 0, MISMATCH: 1, TARGET_EMPTY: 2 });

export async function compare({ sourceUrl, targetUrl, sourceIdentity, targetIdentity } = {}) {
  const started = Date.now(), plan = loadReviewedPlan();
  let source, target;
  try {
    source = await connect(sourceUrl, 'growthos-v2-compare-source');
    target = await connect(targetUrl, 'growthos-v2-compare-target');
    const identities = await assertPinnedIdentities(source, target, { source: sourceIdentity, target: targetIdentity });
    await beginSourceSnapshot(source);
    await beginSourceSnapshot(target);
    const empty = (await target.query(isEmptyTargetSql)).rows[0];
    if (empty.relations === '0' && empty.types === '0') {
      await Promise.all([source.query('ROLLBACK'), target.query('ROLLBACK')]);
      return { status: 'TARGET_EMPTY', identities, durationMs: Date.now() - started };
    }
    const snap = await captureSource(source, plan);
    const report = await verifyTarget(target, snap);
    await Promise.all([source.query('ROLLBACK'), target.query('ROLLBACK')]);
    return { status: report.ok ? 'MATCH' : 'MISMATCH', identities, layoutSha256: snap.layout, ...report,
      totals: { preservedTables: report.tables.filter(t => t.kind === 'preserved').length,
        newEmptyTables: report.tables.filter(t => t.kind === 'new-empty').length,
        sourceRows: snap.tables.reduce((n, t) => n + t.rows, 0) },
      durationMs: Date.now() - started };
  } finally {
    await Promise.allSettled([source?.end(), target?.end()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compare({ sourceUrl: process.env.SOURCE_DATABASE_URL, targetUrl: process.env.TARGET_DATABASE_URL,
    sourceIdentity: process.env.SOURCE_IDENTITY, targetIdentity: process.env.TARGET_IDENTITY })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exitCode = EXIT_CODES[r.status] ?? 1; })
    .catch(e => { console.log(JSON.stringify({ status: 'FAILED', error: safeError(e) }, null, 2)); process.exitCode = 1; });
}
