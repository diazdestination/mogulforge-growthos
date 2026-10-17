import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { TARGET, flyAuthorization, verifyAdmission, startProxy, closeClient } from './staging-observation-runner.mjs';

test('Fly API normalization prefers macaroon tokens and does not log secrets', () => {
  const oauth = 'oauth_' + 'a'.repeat(30), mac = 'fm2_' + 'b'.repeat(30);
  assert.equal(flyAuthorization(`access_token: ${oauth},${mac}\n`), `FlyV1 ${mac}`);
  assert.equal(flyAuthorization(`access_token: Bearer ${oauth}\n`), `Bearer ${oauth}`);
  assert.equal(flyAuthorization(`access_token: FlyV1 ${mac}\n`), `FlyV1 ${mac}`);
  for (const config of ['access_token: |\n secret', 'access_token: x\naccess_token: y', 'access_token: "secret"', 'access_token: injected secret']) {
    assert.throws(() => flyAuthorization(config), error => /^fly_(config|token)_shape$/.test(error.message));
  }
});
const bytes = Buffer.from('reviewed bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
function admission() { return { kind: 'REVIEWED_STAGING_OBSERVER', target: TARGET.cluster, sourceBase: '7091af816715cfd437925eb0af82fb47d3411e34', flyBinarySha256: hash, files: Object.fromEntries(['scripts/staging-observation-core.mjs','scripts/staging-observation-runner.mjs','reports/release-preparation-2026-10-09/schema-catalog.mjs', ...['95','141','142'].map(n => `reports/staging-observation-2026-10-10/fixtures/catalog-${n}.json`)].map(path => [path, hash])) }; }
test('reviewed exact source and binary bytes are required before any connection', () => {
  verifyAdmission(admission(), () => bytes);
  assert.throws(() => verifyAdmission(admission(), () => Buffer.from('changed')), /source_drift/);
  const other = admission(); other.target = 'kzpwm0j18eg04nv3';
  assert.throws(() => verifyAdmission(other, () => { throw Error('must not read'); }), /admission_identity/);
  const missing = admission(); delete missing.files['scripts/staging-observation-core.mjs'];
  assert.throws(() => verifyAdmission(missing, () => bytes), /admission_files/);
  const binary = admission(); binary.flyBinarySha256 = '0'.repeat(64);
  assert.throws(() => verifyAdmission(binary, () => bytes), /fly_binary_drift/);
});
test('runner is fixed to staging and only issues GET provider requests', () => {
  const source = readFileSync(new URL('./staging-observation-runner.mjs', import.meta.url), 'utf8');
  assert.equal(TARGET.cluster, 'zp2wjrejd2zodn4q');
  assert.equal(TARGET.reader, 'growthos-restore-reader');
  assert.match(source, /method: 'GET'/);
  assert.doesNotMatch(source, /method: '(POST|PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(source, /dotenv|from ['"].*artifacts\/api-server\/src/);
});
function child() {
  const c = new EventEmitter(); c.pid = 123; c.stdout = c.stderr = { resume() {} };
  c.killed = false; c.kill = () => { c.killed = true; c.emit('close'); };
  return c;
}
test('proxy refuses occupied ports without starting a process', async () => {
  await assert.rejects(startProxy({}, { inspectListener: async () => '999', spawnChild: () => { throw Error('must not spawn'); } }), /proxy_port_occupied/);
});
test('proxy verifies listener ownership and acknowledges child exit plus listener removal', async () => {
  const c = child(), receipt = {}; let reads = 0;
  const proxy = await startProxy(receipt, { inspectListener: async () => ++reads === 1 || c.killed ? 'none' : '123', spawnChild: () => c, pause: async () => {} });
  assert.equal(receipt.proxy.ownedListenerVerified, true);
  await proxy.close();
  assert.equal(receipt.proxy.exitAcknowledged, true); assert.equal(receipt.proxy.listenerGone, true);
});
test('proxy refuses a foreign listener and does not claim cleanup success', async () => {
  const c = child(), receipt = {}; let reads = 0;
  await assert.rejects(startProxy(receipt, { inspectListener: async () => ++reads === 1 ? 'none' : '999', spawnChild: () => c, pause: async () => {} }), /proxy_cleanup_unconfirmed/);
  assert.equal(c.killed, true); assert.equal(receipt.proxy.listenerGone, false);
});
test('proxy startup timeout closes the owned child', async () => {
  const c = child(), receipt = {};
  await assert.rejects(startProxy(receipt, { inspectListener: async () => 'none', spawnChild: () => c, startMs: 0, pause: async () => {} }), /proxy_start_timeout/);
  assert.equal(c.killed, true); assert.equal(receipt.proxy.exitAcknowledged, true);
});
test('client graceful closure and forced closure are distinct outcomes', async () => {
  const receipt = {}, stream = { destroyed: false, destroy() { this.destroyed = true; } };
  await closeClient({ connection: { stream }, end: async () => { stream.destroyed = true; } }, receipt);
  assert.equal(receipt.clientEndAcknowledged, true);
  const failed = {}; stream.destroyed = false;
  await assert.rejects(closeClient({ connection: { stream }, end: async () => { throw Error('secret raw error'); } }, failed, async () => {}), /client_cleanup_unconfirmed/);
  assert.equal(stream.destroyed, true); assert.equal(failed.clientEndAcknowledged, false);
});
