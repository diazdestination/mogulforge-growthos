/** Optional private operational tools. Backups require Node >=22.16. */
import * as sqlite from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateAdapterConfig } from './adapter.mjs';

export const WORKER_CONTRACT = 'growthos-website-worker-v1';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const STATES = ['queued', 'processing', 'saved', 'needs-review', 'expired'];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function privatePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /(?:^|[\\/])(?:public|\.next|dist|out)(?:[\\/]|$)/i.test(value)) fail('operations_private_path_required');
  const directory = realpathSync(path.dirname(value));
  if (/(?:^|[\\/])(?:public|\.next|dist|out)(?:[\\/]|$)/i.test(directory)) fail('operations_private_path_required');
  if (existsSync(value) && lstatSync(value).isSymbolicLink()) fail('operations_symlink_forbidden');
  return path.join(directory, path.basename(value));
}

function openJournal(journalPath) {
  const resolved = privatePath(journalPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) fail('operations_journal_missing');
  const database = new sqlite.DatabaseSync(resolved, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=3000');
    const metadata = database.prepare('SELECT key_hash FROM adapter_meta WHERE id=1').get();
    if (!/^[a-f0-9]{64}$/.test(metadata?.key_hash ?? '')) fail('operations_journal_invalid');
    return { database, resolved, keyHash: metadata.key_hash };
  } catch (error) { database.close(); throw error; }
}

/** SQLite's backup API includes committed WAL contents; an ordinary file copy does not. */
export async function backupWebsiteJournal({ journalPath, backupRoot, now = Date.now }) {
  if (typeof sqlite.backup !== 'function') fail('operations_backup_runtime_unsupported');
  if (!path.isAbsolute(backupRoot ?? '') || !existsSync(backupRoot)) fail('operations_backup_root_required');
  const root = realpathSync(backupRoot);
  privatePath(path.join(root, 'check.sqlite'));
  const { database, resolved } = openJournal(journalPath);
  let folder;
  try {
    folder = mkdtempSync(path.join(root, 'growthos-journal-'));
    chmodSync(folder, 0o700);
    const destination = path.join(folder, 'journal.sqlite');
    const startedAt = now();
    const pages = await sqlite.backup(database, destination, {
      rate: 1000,
      progress() { if (now() - startedAt > 30_000) fail('operations_backup_deadline'); },
    });
    chmodSync(destination, 0o600);
    const verification = new sqlite.DatabaseSync(destination, { readOnly: true });
    let records;
    try {
      if (verification.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('operations_backup_integrity');
      records = verification.prepare('SELECT count(*) AS n FROM website_delivery').get().n;
    } finally { verification.close(); }
    const manifest = {
      contract: 'growthos-website-journal-backup-v1', createdAt: new Date(now()).toISOString(),
      elapsedMs: Math.max(0, now() - startedAt), pages, records,
      sha256: sha(readFileSync(destination)), bytes: statSync(destination).size,
      encryptedPayloads: true, encryptionKeyIncluded: false, sourceModified: false,
      // A backup alone does not prove that keys, the CRM receipt store or hosting can be restored.
      restoreVerified: false,
    };
    writeFileSync(path.join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { directory: folder, journalPath: destination, manifest };
  } catch (error) {
    if (folder && path.dirname(folder) === root && path.basename(folder).startsWith('growthos-journal-')) {
      for (const name of ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm', 'manifest.json']) {
        const owned = path.join(folder, name);
        if (owned !== resolved && existsSync(owned)) unlinkSync(owned);
      }
      rmdirSync(folder);
    }
    throw error;
  } finally { database.close(); }
}

export function workerHeartbeatPath(config) { return `${config.journalPath}.worker.json`; }

/** Store only process health and counts beside the private journal. */
export function writeWorkerHeartbeat(rawConfig, { state, counts = null, instanceId, reason = null }, now = Date.now) {
  const config = validateAdapterConfig(rawConfig);
  if (!['running', 'stopped', 'failed'].includes(state) || typeof instanceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(instanceId)) fail('operations_heartbeat_invalid');
  if (reason !== null && !['worker_failure', 'worker_stopped'].includes(reason)) fail('operations_heartbeat_invalid');
  const safeCounts = counts === null ? null : Object.fromEntries(STATES.map((key) => {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) fail('operations_heartbeat_invalid');
    return [key, counts[key]];
  }));
  const target = privatePath(workerHeartbeatPath(config));
  const partitionHash = sha(`${config.apiOrigin}|${config.siteId}`);
  if (existsSync(target)) {
    let previous;
    try { previous = JSON.parse(readFileSync(target, 'utf8')); } catch { fail('operations_heartbeat_invalid'); }
    if (previous.contract !== WORKER_CONTRACT || previous.partitionHash !== partitionHash) fail('operations_heartbeat_identity');
  }
  const heartbeat = { contract: WORKER_CONTRACT, partitionHash, instanceId, state, counts: safeCounts, reason, updatedAt: new Date(now()).toISOString() };
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return heartbeat;
}

/** No drain, expiry mutation, credentials, customer text or request IDs in health output. */
export function inspectWebsiteOperations(rawConfig, { now = Date.now, staleAfterMs = 180_000, queueWarningMs = 300_000 } = {}) {
  const config = validateAdapterConfig(rawConfig);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1 || !Number.isFinite(queueWarningMs) || queueWarningMs < 1) fail('operations_threshold_invalid');
  const timestamp = now();
  const { database, keyHash } = openJournal(config.journalPath);
  let counts, totalRecords, oldestPendingAt;
  try {
    if (keyHash !== sha(`growthos-journal-key-v1:${config.encryptionKey}`)) fail('journal_key_mismatch');
    database.exec('BEGIN');
    counts = Object.fromEntries(STATES.map((state) => [state, 0]));
    for (const row of database.prepare('SELECT state,count(*) AS n FROM website_delivery WHERE partition=? GROUP BY state').all(`${config.apiOrigin}|${config.siteId}`)) {
      if (!STATES.includes(row.state)) fail('operations_journal_invalid');
      counts[row.state] = row.n;
    }
    totalRecords = database.prepare('SELECT count(*) AS n FROM website_delivery').get().n;
    oldestPendingAt = database.prepare("SELECT min(received_at) AS oldest FROM website_delivery WHERE partition=? AND state IN ('queued','processing')").get(`${config.apiOrigin}|${config.siteId}`).oldest;
    database.exec('COMMIT');
  } finally { database.close(); }
  const reasons = [];
  const heartbeatFile = privatePath(workerHeartbeatPath(config));
  let heartbeat = null;
  try { heartbeat = JSON.parse(readFileSync(heartbeatFile, 'utf8')); } catch { reasons.push('worker_unobserved'); }
  let workerAgeMs = null;
  if (heartbeat) {
    const updatedAt = Date.parse(heartbeat.updatedAt);
    if (heartbeat.contract !== WORKER_CONTRACT || heartbeat.partitionHash !== sha(`${config.apiOrigin}|${config.siteId}`) || !Number.isFinite(updatedAt) || updatedAt > timestamp + 60_000 || !['running', 'stopped', 'failed'].includes(heartbeat.state)) reasons.push('worker_identity_invalid');
    else {
      workerAgeMs = Math.max(0, timestamp - updatedAt);
      if (heartbeat.state !== 'running') reasons.push('worker_not_running');
      if (workerAgeMs > staleAfterMs) reasons.push('worker_stale');
    }
  }
  const oldestPendingAgeMs = oldestPendingAt === null ? null : Math.max(0, timestamp - oldestPendingAt);
  const capacity = Math.max(1, Math.min(config.capacity ?? 10_000, 10_000));
  if (counts['needs-review'] || counts.expired) reasons.push('delivery_needs_review');
  if (oldestPendingAgeMs !== null && oldestPendingAgeMs >= queueWarningMs) reasons.push('delivery_queue_old');
  if (totalRecords >= capacity) reasons.push('journal_capacity_reached');
  else if (totalRecords >= capacity * 0.8) reasons.push('journal_capacity_warning');
  return { contract: WORKER_CONTRACT, status: reasons.length ? 'needs-attention' : 'healthy', checkedAt: new Date(timestamp).toISOString(), counts, totalRecords, capacity, workerAgeMs, oldestPendingAgeMs, reasons };
}
