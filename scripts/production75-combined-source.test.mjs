import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PINNED_FILES, SOURCE_COMMIT } from './production75-pins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../reports/combined-release-preservation-2026-10-15.json', import.meta.url)));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const indexedBytes = path => git('show', `:${path}`);
const checkBytes = (bytes, pin) => {
  assert.equal(bytes.length, pin.bytes, `${pin.path}: byte length`);
  assert.equal(sha(bytes), pin.sha256, `${pin.path}: exact Git bytes`);
};

test('combined source retains all19 original SQL Git bytes and original main lineage', () => {
  assert.equal(SOURCE_COMMIT, manifest.main);
  assert.equal(PINNED_FILES.length, 19);
  assert.deepEqual(PINNED_FILES, manifest.legacySql);
  for (const pin of PINNED_FILES) checkBytes(indexedBytes(pin.path), pin);
});

test('combined source retains the product eight protected Git blobs', () => {
  assert.equal(manifest.protected.length, 8);
  for (const pin of manifest.protected) {
    checkBytes(indexedBytes(pin.path), pin);
    assert.equal(git('rev-parse', `:${pin.path}`).toString().trim(), pin.blob);
  }
  // The index hash checks are also meaningful for an unstaged local worktree.
  const paths = manifest.protected.map(pin => pin.path);
  assert.equal(git('diff', '--name-only', '--', ...paths).toString(), '');
});

test('a same-size altered protected buffer fails the same preservation check', () => {
  const pin = manifest.protected[0];
  const original = indexedBytes(pin.path);
  checkBytes(original, pin);
  const altered = Buffer.from(original);
  altered[0] ^= 1;
  assert.equal(altered.length, original.length);
  assert.throws(() => checkBytes(altered, pin), /exact Git bytes/);
});

test('complete API and library index remains equal to the accepted product scope', () => {
  const entries = git('ls-files', '--stage', '--', ...manifest.scope.paths).toString().trim().split('\n').map(line => {
    const [meta, path] = line.split('\t');
    const [mode, blob, stage] = meta.split(' ');
    assert.equal(stage, '0', `${path}: no unresolved merge stage`);
    return { path, mode, blob };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  assert.equal(entries.length, manifest.scope.count);
  assert.equal(entries.length, 2115);
  assert.equal(sha(JSON.stringify(entries)), manifest.scope.sha256);
  assert.equal(git('diff', '--name-only', '--', ...manifest.scope.paths).toString(), '');
});

test('approved design and plan copies retain the exact approved byte hashes', () => {
  for (const approval of Object.values(manifest.approvals)) {
    assert.equal(sha(indexedBytes(approval.path)), approval.sha256, approval.path);
  }
});
