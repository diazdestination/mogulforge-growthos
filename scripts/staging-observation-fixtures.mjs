/** Local-only fixture generation. Importing this module performs no I/O.
 * SQL comes from the pinned Git commit, never an environment URL or app import.
 * Each run owns one labelled loopback PostgreSQL16 container and removes it.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localEnvironment, withWslDockerSession, parseLoopbackPort } from './local-dev.mjs';
import { collectSchemaCatalog, catalogDigest } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';

export const SOURCE_COMMIT = '7091af816715cfd437925eb0af82fb47d3411e34';
export const ACCEPTED_95_DIGEST = 'a717ae6d79fe57095a4354b55bf1098b17085c00bd82b17a6076765434113516';
const MANIFEST_PATH = 'reports/release-preparation-2026-10-09/source-manifest.json';
const SQL_NAMES = [
  '0000_isolated-staging-initial', '0001_pilot-email-sender', '0002_mobile-microsoft-pilot',
  '0003_swarm-foundation', '0004_beta-operations', '0005_contractor-operations',
  '0006_native-contractor-day', '0007_customer-care', '0008_operations-wave',
  '0009_launch-communications', '0010_lead-replies', '0011_invoice-recovery',
  '0012_callie-intake', '0013_standing-service', '0014_source-nurture',
  '0015_callie-conversation', '0016_contractor-workday', '0017_returning-customer-work',
  '0018_lead-alert-coverage',
];
export const SQL_PATHS = Object.freeze(SQL_NAMES.map((name, index) =>
  `reports/staging-schema-preview-2026-${index < 2 ? '09-30' : '10-01'}/${name}.sql`));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = resolve(root, 'reports/staging-observation-2026-10-10/fixtures');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(code), { code });

export function validateSqlManifest(manifest) {
  if (manifest?.historicalBaseline95CatalogDigest !== ACCEPTED_95_DIGEST ||
      !Array.isArray(manifest.sqlFiles) || manifest.sqlFiles.length !== SQL_PATHS.length) {
    throw failure('fixture_manifest_invalid');
  }
  return manifest.sqlFiles.map((entry, index) => {
    if (entry?.path !== SQL_PATHS[index] || !/^[a-f0-9]{64}$/.test(entry.gitObjectSha256 ?? '') ||
        !Number.isSafeInteger(entry.gitObjectBytes) || entry.gitObjectBytes < 1 || entry.gitObjectBytes > 1024 * 1024 ||
        entry.canonicalLfSha256 !== entry.gitObjectSha256 ||
        // 0018 was new in this manifest; only earlier SQL has a historical acceptance hash.
        (index === 18 ? entry.historicalAcceptedSha256 !== null : entry.historicalAcceptedSha256 !== entry.gitObjectSha256)) {
      throw failure('fixture_manifest_entry_invalid');
    }
    return { path: entry.path, gitObjectSha256: entry.gitObjectSha256, gitObjectBytes: entry.gitObjectBytes };
  });
}

export function verifySqlBlob(entry, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.gitObjectBytes || sha256(bytes) !== entry.gitObjectSha256 ||
      bytes.includes(13) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    throw failure('fixture_sql_blob_mismatch');
  }
  return bytes.toString('utf8');
}

export function validateFixture(catalog, tableCount) {
  if (![95, 141, 142].includes(tableCount) || catalog?.formatVersion !== 1 ||
      !Array.isArray(catalog.tables) || catalog.tables.length !== tableCount) throw failure('fixture_table_count_mismatch');
  const logicalDigest = catalogDigest(catalog);
  if (tableCount === 95 && logicalDigest !== ACCEPTED_95_DIGEST) throw failure('fixture_95_catalog_mismatch');
  return { tableCount, logicalDigest, physicalDigest: catalogDigest(catalog, { physical: true }) };
}

export function assertFixtureContainer(inspection, { runId, name, id }) {
  if (!inspection || inspection.Config?.Labels?.['com.forge.local-test'] !== runId ||
      inspection.Config?.Labels?.['com.forge.fixture-purpose'] !== 'staging-observation-20261010' ||
      inspection.Name !== `/${name}` || (id && inspection.Id !== id)) throw failure('fixture_container_ownership_mismatch');
}

function gitBlob(path) {
  return execFileSync('git', ['show', `${SOURCE_COMMIT}:${path}`], {
    cwd: root, env: localEnvironment(), windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function docker(args, { allowFailure = false, timeoutMs = 60000 } = {}) {
  let program = 'docker';
  if (process.platform === 'win32' && existsSync('C:/Forge/tools/local-dev/docker-wsl.mjs')) {
    program = process.execPath;
    args = ['C:/Forge/tools/local-dev/docker-wsl.mjs', ...args];
  }
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd: root, env: localEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    let tooLarge = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { tooLarge = true; child.kill(); }
    });
    child.stderr.on('data', () => {}); // Never relay arbitrary command diagnostics.
    child.once('error', () => { clearTimeout(timer); reject(failure('fixture_docker_unavailable')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || tooLarge || (code !== 0 && !allowFailure)) reject(failure(timedOut ? 'fixture_docker_timeout' : tooLarge ? 'fixture_docker_output_bound' : 'fixture_docker_failed'));
      else done({ code, output: output.trim() });
    });
  });
}

async function generateLocalFixtures() {
  const startedAt = new Date().toISOString();
  const manifestBytes = gitBlob(MANIFEST_PATH);
  const entries = validateSqlManifest(JSON.parse(manifestBytes.toString('utf8')));
  // Validate every blob before creating a database or executing any SQL.
  const sql = entries.map(entry => verifySqlBlob(entry, gitBlob(entry.path)));
  const runId = randomUUID();
  const name = `growthos-catalog-fixtures-${process.pid}-${runId.slice(0, 8)}`;
  const identity = { runId, name, id: null };
  const receipt = { kind: 'LOCAL_POSTGRES16_CATALOG_FIXTURES', startedAt, sourceCommit: SOURCE_COMMIT,
    manifest: { path: MANIFEST_PATH, sha256: sha256(manifestBytes), bytes: manifestBytes.length },
    sqlFiles: entries, runId, containerName: name, containerCreated: false, clientClosed: false,
    containerRemoved: false, hostedAccess: false, fixtures: [], status: 'FAILED' };
  const catalogs = new Map();
  let client;
  let creationAttempted = false;
  let error;
  try {
    // Existing local image only; the runner cannot silently pull external content.
    const image = JSON.parse((await docker(['image', 'inspect', 'postgres:16-alpine'])).output)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '')) throw failure('fixture_image_identity_invalid');
    receipt.imageId = image.Id;
    receipt.imageRepoDigests = image.RepoDigests;
    creationAttempted = true;
    identity.id = (await docker(['run', '--detach', '--rm', '--pull=never', '--name', name,
      '--label', `com.forge.local-test=${runId}`, '--label', 'com.forge.fixture-purpose=staging-observation-20261010',
      '--memory', '1g', '--cpus', '2', '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_USER=postgres', '--env', 'POSTGRES_PASSWORD=fixture-local-only',
      '--env', 'POSTGRES_DB=catalog_fixture', image.Id])).output;
    if (!/^[a-f0-9]{64}$/.test(identity.id)) throw failure('fixture_container_id_invalid');
    receipt.containerCreated = true;
    receipt.containerId = identity.id;
    const inspection = JSON.parse((await docker(['inspect', name])).output)[0];
    assertFixtureContainer(inspection, identity);
    if (inspection.Image !== image.Id) throw failure('fixture_image_identity_mismatch');
    const port = parseLoopbackPort((await docker(['port', name, '5432/tcp'])).output);
    receipt.loopbackBinding = { host: '127.0.0.1', port };
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'catalog_fixture'], { allowFailure: true })).code === 0) { ready = true; break; }
      await new Promise(done => setTimeout(done, 500));
    }
    if (!ready) throw failure('fixture_database_not_ready');
    const require = createRequire(resolve(root, 'artifacts/api-server/package.json'));
    const { Client } = require('pg');
    client = new Client({ host: '127.0.0.1', port, database: 'catalog_fixture', user: 'postgres',
      password: 'fixture-local-only', ssl: false, application_name: 'growthos-local-catalog-fixture',
      connectionTimeoutMillis: 15000, statement_timeout: 30000, query_timeout: 35000, idle_in_transaction_session_timeout: 30000 });
    await client.connect();
    const actual = (await client.query(`SELECT current_setting('server_version_num')::int AS version,
      current_database() AS database, session_user AS username, inet_server_addr()::text AS server_address`)).rows[0];
    if (actual.version < 160000 || actual.version >= 170000 || actual.database !== 'catalog_fixture' || actual.username !== 'postgres') {
      throw failure('fixture_database_identity_mismatch');
    }
    receipt.postgres = actual;
    await client.query("SET search_path TO public; SET lock_timeout TO '5s'; SET timezone TO 'UTC'");
    for (let index = 0; index < sql.length; index++) {
      await client.query(sql[index]);
      const tableCount = new Map([[2, 95], [17, 141], [18, 142]]).get(index);
      if (tableCount) {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const catalog = await collectSchemaCatalog(client);
          const proof = validateFixture(catalog, tableCount);
          catalogs.set(tableCount, catalog);
          receipt.fixtures.push({ ...proof, file: `catalog-${tableCount}.json`, throughSql: entries[index].path });
        } finally { await client.query('ROLLBACK'); }
      }
    }
  } catch (caught) { error = caught; }
  finally {
    if (client) {
      try { await client.end(); receipt.clientClosed = true; }
      catch { error = failure('fixture_client_cleanup_failed'); }
    }
    if (creationAttempted) {
      try {
        const found = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`])).output;
        if (found) {
          const inspection = JSON.parse((await docker(['inspect', name])).output)[0];
          assertFixtureContainer(inspection, identity);
          await docker(['rm', '--force', name]);
        }
        const remaining = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`])).output;
        if (remaining) throw failure('fixture_container_cleanup_failed');
        receipt.containerRemoved = true;
      } catch { error = failure('fixture_container_cleanup_failed'); }
    }
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.status = error ? 'FAILED' : 'PASS';
  if (error) receipt.failureCode = /^fixture_[a-z_]+$/.test(error.code ?? '') ? error.code : 'fixture_generation_failed';
  await mkdir(fixtureDirectory, { recursive: true });
  // Publish usable fixtures only after positive connection/container cleanup.
  if (!error) {
    for (const [count, catalog] of catalogs) {
      const bytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
      await writeFile(resolve(fixtureDirectory, `catalog-${count}.json`), bytes);
      Object.assign(receipt.fixtures.find(item => item.tableCount === count), { fileSha256: sha256(bytes), fileBytes: bytes.length });
    }
  }
  await writeFile(resolve(fixtureDirectory, 'generation-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  if (error) throw failure(receipt.failureCode);
  return receipt;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--generate-local') throw failure('fixture_explicit_local_action_required');
  return withWslDockerSession(generateLocalFixtures);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(receipt => console.log(JSON.stringify({ status: receipt.status, fixtures: receipt.fixtures,
    clientClosed: receipt.clientClosed, containerRemoved: receipt.containerRemoved })))
    .catch(error => { console.error(/^fixture_[a-z_]+$/.test(error.code ?? '') ? error.code : 'fixture_generation_failed'); process.exitCode = 1; });
}
