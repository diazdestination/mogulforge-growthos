import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  // The owner-approved PR73 amendment re-pins the lockfile (one promoted api-server
  // dependency); its historical blob stays verifiable while the index follows the amendment.
  const zapier = JSON.parse(readFileSync(new URL('../reports/c1-zapier-connected-apps-amendment-2026-10-29.json', import.meta.url), 'utf8'));
  for (const pin of manifest.protected) {
    checkBytes(git('cat-file','blob',pin.blob), pin);
    const repin = zapier.protectedChanges.find(change => change.path === pin.path);
    if(pin.path!=='scripts/contractor-recovery-drill.mjs') {
      const current = repin ? { ...pin, ...repin.after } : pin;
      if (repin) assert.equal(repin.before.blob, pin.blob, `${pin.path}: amendment base blob`);
      checkBytes(indexedBytes(pin.path),current);
      assert.equal(git('rev-parse', `:${pin.path}`).toString().trim(),current.blob);
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

test('complete API and library index equals the approved Zapier Connected Apps successor while preserving the revenue proof', () => {
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
  assert.deepEqual(proof.launchGapAmendment.integration.scope,{count:2123,sha256:'f8ea5fb8a91a065097e3649996fe4fdfc0e5063f5a0cda1843626b95c99ec472'});
  assert.deepEqual(proof.inquiryConsentAmendment.integration.scope,{count:2123,sha256:'c0519f20f3cf8e0e26ac1aa6d19701e4c587450fd82d6c4d8b359070703ef497'});
  assert.deepEqual(proof.revenueOpportunitiesAmendment.scope,{count:2124,sha256:'e4dd528c0b4ace7d638df724bf704b74bc33bfc43a3879bd8f9000a88dab35ea'});
  assert.equal(entries.length,2134);
  assert.equal(proof.currentScope.sha256,'0291108bb05805ab9a16f7cbdc9ff9e5b44f9f880d74ad613bc7ad7b880a3997');
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
