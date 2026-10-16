/** End-to-end tests against two disposable local postgres:16-alpine containers
 * (V1 stand-in with a synthetic legacy-75 dataset, V2 stand-in that starts empty).
 * Containers are named claude-v2mig-*, run with --rm, bind 127.0.0.1 only and are
 * removed in afterAll. No hosted access, no real credentials or records. */
import { it as test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { root, connect, beginSourceSnapshot, loadReviewedPlan, captureSource, legacySchemaSql, safeError, SESSION_SQL } from './lib.mjs';
import { checkAppPrivileges } from './app-privileges.mjs';
import { copyToV2, identify, EXIT_CODES } from './copy-to-v2.mjs';
import { compare, EXIT_CODES as COMPARE_EXIT_CODES } from './compare.mjs';

const FIXTURES = resolve(root, 'reports/production75-recovery-2026-10-11');
const LAYOUTS = { 'fly-db': 'fly-db', growthos_staging: 'legacy_staging' }; // layout -> source database
const ADMIN_PW = 'fictional-local-admin', USER_PW = 'fictional-local-user', READER_PW = 'fictional-local-reader';
const runId = randomUUID(), containers = [];
let wsl, srcPort, dstPort;
const timings = {};

const fixtureSql = layout => readFileSync(resolve(FIXTURES, `fixture75-${layout}.sql`), 'utf8').replaceAll('\r', '');
const catalog75 = layout => JSON.parse(readFileSync(resolve(FIXTURES, `catalog75-${layout}.json`), 'utf8'));

function docker(args) {
  const bridge = 'C:/Forge/tools/local-dev/docker-wsl.mjs';
  const [cmd, full] = process.platform === 'win32' && existsSync(bridge) ? [process.execPath, [bridge, ...args]] : ['docker', args];
  return execFileSync(cmd, full, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const url = (port, db, user = 'postgres', pw = ADMIN_PW) => `postgresql://${encodeURIComponent(user)}:${pw}@127.0.0.1:${port}/${encodeURIComponent(db)}`;
async function startPostgres(role) {
  const name = `claude-v2mig-${role}-${runId.slice(0, 8)}`;
  const id = docker(['run', '-d', '--rm', '--pull=never', '--name', name, '--label', `com.forge.local-test=${runId}`,
    '--cpus', '1', '--memory', '512m', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${ADMIN_PW}`, '-e', 'POSTGRES_DB=control', 'postgres:16-alpine']);
  assert.match(id, /^[a-f0-9]{64}$/);
  containers.push(id);
  const port = Number(/^127\.0\.0\.1:(\d+)$/m.exec(docker(['port', id, '5432/tcp']))[1]);
  for (let i = 0; i < 60; i++) {
    try { const c = await connect(url(port, 'control'), 'claude-v2mig-ready'); await c.end(); return port; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('postgres_not_ready');
}
async function admin(port, db, sql, params) {
  const c = await connect(url(port, db), 'claude-v2mig-admin');
  try { return await c.query(sql, params); } finally { await c.end(); }
}

/** Synthetic legacy-75 dataset (fictional tenants). Extends the production75-local
 * seed with the awkward types: bytea incl. NUL, text[] with commas/quotes, timestamp
 * without time zone, JSON null vs SQL NULL, Unicode and quotes. */
async function seed(c) {
  for (let i = 1; i <= 2; i++) {
    const org = (await c.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id', [`Fictional tenant ${i}`, `synthetic-v2-${i}`])).rows[0].id;
    for (const u of [1, 2]) await c.query('INSERT INTO users(id,organization_id) VALUES($1,$2)', [`fictional-user-${i}-${u}`, org]);
    await c.query('INSERT INTO org_settings(organization_id,business_profile,lead_scoring,ai_instructions) VALUES($1,$2,$4::jsonb,$3)',
      [org, JSON.stringify({ fixture: true, nested: { nullValue: null, labels: ['one', 'two'] } }), `Preserve Unicode Ω and quote ' ${i}`, i === 2 ? 'null' : null]);
    for (let k = 1; k <= 3; k++) {
      const contact = (await c.query('INSERT INTO contacts(organization_id,first_name,last_name,do_not_contact_email) VALUES($1,$2,NULL,$3) RETURNING id', [org, `Fictional contact ${i}.${k}`, k === 2])).rows[0].id;
      const lead = (await c.query('INSERT INTO leads(organization_id,contact_id,score_reasons,summary) VALUES($1,$2,$3,$4) RETURNING id',
        [org, contact, JSON.stringify([{ reason: 'synthetic', score: k }]), k === 1 ? 'Preserved active work' : null])).rows[0].id;
      await c.query('INSERT INTO estimates(organization_id,lead_id,title,line_items,total_cents,notes) VALUES($1,$2,$3,$4,$5,NULL)', [org, lead, `Estimate ${i}.${k}`, JSON.stringify([{ name: 'fictional work', quantity: k }]), i * 13579 + k]);
      await c.query('INSERT INTO projects(organization_id,lead_id,name,crew_notes) VALUES($1,$2,$3,$4)', [org, lead, `Project ${i}.${k}`, k === 1 ? 'Keep historical note' : null]);
    }
    await c.query('INSERT INTO lead_imports(organization_id,file_name,total_rows,errors) VALUES($1,$2,$3,$4)', [org, `fictional-${i}.csv`, i * 7, JSON.stringify([{ row: i, message: 'fictional import error' }])]);
    for (const status of ['pending', 'failed', 'done'])
      await c.query("INSERT INTO scheduled_actions(organization_id,action,context,run_at,status,attempts,last_error) VALUES($1,$2,$3,'2026-01-02T03:04:05.123456Z',$4,$5,$6)",
        [org, JSON.stringify({ type: 'synthetic-held-effect' }), JSON.stringify({ unknownExternalOutcome: status === 'failed' }), status, status === 'failed' ? 1 : 0, status === 'failed' ? 'Synthetic unknown effect: never replay' : null]);
    await c.query('INSERT INTO stored_objects(id,organization_id,data,content_type,size_bytes) VALUES(gen_random_uuid(),$1,$2,$3,$4)', [org, Buffer.from([0, 1, 2, 255, 10, 92]), 'application/octet-stream', 6]);
    await c.query('INSERT INTO gmail_connections(organization_id,user_id,email,granted_scopes) VALUES($1,$2,$3,$4)', [org, `fictional-user-${i}-1`, `user${i}@example.invalid`, ['scope,with,commas', 'with "quote"', 'Ω']]);
    await c.query("INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,'2026-12-31 23:59:59.5')", [`fictional-session-${i}`, JSON.stringify({ cookie: { path: '/' }, n: 1.5 })]);
  }
}

beforeAll(async () => {
  const t0 = Date.now();
  // Keep the WSL distribution (and so the containers) alive for the whole suite.
  if (process.platform === 'win32' && existsSync('C:/Forge/tools/local-dev/docker-wsl.mjs'))
    wsl = spawn('wsl.exe', ['--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec', 'cat'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  srcPort = await startPostgres('src');
  dstPort = await startPostgres('dst');
  for (const port of [srcPort, dstPort])
    await admin(port, 'control', `CREATE ROLE schema_admin NOLOGIN; CREATE ROLE "fly-user" LOGIN PASSWORD '${USER_PW}'; GRANT schema_admin TO "fly-user";
      CREATE ROLE "growthos-reader" LOGIN PASSWORD '${READER_PW}'; GRANT pg_read_all_data, pg_read_all_stats TO "growthos-reader";`);
  for (const [layout, db] of Object.entries(LAYOUTS)) {
    await admin(srcPort, 'control', `CREATE DATABASE "${db}" OWNER schema_admin`);
    const c = await connect(url(srcPort, db, 'fly-user', USER_PW), 'claude-v2mig-seed');
    try { await c.query('SET ROLE schema_admin'); await c.query(fixtureSql(layout)); await seed(c); } finally { await c.end(); }
  }
  await admin(srcPort, 'control', 'CREATE DATABASE tgt_same_cluster OWNER schema_admin');
  for (const db of ['tgt_happy', 'tgt_layout2', 'tgt_nonempty', 'tgt_corrupt', 'tgt_lost_ack', 'tgt_pre_commit', 'tgt_identity', 'tgt_sessions', 'tgt_late_writer', 'tgt_objects'])
    await admin(dstPort, 'control', `CREATE DATABASE ${db} OWNER schema_admin`);
  timings.containersAndSeedMs = Date.now() - t0;
}, 180000);

afterAll(async () => {
  for (const id of containers) { try { docker(['rm', '-f', id]); } catch {} }
  const left = docker(['ps', '-a', '-q', '--filter', `label=com.forge.local-test=${runId}`]);
  wsl?.stdin.end();
  console.log(JSON.stringify({ v2MigrationTestTimings: timings, containersLeft: left ? left.split('\n').length : 0 }));
  assert.equal(left, '');
}, 60000);

const src = (layout = 'fly-db') => url(srcPort, LAYOUTS[layout], 'growthos-reader', READER_PW);
const dst = db => url(dstPort, db, 'fly-user', USER_PW);
// Every run uses a reviewed manifest drafted by --identify, with the owner role filled in.
const manifestFor = async (sourceUrl, targetUrl, change = m => m) => {
  const { observedSourceSessions: _observed, ...draft } = await identify({ sourceUrl, targetUrl });
  return change({ ...draft, target: { ...draft.target, ownerRole: 'schema_admin' } });
};
const copy = async opts => copyToV2({ manifest: await manifestFor(opts.sourceUrl, opts.targetUrl), ...opts });
const cmp = async opts => compare({ manifest: await manifestFor(opts.sourceUrl, opts.targetUrl), ...opts });

test('rebuilt legacy schema SQL is byte-identical to the reviewed production75 fixtures', () => {
  for (const layout of Object.keys(LAYOUTS)) assert.equal(legacySchemaSql(catalog75(layout)), fixtureSql(layout));
});

test('happy path: copy commits, 75 tables match by count and fingerprint, compare passes', async () => {
  const t0 = Date.now();
  const r = await copy({ sourceUrl: src(), targetUrl: dst('tgt_happy') });
  timings.copyMs = Date.now() - t0; timings.copyBreakdownMs = r.timingsMs;
  assert.equal(r.status, 'COMMITTED', JSON.stringify(r.verification.problems));
  // Receipt is bound to the admitted facts (least-privilege logins can read pg_control_system here).
  assert.deepEqual({ ...r.admitted.target, systemIdentifier: 'x' }, { systemIdentifier: 'x', database: 'tgt_happy', sessionUser: 'fly-user', currentUser: 'fly-user', pgMajor: 16, ownerRole: 'schema_admin' });
  assert.equal(r.admitted.source.sessionUser, 'growthos-reader');
  assert.notEqual(r.admitted.source.systemIdentifier, r.admitted.target.systemIdentifier);
  assert.deepEqual(r.sourceSessions, { observed: 0, allowlist: [], unexpected: 0 });
  assert.equal(r.stepsApplied.length, 20);
  assert.equal(r.rowsCopied, 46);
  assert.deepEqual(r.verification.catalog.tables, 142);
  assert.equal(r.verification.catalog.columns, 1870);
  assert.equal(r.tables.filter(t => t.kind === 'preserved').length, 75);
  assert.equal(r.tables.filter(t => t.kind === 'new-empty').length, 67);
  assert.ok(r.tables.every(t => t.match));
  assert.ok(!JSON.stringify(r).includes('Fictional'), 'summary must not contain row values');
  const t1 = Date.now();
  const cmpResult = await cmp({ sourceUrl: src(), targetUrl: dst('tgt_happy') });
  timings.compareMs = Date.now() - t1;
  assert.equal(cmpResult.status, 'MATCH', JSON.stringify(cmpResult.problems));
  assert.equal(cmpResult.totals.sourceRows, 46);
  assert.equal(cmpResult.addedColumnsChecked, 16);
  // Objects are owned by the requested role, and the app login can use them.
  const c = await connect(dst('tgt_happy'), 'claude-v2mig-check');
  try {
    assert.equal((await c.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public' AND tableowner<>'schema_admin'")).rows[0].n, '0');
    assert.deepEqual((await c.query("SELECT count(*) FILTER (WHERE lead_scoring IS NULL) AS sql_null, count(*) FILTER (WHERE lead_scoring = 'null'::jsonb) AS json_null FROM org_settings")).rows[0], { sql_null: '1', json_null: '1' }); // JSON null kept distinct from SQL NULL
  } finally { await c.end(); }
}, 120000);

test('second physical legacy layout also copies and compares cleanly', async () => {
  const r = await copy({ sourceUrl: src('growthos_staging'), targetUrl: dst('tgt_layout2') });
  assert.equal(r.status, 'COMMITTED');
  assert.equal((await cmp({ sourceUrl: src('growthos_staging'), targetUrl: dst('tgt_layout2') })).status, 'MATCH');
}, 120000);

test('non-empty target is refused before anything is written', async () => {
  await admin(dstPort, 'tgt_nonempty', 'CREATE TABLE stray(id int)');
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: dst('tgt_nonempty') }), e => e.safeCode === 'v2_target_not_empty');
  const tables = (await admin(dstPort, 'tgt_nonempty', "SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename);
  assert.deepEqual(tables, ['stray']);
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: src() }), e => e.safeCode === 'v2_source_target_must_differ');
}, 60000);

test('source cannot be modified: READ ONLY snapshot refuses writes and data is unchanged after copy', async () => {
  const plan = loadReviewedPlan();
  // Even with an owner-capable login, the tool's source session refuses writes.
  const c = await connect(url(srcPort, 'fly-db', 'fly-user', USER_PW), 'claude-v2mig-ro');
  try {
    await beginSourceSnapshot(c);
    await assert.rejects(c.query("UPDATE organizations SET name='changed'"), e => e.code === '25006');
    await c.query('ROLLBACK');
    await assert.rejects(c.query("SET ROLE schema_admin; UPDATE organizations SET name='changed'"), e => e.code === '25006'); // session default read-only
  } finally { await c.end(); }
  // The recommended reader login cannot write at all.
  const r = await connect(src(), 'claude-v2mig-reader');
  try { await assert.rejects(r.query("DELETE FROM sessions"), e => e.code === '42501'); } finally { await r.end(); }
  // Fingerprints taken before and after a full copy are identical.
  const snapshot = async () => { const s = await connect(src(), 'claude-v2mig-fp'); try { await beginSourceSnapshot(s); return (await captureSource(s, plan)).tables; } finally { await s.end(); } };
  const before = await snapshot();
  await admin(dstPort, 'control', 'CREATE DATABASE tgt_ro OWNER schema_admin');
  assert.equal((await copy({ sourceUrl: src(), targetUrl: dst('tgt_ro') })).status, 'COMMITTED');
  assert.deepEqual(await snapshot(), before);
}, 120000);

test('compare detects a corrupted target row, a lost row and a stray row in a new table (CLI exits 1)', async () => {
  assert.equal((await copy({ sourceUrl: src(), targetUrl: dst('tgt_corrupt') })).status, 'COMMITTED');
  // Same row count, one changed value.
  await admin(dstPort, 'tgt_corrupt', "UPDATE contacts SET first_name = first_name || ' ' WHERE first_name = 'Fictional contact 1.2'");
  let r = await cmp({ sourceUrl: src(), targetUrl: dst('tgt_corrupt') });
  assert.equal(r.status, 'MISMATCH');
  assert.deepEqual(r.problems, [{ check: 'table', table: 'contacts' }]);
  const row = r.tables.find(t => t.table === 'contacts');
  assert.equal(row.sourceRows, row.targetRows); // counts equal, fingerprint differs
  // JSON null replaced with SQL NULL must also be caught.
  await admin(dstPort, 'tgt_corrupt', "UPDATE org_settings SET lead_scoring = NULL WHERE lead_scoring = 'null'::jsonb");
  await admin(dstPort, 'tgt_corrupt', "DELETE FROM sessions WHERE sid = 'fictional-session-2'");
  await admin(dstPort, 'tgt_corrupt', "INSERT INTO invoice_sequences(organization_id) SELECT id FROM organizations LIMIT 1");
  r = await cmp({ sourceUrl: src(), targetUrl: dst('tgt_corrupt') });
  assert.deepEqual(r.problems.map(p => `${p.check}:${p.table}`).sort(),
    ['new_table_not_empty:invoice_sequences', 'table:contacts', 'table:org_settings', 'table:sessions']);
  // CLI: exit status 1 and no row values in output.
  const manifestPath = resolve(tmpdir(), `claude-v2mig-manifest-${runId}.json`);
  writeFileSync(manifestPath, JSON.stringify(await manifestFor(src(), dst('tgt_corrupt'))));
  const child = spawn(process.execPath, [resolve(root, 'scripts/v2-migration/compare.mjs')], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SOURCE_DATABASE_URL: src(), TARGET_DATABASE_URL: dst('tgt_corrupt'), V2_MANIFEST: manifestPath }, windowsHide: true });
  let out = ''; child.stdout.on('data', d => { out += d; });
  const code = await new Promise(done => child.on('close', done));
  unlinkSync(manifestPath);
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).status, 'MISMATCH');
  assert.ok(!out.includes('Fictional') && !out.includes(USER_PW) && !out.includes(READER_PW));
}, 120000);

/** Fault injection on the real pg client used by copy-to-v2 (target connection only). */
const pg = createRequire(resolve(root, 'artifacts/api-server/package.json'))('pg');
async function withTargetFault(fault, fn) {
  const original = pg.Client.prototype.query, late = [];
  pg.Client.prototype.query = async function (...args) {
    const target = this.connectionParameters.application_name === 'growthos-v2-copy-target';
    if (target && fault === 'pg17' && typeof args[0] === 'string' && args[0].includes('"pgMajor"')) {
      const result = await original.apply(this, args); result.rows[0].pgMajor = 17; return result;
    }
    // 'late-writer': a writer connects to the source while the target transaction is running.
    if (target && fault === 'late-writer' && typeof args[0] === 'string' && args[0].includes('ADD COLUMN "scheduling_policy"') && late.length === 0)
      late.push(await connect(url(srcPort, 'fly-db', 'fly-user', USER_PW), 'claude-v2mig-late-writer'));
    if (target && fault === 'identity' && typeof args[0] === 'string' && args[0].includes('pg_control_system')) throw Object.assign(new Error('synthetic permission denied'), { code: '42501' });
    // 'before': connection lost while the last reviewed step (0019) runs, i.e. before COMMIT is sent.
    if (target && fault === 'before' && typeof args[0] === 'string' && args[0].includes('ADD COLUMN "scheduling_policy"')) throw Object.assign(new Error('synthetic pre-commit loss'), { code: '08006' });
    if (target && args[0] === 'COMMIT') {
      const result = await original.apply(this, args);
      if (fault === 'after') throw Object.assign(new Error('synthetic lost commit acknowledgement'), { code: '08006' });
      return result;
    }
    return original.apply(this, args);
  };
  try { return await fn(); } finally { pg.Client.prototype.query = original; for (const c of late) await c.end(); }
}
const publicTables = async db => Number((await admin(dstPort, db, "SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n);

test('lost COMMIT acknowledgement reports UNKNOWN_OUTCOME (exit 3), never FAILED; compare reconciles to MATCH; no retry', async () => {
  const r = await withTargetFault('after', () => copy({ sourceUrl: src(), targetUrl: dst('tgt_lost_ack') }));
  assert.equal(r.status, 'UNKNOWN_OUTCOME');
  assert.equal(r.commitSent, true);
  assert.equal(EXIT_CODES[r.status], 3);
  assert.match(r.reconcile, /compare.mjs/);
  assert.equal(r.error.sqlstate, '08006');
  assert.equal(await publicTables('tgt_lost_ack'), 142); // it did commit
  assert.equal((await cmp({ sourceUrl: src(), targetUrl: dst('tgt_lost_ack') })).status, 'MATCH');
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: dst('tgt_lost_ack') }), e => e.safeCode === 'v2_target_not_empty');
}, 120000);

test('failure before COMMIT is FAILED with commitSent=false; target stays empty and compare says TARGET_EMPTY', async () => {
  await assert.rejects(withTargetFault('before', () => copy({ sourceUrl: src(), targetUrl: dst('tgt_pre_commit') })),
    e => e.code === '08006' && e.commitSent === false);
  assert.equal(await publicTables('tgt_pre_commit'), 0);
  const cmpResult = await cmp({ sourceUrl: src(), targetUrl: dst('tgt_pre_commit') });
  assert.equal(cmpResult.status, 'TARGET_EMPTY');
  assert.equal(COMPARE_EXIT_CODES[cmpResult.status], 2);
}, 120000);

test('admission is mandatory and positive: unreadable, missing, same cluster, URL alias, wrong login/role/major', async () => {
  const target = dst('tgt_identity'), code = c => e => e.safeCode === c;
  // Unreadable identity: refused, no override exists.
  await assert.rejects(withTargetFault('identity', () => copy({ sourceUrl: src(), targetUrl: target })), code('v2_identity_unavailable'));
  // Missing manifest (copy and compare).
  await assert.rejects(copyToV2({ sourceUrl: src(), targetUrl: target }), code('v2_manifest_required'));
  await assert.rejects(compare({ sourceUrl: src(), targetUrl: target }), code('v2_manifest_required'));
  // Same cluster, different database: refused even though the database names differ.
  const sameCluster = url(srcPort, 'tgt_same_cluster', 'fly-user', USER_PW);
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: sameCluster }), code('v2_same_cluster'));
  // A manifest claiming a different cluster does not help: the observed identifiers are compared.
  await assert.rejects(copyToV2({ sourceUrl: src(), targetUrl: sameCluster, manifest: await manifestFor(src(), target) }), code('v2_same_cluster'));
  // URL alias of the source itself (localhost vs 127.0.0.1).
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: src().replace('127.0.0.1', 'localhost') }), code('v2_same_cluster'));
  // Wrong pinned target database, login, source role, owner role, PG major.
  const wrong = async change => copyToV2({ sourceUrl: src(), targetUrl: target, manifest: await manifestFor(src(), target, change) });
  await assert.rejects(wrong(m => ({ ...m, target: { ...m.target, database: 'tgt_pre_commit' } })), code('v2_target_database_mismatch'));
  await assert.rejects(wrong(m => ({ ...m, target: { ...m.target, sessionUser: 'growthos-reader' } })), code('v2_target_session_user_mismatch'));
  await assert.rejects(wrong(m => ({ ...m, source: { ...m.source, currentUser: 'schema_admin' } })), code('v2_source_current_user_mismatch'));
  await assert.rejects(wrong(m => ({ ...m, target: { ...m.target, ownerRole: 'growthos-reader' } })), code('v2_target_owner_role_unavailable'));
  await assert.rejects(wrong(m => ({ ...m, target: { ...m.target, pgMajor: 17 } })), code('v2_manifest_invalid'));
  await assert.rejects(withTargetFault('pg17', () => copy({ sourceUrl: src(), targetUrl: target })), code('v2_target_pg_major_mismatch'));
  assert.equal(await publicTables('tgt_identity'), 0);
  assert.equal((await admin(srcPort, 'tgt_same_cluster', "SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, '0');
  // Correct manifest succeeds.
  assert.equal((await copy({ sourceUrl: src(), targetUrl: target })).status, 'COMMITTED');
}, 180000);

test('unexpected source sessions hold the copy before target mutation and again before COMMIT', async () => {
  const writer = await connect(url(srcPort, 'fly-db', 'fly-user', USER_PW), 'claude-v2mig-writer');
  try {
    await assert.rejects(copy({ sourceUrl: src(), targetUrl: dst('tgt_sessions') }),
      e => e.safeCode === 'v2_source_unexpected_sessions' && e.commitSent === false && e.v2Detail.unexpected.some(u => u.usename === 'fly-user'));
    assert.equal(await publicTables('tgt_sessions'), 0);
    // A reviewed allowlist entry (exact login + application name) is accepted and recorded.
    const seen = (await identify({ sourceUrl: src(), targetUrl: dst('tgt_sessions') })).observedSourceSessions;
    const allow = seen.map(({ usename, application_name }) => ({ usename, application_name }));
    const r = await copyToV2({ sourceUrl: src(), targetUrl: dst('tgt_sessions'), manifest: await manifestFor(src(), dst('tgt_sessions'), m => ({ ...m, allowedSourceSessions: allow })) });
    assert.equal(r.status, 'COMMITTED');
    assert.deepEqual(r.sourceSessions, { observed: 1, allowlist: allow, unexpected: 0 });
  } finally { await writer.end(); }
  // A writer that appears while the target transaction runs blocks the COMMIT.
  await assert.rejects(withTargetFault('late-writer', () => copy({ sourceUrl: src(), targetUrl: dst('tgt_late_writer') })),
    e => e.safeCode === 'v2_source_unexpected_sessions' && e.commitSent === false);
  assert.equal(await publicTables('tgt_late_writer'), 0);
  // A source login that cannot see other users' sessions fails closed instead of seeing none.
  const blind = url(srcPort, 'fly-db', 'fly-user', USER_PW);
  await assert.rejects(copy({ sourceUrl: blind, targetUrl: dst('tgt_late_writer') }), e => e.safeCode === 'v2_source_sessions_unobservable');
  assert.equal(await publicTables('tgt_late_writer'), 0);
}, 180000);

test('target with standalone routines, composite types or extra schemas is not empty', async () => {
  await admin(dstPort, 'tgt_objects', "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'");
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: dst('tgt_objects') }), e => e.safeCode === 'v2_target_not_empty' && e.v2Detail.routines === 1);
  await admin(dstPort, 'tgt_objects', 'DROP FUNCTION public.f(); CREATE TYPE public.pair AS (a int, b int)');
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: dst('tgt_objects') }), e => e.safeCode === 'v2_target_not_empty' && e.v2Detail.relations === 1);
  await admin(dstPort, 'tgt_objects', 'DROP TYPE public.pair; CREATE SCHEMA extra');
  await assert.rejects(copy({ sourceUrl: src(), targetUrl: dst('tgt_objects') }), e => e.safeCode === 'v2_target_not_empty' && e.v2Detail.schemas === 1);
  assert.notEqual((await cmp({ sourceUrl: src(), targetUrl: dst('tgt_objects') })).status, 'TARGET_EMPTY');
  await admin(dstPort, 'tgt_objects', 'DROP SCHEMA extra');
  assert.equal((await cmp({ sourceUrl: src(), targetUrl: dst('tgt_objects') })).status, 'TARGET_EMPTY');
}, 120000);

test('app privilege check: owner-member passes; SELECT-only and wholly inaccessible tables are gaps', async () => {
  // tgt_happy holds the committed 142-table copy from the happy-path test.
  assert.equal((await checkAppPrivileges(dst('tgt_happy'))).status, 'OK');
  await admin(dstPort, 'control', `CREATE ROLE app_select_one LOGIN PASSWORD '${USER_PW}'; CREATE ROLE app_all_but_one LOGIN PASSWORD '${USER_PW}'`);
  await admin(dstPort, 'tgt_happy', `GRANT SELECT ON organizations TO app_select_one;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_all_but_one; REVOKE ALL ON sessions FROM app_all_but_one`);
  const one = await checkAppPrivileges(url(dstPort, 'tgt_happy', 'app_select_one', USER_PW));
  assert.equal(one.status, 'GAPS');
  assert.equal(one.gaps.length, 142 * 4 - 1); // everything except SELECT on organizations
  assert.ok(one.gaps.some(g => g.name === 'organizations' && g.privilege === 'INSERT'));
  const most = await checkAppPrivileges(url(dstPort, 'tgt_happy', 'app_all_but_one', USER_PW));
  assert.deepEqual(most.gaps.map(g => `${g.name}:${g.privilege}`), ['sessions:DELETE', 'sessions:INSERT', 'sessions:SELECT', 'sessions:UPDATE']);
}, 60000);

test('setup failures never strand connections (connect and identify)', async () => {
  const original = { query: pg.Client.prototype.query, end: pg.Client.prototype.end };
  let ends = 0;
  pg.Client.prototype.end = function (...a) { ends++; return original.end.apply(this, a); };
  try {
    pg.Client.prototype.query = function (...a) { return a[0] === SESSION_SQL ? Promise.reject(new Error('synthetic init failure')) : original.query.apply(this, a); };
    await assert.rejects(connect(src(), 'claude-v2mig-init'), /synthetic init failure/);
    assert.equal(ends, 1);
    pg.Client.prototype.query = original.query;
    ends = 0;
    await assert.rejects(identify({ sourceUrl: src(), targetUrl: url(dstPort, 'tgt_happy', 'fly-user', 'wrong-password') }));
    assert.equal(ends, 2); // failed target client and the already-open source client
  } finally { Object.assign(pg.Client.prototype, original); }
}, 60000);

test('error output never contains PostgreSQL detail/message values, only codes and object names', async () => {
  let caught;
  try { await admin(srcPort, 'fly-db', "INSERT INTO organizations(name,slug) VALUES('Fictional dup','synthetic-v2-1')"); } catch (e) { caught = e; }
  assert.ok(caught?.detail?.includes('synthetic-v2-1')); // pg itself puts key values in detail
  const out = JSON.stringify(safeError(caught));
  assert.ok(!out.includes('synthetic-v2-1') && !out.includes('Fictional'));
  assert.deepEqual(JSON.parse(out), { code: 'v2_unexpected_error', sqlstate: '23505', schema: 'public', table: 'organizations', constraint: JSON.parse(out).constraint });
  assert.match(JSON.parse(out).constraint, /^[a-z0-9_]+$/);
});
