/** Explicit local-only acceptance of the new migration mechanism. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { localEnvironment, parseLoopbackPort, withWslDockerSession } from './local-dev.mjs';
import { SOURCE_COMMIT, validateSqlManifest, verifySqlBlob, assertFixtureContainer } from './staging-observation-fixtures.mjs';
import { catalogDigest } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(root, 'reports/staging-observation-2026-10-10/upgrade-fixtures');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const check = (value, code) => { if (!value) fail(code); };
function gitBlob(path) {
  return execFileSync('git', ['show', `${SOURCE_COMMIT}:${path}`], { cwd: root, env: localEnvironment(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
}
async function docker(args, { allowFailure = false } = {}) {
  let executable = 'docker';
  if (process.platform === 'win32' && existsSync('C:/Forge/tools/local-dev/docker-wsl.mjs')) {
    executable = process.execPath; args = ['C:/Forge/tools/local-dev/docker-wsl.mjs', ...args];
  }
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, env: localEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 60000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) { exceeded = true; child.kill(); } });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject({ safeCode: 'migration_local_docker_unavailable' }); });
    child.once('close', code => { clearTimeout(timer); if (exceeded || (code !== 0 && !allowFailure)) reject({ safeCode: 'migration_local_docker_failed' }); else done({ code, output: output.trim() }); });
  });
}

export function safeState(state) {
  return { catalogPhysicalDigest: catalogDigest(state.catalog, { physical: true }), tableCount: state.catalog.tables.length,
    originalFingerprints: state.fingerprints, originalRows: state.fingerprints.reduce((sum, row) => sum + row.rows, 0),
    originalEmptyTables: state.fingerprints.filter(row => row.rows === 0).length,
    privilegeTableEntries: state.privileges.tables.length, privilegeColumnEntries: state.privileges.columns.length,
    privilegeDigest: hash(JSON.stringify(state.privileges)), tableAclDigest: hash(JSON.stringify(state.tableAcl)),
    defaultsVerified: state.defaults.length, newTablesEmpty: state.newTables.length,
    identity: state.identity };
}
function safeResult(result) {
  const { before, after, ...summary } = result;
  return { ...summary, ...(before ? { before: safeState(before) } : {}), ...(after ? { after: safeState(after) } : {}) };
}

async function runLocal() {
  const corePath = resolve(root, 'scripts/staging-migration-core.mjs');
  const coreSha256 = hash(await readFile(corePath));
  const { prepareMigration, captureMigrationState, executeMigration, verifyCommittedMigration } = await import('./staging-migration-core.mjs');
  const manifestBytes = gitBlob('reports/release-preparation-2026-10-09/source-manifest.json');
  const entries = validateSqlManifest(JSON.parse(manifestBytes));
  const buffers = entries.map(entry => gitBlob(entry.path));
  buffers.forEach((bytes, index) => verifySqlBlob(entries[index], bytes));
  const catalog95 = JSON.parse(await readFile(resolve(root, 'reports/staging-observation-2026-10-10/fixtures/catalog-95.json'), 'utf8'));
  const catalog142 = JSON.parse(await readFile(resolve(root, 'reports/staging-observation-2026-10-10/fixtures/catalog-142.json'), 'utf8'));
  const plan = prepareMigration({ manifestBytes, sqlBuffers: buffers.slice(3), catalog95, catalog142 });
  const runId = randomUUID(); const name = `growthos-upgrade-local-${process.pid}-${runId.slice(0, 8)}`;
  const journalDirectory = resolve(evidenceDirectory, 'journals', runId);
  await mkdir(journalDirectory, { recursive: true });
  const identity = { name, runId, id: null };
  const evidence = { kind: 'LOCAL_POSTGRES16_NEW_MIGRATION_EXECUTOR_ACCEPTANCE', startedAt: new Date().toISOString(),
    status: 'FAILED', sourceCommit: SOURCE_COMMIT, coreSha256, manifestSha256: hash(manifestBytes), sqlFiles: entries,
    runId, containerName: name, hostedAccess: false, rawRowsRecorded: false, cases: {}, checks: {},
    cleanup: { clientsClosed: 0, socketsClosed: 0, expectedClients: 0, containerRemoved: false } };
  const clients = []; let admin; let creationAttempted = false; let error;
  try {
    const image = JSON.parse((await docker(['image', 'inspect', 'postgres:16-alpine'])).output)[0];
    check(/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? ''), 'migration_local_image_invalid');
    evidence.imageId = image.Id;
    creationAttempted = true;
    identity.id = (await docker(['run', '--detach', '--rm', '--pull=never', '--name', name,
      '--label', `com.forge.local-test=${runId}`, '--label', 'com.forge.fixture-purpose=staging-observation-20261010',
      '--memory', '1g', '--cpus', '2', '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_PASSWORD=local-upgrade-only', '--env', 'POSTGRES_DB=growthos_staging', image.Id])).output;
    check(/^[a-f0-9]{64}$/.test(identity.id), 'migration_local_container_invalid');
    evidence.containerId = identity.id;
    assertFixtureContainer(JSON.parse((await docker(['inspect', name])).output)[0], identity);
    const port = parseLoopbackPort((await docker(['port', name, '5432/tcp'])).output);
    evidence.loopbackBinding = { host: '127.0.0.1', port };
    let ready = false;
    for (let index = 0; index < 30; index++) {
      if ((await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'growthos_staging'], { allowFailure: true })).code === 0) { ready = true; break; }
      await new Promise(done => setTimeout(done, 500));
    }
    check(ready, 'migration_local_database_not_ready');
    const require = createRequire(resolve(root, 'artifacts/api-server/package.json'));
    const { Client } = require('pg');
    const connect = async user => {
      const password = user === 'postgres' ? 'local-upgrade-only' : user === 'fly-user' ? 'local-owner-only' : 'local-reader-only';
      const client = new Client({ host: '127.0.0.1', port, database: 'growthos_staging', user, password, ssl: false,
        application_name: 'growthos-local-upgrade-acceptance', connectionTimeoutMillis: 10000, query_timeout: 35000,
        statement_timeout: 30000, idle_in_transaction_session_timeout: 30000 });
      client.on('error', () => {}); clients.push(client); await client.connect(); return client;
    };
    admin = await connect('postgres');
    const actual = (await admin.query("SELECT current_database() AS database,current_setting('server_version_num')::int AS version")).rows[0];
    check(actual.database === 'growthos_staging' && actual.version >= 160000 && actual.version < 170000, 'migration_local_identity');
    evidence.postgres = actual;
    await admin.query(`CREATE ROLE schema_admin NOLOGIN;
      CREATE ROLE "fly-user" LOGIN PASSWORD 'local-owner-only'; GRANT schema_admin TO "fly-user";
      ALTER ROLE "fly-user" SET role TO 'schema_admin';
      CREATE ROLE reader NOLOGIN; CREATE ROLE writer NOLOGIN;
      GRANT pg_read_all_data TO reader; GRANT pg_read_all_data,pg_write_all_data TO writer;
      CREATE ROLE "growthos-restore-reader" LOGIN PASSWORD 'local-reader-only';
      CREATE ROLE "growthos-staging-live" NOLOGIN;
      GRANT reader TO "growthos-restore-reader"; GRANT writer TO "growthos-staging-live";
      ALTER SCHEMA public OWNER TO schema_admin; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE TEMP ON DATABASE growthos_staging FROM PUBLIC; SET ROLE schema_admin`);
    for (const bytes of buffers.slice(0, 3)) await admin.query(bytes.toString('utf8'));
    await admin.query('RESET ROLE');
    const capture = async () => {
      const reader = await connect('growthos-restore-reader');
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off");
      try { return await captureMigrationState(reader, plan); }
      finally { check((await reader.query('ROLLBACK')).command === 'ROLLBACK', 'migration_local_capture_rollback'); }
    };
    const runCase = async (label, expectedBefore, options = {}) => {
      const client = await connect('fly-user'); const journal = [];
      const initialIdentity = (await client.query('SELECT session_user::text AS login,current_user::text AS role,pg_backend_pid() AS pid')).rows[0];
      check(initialIdentity.login === 'fly-user' && initialIdentity.role === 'schema_admin' && Number.isInteger(initialIdentity.pid) && initialIdentity.pid > 0,
        'migration_local_default_role_not_modeled');
      const wrapped = options.lateFailure ? { connection: client.connection, query: (...args) => args[0] === plan.steps.at(-1).sql ? client.query('SELECT 1 / 0') : client.query(...args) } : client;
      const journalFile = resolve(journalDirectory, `${label}.jsonl`);
      const descriptor = openSync(journalFile, 'wx');
      try {
        const result = await executeMigration(wrapped, { plan, expectedBefore, outcome: options.outcome ?? 'rollback',
          persist: async event => { writeSync(descriptor, `${JSON.stringify(event)}\n`); fsyncSync(descriptor); journal.push(event); } });
        evidence.cases[label] = { initialIdentity, result: safeResult(result), journal, durableJournal: `journals/${runId}/${label}.jsonl` };
        return result;
      } finally { closeSync(descriptor); }
    };
    // All originals empty is valid and must not be treated as a missing baseline.
    const empty = await capture();
    const emptyResult = await runCase('empty-original-tables', empty);
    evidence.checks.emptyOriginalsAccepted = emptyResult.status === 'rehearsed-rolled-back' && emptyResult.rollbackAcknowledged && empty.fingerprints.every(row => row.rows === 0);
    const emptyAfter = await capture();
    evidence.checks.emptyRehearsalRolledBack = isDeepStrictEqual(emptyAfter.catalog, empty.catalog) && isDeepStrictEqual(emptyAfter.fingerprints, empty.fingerprints);

    // Two synthetic tenants touch every table receiving the26 legacy defaults.
    for (let index = 1; index <= 2; index++) {
      const organization = (await admin.query("INSERT INTO public.organizations(name,slug) VALUES($1,$2) RETURNING id", [`Synthetic upgrade tenant ${index}`, `synthetic-upgrade-${index}`])).rows[0].id;
      const user = `synthetic-upgrade-user-${index}`;
      await admin.query('INSERT INTO public.users(id,organization_id) VALUES($1,$2)', [user, organization]);
      const contact = (await admin.query('INSERT INTO public.contacts(organization_id,first_name) VALUES($1,$2) RETURNING id', [organization, `Synthetic contact ${index}`])).rows[0].id;
      const lead = (await admin.query('INSERT INTO public.leads(organization_id,contact_id) VALUES($1,$2) RETURNING id', [organization, contact])).rows[0].id;
      await admin.query('INSERT INTO public.lead_imports(organization_id) VALUES($1)', [organization]);
      const task = (await admin.query('INSERT INTO public.crm_tasks(organization_id,title) VALUES($1,$2) RETURNING id', [organization, `Retained task ${index}`])).rows[0].id;
      await admin.query("INSERT INTO public.service_obligations(organization_id,contact_id,task_id,due_at,equipment_label,kind) VALUES($1,$2,$3,'2027-01-01T00:00:00Z',$4,'synthetic-retained-kind')", [organization, contact, task, `Retained equipment ${index}`]);
      const subscription = (await admin.query("INSERT INTO public.staff_push_subscriptions(organization_id,user_id,endpoint_hash,expires_at) VALUES($1,$2,$3,'2027-01-01T00:00:00Z') RETURNING id", [organization, user, `synthetic-endpoint-${index}`])).rows[0].id;
      await admin.query("INSERT INTO public.staff_push_deliveries(organization_id,lead_id,subscription_id,expires_at) VALUES($1,$2,$3,'2027-01-01T00:00:00Z')", [organization, lead, subscription]);
      await admin.query('INSERT INTO public.estimates(organization_id,lead_id,title) VALUES($1,$2,$3)', [organization, lead, `Retained estimate ${index}`]);
      await admin.query('INSERT INTO public.projects(organization_id,lead_id,name) VALUES($1,$2,$3)', [organization, lead, `Retained project ${index}`]);
      await admin.query("INSERT INTO public.value_entries(organization_id,lead_id,amount_cents,kind,occurred_at,recorded_by_user_id,source_reference) VALUES($1,$2,$3,'synthetic-retained-kind','2026-01-01T00:00:00Z',$4,$5)", [organization, lead, index * 1234, user, `synthetic-source-${index}`]);
    }
    const baseline = await capture(); evidence.seededBaseline = safeState(baseline);
    evidence.checks.twoTenantsSeeded = baseline.fingerprints.find(row => row.table === 'organizations')?.rows === 2;
    evidence.checks.allLegacyDefaultTablesPopulated = Object.keys((await import('./staging-migration-core.mjs')).LEGACY_DEFAULTS).every(table => baseline.fingerprints.find(row => row.table === table)?.rows === 2);

    await admin.query("UPDATE public.organizations SET name='Changed non-key synthetic value' WHERE slug='synthetic-upgrade-1'");
    const corrupt = await runCase('same-count-non-key-drift', baseline);
    evidence.checks.sameCountDriftRefused = corrupt.status === 'failed' && corrupt.errorCode === 'migration_baseline_drift' && corrupt.stepsAcknowledged === 0 && corrupt.rollbackAcknowledged;
    await admin.query("UPDATE public.organizations SET name='Synthetic upgrade tenant 1' WHERE slug='synthetic-upgrade-1'");
    const repaired = await capture(); evidence.checks.driftFixtureRestored = isDeepStrictEqual(repaired.fingerprints, baseline.fingerprints);

    const late = await runCase('late-sql-error', baseline, { lateFailure: true });
    const afterLate = await capture();
    evidence.checks.lateSqlFailureRolledBack = late.status === 'failed' && late.stepsAcknowledged === 15 && late.rollbackAcknowledged && !late.commitDispatched;
    evidence.checks.lateRollbackPreserves95 = isDeepStrictEqual(afterLate.catalog, baseline.catalog) && isDeepStrictEqual(afterLate.fingerprints, baseline.fingerprints) && isDeepStrictEqual(afterLate.tableAcl, baseline.tableAcl);

    const committed = await runCase('exact-commit', baseline, { outcome: 'commit' });
    evidence.checks.exactCommitAcknowledged = committed.status === 'committed-awaiting-reader' && committed.commitAcknowledged && committed.stepsAcknowledged === 16;
    const fresh = await capture(); evidence.freshReader = safeState(fresh);
    const verified = verifyCommittedMigration(committed, fresh, plan); evidence.verified = verified;
    evidence.checks.freshReaderVerified = verified.status === 'verified' && verified.freshReaderVerified === true;
    evidence.checks.proofCoverage = verified.originalTables === 95 && verified.newTablesEmpty === 47 && verified.defaultsVerified === 26 && verified.privilegeTableEntries === 284;
    evidence.checks.ownerDefaultRoleModeled = Object.values(evidence.cases).every(entry => entry.initialIdentity.login === 'fly-user' &&
      entry.initialIdentity.role === 'schema_admin' && Object.values(entry.result.initialIdentityChecks ?? {}).length === 5 &&
      Object.values(entry.result.initialIdentityChecks).every(value => value === true));
    check(Object.values(evidence.checks).every(value => value === true), 'migration_local_assertion_failed');
  } catch (caught) { error = caught; }
  finally {
    evidence.cleanup.expectedClients = clients.length;
    for (const client of clients) {
      let timer;
      try {
        await Promise.race([client.end(), new Promise((_, reject) => { timer = setTimeout(() => { client.connection?.stream?.destroy(); reject(new Error('end-timeout')); }, 5000); })]);
        evidence.cleanup.clientsClosed++;
        if (!client.connection?.stream || client.connection.stream.destroyed) evidence.cleanup.socketsClosed++;
      } catch { error = { safeCode: 'migration_local_client_cleanup_failed' }; }
      finally { clearTimeout(timer); }
    }
    if (creationAttempted) {
      try {
        if ((await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`])).output) {
          assertFixtureContainer(JSON.parse((await docker(['inspect', name])).output)[0], identity);
          await docker(['rm', '--force', name]);
        }
        check(!(await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`])).output, 'migration_local_cleanup_failed');
        evidence.cleanup.containerRemoved = true;
      } catch { error = { safeCode: 'migration_local_container_cleanup_failed' }; }
    }
  }
  evidence.coreFinishedSha256 = hash(await readFile(corePath));
  evidence.checks.coreUnchanged = evidence.coreFinishedSha256 === coreSha256;
  if (!evidence.checks.coreUnchanged) error = { safeCode: 'migration_local_core_changed_during_run' };
  if (evidence.cleanup.clientsClosed !== clients.length || evidence.cleanup.socketsClosed !== clients.length || !evidence.cleanup.containerRemoved) error = { safeCode: 'migration_local_cleanup_unconfirmed' };
  evidence.finishedAt = new Date().toISOString();
  evidence.status = error ? 'FAILED' : 'PASS';
  if (error) evidence.failureCode = /^migration_[a-z_]+$/.test(error.safeCode ?? '') ? error.safeCode : 'migration_local_failed';
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(resolve(evidenceDirectory, `local-migration-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  await writeFile(resolve(evidenceDirectory, 'local-migration-acceptance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function main(args = process.argv.slice(2)) {
  check(args.length === 1 && args[0] === '--run-local', 'migration_local_explicit_action_required');
  return withWslDockerSession(runLocal);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => { console.log(JSON.stringify({ status: result.status, failureCode: result.failureCode, checks: result.checks, verified: result.verified, cleanup: result.cleanup }));
    if (result.status !== 'PASS') process.exitCode = 1;
  }).catch(error => { console.error(/^migration_[a-z_]+$/.test(error.safeCode ?? '') ? error.safeCode : 'migration_local_failed'); process.exitCode = 1; });
}
