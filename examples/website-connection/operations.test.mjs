import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createWebsiteAdapter } from './adapter.mjs';
import { backupWebsiteJournal, inspectWebsiteOperations, writeWorkerHeartbeat, workerHeartbeatPath } from './operations.mjs';

const roots = [], adapters = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'growthos-operations-')); roots.push(root);
  const config = { apiOrigin: 'http://127.0.0.1:9988', siteId: randomUUID(), siteSecret: `ss_${'a'.repeat(64)}`, encryptionKey: 'b'.repeat(64), journalPath: path.join(root, 'journal.sqlite'), allowLocal: true };
  const request = { schemaVersion: 1, requestId: randomUUID(), contact: { name: 'Synthetic private person', email: 'synthetic@example.invalid' }, project: { serviceCode: 'repair', summary: 'Synthetic private request', timing: 'soon' }, consent: { contact: true, analytics: false, channels: ['email'], policyVersion: 'approved-request-v1' } };
  return { root, config, request };
}
function open(config, deps) { const adapter = createWebsiteAdapter(config, deps); adapters.push(adapter); return adapter; }
const unavailable = async () => { throw new Error('synthetic unavailable'); };
afterEach(() => {
  for (const adapter of adapters.splice(0)) { try { adapter.close(); } catch {} }
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('growthos-operations-'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('consistent backup includes live WAL, preserves immutable replay identity and keeps secrets out of manifest', async () => {
  const { root, config, request } = fixture(); let now = Date.now();
  const adapter = open(config, { fetch: unavailable, now: () => now });
  assert.equal((await adapter.submit(request)).status, 'queued');
  const snapshot = await backupWebsiteJournal({ journalPath: config.journalPath, backupRoot: root });
  assert.equal(snapshot.manifest.records, 1); assert.equal(snapshot.manifest.restoreVerified, false);
  const content = readFileSync(snapshot.journalPath);
  assert.equal(content.includes(Buffer.from(request.contact.name)), false);
  assert.equal(content.includes(Buffer.from(request.project.summary)), false);
  const manifest = JSON.stringify(snapshot.manifest);
  for (const value of [config.siteSecret, config.encryptionKey, request.contact.email, request.requestId]) assert.equal(manifest.includes(value), false);
  const second = await backupWebsiteJournal({ journalPath: config.journalPath, backupRoot: root });
  assert.notEqual(second.journalPath, snapshot.journalPath);
  const restored = open({ ...config, journalPath: snapshot.journalPath }, { fetch: unavailable, now: () => now });
  assert.equal(restored.lookup(request.requestId).status, 'queued');
  await assert.rejects(restored.submit({ ...request, project: { ...request.project, summary: 'Changed' } }), { code: 'idempotency_conflict' });
  assert.throws(() => createWebsiteAdapter({ ...config, journalPath: second.journalPath, encryptionKey: 'c'.repeat(64) }), { code: 'journal_key_mismatch' });
});

test('restored uncertain request reuses authoritative receipt after a lost acknowledgement', async () => {
  const { root, config, request } = fixture(); let now = Date.now(); const receipts = new Map(); let creations = 0;
  const fetch = async (_url, options) => {
    const input = JSON.parse(options.body);
    if (!receipts.has(input.requestId)) { creations++; receipts.set(input.requestId, { status: 'saved', leadId: randomUUID(), receiptId: randomUUID(), notification: 'staff-inbox' }); throw new Error('ack lost'); }
    return new Response(JSON.stringify({ ...receipts.get(input.requestId), duplicate: true }), { status: 200 });
  };
  const source = open(config, { fetch, now: () => now }); await source.submit(request);
  const snapshot = await backupWebsiteJournal({ journalPath: config.journalPath, backupRoot: root });
  source.close(); now += 60_000;
  const restored = open({ ...config, journalPath: snapshot.journalPath }, { fetch, now: () => now });
  await restored.drain();
  assert.equal(restored.lookup(request.requestId).receiptId, receipts.get(request.requestId).receiptId);
  assert.equal(creations, 1);
});

test('backup keeps an active claim and a second instance cannot steal it', async () => {
  const { root, config, request } = fixture(); let finish;
  const source = open(config, { fetch: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = source.submit(request);
  const snapshot = await backupWebsiteJournal({ journalPath: config.journalPath, backupRoot: root });
  let restoredCalls = 0;
  const restored = open({ ...config, journalPath: snapshot.journalPath }, { fetch: async () => { restoredCalls++; throw new Error('must not run'); } });
  await restored.drain(); assert.equal(restoredCalls, 0); assert.equal(restored.lookup(request.requestId).status, 'queued');
  finish(new Response(JSON.stringify({ status: 'saved', leadId: randomUUID(), receiptId: randomUUID(), notification: 'staff-inbox' }), { status: 200 }));
  await pending;
});

test('snapshot requires an existing source and a private destination', async () => {
  const { root, config } = fixture();
  await assert.rejects(backupWebsiteJournal({ journalPath: config.journalPath, backupRoot: root }), { code: 'operations_journal_missing' });
  open(config, { fetch: unavailable });
  const exposed = path.join(root, 'public'); mkdirSync(exposed);
  await assert.rejects(backupWebsiteJournal({ journalPath: config.journalPath, backupRoot: exposed }), { code: 'operations_private_path_required' });
});

test('health detects missing/stale/stopped worker, old queue and exhausted capacity without customer fields', async () => {
  const { config, request } = fixture(); config.capacity = 1; let now = Date.now();
  const adapter = open(config, { fetch: unavailable, now: () => now }); await adapter.submit(request);
  assert.ok(inspectWebsiteOperations(config, { now: () => now }).reasons.includes('worker_unobserved'));
  writeWorkerHeartbeat(config, { state: 'running', counts: adapter.inspect().counts, instanceId: randomUUID() }, () => now);
  now += 400_000;
  const health = inspectWebsiteOperations(config, { now: () => now });
  assert.deepEqual(health.reasons, ['worker_stale', 'delivery_queue_old', 'journal_capacity_reached']);
  for (const privateValue of [request.contact.name, request.contact.email, request.requestId, config.encryptionKey, config.siteSecret]) assert.equal(JSON.stringify(health).includes(privateValue), false);
  writeWorkerHeartbeat(config, { state: 'stopped', instanceId: randomUUID(), reason: 'worker_stopped' }, () => now);
  assert.ok(inspectWebsiteOperations(config, { now: () => now }).reasons.includes('worker_not_running'));
});

test('health rejects wrong key and detects mismatched or future worker identity', async () => {
  const { config } = fixture(); const adapter = open(config, { fetch: unavailable }); const now = Date.now();
  writeWorkerHeartbeat(config, { state: 'running', counts: adapter.inspect().counts, instanceId: randomUUID() }, () => now);
  assert.equal(inspectWebsiteOperations(config, { now: () => now }).status, 'healthy');
  assert.throws(() => inspectWebsiteOperations({ ...config, encryptionKey: 'c'.repeat(64) }), { code: 'journal_key_mismatch' });
  const heartbeat = JSON.parse(readFileSync(workerHeartbeatPath(config), 'utf8'));
  heartbeat.updatedAt = new Date(now + 120_000).toISOString(); writeFileSync(workerHeartbeatPath(config), JSON.stringify(heartbeat));
  assert.ok(inspectWebsiteOperations(config, { now: () => now }).reasons.includes('worker_identity_invalid'));
  assert.throws(() => writeWorkerHeartbeat({ ...config, siteId: randomUUID() }, { state: 'running', instanceId: randomUUID() }), { code: 'operations_heartbeat_identity' });
});

test('read-only health does not expire or rewrite journal records', async () => {
  const { config, request } = fixture(); const adapter = open(config, { fetch: unavailable }); await adapter.submit(request);
  const database = new DatabaseSync(config.journalPath);
  try {
    const before = database.prepare('SELECT * FROM website_delivery').get();
    inspectWebsiteOperations(config, { now: () => Date.now() + 8 * 86_400_000 });
    assert.deepEqual(database.prepare('SELECT * FROM website_delivery').get(), before);
  } finally { database.close(); }
});

test('equivalent origin and site identity normalize before writing or checking heartbeat', () => {
  const { config } = fixture(); const adapter = open(config, { fetch: unavailable });
  const equivalent = { ...config, apiOrigin: `${config.apiOrigin}/`, siteId: config.siteId.toUpperCase() };
  writeWorkerHeartbeat(equivalent, { state: 'running', counts: adapter.inspect().counts, instanceId: randomUUID() });
  assert.equal(inspectWebsiteOperations(config).status, 'healthy');
  writeWorkerHeartbeat(config, { state: 'running', instanceId: randomUUID() });
  assert.equal(inspectWebsiteOperations(equivalent).status, 'healthy');
});
