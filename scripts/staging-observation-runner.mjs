// Owner-authorized, fixed-target read-only observer. No application imports.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { observeStaging } from './staging-observation-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runFile = promisify(execFile);
const require = createRequire(resolve(root, 'artifacts/api-server/package.json'));
const { Client } = require('pg');
export const TARGET = Object.freeze({ account: 'diazdestination@gmail.com', org: 'adam-diaz', cluster: 'zp2wjrejd2zodn4q', database: 'growthos_staging', reader: 'growthos-restore-reader', app: 'mogulforge-growthos-staging', machine: '8d96936a03d058', port: 16483 });
const FLY = 'C:/Forge/tools/flyctl/0.4.115/flyctl.exe';
const CONFIG = 'C:/Users/diazd/.fly/config.yml';
const ARTIFACTS = 'C:/Forge/artifacts/growthos-db-recovery-20261010';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
export function flyAuthorization(config) {
  const matches = [...config.matchAll(/^access_token: ([^\r\n]+)$/gm)];
  if (matches.length !== 1) fail('fly_config_shape');
  const tokens = matches[0][1].trim().replace(/^(FlyV1|Bearer) /, '').split(',');
  if (!tokens.length || tokens.some(token => !/^[A-Za-z0-9_+\/=.-]{20,5000}$/.test(token))) fail('fly_token_shape');
  // Same normalization as official superfly/fly-go tokens.Tokens.FlapsHeader.
  const macaroons = tokens.filter(token => /^(fm1r|fm1a|fm2)_/.test(token));
  return macaroons.length ? `FlyV1 ${macaroons.join(',')}` : `Bearer ${tokens.join(',')}`;
}
function environment() {
  const allowed = /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|COMSPEC|PROGRAMDATA)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), NO_COLOR: '1', FLY_NO_UPDATE_CHECK: '1' };
}
async function cli(args, timeout = 30000) {
  try { return (await runFile(FLY, args, { env: environment(), windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch { fail('fly_cli_failed'); }
}
export function verifyAdmission(admission, read = readFileSync) {
  if (admission?.kind !== 'REVIEWED_STAGING_OBSERVER' || admission?.target !== TARGET.cluster || admission?.sourceBase !== '7091af816715cfd437925eb0af82fb47d3411e34') fail('admission_identity');
  const required = ['scripts/staging-observation-core.mjs', 'scripts/staging-observation-runner.mjs', 'reports/release-preparation-2026-10-09/schema-catalog.mjs', ...['95', '141', '142'].map(n => `reports/staging-observation-2026-10-10/fixtures/catalog-${n}.json`)];
  if (!admission.files || Object.keys(admission.files).sort().join('|') !== required.sort().join('|')) fail('admission_files');
  for (const path of required) if (!/^[a-f0-9]{64}$/.test(admission.files[path]) || sha(read(resolve(root, path))) !== admission.files[path]) fail('source_drift');
  if (!/^[a-f0-9]{64}$/.test(admission.flyBinarySha256) || sha(read(FLY)) !== admission.flyBinarySha256) fail('fly_binary_drift');
}
async function getApi(path, authorization) {
  try {
    const response = await fetch(`https://api.machines.dev/v1/${path}`, { method: 'GET', headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) fail(`fly_http_${response.status}`);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) fail('fly_response_bound');
    return JSON.parse(text);
  } catch (error) { if (error.safeCode) throw error; fail('fly_api_failed'); }
}
async function listenerPid() {
  try {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-Command', `$p=@(Get-NetTCPConnection -LocalPort ${TARGET.port} -State Listen -ErrorAction SilentlyContinue); if($p.Count -eq 0){'none'}elseif($p.Count -eq 1 -and $p[0].LocalAddress -eq '127.0.0.1'){$p[0].OwningProcess}else{'unsafe'}`], { windowsHide: true, timeout: 10000, env: environment() });
    return stdout.trim();
  } catch { fail('listener_inspection_failed'); }
}
async function wait(ms) { await new Promise(done => setTimeout(done, ms)); }
export async function startProxy(receipt, {
  inspectListener = listenerPid,
  spawnChild = () => spawn(FLY, ['mpg', 'proxy', TARGET.cluster, '--bind-addr', '127.0.0.1', '--local-port', String(TARGET.port)], { env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  pause = wait, startMs = 45000, cleanupMs = 10000,
} = {}) {
  if (await inspectListener() !== 'none') fail('proxy_port_occupied');
  const child = spawnChild();
  let closed = false;
  let launchFailed = false;
  const exited = new Promise(done => { child.once('error', () => { launchFailed = true; closed = true; done(); }); child.once('close', () => { closed = true; done(); }); });
  // Provider diagnostics can contain sensitive context. Drain without logging.
  child.stdout.resume(); child.stderr.resume();
  receipt.proxy = { pid: child.pid ?? null, bind: '127.0.0.1', port: TARGET.port, ownedListenerVerified: false, exitAcknowledged: false, listenerGone: false };
  const close = async () => {
    if (!closed) child.kill();
    await Promise.race([exited, pause(cleanupMs)]);
    receipt.proxy.exitAcknowledged = closed;
    receipt.proxy.listenerGone = await inspectListener() === 'none';
    if (!closed || !receipt.proxy.listenerGone) fail('proxy_cleanup_unconfirmed');
  };
  try {
    const until = Date.now() + startMs;
    while (Date.now() < until && !closed) {
      const pid = await inspectListener();
      if (pid === String(child.pid)) { receipt.proxy.ownedListenerVerified = true; return { close }; }
      if (pid !== 'none') fail('proxy_listener_not_owned');
      await pause(1000);
    }
    fail(launchFailed ? 'proxy_launch_failed' : 'proxy_start_timeout');
  } catch (error) { await close(); throw error; }
}
export async function closeClient(client, receipt, pause = wait) {
  let ended = false;
  try { await Promise.race([client.end().then(() => { ended = true; }), pause(5000)]); } catch {}
  if (!ended) {
    client.connection?.stream?.destroy();
    await pause(250);
  }
  receipt.clientEndAcknowledged = ended;
  receipt.socketClosed = !client.connection?.stream || client.connection.stream.destroyed;
  if (!ended || !receipt.socketClosed) fail('client_cleanup_unconfirmed');
}
export async function main() {
  if (process.platform !== 'win32' || process.argv.length !== 2) fail('runner_usage');
  const receipt = { kind: 'GROWTHOS_STAGING_READONLY_OBSERVATION', startedAt: new Date().toISOString(), target: TARGET, managedRestoreProved: false, effectiveAppBindingVerified: false, status: 'failed' };
  let proxy, client;
  try {
    const admission = JSON.parse(readFileSync(`${ARTIFACTS}/observer-admission.json`, 'utf8'));
    verifyAdmission(admission);
    receipt.reviewedSourceHashes = admission.files;
    const identity = (await cli(['auth', 'whoami'])).trim();
    if (identity !== TARGET.account) fail('fly_account_mismatch');
    // Let the official CLI refresh its short-lived API discharges before using
    // its normal credential file; a browser session is not API authentication.
    const clusters = JSON.parse(await cli(['mpg', 'list', '--org', 'personal', '--json']));
    if (!Array.isArray(clusters) || !clusters.some(cluster => cluster.id === TARGET.cluster)) fail('fly_cluster_listing_mismatch');
    const authorization = flyAuthorization(readFileSync(CONFIG, 'utf8'));
    const cluster = (await getApi(`postgres/${TARGET.cluster}`, authorization)).data;
    if (cluster?.id !== TARGET.cluster || cluster?.organization?.slug !== TARGET.org || cluster?.region !== 'iad' || cluster?.status !== 'ready' || String(cluster?.pg_major_version) !== '16') fail('fly_cluster_mismatch');
    const machine = await getApi(`apps/${TARGET.app}/machines/${TARGET.machine}`, authorization);
    if (machine.id !== TARGET.machine || machine.state !== 'stopped') fail('staging_not_stopped');
    receipt.provider = { account: identity, cluster: cluster.id, region: cluster.region, version: cluster.pg_major_version, appState: machine.state, machineVersion: machine.instance_id };
    const credentials = (await getApi(`postgres/${TARGET.cluster}/users/${TARGET.reader}/credentials`, authorization)).data;
    if (credentials?.username !== TARGET.reader || typeof credentials.password !== 'string' || credentials.password.length < 8) fail('reader_credential_mismatch');
    const expectedCatalogs = Object.fromEntries(['95', '141', '142'].map(n => [n, JSON.parse(readFileSync(resolve(root, `reports/staging-observation-2026-10-10/fixtures/catalog-${n}.json`), 'utf8'))]));
    proxy = await startProxy(receipt);
    client = new Client({ host: '127.0.0.1', port: TARGET.port, user: TARGET.reader, password: credentials.password, database: TARGET.database, application_name: 'growthos-readonly-verification-20261010', connectionTimeoutMillis: 10000, query_timeout: 35000, ssl: false, options: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=45000' });
    client.on('error', () => {});
    await client.connect();
    receipt.transport = { kind: 'Fly authenticated private WireGuard proxy', sqlTls: false, loopbackOnly: true, fixedCluster: true, flyVersion: '0.4.115' };
    receipt.observation = await observeStaging(client, { expectedCatalogs });
    receipt.status = receipt.observation.status;
  } catch (error) { receipt.status = 'failed'; receipt.errorCode = error.safeCode || 'observation_runner_failed'; }
  finally {
    if (client) try { await closeClient(client, receipt); } catch (error) { receipt.status = 'failed'; receipt.cleanupError = error.safeCode; }
    if (proxy) try { await proxy.close(); } catch (error) { receipt.status = 'failed'; receipt.cleanupError = error.safeCode; }
    receipt.finishedAt = new Date().toISOString();
    const path = `${ARTIFACTS}/staging-observation-${receipt.startedAt.replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: receipt.status, errorCode: receipt.errorCode, classification: receipt.observation?.catalog?.classification, unresolved: receipt.observation?.unresolved, receipt: path, clientEndAcknowledged: receipt.clientEndAcknowledged, proxyExitAcknowledged: receipt.proxy?.exitAcknowledged }));
    if (receipt.status === 'failed') process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('staging_observation_failed'); process.exitCode = 1; });
