import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateApproval, assertOwnedCopy, deletionComplete, providerRequest, refreshingProviderRequest, deleteOwnedCopy, closeOwnedTransport,
  productionInventoryIdentity, machineIdentity } from './staging-copy-rehearsal.mjs';

const SOURCE = 'zp2wjrejd2zodn4q';
const PRODUCTION = 'kzpwm0j18eg04nv3';
const COPY = 'aa11bb22cc33dd44';
const EXISTING = 'ee55ff66gg77hh88';
const NOW = Date.parse('2026-10-10T17:30:00Z');
const sha = value => createHash('sha256').update(value).digest('hex');
const paths = ['scripts/staging-copy-rehearsal.mjs', 'scripts/staging-migration-core.mjs', 'scripts/staging-admin-preflight.mjs',
  'scripts/staging-observation-runner.mjs', 'scripts/staging-observation-core.mjs', 'scripts/staging-observation-fixtures.mjs',
  'scripts/local-dev.mjs', 'reports/release-preparation-2026-10-09/schema-catalog.mjs',
  'reports/staging-observation-2026-10-10/fixtures/catalog-95.json', 'reports/staging-observation-2026-10-10/fixtures/catalog-142.json'];
const hashes = Object.fromEntries(paths.map(path => [path, sha(path)]));
function packet() {
  const nonce = '12ab34cd-56ef-4789-abcd-0123456789ab';
  return { kind: 'ONE_MANAGED_COPY_95_TO_142_REHEARSAL', nonce, name: `growthos-upgrade-${nonce.slice(0, 8)}`,
    source: SOURCE, excludedProduction: PRODUCTION, account: 'diazdestination@gmail.com', organization: 'adam-diaz',
    region: 'iad', plan: 'basic', maxCopies: 1, preparedAt: '2026-10-10T17:00:00Z', expiresAt: '2026-10-10T21:00:00Z',
    backupId: '20261010-000144F_20261010-165930I', backupFinishedAt: '2026-10-10T16:59:30Z',
    sourceIdentity: { id: SOURCE, name: 'mogulforge-growthos-staging-db', plan: 'basic', region: 'iad', organization: 'adam-diaz', version: '16', status: 'ready' },
    productionIdentity: { id: PRODUCTION, name: 'mogulforge-growthos-db', plan: 'basic', region: 'iad', organization: 'adam-diaz', version: '16', status: 'ready' },
    machineIdentity: { id: '8d96936a03d058', state: 'stopped', instance: '01M4CAG4E3M3JDYNGMGS2C9YVJ', configSha256: 'a'.repeat(64) },
    sourceHashes: structuredClone(hashes), flyBinarySha256: 'b'.repeat(64), adminPolicySha256: 'c'.repeat(64), workMinutes: 90, cleanupReserveMinutes: 30,
    estimatedUsdForTwoHours: 0.15, finalMeteredChargeUnverified: true, sourceWritesAuthorized: false };
}
const approved = plan => ({ ownerApproved: true, planSha256: sha(JSON.stringify(plan)), maxCopies: 1,
  maximumDurationMinutes: 120, sourceWritesAuthorized: false });
function ownedFixture() {
  const plan = packet();
  return { plan, owned: { name: plan.name, backupId: plan.backupId, startedAt: '2026-10-10T17:30:00.719Z',
    beforeIds: [SOURCE, PRODUCTION, EXISTING], copyId: COPY },
    copy: { id: COPY, name: plan.name, organization: { slug: 'adam-diaz' }, plan: 'basic', region: 'iad',
      pg_major_version: '16', created_at: '2026-10-10T17:30:00Z', attached_apps: [], status: 'ready' } };
}

test('valid exact-source one-copy owner packet is accepted without any provider access', () => {
  const plan = packet();
  assert.doesNotThrow(() => validateApproval(plan, approved(plan), hashes, NOW));
});

test('false or absent owner approval, altered consent terms, or stale packet hash are refused', () => {
  const plan = packet();
  for (const change of [{ ownerApproved: false }, { maxCopies: 2 }, { maximumDurationMinutes: 121 },
    { sourceWritesAuthorized: true }, { planSha256: 'c'.repeat(64) }]) {
    assert.throws(() => validateApproval(plan, { ...approved(plan), ...change }, hashes, NOW), /copy_owner_approval_required/);
  }
  assert.throws(() => validateApproval(plan, undefined, hashes, NOW), /copy_owner_approval_required/);
});

test('expired, future-prepared and invalid-time packets are refused even when their approval hash matches', () => {
  for (const change of [{ expiresAt: '2026-10-10T17:30:00Z' }, { preparedAt: '2026-10-10T17:30:01Z' },
    { expiresAt: 'invalid' }, { preparedAt: 'invalid' }]) {
    const plan = { ...packet(), ...change };
    assert.throws(() => validateApproval(plan, approved(plan), hashes, NOW), /copy_plan_expired/);
  }
  const plan = packet(); assert.throws(() => validateApproval(plan, approved(plan), hashes, NaN), /copy_plan_expired/);
});

test('changed or missing current source hashes cannot use an otherwise matching owner packet', () => {
  const plan = packet(); const changed = { ...hashes, [paths[1]]: 'd'.repeat(64) };
  assert.throws(() => validateApproval(plan, approved(plan), changed, NOW), /copy_source_drift/);
  const missing = { ...hashes }; delete missing[paths[0]];
  assert.throws(() => validateApproval(plan, approved(plan), missing, NOW), /copy_source_drift/);
});

test('protected source and production identities, single-copy count and unique name are fixed', () => {
  for (const change of [{ source: PRODUCTION }, { excludedProduction: SOURCE }, { kind: 'OTHER' },
    { maxCopies: 2 }, { name: 'different-copy-name' }, { nonce: '../unsafe' }]) {
    const plan = { ...packet(), ...change };
    assert.throws(() => validateApproval(plan, approved(plan), hashes, NOW), /^Error: copy_plan_/);
  }
});

test('plan account, organization, location, size, source-write policy and lifetime cannot be mutated', () => {
  // Rehashing the approval deliberately isolates fixed-plan validation from the
  // packet-integrity check; a newly hashed unsafe target is still unauthorized.
  for (const change of [{ account: 'other@example.invalid' }, { organization: 'other-org' }, { region: 'lhr' },
    { plan: 'large' }, { sourceWritesAuthorized: true }, { workMinutes: 91 }, { cleanupReserveMinutes: 31 }]) {
    const plan = { ...packet(), ...change };
    assert.throws(() => validateApproval(plan, approved(plan), hashes, NOW), /^Error: copy_plan_/);
  }
});

test('owned copy accepts a timestamp rounded to seconds within its recorded creation window', () => {
  const { copy, owned, plan } = ownedFixture();
  assert.doesNotThrow(() => assertOwnedCopy(copy, owned, plan));
});

test('source, production and every previously existing ID are refused even if ownership names them', () => {
  const f = ownedFixture();
  for (const id of [SOURCE, PRODUCTION, EXISTING]) {
    assert.throws(() => assertOwnedCopy({ ...f.copy, id }, { ...f.owned, copyId: id }, f.plan), /copy_protected_identity/);
  }
  assert.throws(() => assertOwnedCopy({ ...f.copy, id: 'another123456789' }, f.owned, f.plan), /copy_protected_identity/);
});

test('attached copies and changed name, organization, plan, region or PostgreSQL major are refused', () => {
  const f = ownedFixture();
  for (const change of [{ name: 'other-copy' }, { organization: { slug: 'other-org' } }, { plan: 'large' },
    { region: 'lhr' }, { pg_major_version: '17' }]) {
    assert.throws(() => assertOwnedCopy({ ...f.copy, ...change }, f.owned, f.plan), /copy_identity/);
  }
  for (const attached_apps of [['app'], undefined, null]) {
    assert.throws(() => assertOwnedCopy({ ...f.copy, attached_apps }, f.owned, f.plan), /copy_attached/);
  }
});

test('non-finite creation times and timestamps outside the narrow create window fail closed', () => {
  const f = ownedFixture();
  for (const created_at of ['invalid', null, '2026-10-10T17:29:49Z', '2026-10-10T17:31:32Z']) {
    assert.throws(() => assertOwnedCopy({ ...f.copy, created_at }, f.owned, f.plan), /copy_creation_window/);
  }
  assert.throws(() => assertOwnedCopy(f.copy, { ...f.owned, startedAt: 'invalid' }, f.plan), /copy_creation_window/);
});

test('HTTP200 terminal deleted plus active-list absence proves deletion; either fact alone does not', () => {
  const body = { data: { id: COPY, status: 'deleted' } };
  assert.equal(deletionComplete(200, body, [SOURCE, PRODUCTION], COPY), true);
  assert.equal(deletionComplete(200, body, [SOURCE, PRODUCTION, COPY], COPY), false);
  assert.equal(deletionComplete(200, { data: { id: COPY, status: 'deleting' } }, [SOURCE, PRODUCTION], COPY), false);
  assert.equal(deletionComplete(200, { data: { id: EXISTING, status: 'deleted' } }, [SOURCE, PRODUCTION], COPY), false);
  assert.equal(deletionComplete(200, {}, [SOURCE, PRODUCTION], COPY), false);
});

test('404 requires active-list absence and410 or other responses are never deletion proof', () => {
  assert.equal(deletionComplete(404, null, [SOURCE, PRODUCTION], COPY), true);
  assert.equal(deletionComplete(404, null, [SOURCE, PRODUCTION, COPY], COPY), false);
  for (const status of [202, 204, 403, 410, 500]) {
    assert.equal(deletionComplete(status, { data: { id: COPY, status: 'deleted' } }, [SOURCE, PRODUCTION], COPY), false);
  }
});

test('provider request sends the exact approved restore payload and never follows redirects', async () => {
  const plan = packet(); const body = { backup_id: plan.backupId, name: plan.name }; const calls = [];
  const result = await providerRequest(`postgres/${SOURCE}/restore`, 'POST', body, {
    authorization: 'FlyV1 synthetic-test-authorization', deadline: Date.now() + 10000,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ data: ownedFixture().copy }), { status: 201 }); },
  });
  assert.equal(result.status, 201); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.machines.dev/v1/postgres/${SOURCE}/restore`);
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.body, JSON.stringify(body));
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers.Authorization, 'FlyV1 synthetic-test-authorization');
  assert.equal(calls[0].options.redirect, 'error'); assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('provider deadline blocks dispatch and malformed or oversized responses cannot be used', async () => {
  let calls = 0;
  await assert.rejects(providerRequest(`postgres/${COPY}`, 'GET', undefined, { authorization: 'synthetic', deadline: Date.now() - 1,
    fetchImpl: async () => { calls++; return new Response('{}'); } }), /copy_phase_deadline/);
  assert.equal(calls, 0);
  await assert.rejects(providerRequest(`postgres/${COPY}`, 'GET', undefined, { authorization: 'synthetic',
    fetchImpl: async () => new Response('invalid-json') }), /copy_response_invalid/);
  await assert.rejects(providerRequest(`postgres/${COPY}`, 'GET', undefined, { authorization: 'synthetic',
    fetchImpl: async () => new Response('x'.repeat(4000001)) }), /copy_response_bound/);
});

test('each provider request receives freshly refreshed authorization and the current deadline', async () => {
  const calls = []; let refreshes = 0; let deadline = Date.now() + 60000;
  const request = refreshingProviderRequest({
    refreshAuthorization: async () => `synthetic-authorization-${++refreshes}`,
    getDeadline: () => deadline,
    request: async (path, method, body, options) => { calls.push({ path, method, body, ...options }); return { status: 200 }; },
  });
  const firstDeadline = deadline;
  await request(`postgres/${COPY}`);
  deadline += 30000;
  const body = { backup_id: packet().backupId, name: packet().name };
  await request(`postgres/${SOURCE}/restore`, 'POST', body);
  assert.equal(refreshes, 2);
  assert.deepEqual(calls, [
    { path: `postgres/${COPY}`, method: 'GET', body: undefined, authorization: 'synthetic-authorization-1', deadline: firstDeadline },
    { path: `postgres/${SOURCE}/restore`, method: 'POST', body, authorization: 'synthetic-authorization-2', deadline },
  ]);
});

test('authorization refresh failure prevents every provider dispatch without retrying refresh', async () => {
  let refreshes = 0; let dispatches = 0;
  const failure = new Error('synthetic account verification failure');
  const request = refreshingProviderRequest({
    refreshAuthorization: async () => { refreshes++; throw failure; },
    request: async () => { dispatches++; return { status: 202 }; },
  });
  await assert.rejects(request(`postgres/${COPY}`, 'DELETE'), error => error === failure);
  assert.equal(refreshes, 1); assert.equal(dispatches, 0);
});

test('a provider mutation error is returned unchanged with no automatic authorization or mutation retry', async () => {
  let refreshes = 0; const calls = [];
  const failure = new Error('synthetic unknown mutation outcome');
  const request = refreshingProviderRequest({
    refreshAuthorization: async () => `synthetic-authorization-${++refreshes}`,
    request: async (path, method, body, options) => { calls.push({ path, method, body, ...options }); throw failure; },
  });
  await assert.rejects(request(`postgres/${COPY}`, 'DELETE'), error => error === failure);
  assert.equal(refreshes, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].authorization, 'synthetic-authorization-1');
});

function lifecycle({ loseDeleteAck = false, protectedChanged = false, persistFailure, initialStatus = 200,
  initialCopyPatch = {}, terminalStatus = 200, activeCopy = false } = {}) {
  const f = ownedFixture(); const calls = []; const events = []; let dispatched = false; let time = NOW;
  return { calls, events, options: { owned: f.owned, plan: f.plan, now: () => time, deadline: NOW + 30000,
    pause: async ms => { time += ms; },
    persist: async (phase, value) => { if (phase === persistFailure) throw new Error('synthetic journal failure'); events.push({ phase, value }); },
    verifyProtected: async () => { if (protectedChanged) throw new Error('synthetic protected-state drift'); },
    listActive: async () => [{ id: SOURCE }, { id: PRODUCTION }, ...(activeCopy ? [{ id: COPY }] : [])],
    request: async (path, method) => {
      calls.push({ path, method }); assert.equal(path, `postgres/${COPY}`);
      if (method === 'DELETE') {
        assert.ok(events.some(event => event.phase === 'delete-intent'));
        assert.equal(dispatched, false, 'a second DELETE must never be dispatched'); dispatched = true;
        if (loseDeleteAck) throw new Error('synthetic lost network response');
        return { status: 202 };
      }
      assert.equal(method, 'GET');
      return dispatched ? { status: terminalStatus, body: { data: { ...f.copy, status: 'deleted' } } }
        : { status: initialStatus, body: { data: { ...f.copy, ...initialCopyPatch } } };
    },
  } };
}

test('lost DELETE acknowledgment still reconciles terminal deleted and absence without repeating DELETE', async () => {
  const f = lifecycle({ loseDeleteAck: true });
  const result = await deleteOwnedCopy(f.options);
  assert.equal(result.deleted, true); assert.equal(result.httpStatus, 200); assert.equal(result.terminalStatus, 'deleted');
  assert.equal(result.protectedStateChanged, false); assert.equal(result.activeOriginalsPresent, true);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(f.calls.filter(call => call.method === 'GET').length >= 2);
  assert.equal(f.events.find(event => event.phase === 'delete-response').value.status, null);
});

test('protected-source drift remains a failure finding while exact owned detached copy is cleaned up', async () => {
  const f = lifecycle({ protectedChanged: true });
  const result = await deleteOwnedCopy(f.options);
  assert.equal(result.deleted, true); assert.equal(result.protectedStateChanged, true);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(f.calls.every(call => call.path === `postgres/${COPY}`));
});

test('lost DELETE acknowledgment uses refreshed GET and active inventory reconciliation without another mutation', async () => {
  const f = lifecycle({ loseDeleteAck: true });
  const originalRequest = f.options.request; const originalList = f.options.listActive;
  const sequence = []; let refreshes = 0; const deadline = Date.now() + 60000;
  f.options.request = refreshingProviderRequest({
    refreshAuthorization: async () => `synthetic-authorization-${++refreshes}`,
    getDeadline: () => deadline,
    request: async (path, method, body, options) => {
      sequence.push({ method, authorization: options.authorization });
      assert.equal(options.deadline, deadline);
      return originalRequest(path, method, body);
    },
  });
  f.options.listActive = async () => { sequence.push({ method: 'LIST' }); return originalList(); };
  const result = await deleteOwnedCopy(f.options);
  assert.equal(result.deleted, true); assert.equal(result.protectedStateChanged, false);
  assert.equal(result.terminalStatus, 'deleted'); assert.equal(result.activeOriginalsPresent, true);
  assert.equal(refreshes, 3);
  assert.deepEqual(sequence, [
    { method: 'GET', authorization: 'synthetic-authorization-1' },
    { method: 'DELETE', authorization: 'synthetic-authorization-2' },
    { method: 'GET', authorization: 'synthetic-authorization-3' },
    { method: 'LIST' },
  ]);
  assert.equal(f.events.find(event => event.phase === 'delete-response').value.status, null);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('missing or changed initial ownership metadata refuses DELETE, including protected IDs and attachments', async () => {
  for (const options of [{ initialStatus: 404 }, { initialCopyPatch: { id: SOURCE } },
    { initialCopyPatch: { attached_apps: ['other-app'] } }, { initialCopyPatch: { organization: { slug: 'other' } } }]) {
    const f = lifecycle(options);
    await assert.rejects(deleteOwnedCopy(f.options), /^Error: copy_/);
    assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
  }
});

test('failed durable DELETE intent prevents mutation; post-dispatch journal failure retains cleanup proof and failure flag', async () => {
  const failedIntent = lifecycle({ persistFailure: 'delete-intent' });
  await assert.rejects(deleteOwnedCopy(failedIntent.options), /synthetic journal failure/);
  assert.equal(failedIntent.calls.some(call => call.method === 'DELETE'), false);
  const failedResponse = lifecycle({ persistFailure: 'delete-response' });
  const result = await deleteOwnedCopy(failedResponse.options);
  assert.equal(result.deleted, true); assert.equal(result.journalFailed, true);
  assert.equal(failedResponse.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('410 or contradictory active inventory cannot complete cleanup and only bounded reads follow DELETE', async () => {
  for (const options of [{ terminalStatus: 410 }, { activeCopy: true }]) {
    const f = lifecycle(options);
    await assert.rejects(deleteOwnedCopy(f.options), /copy_cleanup_unconfirmed/);
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'GET').length, 3);
  }
  const absent = lifecycle({ terminalStatus: 404 });
  assert.equal((await deleteOwnedCopy(absent.options)).deleted, true);
});

test('client-close failure still attempts owned proxy closure and cannot report transport success', async () => {
  const receipt = {}; let clientCloses = 0; let proxyCloses = 0;
  await assert.rejects(closeOwnedTransport({}, { close: async () => { proxyCloses++; } }, receipt,
    async () => { clientCloses++; throw new Error('synthetic close failure'); }), /copy_transport_cleanup/);
  assert.equal(clientCloses, 1); assert.equal(proxyCloses, 1); assert.equal(receipt.clientCleanupFailed, true);
  const bothReceipt = {};
  await assert.rejects(closeOwnedTransport({}, { close: async () => { throw new Error('synthetic proxy failure'); } }, bothReceipt,
    async () => { throw new Error('synthetic close failure'); }), /copy_transport_cleanup/);
  assert.equal(bothReceipt.clientCleanupFailed, true); assert.equal(bothReceipt.proxyCleanupFailed, true);
});

function productionRow() {
  return { id: PRODUCTION, name: 'mogulforge-growthos-db', region: 'iad', status: 'ready', plan: 'basic', version: 1,
    organization: { Slug: 'adam-diaz', Name: 'Adam Diaz' }, attached_apps: [
      { id: 2, name: 'Zulu' }, { id: 1, name: 'Zulu' }, { id: 1, name: 'Alpha' },
    ], unrequestedProviderDetails: 'synthetic-ignored-value' };
}

test('production inventory yields a stable allowlisted snapshot with attachments ordered by id then name', () => {
  const row = productionRow();
  const actual = productionInventoryIdentity([{ id: SOURCE, name: 'staging' }, row]);
  assert.deepEqual(Object.keys(actual).sort(), ['id', 'name', 'region', 'status', 'plan', 'providerVersion', 'organization', 'attachedApps'].sort());
  assert.equal(actual.id, PRODUCTION); assert.equal(actual.name, 'mogulforge-growthos-db');
  assert.equal(actual.region, 'iad'); assert.equal(actual.status, 'ready'); assert.equal(actual.plan, 'basic');
  assert.equal(String(actual.providerVersion), '1'); assert.equal(actual.organization, 'adam-diaz');
  assert.deepEqual(actual.attachedApps, [{ id: 1, name: 'Alpha' }, { id: 1, name: 'Zulu' }, { id: 2, name: 'Zulu' }]);
  assert.deepEqual(productionInventoryIdentity([{ ...row, attached_apps: [...row.attached_apps].reverse() }]), actual);
  assert.equal(JSON.stringify(actual).includes('synthetic-ignored-value'), false);
});

test('production inventory refuses missing, malformed or duplicate fixed production identities', () => {
  for (const inventory of [null, {}, [], [{ id: SOURCE }], [productionRow(), productionRow()]]) {
    assert.throws(() => productionInventoryIdentity(inventory), /^Error: copy_/);
  }
});

test('production inventory refuses wrong organization, location, plan, provider version or attachment shape', () => {
  for (const change of [{ name: 'other-production' }, { organization: { Slug: 'another-account' } }, { organization: {} },
    { region: 'lhr' }, { plan: 'large' }, { status: 'creating' }, { version: 2 }, { attached_apps: null },
    { attached_apps: [{ id: 123 }] }, { attached_apps: [{ id: 'string-id', name: 'bad-id' }] },
    { attached_apps: [{ id: 1.5, name: 'noninteger-id' }] }]) {
    assert.throws(() => productionInventoryIdentity([{ ...productionRow(), ...change }]), /^Error: copy_/);
  }
});

test('machine identity canonicalizes object keys recursively while retaining region and instance', () => {
  const base = { id: '8d96936a03d058', state: 'stopped', region: 'iad', instance_id: 'original-instance',
    config: { env: { HOLD: 'true', MODE: 'staging' }, services: [{ protocol: 'tcp', ports: [80, 443] }], metadata: { b: 2, a: 1 } } };
  const reordered = { ...base, config: { metadata: { a: 1, b: 2 }, services: [{ ports: [80, 443], protocol: 'tcp' }],
    env: { MODE: 'staging', HOLD: 'true' } } };
  const actual = machineIdentity(base);
  assert.deepEqual(machineIdentity(reordered), actual);
  assert.equal(actual.region, 'iad'); assert.equal(actual.instance, 'original-instance');
  assert.match(actual.configSha256, /^[a-f0-9]{64}$/);
});

test('machine nested values, array order, instance or region changes alter its protected snapshot', () => {
  const base = { id: '8d96936a03d058', state: 'stopped', region: 'iad', instance_id: 'original-instance',
    config: { env: { HOLD: 'true' }, services: [{ protocol: 'tcp', ports: [80, 443] }] } };
  const original = machineIdentity(base);
  const nestedChange = structuredClone(base); nestedChange.config.env.HOLD = 'false';
  const arrayChange = structuredClone(base); arrayChange.config.services[0].ports.reverse();
  assert.notEqual(machineIdentity(nestedChange).configSha256, original.configSha256);
  assert.notEqual(machineIdentity(arrayChange).configSha256, original.configSha256);
  assert.notDeepEqual(machineIdentity({ ...base, instance_id: 'new-instance' }), original);
  assert.notDeepEqual(machineIdentity({ ...base, region: 'lhr' }), original);
});
