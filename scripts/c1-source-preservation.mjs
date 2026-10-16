/** Local proof only. Exact reviewed product overlay; never runtime/release authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const descriptorPath = 'reports/c1-source-preservation-2026-10-16.json';
const descriptorSha256 = '6d64fb78992d82fae67eb6d258cf3fbf1e8ea23b4ca11929d9b95b985679348c';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const sorted = entries => [...entries].sort((a,b) => Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
const scope = entries => ({count:entries.length,sha256:hash(JSON.stringify(sorted(entries)))});
const git = (...args) => execFileSync('git',['-C',root,...args],{windowsHide:true,maxBuffer:16*1024*1024});
const text = (...args) => git(...args).toString('utf8').trim();

export function parseC1Index(input) {
  return Buffer.from(input).toString('utf8').split('\n').filter(Boolean).map(line => {
    const match=/^(\d{6}) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);
    assert.ok(match,'C1 index must have exact resolved stage-zero entries');
    return {path:match[3],mode:match[1],blob:match[2]};
  });
}
function treeEntries(commit, paths) {
  return git('ls-tree','-r',commit,'--',...paths).toString('utf8').split('\n').filter(Boolean).map(line => {
    const match=/^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match,'C1 baseline must contain exact file blobs');
    return {path:match[3],mode:match[1],blob:match[2]};
  });
}
function checkedDescriptor(bytes) {
  assert.equal(hash(bytes),descriptorSha256,'C1 reviewed descriptor changed');
  return json(bytes);
}
export function loadC1SourceSnapshot() {
  const descriptor=git('show',`:${descriptorPath}`),d=checkedDescriptor(descriptor);
  const index=parseC1Index(git('ls-files','--stage'));
  const indexed = new Map(index.map(row=>[row.path,row]));
  const rows = pins => pins.map(pin=>({path:pin.path,...indexed.get(pin.path),bytes:git('show',`:${pin.path}`)}));
  const ancestor=spawnSync('git',['-C',root,'merge-base','--is-ancestor',d.overlay.sourceCommit,'HEAD'],{windowsHide:true});
  assert.ok(ancestor.status===0||ancestor.status===1,'C1 lineage could not be read');
  const protectedPaths=[...new Set([descriptorPath,...d.scopePaths,...d.originalProtected.map(p=>p.path),...d.sql.map(p=>p.path),...d.runtime.map(p=>p.path),...d.approvals.map(p=>p.path),'scripts/c1-source-preservation.mjs','scripts/c1-source-preservation.test.mjs'])];
  return {
    descriptor,
    legacyManifest:git('show',`${d.overlay.sourceCommit}:${d.legacyManifest.path}`),
    currentManifest:git('show',`:${d.legacyManifest.path}`),
    legacyTree:text('rev-parse',`${d.legacy.sourceCommit}^{tree}`),
    overlayTree:text('rev-parse',`${d.overlay.sourceCommit}^{tree}`),
    overlayIsAncestor:ancestor.status===0,
    legacyProduct:treeEntries(d.legacy.sourceCommit,d.scopePaths),
    currentProduct:index.filter(row=>d.scopePaths.some(path=>row.path.startsWith(`${path}/`))),
    historicalProtected:d.originalProtected.map(pin=>({path:pin.path,bytes:git('cat-file','blob',pin.blob)})),
    historicalProduct:d.originalProductBlobs.map(pin=>({path:pin.path,bytes:git('cat-file','blob',pin.blob)})),
    currentProductBytes:rows(d.currentProductBlobs),
    currentProtected:rows(d.originalProtected),sql:rows(d.sql),runtime:rows(d.runtime),approvals:rows(d.approvals),
    workingDiff:git('diff','--name-only','--',d.legacyManifest.path,...protectedPaths).toString(),
    untracked:git('ls-files','--others','--exclude-standard','--',d.legacyManifest.path,...protectedPaths).toString(),
  };
}
function verifyBytes(actual,pin) {
  assert.equal(actual.path,pin.path,'C1 pinned path changed');
  assert.equal(actual.bytes.length,pin.bytes,`${pin.path}: byte count`);
  assert.equal(hash(actual.bytes),pin.sha256,`${pin.path}: canonical bytes changed`);
  if(pin.mode)assert.equal(actual.mode,pin.mode,`${pin.path}: mode changed`);
  if(pin.blob&&actual.blob)assert.equal(actual.blob,pin.blob,`${pin.path}: blob changed`);
}
function verifyRows(actual,pins) {
  assert.equal(actual.length,pins.length,'C1 protected coverage changed');
  pins.forEach((pin,index)=>verifyBytes(actual[index],pin));
}
export function verifyC1SourceSnapshot(snapshot) {
  const d=checkedDescriptor(snapshot.descriptor);
  assert.equal(hash(snapshot.legacyManifest),d.legacyManifest.sha256,'C1 historical manifest changed');
  assert.equal(hash(snapshot.currentManifest),d.legacyManifest.sha256,'C1 current legacy manifest changed');
  const manifest=json(snapshot.legacyManifest);
  assert.deepEqual(manifest.scope,{paths:d.scopePaths,...d.legacy.scope});
  assert.deepEqual(manifest.protected,d.originalProtected,'C1 original protected identities changed');
  assert.equal(snapshot.legacyTree,d.legacy.sourceTree,'C1 legacy tree changed');
  assert.equal(snapshot.overlayTree,d.overlay.sourceTree,'C1 overlay tree changed');
  assert.equal(snapshot.overlayIsAncestor,true,'C1 candidate is outside the reviewed lineage');
  assert.deepEqual(scope(snapshot.legacyProduct),d.legacy.scope,'C1 legacy scope changed');
  assert.equal(new Set(snapshot.currentProduct.map(e=>e.path)).size,snapshot.currentProduct.length,'C1 duplicate path');
  const expected=new Map(snapshot.legacyProduct.map(row=>[row.path,row]));
  for(const change of d.changes){
    const before=expected.get(change.path)??null;
    assert.deepEqual(before,change.before,'C1 original overlay path changed');
    expected.set(change.path,{path:change.path,...change.after});
  }
  assert.deepEqual(sorted(snapshot.currentProduct),sorted([...expected.values()]),'C1 product differs from the exact reviewed overlay');
  assert.deepEqual(scope(snapshot.currentProduct),d.overlay.scope,'C1 current scope changed');
  verifyRows(snapshot.historicalProtected,d.originalProtected);
  verifyRows(snapshot.historicalProduct,d.originalProductBlobs.map(({mode,...pin})=>pin));
  verifyRows(snapshot.currentProductBytes,d.currentProductBlobs);
  verifyRows(snapshot.currentProtected,d.originalProtected.map(pin=>pin.path===d.amendedDrill.path?d.amendedDrill:{...pin,mode:d.originalProtectedModes[pin.path]}));
  verifyRows(snapshot.sql,d.sql);verifyRows(snapshot.runtime,d.runtime);verifyRows(snapshot.approvals,d.approvals);
  assert.equal(snapshot.workingDiff,'','C1 scoped worktree differs from its index');
  assert.equal(snapshot.untracked,'','C1 untracked scoped source is not reviewed');
  return {legacy:d.legacy,overlay:d.overlay,changedProductPaths:d.changes.map(change=>change.path),amendedProof:d.amendedDrill,descriptorSha256,releaseEligible:false};
}
export const assertC1SourcePreserved = () => verifyC1SourceSnapshot(loadC1SourceSnapshot());
