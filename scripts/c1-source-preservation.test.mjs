import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as sourceProof from './c1-source-preservation.mjs';
import { applyC1TestOnlyAmendment, loadC1SourceSnapshot, parseC1Index, verifyC1SourceSnapshot } from './c1-source-preservation.mjs';

let original;
// Native Windows Git process startup can exceed Vitest's 10-second hook default.
beforeAll(() => { original = loadC1SourceSnapshot(); }, 30000);
const copy = () => structuredClone(original);
// Mirrors the independent ignored-source probe, using an exclusive temporary file.
function withIgnoredAuxiliaryFile(extension, run) {
  const directory=fileURLToPath(new URL('./smart-sites/tmp/',import.meta.url));
  const relative=`scripts/smart-sites/tmp/c1-unreviewed-${process.pid}.${extension}`;
  const path=fileURLToPath(new URL(`../${relative}`,import.meta.url));
  const createdDirectory=!existsSync(directory);
  mkdirSync(directory,{recursive:true});
  writeFileSync(path,'// synthetic ignored auxiliary input\n',{flag:'wx'});
  try {
    const root=fileURLToPath(new URL('../',import.meta.url));
    expect(execFileSync('git',['-C',root,'check-ignore','--',relative],{windowsHide:true}).toString().trim()).toBe(relative);
    run(relative);
  } finally {
    unlinkSync(path);
    if(createdDirectory)rmdirSync(directory);
  }
}
describe('exact C1 source preservation overlay', () => {
  it('keeps original acceptance separate from the exact current product scope', () => {
    const result = verifyC1SourceSnapshot(original);
    expect(result.legacy.sourceCommit).toBe('f56e6cef452b5b564838a72202c0d37cd2caf384');
    expect(result.legacy.scope.count).toBe(2115);
    expect(result.overlay.sourceCommit).toBe('54cffe4c1552ae306781632202da19bb0fe88f4a');
    expect(result.overlay.scope.count).toBe(2117);
    expect(result.overlay.scope.sha256).toBe('4cf023465c1eedfa749c01cb6304ea60ffe1bae4ef9f007139efbfe51d85b237');
    expect(result.changedProductPaths).toHaveLength(7);
    expect(result.testOnlyAmendment.sourceCommit).toBe('2f79a3180dc08d14a187674b806d98607349c4d1');
    expect(result.testOnlyAmendment.scope.count).toBe(2119);
    expect(result.smartSiteAmendment.sourceCommit).toBe('b7f34c70638f9f664a23817021324d26b7ed8ca6');
    expect(result.smartSiteAmendment.scope).toEqual({count:2118,sha256:'a017cf3a0996f8bd127ac9d804e6eb328d96032e49ff6fd955f77246e94ef480'});
    expect(result.smartSiteAmendment.changedPaths).toEqual([
      'artifacts/api-server/src/routes/v1/smart-site-acquisition.test.ts',
      'artifacts/api-server/src/routes/v1/smart-site-hookup-scripts.test.ts',
      'artifacts/api-server/src/services/smart-sites.ts',
    ]);
    expect(result.smartSiteAmendment.reviewedB.sourceCommit).toBe('308952e2abd0c97d4edc4274538af12a7134677a');
    expect(result.smartSiteAmendment.integration.sourceCommit).toBe('08c97d7b76ce8e4668c04dc1fcbde9089a709bbe');
    expect(result.smartSiteAmendment.auxiliaryScope.count).toBe(3);
    expect(result.currentScope).toEqual({count:2120,sha256:'99a7972dbcb95bf3bc32190bcb0deac1a18c6b59907f8e0184d8e0983fd5b254'});
    expect(result.testOnlyAmendment.changedPaths).toHaveLength(7);
    expect(result.testOnlyAmendment.changedPaths.every(path=>/^artifacts\/api-server\/src\/.*(?:\.test\.ts|test-helpers\/[^/]+\.ts)$/.test(path))).toBe(true);
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
  it.each(['legacy_manifest','current_manifest','descriptor','historical_protected','current_protected','old_product','current_product','sql','runtime','approval','amendment','amendment_original','amendment_current'])('refuses a same-size altered %s input', kind => {
    const snapshot=copy();
    const bytes=kind==='legacy_manifest'?snapshot.legacyManifest:kind==='current_manifest'?snapshot.currentManifest:kind==='descriptor'?snapshot.descriptor:kind==='historical_protected'?snapshot.historicalProtected[0].bytes:kind==='current_protected'?snapshot.currentProtected[0].bytes:kind==='old_product'?snapshot.historicalProduct[0].bytes:kind==='current_product'?snapshot.currentProductBytes[0].bytes:kind==='sql'?snapshot.sql[0].bytes:kind==='runtime'?snapshot.runtime[0].bytes:kind==='amendment'?snapshot.amendment:kind==='amendment_original'?snapshot.amendmentOriginal[0].bytes:kind==='amendment_current'?snapshot.amendmentCurrent[0].bytes:snapshot.approvals[0].bytes;
    bytes[0]^=1;
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it.each(['legacyTree','overlayTree','amendmentTree'])('refuses changed %s identity', key => {
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
  it('refuses a candidate outside the reviewed test-only amendment lineage', () => {
    const snapshot=copy();snapshot.amendmentIsAncestor=false;
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses a historical C1 overlay product that drifted from the reviewed overlay', () => {
    const snapshot=copy();snapshot.overlayProduct[0].blob='0'.repeat(40);
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it('refuses an amendment commit product that differs from the reviewed amendment', () => {
    const snapshot=copy();snapshot.amendmentProduct.pop();
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow();
  });
  it.each([
    ['production source', 'artifacts/api-server/src/services/staff-push-policy.ts'],
    ['library source', 'lib/db/src/schema/index.ts'],
    ['build input', 'artifacts/api-server/package.json'],
    ['traversal outside test helpers', 'artifacts/api-server/src/test-helpers/../services/staff-push.ts'],
    ['a test-named path that traverses out of the API source', 'artifacts/api-server/src/../../../lib/db/src/x.test.ts'],
  ])('the amendment rule refuses %s', (_label, path) => {
    const base=new Map([[path,{path,mode:'100644',blob:'1'.repeat(40)}]]);
    expect(()=>applyC1TestOnlyAmendment(base,[{path,before:{path,mode:'100644',blob:'1'.repeat(40)},after:{mode:'100644',blob:'2'.repeat(40)}}])).toThrow(/only test source/);
  });
  it('the amendment rule refuses a stale base, a duplicate path and accepts an exact test-only change', () => {
    const path='artifacts/api-server/src/services/example.test.ts',row={path,mode:'100644',blob:'1'.repeat(40)};
    const change={path,before:row,after:{mode:'100644',blob:'2'.repeat(40)}};
    expect(()=>applyC1TestOnlyAmendment(new Map(),[change])).toThrow(/base path changed/);
    expect(()=>applyC1TestOnlyAmendment(new Map([[path,row]]),[change,change])).toThrow(/duplicate path/);
    expect(applyC1TestOnlyAmendment(new Map([[path,row]]),[change]).get(path)).toEqual({path,mode:'100644',blob:'2'.repeat(40)});
  });
  it.each(['smartSiteAmendment','smartSiteOriginal','smartSiteCurrent','smartSiteAuxiliary'])('refuses same-size altered %s bytes', key => {
    const snapshot=copy(),bytes=key==='smartSiteAmendment'?snapshot[key]:snapshot[key][0].bytes;
    bytes[0]^=1;
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/changed/);
  });
  it.each(['reviewedBCommit','reviewedBTree','smartSiteCommit','smartSiteTree','integrationCommit','integrationTree'])('refuses changed %s identity', key => {
    const snapshot=copy();snapshot[key]='0'.repeat(40);
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/changed/);
  });
  it.each(['reviewedBIsAncestor','smartSiteIsAncestor','integrationIsAncestor'])('refuses lost %s ancestry', key => {
    const snapshot=copy();snapshot[key]=false;
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/lineage/);
  });
  it.each(['reviewedBProduct','smartSiteProduct','integrationProduct'])('refuses historical %s map drift', key => {
    const snapshot=copy();snapshot[key][0].blob='0'.repeat(40);
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/differs/);
  });
  it.each(['smartSiteAuxiliaryProduct','integrationAuxiliaryProduct','currentAuxiliaryProduct'])('refuses extra, missing, duplicate, changed blob or changed mode in %s', key => {
    for(const mutation of ['extra','missing','duplicate','blob','mode']){
      const snapshot=copy(),rows=snapshot[key];
      if(mutation==='extra')rows.push({...rows[0],path:'scripts/smart-sites/fourth.mjs'});
      if(mutation==='missing')rows.pop();
      if(mutation==='duplicate')rows.push({...rows[0]});
      if(mutation==='blob')rows[0].blob='0'.repeat(40);
      if(mutation==='mode')rows[0].mode='100755';
      expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/auxiliary/);
    }
  });
  it.each(['smartSiteCurrent','smartSiteAuxiliary'])('refuses missing pinned blobs and mode or blob drift in %s', key => {
    for(const mutation of ['missing','mode','blob']){
      const snapshot=copy(),rows=snapshot[key];
      if(mutation==='missing')rows.pop();
      if(mutation==='mode')rows[0].mode='100755';
      if(mutation==='blob')rows[0].blob='0'.repeat(40);
      expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/coverage|changed/);
    }
  });
  it('the Smart Site rule accepts only the exact three reviewed paths and refuses stale, missing, duplicate and extra changes', () => {
    const changes=[
      {path:'artifacts/api-server/src/routes/v1/smart-site-acquisition.test.ts',before:{path:'artifacts/api-server/src/routes/v1/smart-site-acquisition.test.ts',mode:'100644',blob:'ec57504b78ac688ed61b429a700d3ff138ae050e'},after:{mode:'100644',blob:'e27514d9e1ff826a79700ff488b6fe460a447b84'}},
      {path:'artifacts/api-server/src/routes/v1/smart-site-hookup-scripts.test.ts',before:null,after:{mode:'100644',blob:'ccddb11dc94020b68aa716391a20468cbcc22df6'}},
      {path:'artifacts/api-server/src/services/smart-sites.ts',before:{path:'artifacts/api-server/src/services/smart-sites.ts',mode:'100644',blob:'c1c6e532fbed264eaef648a369ee533bfd905fb0'},after:{mode:'100644',blob:'9b13dc788fdd5fd0733e9c951b5ac97353ca4517'}},
    ];
    const base=new Map(changes.filter(change=>change.before).map(change=>[change.path,change.before]));
    const apply=changes=>sourceProof.applyC1SmartSiteAmendment(base,changes);
    const applied=apply(changes);
    expect(changes.map(change=>applied.get(change.path))).toEqual(changes.map(change=>({path:change.path,...change.after})));
    const stale=structuredClone(changes);stale[0].before.blob='0'.repeat(40);
    expect(()=>apply(stale)).toThrow(/base path changed/);
    expect(()=>apply(changes.slice(1))).toThrow(/coverage/);
    expect(()=>apply([...changes,changes[0]])).toThrow(/duplicate/);
    expect(()=>apply([...changes,{...changes[0],path:'artifacts/api-server/src/services/unreviewed.ts'}])).toThrow(/coverage/);
    const replacement=structuredClone(changes);replacement[0].path='artifacts/api-server/src/services/unreviewed.ts';
    expect(()=>apply(replacement)).toThrow(/coverage/);
  });
  it('refuses unstaged auxiliary CLI source', () => {
    const snapshot=copy();snapshot.workingDiff='scripts/smart-sites/common.mjs\n';
    expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/worktree/);
  });
  it('loads and refuses a fourth untracked auxiliary CLI source', () => {
    const path=fileURLToPath(new URL(`./smart-sites/c1-unreviewed-${process.pid}.mjs`,import.meta.url));
    writeFileSync(path,'// synthetic unreviewed source\n',{flag:'wx'});
    try {
      const snapshot=loadC1SourceSnapshot();
      expect(snapshot.untracked).toContain(`scripts/smart-sites/c1-unreviewed-${process.pid}.mjs`);
      expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/untracked scoped source/);
    } finally { unlinkSync(path); }
  });
  it('refuses an ignored nested fourth auxiliary .mjs source', () => {
    withIgnoredAuxiliaryFile('mjs',relative=>{
      const snapshot=loadC1SourceSnapshot();
      expect(snapshot.untracked).not.toContain(relative);
      expect(()=>verifyC1SourceSnapshot(snapshot)).toThrow(/untracked auxiliary executable source/);
    });
  });
  it('permits an ignored auxiliary log outside the executable source boundary', () => {
    withIgnoredAuxiliaryFile('log',relative=>{
      const snapshot=loadC1SourceSnapshot();
      expect(snapshot.untracked).not.toContain(relative);
      expect(verifyC1SourceSnapshot(snapshot).releaseEligible).toBe(false);
    });
  });
});
