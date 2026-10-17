#!/usr/bin/env node
/** Copy the legacy V1 production database into a FRESH, EMPTY V2 database and
 * upgrade it to the reviewed 142-table schema, in ONE target transaction.
 *
 *   SOURCE_DATABASE_URL  V1 legacy database (read-only login recommended)
 *   TARGET_DATABASE_URL  fresh empty V2 database (direct connection, not PgBouncer)
 *   V2_MANIFEST          REQUIRED path to the reviewed, nonsecret admission manifest
 *                        (see lib.mjs). Draft it with --identify; every value must be
 *                        reviewed in the execution packet. No override exists.
 *
 *   node scripts/v2-migration/copy-to-v2.mjs --identify   # facts only, no data, no writes
 *   node scripts/v2-migration/copy-to-v2.mjs --execute
 *
 * Admission before ANY target mutation (fails closed): distinct cluster system identifiers,
 * exact databases, session logins, source effective role, PostgreSQL 16 on both sides, empty
 * target, and no source client sessions outside the manifest allowlist. Inside the target
 * transaction SET LOCAL ROLE <ownerRole> is verified. Target facts and source sessions are
 * rechecked immediately before COMMIT.
 *
 * Route (reuses reviewed code, see lib.mjs): rebuild the exact legacy-75 schema from the live
 * source catalog, copy every row, add FKs, then apply the same 19 pinned SQL steps + 0019 that
 * were rehearsed for the in-place upgrade. Before COMMIT the target is verified against the
 * source snapshot (catalog, per-table row counts and sha256 fingerprints).
 * Prints a JSON summary only: no row values, no URLs, no credentials.
 *
 * Outcomes / exit codes:
 *   COMMITTED (0)        COMMIT acknowledged by the target.
 *   ROLLED_BACK (1)      verification failed; ROLLBACK acknowledged; COMMIT never sent.
 *   FAILED (1)           error before COMMIT was sent; the server discards the transaction
 *                        (not proof: confirm with compare.mjs => TARGET_EMPTY before a rerun).
 *   UNKNOWN_OUTCOME (3)  COMMIT was sent but no acknowledgement arrived. The target may be
 *                        committed. NEVER retry and NEVER drop the target; reconcile with
 *                        compare.mjs (see RUNBOOK). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSchemaCatalog } from '../../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { connect, beginSourceSnapshot, loadReviewedPlan, captureSource, legacySchemaSql, foreignKeySql, readRows,
  tableColumns, verifyTarget, assertCatalogEqual, isEmptyTargetSql, isEmptyCounts, check, q, safeError,
  readFacts, admit, assertTargetFacts, sourceSessions } from './lib.mjs';

export async function assertTargetEmpty(client) {
  const counts = (await client.query(isEmptyTargetSql)).rows[0];
  check(isEmptyCounts(counts), 'v2_target_not_empty', Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])));
}
async function assertNoUnexpectedSessions(source, allowed) {
  const s = await sourceSessions(source, allowed);
  check(s.unexpected.length === 0, 'v2_source_unexpected_sessions', { unexpected: s.unexpected });
  return s;
}

export const EXIT_CODES = Object.freeze({ COMMITTED: 0, ROLLED_BACK: 1, FAILED: 1, UNKNOWN_OUTCOME: 3 });
export const RECONCILE = 'Run compare.mjs with the same URLs and manifest. MATCH => committed; TARGET_EMPTY => not committed; anything else => STOP, preserve evidence, escalate. Do not retry or drop the target.';

/** Read-only: prints a DRAFT manifest (observed facts) for review. ownerRole and the session
 * allowlist must be filled in by the reviewer; observed sessions are listed, never auto-allowed. */
export async function identify({ sourceUrl, targetUrl } = {}) {
  check(sourceUrl && targetUrl, 'v2_database_url_missing');
  const source = await connect(sourceUrl, 'growthos-v2-identify');
  try {
    const target = await connect(targetUrl, 'growthos-v2-identify');
    try {
      const [s, t] = [await readFacts(source), await readFacts(target)];
      const { currentUser: _ignored, ...targetFacts } = t;
      return { source: s, target: { ...targetFacts, ownerRole: null }, allowedSourceSessions: [],
        observedSourceSessions: (await source.query(`SELECT usename::text AS usename, application_name, state FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' ORDER BY 1,2`)).rows };
    } finally { await target.end().catch(() => {}); }
  } finally { await source.end().catch(() => {}); }
}

export async function copyToV2({ sourceUrl, targetUrl, manifest } = {}) {
  check(sourceUrl && targetUrl && sourceUrl !== targetUrl, 'v2_source_target_must_differ');
  const timings = {}, started = Date.now(), mark = name => { timings[name] = Date.now() - started; };
  const plan = loadReviewedPlan();
  let source, target, commitSent = false, snap, copied = 0, admitted, sessions;
  try {
    source = await connect(sourceUrl, 'growthos-v2-copy-source');
    target = await connect(targetUrl, 'growthos-v2-copy-target');
    admitted = await admit(source, target, manifest);
    const m = admitted.manifest;
    await assertTargetEmpty(target);
    mark('admitted');

    // 1. Source: one consistent READ ONLY snapshot.
    await beginSourceSnapshot(source);
    snap = await captureSource(source, plan);
    check(snap.sequences.length === 0, 'v2_source_sequences_unsupported');
    const rowsByTable = new Map();
    for (const t of snap.catalog.tables) rowsByTable.set(t.name, await readRows(source, snap.catalog, t.name));
    await source.query('ROLLBACK');
    // Hold before any target mutation if anything unexpected is connected to the source.
    sessions = await assertNoUnexpectedSessions(source, m.allowedSourceSessions);
    mark('sourceRead');

    // 2. Target: everything in ONE transaction, as the verified owner role.
    await target.query('BEGIN');
    const member = (await target.query("SELECT pg_has_role(session_user, $1, 'MEMBER') AS ok", [m.target.ownerRole]).catch(() => ({ rows: [{ ok: false }] }))).rows[0].ok;
    check(member === true, 'v2_target_owner_role_unavailable');
    await target.query(`SET LOCAL ROLE "${m.target.ownerRole}"`); // validated by the manifest regex: no quotes possible
    await assertTargetFacts(target, m, { ownerRole: true });
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
    // Recheck immediately before COMMIT: same admitted target/role, still no unexpected source sessions.
    await assertTargetFacts(target, m, { ownerRole: true });
    sessions = await assertNoUnexpectedSessions(source, m.allowedSourceSessions);
    commitSent = true;
    try { await target.query('COMMIT'); }
    catch (e) { return { ...summary('UNKNOWN_OUTCOME', report), error: safeError(e), reconcile: RECONCILE }; }
    mark('committed');
    return summary('COMMITTED', report);

    function summary(status, report) {
      return { status, commitSent,
        admitted: { source: admitted.source, target: { ...admitted.target, ownerRole: m.target.ownerRole } },
        sourceSessions: { observed: sessions.observed, allowlist: m.allowedSourceSessions, unexpected: sessions.unexpected.length },
        layoutSha256: snap.layout, sourceTables: snap.catalog.tables.length, rowsCopied: copied,
        stepsApplied: plan.steps.map(s => ({ name: s.name, sha256: s.sha256 })),
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

export function readManifest(path) {
  check(typeof path === 'string' && path.length > 0, 'v2_manifest_required');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env, urls = { sourceUrl: env.SOURCE_DATABASE_URL, targetUrl: env.TARGET_DATABASE_URL };
  const fail = e => { console.log(JSON.stringify({ status: 'FAILED', commitSent: false, error: safeError(e),
    note: 'COMMIT was never sent. Confirm with compare.mjs (TARGET_EMPTY) before any rerun.' }, null, 2)); process.exitCode = 1; };
  if (process.argv[2] === '--identify') identify(urls).then(r => console.log(JSON.stringify(r, null, 2))).catch(fail);
  else if (process.argv[2] !== '--execute') { console.error('usage: node copy-to-v2.mjs --identify | --execute (see header)'); process.exitCode = 2; }
  else Promise.resolve().then(() => copyToV2({ ...urls, manifest: readManifest(env.V2_MANIFEST) }))
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exitCode = EXIT_CODES[r.status] ?? 1; })
    .catch(fail);
}
