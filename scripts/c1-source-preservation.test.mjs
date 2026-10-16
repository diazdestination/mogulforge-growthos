import { beforeAll, describe, expect, it } from 'vitest';
import { loadC1SourceSnapshot, parseC1Index, verifyC1SourceSnapshot } from './c1-source-preservation.mjs';

let original;
beforeAll(() => { original = loadC1SourceSnapshot(); });
const copy = () => structuredClone(original);
describe('exact C1 source preservation overlay', () => {
  it('keeps original acceptance separate from the exact current product scope', () => {
    const result = verifyC1SourceSnapshot(original);
    expect(result.legacy.sourceCommit).toBe('f56e6cef452b5b564838a72202c0d37cd2caf384');
    expect(result.legacy.scope.count).toBe(2115);
    expect(result.overlay.sourceCommit).toBe('54cffe4c1552ae306781632202da19bb0fe88f4a');
    expect(result.overlay.scope.count).toBe(2117);
    expect(result.overlay.scope.sha256).toBe('4cf023465c1eedfa749c01cb6304ea60ffe1bae4ef9f007139efbfe51d85b237');
    expect(result.changedProductPaths).toHaveLength(7);
    expect(result.releaseEligible).toBe(false);
  });
  it.each(['changed_blob','same_size_blob','extra_path','missing_path','changed_mode','duplicate_path'])('refuses %s in the current complete product index', mutation => {
    const snapshot=copy(),entry=snapshot.currentProduct[0];
    if(mutation==='changed_blob')entry.blob='0'.repeat(40);
    if(mutation==='same_size_blob')entry.blob=(entry.blob[0]==='a'?'b':'a')+entry.blob.slice(1);
    if(mutation==='extra_path')snapshot.currentProduct.push({...entry,path:'lib/unreviewed.ts'});
    if(mutation==='missing_path')snapshot.currentProduct.pop();
    if(mutation==='changed_mode')entry.mode='100755';
    if(mutation==='duplicate_path')snapshot.currentProduct.push({...entry});
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it.each(['legacy_manifest','current_manifest','descriptor','historical_protected','current_protected','old_product','current_product','sql','runtime','approval'])('refuses a same-size altered %s input', kind => {
    const snapshot=copy();
    const bytes=kind==='legacy_manifest'?snapshot.legacyManifest:kind==='current_manifest'?snapshot.currentManifest:kind==='descriptor'?snapshot.descriptor:kind==='historical_protected'?snapshot.historicalProtected[0].bytes:kind==='current_protected'?snapshot.currentProtected[0].bytes:kind==='old_product'?snapshot.historicalProduct[0].bytes:kind==='current_product'?snapshot.currentProductBytes[0].bytes:kind==='sql'?snapshot.sql[0].bytes:kind==='runtime'?snapshot.runtime[0].bytes:snapshot.approvals[0].bytes;
    bytes[0]^=1;
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it.each(['legacyTree','overlayTree'])('refuses changed %s identity', key => {
    const snapshot=copy();snapshot[key]='0'.repeat(40);
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses a different original product index even with the same number of paths', () => {
    const snapshot=copy();snapshot.legacyProduct[0].blob='0'.repeat(40);
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses unstaged scoped edits, including an altered existing proof input', () => {
    const snapshot=copy();snapshot.workingDiff='scripts/contractor-recovery-drill.mjs\n';
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses an untracked product input', () => {
    const snapshot=copy();snapshot.untracked='artifacts/api-server/src/unreviewed.ts\n';
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses a candidate outside the approved overlay lineage', () => {
    const snapshot=copy();snapshot.overlayIsAncestor=false;
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses an unresolved index stage before calculating any scope digest', () => {
    expect(()=>parseC1Index('100644 '+ 'a'.repeat(40)+' 2\tlib/conflict.ts\n')).toThrow();
  });
  it.each(['scripts/saved-scheduling-recovery-fixture.mjs','scripts/contractor-recovery-app-probe.mjs','scripts/release-schema.mjs'])('refuses mode drift of unchanged protected input %s', path => {
    const snapshot=copy();snapshot.currentProtected.find(row=>row.path===path).mode='100755';
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
});
