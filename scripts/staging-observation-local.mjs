/** Local integration smoke. No application imports, hosted access or target URLs. */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localEnvironment, withWslDockerSession, parseLoopbackPort } from './local-dev.mjs';
import { SOURCE_COMMIT, validateSqlManifest, verifySqlBlob, assertFixtureContainer } from './staging-observation-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(root, 'reports/staging-observation-2026-10-10/fixtures');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };

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
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('local_docker_unavailable'), { safeCode: 'local_docker_unavailable' })); });
    child.once('close', code => {
      clearTimeout(timer);
      if (exceeded || (code !== 0 && !allowFailure)) reject(Object.assign(new Error('local_docker_failed'), { safeCode: 'local_docker_failed' }));
      else done({ code, output: output.trim() });
    });
  });
}

function gitBlob(path) {
  return execFileSync('git', ['show', `${SOURCE_COMMIT}:${path}`], { cwd: root, env: localEnvironment(), windowsHide: true,
    timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function smoke() {
  const corePath = resolve(root, 'scripts/staging-observation-core.mjs');
  const coreSha256 = createHash('sha256').update(await readFile(corePath)).digest('hex');
  const { observeStaging } = await import('./staging-observation-core.mjs');
  const manifest = JSON.parse(gitBlob('reports/release-preparation-2026-10-09/source-manifest.json'));
  const source = validateSqlManifest(manifest).slice(0, 3);
  const sql = source.map(entry => verifySqlBlob(entry, gitBlob(entry.path)));
  const expectedCatalogs = Object.fromEntries(await Promise.all([95, 141, 142].map(async count =>
    [count, JSON.parse(await readFile(resolve(evidenceDirectory, `catalog-${count}.json`), 'utf8'))])));
  const runId = randomUUID();
  const name = `growthos-observer-local-${process.pid}-${runId.slice(0, 8)}`;
  const identity = { name, runId, id: null };
  const evidence = { kind: 'LOCAL_POSTGRES16_READ_ONLY_OBSERVER_SMOKE', status: 'FAILED', startedAt: new Date().toISOString(),
    sourceCommit: SOURCE_COMMIT, coreSha256, sqlFiles: source, runId, containerName: name, hostedAccess: false,
    cleanup: { readerClosed: false, adminClosed: false, containerRemoved: false }, checks: {}, observation: null };
  let admin; let reader; let creationAttempted = false; let error;
  try {
    const image = JSON.parse((await docker(['image', 'inspect', 'postgres:16-alpine'])).output)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '')) fail('local_image_invalid');
    evidence.imageId = image.Id;
    creationAttempted = true;
    identity.id = (await docker(['run', '--detach', '--rm', '--pull=never', '--name', name,
      '--label', `com.forge.local-test=${runId}`, '--label', 'com.forge.fixture-purpose=staging-observation-20261010',
      '--memory', '1g', '--cpus', '2', '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_PASSWORD=local-observer-only', '--env', 'POSTGRES_DB=growthos_staging', image.Id])).output;
    if (!/^[a-f0-9]{64}$/.test(identity.id)) fail('local_container_invalid');
    evidence.containerId = identity.id;
    assertFixtureContainer(JSON.parse((await docker(['inspect', name])).output)[0], identity);
    const port = parseLoopbackPort((await docker(['port', name, '5432/tcp'])).output);
    evidence.loopbackBinding = { host: '127.0.0.1', port };
    let ready = false;
    for (let index = 0; index < 30; index++) {
      if ((await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'growthos_staging'], { allowFailure: true })).code === 0) { ready = true; break; }
      await new Promise(done => setTimeout(done, 500));
    }
    if (!ready) fail('local_database_not_ready');
    const require = createRequire(resolve(root, 'artifacts/api-server/package.json'));
    const { Client } = require('pg');
    const config = { host: '127.0.0.1', port, database: 'growthos_staging', ssl: false,
      connectionTimeoutMillis: 10000, statement_timeout: 30000, query_timeout: 35000, idle_in_transaction_session_timeout: 30000 };
    admin = new Client({ ...config, user: 'postgres', password: 'local-observer-only', application_name: 'growthos-observer-smoke-admin' });
    await admin.connect();
    const actual = (await admin.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version")).rows[0];
    if (actual.database !== 'growthos_staging' || actual.version < 160000 || actual.version >= 170000) fail('local_identity_mismatch');
    evidence.postgres = actual;
    for (const statement of sql) await admin.query(statement);
    await admin.query(`CREATE ROLE "growthos-local-reader-group" NOLOGIN;
      CREATE ROLE "growthos-restore-reader" LOGIN PASSWORD 'local-reader-only';
      CREATE ROLE "growthos-staging-live" LOGIN PASSWORD 'local-writer-only';
      GRANT "growthos-local-reader-group" TO "growthos-restore-reader";
      REVOKE ALL ON DATABASE growthos_staging FROM PUBLIC;
      GRANT CONNECT ON DATABASE growthos_staging TO "growthos-restore-reader", "growthos-staging-live";
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO "growthos-local-reader-group", "growthos-staging-live";
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "growthos-local-reader-group";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "growthos-staging-live";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "growthos-staging-live";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "growthos-local-reader-group";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "growthos-staging-live";
      INSERT INTO public.organizations (name, slug) VALUES ('Local observer fixture', 'local-observer-fixture')`);
    const sourceFingerprint = (await admin.query(`SELECT count(*)::text AS rows,
      md5(COALESCE(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text) COLLATE "C"),'')) AS digest
      FROM public.organizations AS t`)).rows[0];
    reader = new Client({ ...config, user: 'growthos-restore-reader', password: 'local-reader-only', application_name: 'growthos-observer-smoke-reader' });
    await reader.connect();
    evidence.observation = await observeStaging(reader, { expectedCatalogs });
    const observed = evidence.observation;
    // The synthetic membership/default grants deliberately exercise fail-closed
    // policy assessment. Their presence must be explicit, never a silent GO.
    evidence.expectedUnresolved = ['default_grant_policy_unassessed', 'reader_set_role_paths_unassessed'];
    const completedAsExpected = result => result.status === 'unresolved' &&
      JSON.stringify([...result.unresolved].sort()) === JSON.stringify(evidence.expectedUnresolved);
    evidence.checks.observationCompleted = completedAsExpected(observed);
    evidence.checks.identityMatches = observed.identity?.database === 'growthos_staging' && observed.identity?.login === 'growthos-restore-reader' && observed.identity?.role === 'growthos-restore-reader';
    evidence.checks.exact95Catalog = observed.catalog?.classification === '95' && observed.catalog?.physicalMatch === true;
    evidence.checks.all95Fingerprints = observed.fingerprintSummary?.complete === true && observed.fingerprintSummary?.tables === 95;
    const organization = observed.fingerprints.find(row => row.table === 'organizations');
    evidence.checks.syntheticRowDigestMatches = organization?.rows === 1 && organization?.digest === sourceFingerprint.digest;
    const readerTables = observed.privileges.tables?.filter(row => row.principal === 'growthos-restore-reader') ?? [];
    const writerTables = observed.privileges.tables?.filter(row => row.principal === 'growthos-staging-live') ?? [];
    evidence.checks.readerInheritedSelect = observed.privileges.roles?.some(row => row.principal === 'growthos-restore-reader' && row.name === 'growthos-local-reader-group' && row.usable) === true &&
      readerTables.length === 95 && readerTables.every(row => row.select && !row.insert && !row.update && !row.delete);
    evidence.checks.writerDmlCaptured = writerTables.length === 95 && writerTables.every(row => row.select && row.insert && row.update && row.delete);
    evidence.checks.observerRollbackAcknowledged = observed.transaction.rollbackAcknowledged === true;
    evidence.checks.observerReadOnly = observed.transaction.readOnly === true && observed.transaction.isolation === 'repeatable read';
    // Separate probe after observer rollback: the database, not a mock, rejects DML.
    await reader.query('BEGIN READ ONLY');
    try { await reader.query("UPDATE public.organizations SET name='Must never persist'"); }
    catch (caught) { evidence.checks.databaseRejectsReadOnlyWrite = caught.code === '25006'; }
    finally { evidence.checks.probeRollbackAcknowledged = (await reader.query('ROLLBACK')).command === 'ROLLBACK'; }
    const after = (await admin.query(`SELECT md5(COALESCE(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text) COLLATE "C"),'')) AS digest FROM public.organizations AS t`)).rows[0];
    evidence.checks.syntheticRowUnchanged = after.digest === sourceFingerprint.digest;
    // A same-row-count change to a non-key field must change the complete-row
    // digest. Each observation owns a fresh transaction after the previous ROLLBACK.
    const summarize = result => ({ status: result.status, unresolved: result.unresolved,
      catalogClassification: result.catalog?.classification, fingerprintSummary: result.fingerprintSummary,
      organizationFingerprint: result.fingerprints.find(row => row.table === 'organizations'),
      transaction: result.transaction });
    await admin.query("UPDATE public.organizations SET name='Local observer changed-name fixture' WHERE slug='local-observer-fixture'");
    const changed = await observeStaging(reader, { expectedCatalogs });
    evidence.changedNonKeyField = summarize(changed);
    const changedOrg = evidence.changedNonKeyField.organizationFingerprint;
    evidence.checks.nonKeyChangePreservesRowCount = changedOrg?.rows === organization?.rows && changedOrg?.rows === 1;
    evidence.checks.nonKeyChangeChangesDigest = typeof changedOrg?.digest === 'string' && changedOrg.digest !== organization?.digest;
    evidence.checks.changedObservationComplete = completedAsExpected(changed) && changed.fingerprintSummary?.complete === true && changed.fingerprintSummary?.tables === 95 && changed.transaction.rollbackAcknowledged === true;
    await admin.query("UPDATE public.organizations SET name='Local observer fixture' WHERE slug='local-observer-fixture'");
    const restored = await observeStaging(reader, { expectedCatalogs });
    evidence.restoredNonKeyField = summarize(restored);
    evidence.checks.restoredNameRestoresDigest = evidence.restoredNonKeyField.organizationFingerprint?.digest === organization?.digest;
    evidence.checks.restoredObservationComplete = completedAsExpected(restored) && restored.fingerprintSummary?.complete === true && restored.fingerprintSummary?.tables === 95 && restored.transaction.rollbackAcknowledged === true;
    if (Object.values(evidence.checks).some(value => value !== true)) fail('local_observation_assertion_failed');
  } catch (caught) { error = caught; }
  finally {
    if (reader) { try { await reader.end(); evidence.cleanup.readerClosed = true; } catch { error = { safeCode: 'local_reader_cleanup_failed' }; } }
    if (admin) { try { await admin.end(); evidence.cleanup.adminClosed = true; } catch { error = { safeCode: 'local_admin_cleanup_failed' }; } }
    if (creationAttempted) {
      try {
        const found = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`])).output;
        if (found) {
          assertFixtureContainer(JSON.parse((await docker(['inspect', name])).output)[0], identity);
          await docker(['rm', '--force', name]);
        }
        if ((await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`])).output) fail('local_container_cleanup_failed');
        evidence.cleanup.containerRemoved = true;
      } catch { error = { safeCode: 'local_container_cleanup_failed' }; }
    }
  }
  evidence.checks.coreUnchangedDuringRun = createHash('sha256').update(await readFile(corePath)).digest('hex') === coreSha256;
  if (!evidence.checks.coreUnchangedDuringRun) error = { safeCode: 'local_core_changed_during_run' };
  evidence.finishedAt = new Date().toISOString();
  evidence.status = error ? 'FAILED' : 'PASS';
  if (error) evidence.failureCode = /^local_[a-z_]+$/.test(error.safeCode ?? '') ? error.safeCode : 'local_smoke_failed';
  await writeFile(resolve(evidenceDirectory, 'local-observer-smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--run-local') fail('local_explicit_action_required');
  return withWslDockerSession(smoke);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(evidence => {
    console.log(JSON.stringify({ status: evidence.status, failureCode: evidence.failureCode,
      observationStatus: evidence.observation?.status, observationError: evidence.observation?.errorCode,
      unresolved: evidence.observation?.unresolved, checks: evidence.checks, cleanup: evidence.cleanup }));
    if (evidence.status !== 'PASS') process.exitCode = 1;
  }).catch(error => { console.error(/^local_[a-z_]+$/.test(error.safeCode ?? '') ? error.safeCode : 'local_smoke_failed'); process.exitCode = 1; });
}
