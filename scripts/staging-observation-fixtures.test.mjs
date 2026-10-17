import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACCEPTED_95_DIGEST, SQL_PATHS, validateSqlManifest, verifySqlBlob, validateFixture,
  assertFixtureContainer, main } from './staging-observation-fixtures.mjs';

function manifest() {
  return { historicalBaseline95CatalogDigest: ACCEPTED_95_DIGEST, sqlFiles: SQL_PATHS.map((path, index) => ({ path,
    gitObjectSha256: 'a'.repeat(64), canonicalLfSha256: 'a'.repeat(64), historicalAcceptedSha256: index === 18 ? null : 'a'.repeat(64), gitObjectBytes: 12 })) };
}

test('manifest requires exactly the canonical 19 files in order and matching accepted hashes', () => {
  assert.equal(validateSqlManifest(manifest()).length, 19);
  for (const mutate of [m => m.sqlFiles.pop(), m => m.sqlFiles.reverse(), m => { m.sqlFiles[0].path = '../outside.sql'; },
    m => { m.sqlFiles[0].gitObjectBytes = 0; }, m => { m.sqlFiles[0].gitObjectSha256 = 'b'.repeat(64); },
    m => { m.historicalBaseline95CatalogDigest = 'b'.repeat(64); }]) {
    const input = manifest(); mutate(input); assert.throws(() => validateSqlManifest(input), /^Error: fixture_manifest/);
  }
});

test('SQL verification rejects changed bytes, newline conversion, truncation and non-UTF8', () => {
  const bytes = Buffer.from('SELECT 1;\n');
  const entry = { gitObjectBytes: bytes.length, gitObjectSha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(verifySqlBlob(entry, bytes), bytes.toString());
  for (const changed of [Buffer.from('SELECT 2;\n'), Buffer.from('SELECT 1;\r\n'), bytes.subarray(0, 4)]) {
    assert.throws(() => verifySqlBlob(entry, changed), /fixture_sql_blob_mismatch/);
  }
  const invalid = Buffer.from([255]);
  assert.throws(() => verifySqlBlob({ gitObjectBytes: 1, gitObjectSha256: createHash('sha256').update(invalid).digest('hex') }, invalid), /fixture_sql_blob_mismatch/);
});

test('95 tables alone cannot establish accepted metadata', () => {
  const fake = { formatVersion: 1, tables: Array.from({ length: 95 }, (_, i) => ({ name: `t${i}` })), columns: [], constraints: [], indexes: [], enums: [], triggers: [], policies: [] };
  assert.throws(() => validateFixture(fake, 95), /fixture_95_catalog_mismatch/);
  assert.throws(() => validateFixture(fake, 141), /fixture_table_count_mismatch/);
});

test('cleanup identity requires exact owned name, full id and both labels', () => {
  const identity = { runId: 'test-run', name: 'owned-name', id: 'a'.repeat(64) };
  const inspection = { Id: identity.id, Name: '/owned-name', Config: { Labels: {
    'com.forge.local-test': 'test-run', 'com.forge.fixture-purpose': 'staging-observation-20261010' } } };
  assert.doesNotThrow(() => assertFixtureContainer(inspection, identity));
  for (const mutate of [x => { x.Id = 'b'.repeat(64); }, x => { x.Name = '/other'; },
    x => { delete x.Config.Labels['com.forge.local-test']; }, x => { delete x.Config.Labels['com.forge.fixture-purpose']; }]) {
    const changed = structuredClone(inspection); mutate(changed);
    assert.throws(() => assertFixtureContainer(changed, identity), /fixture_container_ownership_mismatch/);
  }
});

test('runner rejects implicit or arbitrary target arguments without starting work', async () => {
  await assert.rejects(main([]), /fixture_explicit_local_action_required/);
  await assert.rejects(main(['--database-url', 'postgres://forbidden']), /fixture_explicit_local_action_required/);
});
