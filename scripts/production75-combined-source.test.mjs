import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PINNED_FILES, SOURCE_COMMIT } from './production75-pins.mjs';
import { assertC1SourcePreserved } from './c1-source-preservation.mjs';

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

test('combined source retains all eight original proof objects and validates the separate C1 proof extension', () => {
  assert.equal(manifest.protected.length, 8);
  for (const pin of manifest.protected) {
    checkBytes(git('cat-file','blob',pin.blob), pin);
    if(pin.path!=='scripts/contractor-recovery-drill.mjs') {
      checkBytes(indexedBytes(pin.path),pin);
      assert.equal(git('rev-parse', `:${pin.path}`).toString().trim(),pin.blob);
    }
  }
  // The index hash checks are also meaningful for an unstaged local worktree.
  const paths = manifest.protected.map(pin => pin.path);
  assert.equal(git('diff', '--name-only', '--', ...paths).toString(), '');
  assert.equal(assertC1SourcePreserved().amendedProof.path,'scripts/contractor-recovery-drill.mjs');
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

test('complete API and library index equals the exact reviewed launch-gap successor of C1+B+D', () => {
  const entries = git('ls-files', '--stage', '--', ...manifest.scope.paths).toString().trim().split('\n').map(line => {
    const [meta, path] = line.split('\t');
    const [mode, blob, stage] = meta.split(' ');
    assert.equal(stage, '0', `${path}: no unresolved merge stage`);
    return { path, mode, blob };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const proof=assertC1SourcePreserved();
  assert.equal(manifest.scope.count,2115);
  assert.equal(proof.overlay.scope.count,2117);
  assert.equal(proof.testOnlyAmendment.scope.count,2119);
  assert.equal(proof.smartSiteAmendment.scope.count,2118);
  assert.deepEqual(proof.smartSiteAmendment.integration.scope,{count:2120,sha256:'99a7972dbcb95bf3bc32190bcb0deac1a18c6b59907f8e0184d8e0983fd5b254'});
  assert.equal(entries.length,2123);
  assert.equal(proof.currentScope.sha256,'f8ea5fb8a91a065097e3649996fe4fdfc0e5063f5a0cda1843626b95c99ec472');
  assert.equal(entries.length,proof.currentScope.count);
  assert.equal(sha(JSON.stringify(entries)),proof.currentScope.sha256);
  assert.equal(proof.releaseEligible,false);
  assert.equal(git('diff', '--name-only', '--', ...manifest.scope.paths).toString(), '');
});

test('approved design and plan copies retain the exact approved byte hashes', () => {
  for (const approval of Object.values(manifest.approvals)) {
    assert.equal(sha(indexedBytes(approval.path)), approval.sha256, approval.path);
  }
});
