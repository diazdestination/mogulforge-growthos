import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createWebsiteAdapter, normalizeWebsiteIntake, validateAdapterConfig } from './adapter.mjs';

const folders = [];
const adapters = [];
const secret = `ss_${'a'.repeat(64)}`;
const encryptionKey = 'b'.repeat(64);
const siteId = '11111111-1111-4111-8111-111111111111';
const ack = () => ({ status: 'saved', leadId: randomUUID(), receiptId: randomUUID(), notification: 'staff-inbox', duplicate: false });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function payload() { return { schemaVersion: 1, requestId: randomUUID(), contact: { name: 'Synthetic Person', email: 'qa@example.invalid', phone: '5551234567' },
  project: { serviceCode: 'repair', summary: 'Synthetic request', timing: 'soon' }, consent: { contact: true, analytics: false, channels: ['phone'], policyVersion: 'approved-request-v1' } }; }
function config(extra = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'growthos-adapter-'));
  folders.push(folder);
  return { apiOrigin: 'http://127.0.0.1:9999', siteId, siteSecret: secret, encryptionKey, journalPath: path.join(folder, 'journal.sqlite'), allowLocal: true, ...extra };
}
function open(c, deps) { const adapter = createWebsiteAdapter(c, deps); adapters.push(adapter); return adapter; }
afterEach(() => {
  for (const adapter of adapters.splice(0)) { try { adapter.close(); } catch { /* test may close to simulate restart */ } }
  for (const folder of folders.splice(0)) {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir(), 'growthos-adapter-')));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('configuration rejects unsupported origins, exposed paths and missing keys', () => {
  const c = config();
  for (const bad of [{ apiOrigin: 'https://unapproved.example' }, { apiOrigin: 'https://app.mogulforge.ai/wrong' }, { apiOrigin: 'https://x:secret@app.mogulforge.ai' },
    { siteSecret: 'bad' }, { encryptionKey: '' }, { journalPath: path.resolve('public/journal.sqlite') }]) {
    assert.throws(() => validateAdapterConfig({ ...c, ...bad }), { code: 'adapter_unconfigured' });
  }
});

test('disabled capture and lifecycle pause are visible holds that require operator review', async () => {
  for (const error of ['site_capture_disabled', 'customer_lifecycle_paused']) {
    let calls = 0;
    const adapter = open(config(), { fetch: async () => { calls++; return response({ error }, error === 'customer_lifecycle_paused' ? 423 : 503); } });
    const p = payload();
    assert.deepEqual(await adapter.submit(p), { status: 'needs-review', requestId: p.requestId, retained: true, reason: error, appointmentStatus: 'pending_office_approval' });
    assert.equal((await adapter.submit(p)).status, 'needs-review');
    assert.equal(calls, 1);
  }
});

test('only explicit contact permission is normalized; no tracking or tenant fields accepted', () => {
  const p = payload();
  assert.equal(normalizeWebsiteIntake({ ...p, contact: { ...p.contact, email: ' QA@example.invalid ' } }).contact.email, 'qa@example.invalid');
  for (const bad of [{ organizationId: randomUUID() }, { consent: { ...p.consent, contact: false } }, { consent: { ...p.consent, analytics: true } }, { requestId: 'new' }]) {
    assert.throws(() => normalizeWebsiteIntake({ ...p, ...bad }));
  }
});

test('validates the credential-only handshake and rejects mismatched site evidence', async () => {
  const c = config();
  let calls = 0;
  const adapter = open(c, { fetch: async (url, init) => {
    calls++; assert.equal(url, `${c.apiOrigin}/api/v1/public/smart-sites/${siteId}/check`);
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Origin, undefined);
    assert.deepEqual(JSON.parse(init.body), { schemaVersion: 1 });
    return response({ status: 'credential_verified', siteId: calls === 1 ? siteId : randomUUID(), profile: 'hvac', credentialVersion: 1, checkedAt: new Date().toISOString(), captureEnabled: false, createsLead: false });
  } });
  assert.deepEqual((await adapter.checkConnection()).createsLead, false);
  assert.equal(adapter.inspect().totalRecords, 0);
  await assert.rejects(adapter.checkConnection(), { code: 'connection_not_verified' });
});

test('actual saved receipts deduplicate retries; changed payload conflicts and ciphertext is removed', async () => {
  const c = config(); let calls = 0; const receipt = ack();
  const adapter = open(c, { fetch: async () => { calls++; return response(receipt, 201); } });
  const p = payload();
  assert.equal((await adapter.submit(p)).status, 'saved');
  assert.equal((await adapter.submit(p)).receiptId, receipt.receiptId);
  assert.equal(adapter.lookup(p.requestId).receiptId, receipt.receiptId);
  assert.throws(() => adapter.lookup(randomUUID()), { code: 'request_unknown' });
  assert.equal(calls, 1);
  await assert.rejects(adapter.submit({ ...p, project: { ...p.project, summary: 'Changed' } }), { code: 'idempotency_conflict' });
  const db = new DatabaseSync(c.journalPath);
  assert.equal(db.prepare('select encrypted from website_delivery').get().encrypted, null); db.close();
  const bytes = readFileSync(c.journalPath);
  assert.equal(bytes.includes(Buffer.from('Synthetic Person')), false);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(JSON.stringify(adapter.inspect()).includes('qa@example.invalid'), false);
});

test('a real local lost acknowledgement survives restart and reconciles the original request once', async () => {
  let requests = 0; const saved = new Map(); const receipt = ack(); const timestamps = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const p = JSON.parse(body); requests++; timestamps.push(req.headers['x-smart-site-received-at']);
    saved.set(p.requestId, body);
    if (requests === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...receipt, duplicate: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let clock = Date.now(); const c = config({ apiOrigin: `http://127.0.0.1:${server.address().port}` }); const p = payload();
    const first = open(c, { now: () => clock });
    assert.equal((await first.submit(p)).status, 'queued'); first.close();
    clock += 31_000;
    const restarted = open(c, { now: () => clock });
    assert.equal((await restarted.drain()).counts.saved, 1);
    assert.equal((await restarted.submit(p)).receiptId, receipt.receiptId);
    assert.equal(requests, 2); assert.equal(saved.size, 1); assert.equal(timestamps[0], timestamps[1]);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('unconfirmed success responses never claim a saved CRM lead', async () => {
  const adapter = open(config(), { fetch: async () => response({ ok: true }) });
  const result = await adapter.submit(payload());
  assert.equal(result.status, 'queued'); assert.equal(result.reason, 'unconfirmed_receipt');
  assert.equal(result.leadId, undefined);
});

test('missing responders require review and never create an office-saved result', async () => {
  let allowed = false; const adapter = open(config(), { fetch: async () => allowed ? response(ack(), 201) : response({ error: 'site_staffing_unavailable' }, 503) });
  const p = payload(); const result = await adapter.submit(p);
  assert.equal(result.status, 'needs-review'); assert.equal(result.reason, 'site_staffing_unavailable');
  assert.equal(adapter.inspect().counts.saved, 0);
  allowed = true;
  assert.equal((await adapter.submit(p)).status, 'needs-review');
  assert.equal((await adapter.drain({ retryRequestId: p.requestId })).counts.saved, 1);
});

test('concurrent calls share a claim and fenced late workers cannot replace the newer receipt', async () => {
  let clock = Date.now(); let resolveFirst; let calls = 0; const latest = ack(); const c = config();
  const first = open(c, { now: () => clock, fetch: async () => { calls++; return new Promise((resolve) => { resolveFirst = resolve; }); } });
  const p = payload(); const pending = first.submit(p);
  assert.equal((await first.submit(p)).status, 'queued'); assert.equal(calls, 1);
  clock += 61_000;
  const second = open(c, { now: () => clock, fetch: async () => response(latest) });
  assert.equal((await second.drain()).counts.saved, 1);
  resolveFirst(response({ error: 'wrong' }, 500));
  assert.equal((await pending).receiptId, latest.receiptId);
});

test('a changed site/destination cannot drain an old journal partition; wrong encryption key fails closed', async () => {
  const c = config(); const first = open(c, { fetch: async () => { throw new Error('offline'); } });
  await first.submit(payload()); first.close();
  let calls = 0;
  const other = open({ ...c, siteId: randomUUID() }, { fetch: async () => { calls++; return response(ack()); } });
  assert.equal((await other.drain()).counts.queued, 0); assert.equal(calls, 0);
  assert.throws(() => createWebsiteAdapter({ ...c, encryptionKey: 'c'.repeat(64) }), { code: 'journal_key_mismatch' });
});

test('retry exhaustion and payload expiry are visible; capacity never pretends to accept a request', async () => {
  let clock = Date.now(); const c = config({ capacity: 1 });
  const adapter = open(c, { now: () => clock, fetch: async () => { throw new Error('offline'); } });
  const p = payload(); await adapter.submit(p);
  await assert.rejects(adapter.submit(payload()), { code: 'journal_capacity_reached' });
  clock += 4 * 86_400_000;
  assert.equal(adapter.inspect().counts['needs-review'], 1);
  clock += 4 * 86_400_000;
  assert.equal(adapter.inspect().counts.expired, 1);
  assert.equal((await adapter.submit(p)).retained, false);
  await assert.rejects(adapter.drain({ retryRequestId: p.requestId }), { code: 'request_not_retryable' });
  const db = new DatabaseSync(c.journalPath); assert.equal(db.prepare('SELECT encrypted FROM website_delivery').get().encrypted, null); db.close();
});

test('native fetch refuses redirects without forwarding the credential to the redirected endpoint', async () => {
  let leaked = false;
  const server = createServer((req, res) => {
    if (req.url === '/redirected') { leaked = true; res.end('{}'); return; }
    res.writeHead(302, { Location: '/redirected' }); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = open(config({ apiOrigin: `http://127.0.0.1:${server.address().port}` }));
    assert.equal((await adapter.submit(payload())).status, 'queued'); assert.equal(leaked, false);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
