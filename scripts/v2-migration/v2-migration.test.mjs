/** End-to-end tests against two disposable local postgres:16-alpine containers
 * (V1 stand-in with a synthetic legacy-75 dataset, V2 stand-in that starts empty).
 * Containers are named claude-v2mig-*, run with --rm, bind 127.0.0.1 only and are
 * removed in afterAll. No hosted access, no real credentials or records. */
import { it as test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { root, connect, beginSourceSnapshot, loadReviewedPlan, captureSource, legacySchemaSql } from './lib.mjs';
import { copyToV2 } from './copy-to-v2.mjs';
import { compare } from './compare.mjs';

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
      CREATE ROLE "growthos-reader" LOGIN PASSWORD '${READER_PW}'; GRANT pg_read_all_data TO "growthos-reader";`);
  for (const [layout, db] of Object.entries(LAYOUTS)) {
    await admin(srcPort, 'control', `CREATE DATABASE "${db}" OWNER schema_admin`);
    const c = await connect(url(srcPort, db, 'fly-user', USER_PW), 'claude-v2mig-seed');
    try { await c.query('SET ROLE schema_admin'); await c.query(fixtureSql(layout)); await seed(c); } finally { await c.end(); }
  }
  for (const db of ['tgt_happy', 'tgt_layout2', 'tgt_nonempty', 'tgt_corrupt'])
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

test('rebuilt legacy schema SQL is byte-identical to the reviewed production75 fixtures', () => {
  for (const layout of Object.keys(LAYOUTS)) assert.equal(legacySchemaSql(catalog75(layout)), fixtureSql(layout));
});

test('happy path: copy commits, 75 tables match by count and fingerprint, compare passes', async () => {
  const t0 = Date.now();
  const r = await copyToV2({ sourceUrl: src(), targetUrl: dst('tgt_happy'), ownerRole: 'schema_admin' });
  timings.copyMs = Date.now() - t0; timings.copyBreakdownMs = r.timingsMs;
  assert.equal(r.status, 'COMMITTED', JSON.stringify(r.verification.problems));
  assert.equal(r.stepsApplied.length, 20);
  assert.equal(r.rowsCopied, 46);
  assert.deepEqual(r.verification.catalog.tables, 142);
  assert.equal(r.verification.catalog.columns, 1870);
  assert.equal(r.tables.filter(t => t.kind === 'preserved').length, 75);
  assert.equal(r.tables.filter(t => t.kind === 'new-empty').length, 67);
  assert.ok(r.tables.every(t => t.match));
  assert.ok(!JSON.stringify(r).includes('Fictional'), 'summary must not contain row values');
  const t1 = Date.now();
  const cmp = await compare({ sourceUrl: src(), targetUrl: dst('tgt_happy') });
  timings.compareMs = Date.now() - t1;
  assert.equal(cmp.status, 'MATCH', JSON.stringify(cmp.problems));
  assert.equal(cmp.totals.sourceRows, 46);
  assert.equal(cmp.addedColumnsChecked, 16);
  // Objects are owned by the requested role, and the app login can use them.
  const c = await connect(dst('tgt_happy'), 'claude-v2mig-check');
  try {
    assert.equal((await c.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public' AND tableowner<>'schema_admin'")).rows[0].n, '0');
    assert.deepEqual((await c.query("SELECT count(*) FILTER (WHERE lead_scoring IS NULL) AS sql_null, count(*) FILTER (WHERE lead_scoring = 'null'::jsonb) AS json_null FROM org_settings")).rows[0], { sql_null: '1', json_null: '1' }); // JSON null kept distinct from SQL NULL
  } finally { await c.end(); }
}, 120000);

test('second physical legacy layout also copies and compares cleanly', async () => {
  const r = await copyToV2({ sourceUrl: src('growthos_staging'), targetUrl: dst('tgt_layout2') });
  assert.equal(r.status, 'COMMITTED');
  assert.equal((await compare({ sourceUrl: src('growthos_staging'), targetUrl: dst('tgt_layout2') })).status, 'MATCH');
}, 120000);

test('non-empty target is refused before anything is written', async () => {
  await admin(dstPort, 'tgt_nonempty', 'CREATE TABLE stray(id int)');
  await assert.rejects(copyToV2({ sourceUrl: src(), targetUrl: dst('tgt_nonempty') }), e => e.safeCode === 'v2_target_not_empty');
  const tables = (await admin(dstPort, 'tgt_nonempty', "SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename);
  assert.deepEqual(tables, ['stray']);
  await assert.rejects(copyToV2({ sourceUrl: src(), targetUrl: src() }), e => e.safeCode === 'v2_source_target_must_differ');
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
  assert.equal((await copyToV2({ sourceUrl: src(), targetUrl: dst('tgt_ro') })).status, 'COMMITTED');
  assert.deepEqual(await snapshot(), before);
}, 120000);

test('compare detects a corrupted target row, a lost row and a stray row in a new table (CLI exits 1)', async () => {
  assert.equal((await copyToV2({ sourceUrl: src(), targetUrl: dst('tgt_corrupt') })).status, 'COMMITTED');
  // Same row count, one changed value.
  await admin(dstPort, 'tgt_corrupt', "UPDATE contacts SET first_name = first_name || ' ' WHERE first_name = 'Fictional contact 1.2'");
  let r = await compare({ sourceUrl: src(), targetUrl: dst('tgt_corrupt') });
  assert.equal(r.status, 'MISMATCH');
  assert.deepEqual(r.problems, [{ check: 'table', table: 'contacts' }]);
  const row = r.tables.find(t => t.table === 'contacts');
  assert.equal(row.sourceRows, row.targetRows); // counts equal, fingerprint differs
  // JSON null replaced with SQL NULL must also be caught.
  await admin(dstPort, 'tgt_corrupt', "UPDATE org_settings SET lead_scoring = NULL WHERE lead_scoring = 'null'::jsonb");
  await admin(dstPort, 'tgt_corrupt', "DELETE FROM sessions WHERE sid = 'fictional-session-2'");
  await admin(dstPort, 'tgt_corrupt', "INSERT INTO invoice_sequences(organization_id) SELECT id FROM organizations LIMIT 1");
  r = await compare({ sourceUrl: src(), targetUrl: dst('tgt_corrupt') });
  assert.deepEqual(r.problems.map(p => `${p.check}:${p.table}`).sort(),
    ['new_table_not_empty:invoice_sequences', 'table:contacts', 'table:org_settings', 'table:sessions']);
  // CLI: exit status 1 and no row values in output.
  const child = spawn(process.execPath, [resolve(root, 'scripts/v2-migration/compare.mjs')], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SOURCE_DATABASE_URL: src(), TARGET_DATABASE_URL: dst('tgt_corrupt') }, windowsHide: true });
  let out = ''; child.stdout.on('data', d => { out += d; });
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).status, 'MISMATCH');
  assert.ok(!out.includes('Fictional') && !out.includes(USER_PW) && !out.includes(READER_PW));
}, 120000);
