/** Local proof only. Exact reviewed product overlay; never runtime/release authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const descriptorPath = 'reports/c1-source-preservation-2026-10-16.json';
const descriptorSha256 = '6d64fb78992d82fae67eb6d258cf3fbf1e8ea23b4ca11929d9b95b985679348c';
// Separately reviewed, test-only amendment layered on the unchanged C1 overlay.
// Its bytes are pinned here and every path it changes must be test-only source.
const amendmentPath = 'reports/c1-test-fixture-amendment-2026-10-16.json';
const amendmentSha256 = 'dfb91466d876ecdfb2fd4457dbb8427ce2f3b0571e9ae620c58d0849b94316a0';
const TEST_ONLY_PATH = /^artifacts\/api-server\/src\/(?:(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.test\.tsx?|test-helpers\/[A-Za-z0-9_.-]+\.ts)$/;
// Separate exact production-source successor; the B amendment above remains test-only.
const smartSiteAmendmentPath = 'reports/c1-smart-site-integration-amendment-2026-10-16.json';
const smartSiteAmendmentSha256 = '33325232de76de2c2a9bc82e9bc9b8e263e346ce3c2c391fb6cca19f06498242';
const SMART_SITE_PATHS = [
  'artifacts/api-server/src/routes/v1/smart-site-acquisition.test.ts',
  'artifacts/api-server/src/routes/v1/smart-site-hookup-scripts.test.ts',
  'artifacts/api-server/src/services/smart-sites.ts',
];
const SMART_SITE_AUXILIARY_PATHS = ['scripts/smart-sites/acceptance-lead.mjs','scripts/smart-sites/common.mjs','scripts/smart-sites/provision-site.mjs'];
// A distinct production-source successor. The original, B and D descriptors stay frozen.
const launchGapAmendmentPath = 'reports/c1-launch-gap-integration-amendment-2026-10-16.json';
const launchGapAmendmentSha256 = 'd9c9d8106c7567e99d53cb5a45cd6270f6e3b22b79b4f20bb6bf1b111cc9c136';
const LAUNCH_GAP_PATHS = [
  'artifacts/api-server/src/lib/orgFlavor.ts',
  'artifacts/api-server/src/services/automation.ts',
  'artifacts/api-server/src/services/manual-sms.ts',
  'artifacts/api-server/src/services/phone-number.ts',
  'artifacts/api-server/src/services/playbooks-single-connection.test.ts',
  'artifacts/api-server/src/services/playbooks.ts',
  'artifacts/api-server/src/services/smart-site-intake-phone.test.ts',
  'artifacts/api-server/src/services/smart-sites.ts',
];
const inquiryAmendmentPath = 'reports/c1-inquiry-consent-integration-amendment-2026-10-16.json';
const inquiryAmendmentSha256 = '05dbc2101e6d7e9993031a9fbab3d9bd9ba41093377a47ec6b98bbafd3ce61b1';
const INQUIRY_PATHS = [
  'artifacts/api-server/src/services/manual-sms.test.ts',
  'artifacts/api-server/src/services/manual-sms.ts',
  'artifacts/api-server/src/services/send-gate.ts',
];
// Owner-approved PR71 is a separate successor; every historical pin stays frozen.
const revenueAmendmentPath = 'reports/c1-revenue-opportunities-amendment-2026-10-29.json';
const revenueAmendmentSha256 = '33d9c44e46dbbc9d8ff071e6e46072c2a2dbd05eccdd35f35333481547824436';
const REVENUE_PATHS = [
  'artifacts/api-server/src/routes/v1/index.ts',
  'artifacts/api-server/src/routes/v1/next-best-action.ts',
  'artifacts/api-server/src/routes/v1/route-inventory.test.ts',
];
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
function checkedAmendment(bytes) {
  assert.equal(hash(bytes),amendmentSha256,'C1 reviewed test-only amendment changed');
  return json(bytes);
}
function checkedSmartSiteAmendment(bytes) {
  assert.equal(hash(bytes),smartSiteAmendmentSha256,'C1 reviewed Smart Site amendment changed');
  return json(bytes);
}
function checkedLaunchGapAmendment(bytes) {
  assert.equal(hash(bytes),launchGapAmendmentSha256,'C1 reviewed launch-gap amendment changed');
  return json(bytes);
}
function checkedInquiryAmendment(bytes) {
  assert.equal(hash(bytes),inquiryAmendmentSha256,'C1 reviewed inquiry amendment changed');
  return json(bytes);
}
function checkedRevenueAmendment(bytes) {
  assert.equal(hash(bytes),revenueAmendmentSha256,'C1 Revenue Opportunities amendment changed');
  return json(bytes);
}
/** Applies the reviewed amendment to the exact C1 overlay map; only test-only paths may change. */
export function applyC1TestOnlyAmendment(expected, changes) {
  const next=new Map(expected);
  assert.equal(new Set(changes.map(change=>change.path)).size,changes.length,'C1 amendment duplicate path');
  for(const change of changes){
    assert.ok(TEST_ONLY_PATH.test(change.path)&&!change.path.split('/').some(part=>part==='.'||part==='..'),`C1 amendment may change only test source: ${change.path}`);
    assert.deepEqual(next.get(change.path)??null,change.before,'C1 amendment base path changed');
    if(change.after)next.set(change.path,{path:change.path,...change.after});else next.delete(change.path);
  }
  return next;
}
/** Applies only the separately reviewed three-path D successor, with exact before identities. */
export function applyC1SmartSiteAmendment(expected, changes) {
  assert.equal(new Set(changes.map(change=>change.path)).size,changes.length,'C1 Smart Site duplicate path');
  assert.deepEqual(sorted(changes).map(change=>change.path),SMART_SITE_PATHS,'C1 Smart Site path coverage changed');
  const next=new Map(expected);
  for(const change of changes){
    assert.deepEqual(next.get(change.path)??null,change.before,'C1 Smart Site base path changed');
    assert.ok(change.after,'C1 Smart Site reviewed successor cannot delete source');
    next.set(change.path,{path:change.path,...change.after});
  }
  return next;
}
/** Exact separately approved production changes, applied to the complete historical map. */
export function applyC1LaunchGapAmendment(expected, changes) {
  assert.equal(new Set(changes.map(change=>change.path)).size,changes.length,'C1 launch-gap duplicate path');
  assert.deepEqual(sorted(changes).map(change=>change.path),LAUNCH_GAP_PATHS,'C1 launch-gap path coverage changed');
  const next=new Map(expected);
  for(const change of changes){
    assert.deepEqual(next.get(change.path)??null,change.before,'C1 launch-gap base path changed');
    assert.ok(change.after,'C1 launch-gap reviewed successor cannot delete source');
    next.set(change.path,{path:change.path,...change.after});
  }
  return next;
}
/** The production inquiry successor is separate from every historical/test-only contract. */
export function applyC1InquiryAmendment(expected, changes) {
  assert.equal(new Set(changes.map(change=>change.path)).size,changes.length,'C1 inquiry duplicate path');
  assert.deepEqual(sorted(changes).map(change=>change.path),INQUIRY_PATHS,'C1 inquiry path coverage changed');
  const next=new Map(expected);
  for(const change of changes){
    assert.deepEqual(next.get(change.path)??null,change.before,'C1 inquiry base path changed');
    assert.ok(change.after,'C1 inquiry reviewed successor cannot delete source');
    next.set(change.path,{path:change.path,...change.after});
  }
  return next;
}
/** Only the exact approved three-path API successor may extend the prior complete map. */
export function applyC1RevenueAmendment(expected, changes) {
  assert.equal(new Set(changes.map(change=>change.path)).size,changes.length,'C1 revenue duplicate path');
  assert.deepEqual(sorted(changes).map(change=>change.path),REVENUE_PATHS,'C1 revenue path coverage changed');
  const next=new Map(expected);
  for(const change of changes){
    assert.deepEqual(next.get(change.path)??null,change.before,'C1 revenue base path changed');
    assert.ok(change.after,'C1 revenue successor cannot delete source');
    next.set(change.path,{path:change.path,...change.after});
  }
  return next;
}
/** Reconstruct a complete source body; no product code is imported or executed. */
export function composeC1InquiryManualSms(predecessorBytes,componentBytes) {
  const predecessor=Buffer.from(predecessorBytes).toString('utf8'),component=Buffer.from(componentBytes).toString('utf8');
  const common='  // This requested-service reply is human-reviewed, not automated outreach.\n';
  const oldCall='  const gate = await checkSendEligibility({\n    organizationId: input.organizationId,\n    contact: row.contact,\n    channel: "sms",\n    kind: "transactional",\n  });';
  const newCall='  // A website inquiry\'s own SMS consent counts only for THIS lead and the\n  // phone given in that inquiry; it never becomes contact-wide consent.\n  const gate = await checkSendEligibility({\n    organizationId: input.organizationId,\n    contact: row.contact,\n    channel: "sms",\n    kind: "transactional",\n    manualInquiryReplyLeadId: input.leadId,\n  });';
  assert.equal(predecessor.split(common+oldCall).length,2,'C1 inquiry composition predecessor anchor changed');
  assert.equal(component.split(common+newCall).length,2,'C1 inquiry composition component scope changed');
  return Buffer.from(predecessor.replace(common+oldCall,common+newCall));
}
function lineage(commit) {
  const ancestor=spawnSync('git',['-C',root,'merge-base','--is-ancestor',commit,'HEAD'],{windowsHide:true});
  assert.ok(ancestor.status===0||ancestor.status===1,'C1 lineage could not be read');
  return ancestor.status===0;
}
export function loadC1SourceSnapshot() {
  const descriptor=git('show',`:${descriptorPath}`),d=checkedDescriptor(descriptor);
  const amendment=git('show',`:${amendmentPath}`),a=checkedAmendment(amendment);
  const smartSiteAmendment=git('show',`:${smartSiteAmendmentPath}`),s=checkedSmartSiteAmendment(smartSiteAmendment);
  const launchGapAmendment=git('show',`:${launchGapAmendmentPath}`),g=checkedLaunchGapAmendment(launchGapAmendment);
  const inquiryAmendment=git('show',`:${inquiryAmendmentPath}`),i=checkedInquiryAmendment(inquiryAmendment);
  const revenueAmendment=git('show',`:${revenueAmendmentPath}`),r=checkedRevenueAmendment(revenueAmendment);
  const index=parseC1Index(git('ls-files','--stage'));
  const indexed = new Map(index.map(row=>[row.path,row]));
  const rows = pins => pins.map(pin=>({path:pin.path,...indexed.get(pin.path),bytes:git('show',`:${pin.path}`)}));
  const historicalRows = (commit,pins) => {
    const entries=new Map(treeEntries(commit,pins.map(pin=>pin.path)).map(row=>[row.path,row]));
    return pins.map(pin=>({path:pin.path,...entries.get(pin.path),bytes:git('show',`${commit}:${pin.path}`)}));
  };
  const revenueIdentity = pin => ({
    commit:text('rev-parse',`${pin.sourceCommit}^{commit}`),
    tree:text('rev-parse',`${pin.sourceCommit}^{tree}`),
    parents:text('show','-s','--format=%P',pin.sourceCommit).split(' '),
    isAncestor:lineage(pin.sourceCommit),
    product:treeEntries(pin.sourceCommit,d.scopePaths),
  });
  const ancestor=spawnSync('git',['-C',root,'merge-base','--is-ancestor',d.overlay.sourceCommit,'HEAD'],{windowsHide:true});
  assert.ok(ancestor.status===0||ancestor.status===1,'C1 lineage could not be read');
  const gapAuxiliaryPaths=g.auxiliary.flatMap(group=>group.paths);
  const protectedPaths=[...new Set([descriptorPath,amendmentPath,smartSiteAmendmentPath,launchGapAmendmentPath,inquiryAmendmentPath,...gapAuxiliaryPaths,...s.auxiliary.paths,...d.scopePaths,...d.originalProtected.map(p=>p.path),...d.sql.map(p=>p.path),...d.runtime.map(p=>p.path),...d.approvals.map(p=>p.path),'scripts/c1-source-preservation.mjs','scripts/c1-source-preservation.test.mjs','scripts/production75-combined-source.test.mjs'])];
  protectedPaths.push(revenueAmendmentPath,'scripts/c1-revenue-source.test.mjs');
  return {
    descriptor,
    revenueAmendment,
    revenueBase:revenueIdentity(r.base),
    revenueSource:revenueIdentity(r.successor),
    revenueOriginal:historicalRows(r.base.sourceCommit,r.originalBlobs),
    revenueCurrent:rows(r.currentBlobs),
    legacyManifest:git('show',`${d.overlay.sourceCommit}:${d.legacyManifest.path}`),
    currentManifest:git('show',`:${d.legacyManifest.path}`),
    legacyTree:text('rev-parse',`${d.legacy.sourceCommit}^{tree}`),
    overlayTree:text('rev-parse',`${d.overlay.sourceCommit}^{tree}`),
    overlayIsAncestor:ancestor.status===0,
    legacyProduct:treeEntries(d.legacy.sourceCommit,d.scopePaths),
    overlayProduct:treeEntries(d.overlay.sourceCommit,d.scopePaths),
    amendment,
    amendmentTree:text('rev-parse',`${a.amendment.sourceCommit}^{tree}`),
    amendmentIsAncestor:lineage(a.amendment.sourceCommit),
    amendmentProduct:treeEntries(a.amendment.sourceCommit,d.scopePaths),
    amendmentOriginal:a.originalBlobs.map(pin=>({path:pin.path,bytes:git('cat-file','blob',pin.blob)})),
    amendmentCurrent:rows(a.currentBlobs),
    smartSiteAmendment,
    reviewedBCommit:text('rev-parse',`${s.reviewedB.sourceCommit}^{commit}`),
    reviewedBTree:text('rev-parse',`${s.reviewedB.sourceCommit}^{tree}`),
    reviewedBIsAncestor:lineage(s.reviewedB.sourceCommit),
    reviewedBProduct:treeEntries(s.reviewedB.sourceCommit,d.scopePaths),
    smartSiteCommit:text('rev-parse',`${s.smartSite.sourceCommit}^{commit}`),
    smartSiteTree:text('rev-parse',`${s.smartSite.sourceCommit}^{tree}`),
    smartSiteIsAncestor:lineage(s.smartSite.sourceCommit),
    smartSiteProduct:treeEntries(s.smartSite.sourceCommit,d.scopePaths),
    integrationCommit:text('rev-parse',`${s.integration.sourceCommit}^{commit}`),
    integrationTree:text('rev-parse',`${s.integration.sourceCommit}^{tree}`),
    integrationIsAncestor:lineage(s.integration.sourceCommit),
    integrationProduct:treeEntries(s.integration.sourceCommit,d.scopePaths),
    smartSiteOriginal:s.originalBlobs.map(pin=>({path:pin.path,bytes:git('cat-file','blob',pin.blob)})),
    // D's exact successor bytes remain historical proof; GAP11's approved result is separate below.
    smartSiteCurrent:historicalRows(s.smartSite.sourceCommit,s.currentBlobs),
    smartSiteAuxiliary:rows(s.auxiliary.blobs),
    smartSiteAuxiliaryProduct:treeEntries(s.smartSite.sourceCommit,s.auxiliary.paths),
    integrationAuxiliaryProduct:treeEntries(s.integration.sourceCommit,s.auxiliary.paths),
    currentAuxiliaryProduct:index.filter(row=>s.auxiliary.paths.some(path=>row.path.startsWith(`${path}/`))),
    currentProduct:index.filter(row=>d.scopePaths.some(path=>row.path.startsWith(`${path}/`))),
    launchGapAmendment,
    launchGapSources:g.sources.map(source=>({key:source.key,
      commit:text('rev-parse',`${source.sourceCommit}^{commit}`),
      tree:text('rev-parse',`${source.sourceCommit}^{tree}`),
      parents:text('show','-s','--format=%P',source.sourceCommit).split(' '),
      isAncestor:lineage(source.sourceCommit),
      product:treeEntries(source.sourceCommit,d.scopePaths),
    })),
    // The approved launch-gap current bytes are now immutable predecessor evidence.
    launchGapCurrent:historicalRows(g.integration.sourceCommit,g.currentBlobs),
    launchGapReviewed:g.changes.map((change,index)=>historicalRows(g.sources.find(source=>source.key===change.origin).sourceCommit,[g.currentBlobs[index]])[0]),
    launchGapAuxiliary:g.auxiliary.map(group=>({key:group.key,
      reviewedProduct:treeEntries(g.sources.find(source=>source.key===group.source).sourceCommit,group.paths),
      currentProduct:index.filter(row=>group.paths.some(path=>row.path===path||row.path.startsWith(`${path}/`))),
      currentBytes:rows(group.blobs),
    })),
    launchGapAuxiliaryUntracked:git('ls-files','--others','-z','--',...gapAuxiliaryPaths).toString('utf8').split('\0').filter(path=>path.endsWith('.mjs')).join('\n'),
    inquiryAmendment,
    inquirySources:i.sources.map(source=>({key:source.key,
      commit:text('rev-parse',`${source.sourceCommit}^{commit}`),
      tree:text('rev-parse',`${source.sourceCommit}^{tree}`),
      parents:text('show','-s','--format=%P',source.sourceCommit).split(' '),
      isAncestor:lineage(source.sourceCommit),
      product:treeEntries(source.sourceCommit,d.scopePaths),
    })),
    inquiryPredecessorProduct:treeEntries(i.sources.find(source=>source.key==='base').sourceCommit,d.scopePaths),
    inquiryOriginal:historicalRows(i.sources.find(source=>source.key==='base').sourceCommit,i.originalBlobs),
    inquiryReviewed:historicalRows(i.sources.find(source=>source.key==='component').sourceCommit,i.reviewedBlobs),
    inquiryCurrent:rows(i.currentBlobs),
    historicalProtected:d.originalProtected.map(pin=>({path:pin.path,bytes:git('cat-file','blob',pin.blob)})),
    historicalProduct:d.originalProductBlobs.map(pin=>({path:pin.path,bytes:git('cat-file','blob',pin.blob)})),
    currentProductBytes:rows(d.currentProductBlobs),
    currentProtected:rows(d.originalProtected),sql:rows(d.sql),runtime:rows(d.runtime),approvals:rows(d.approvals),
    workingDiff:git('diff','--name-only','--',d.legacyManifest.path,...protectedPaths).toString(),
    untracked:git('ls-files','--others','--exclude-standard','--',d.legacyManifest.path,...protectedPaths).toString(),
    // Auxiliary executable source is in scope even beneath Git-ignored directories.
    auxiliaryUntracked:git('ls-files','--others','-z','--',...s.auxiliary.paths).toString('utf8').split('\0').filter(path=>path.endsWith('.mjs')).join('\n'),
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
function verifyIndexedRows(actual,pins) {
  verifyRows(actual,pins);
  actual.forEach((row,index)=>assert.deepEqual({path:row.path,mode:row.mode,blob:row.blob},{path:pins[index].path,mode:pins[index].mode,blob:pins[index].blob},'C1 Smart Site pinned source identity changed'));
}
function verifyLaunchGap(snapshot,composed,smartSiteDescriptor,scopePaths) {
  const g=checkedLaunchGapAmendment(snapshot.launchGapAmendment);
  assert.equal(g.releaseEligible,false,'C1 launch-gap amendment cannot grant release');
  assert.deepEqual(g.predecessor,{descriptorPath:smartSiteAmendmentPath,descriptorSha256:smartSiteAmendmentSha256,integration:smartSiteDescriptor.integration},'C1 launch-gap predecessor changed');
  assert.deepEqual(g.scopePaths,scopePaths,'C1 launch-gap scope paths changed');
  assert.deepEqual(snapshot.launchGapSources.map(source=>source.key),g.sources.map(source=>source.key),'C1 launch-gap source identity coverage changed');
  for(const [index,pin] of g.sources.entries()){
    const actual=snapshot.launchGapSources[index];
    assert.equal(actual.commit,pin.sourceCommit,'C1 launch-gap commit changed');
    assert.equal(actual.tree,pin.sourceTree,'C1 launch-gap tree changed');
    assert.deepEqual(actual.parents,pin.parents,'C1 launch-gap non-squash parents changed');
    assert.equal(actual.isAncestor,true,'C1 launch-gap reviewed lineage changed');
    assert.deepEqual(scope(actual.product),pin.scope,'C1 launch-gap historical complete product map changed');
  }
  const sources=new Map(snapshot.launchGapSources.map(source=>[source.key,source]));
  assert.deepEqual(sorted(sources.get('base').product),sorted([...composed.values()]),'C1 launch-gap historical base differs from complete C1+B+D map');
  const expected=applyC1LaunchGapAmendment(composed,g.changes);
  // Neither a changed-file allowlist nor matching counts can stand in for this complete map comparison.
  assert.deepEqual(sorted(sources.get('integration').product),sorted([...expected.values()]),'C1 launch-gap reviewed integration differs from exact complete source union');
  assert.deepEqual(sorted(snapshot.currentProduct),sorted([...expected.values()]),'C1 launch-gap current product differs from exact complete source union');
  assert.deepEqual(scope(snapshot.currentProduct),g.integration.scope,'C1 launch-gap current complete scope changed');
  assert.deepEqual(g.currentBlobs.map(pin=>pin.path),LAUNCH_GAP_PATHS,'C1 launch-gap current pin coverage changed');
  for(const change of g.changes){
    const reviewed=sources.get(change.origin).product.find(row=>row.path===change.path);
    assert.deepEqual(reviewed,{path:change.path,...change.after},'C1 launch-gap reviewed component provenance changed');
  }
  verifyIndexedRows(snapshot.launchGapReviewed,g.currentBlobs);
  verifyIndexedRows(snapshot.launchGapCurrent,g.currentBlobs);
  const resolution=g.currentBlobs.find(pin=>pin.path===g.resolution.path);
  const {origin,review,preserves,...resolutionPin}=g.resolution;
  assert.deepEqual(resolutionPin,resolution,'C1 launch-gap exact D+GAP11 conflict resolution changed');
  assert.equal(origin,'mergeGap11','C1 launch-gap resolution provenance changed');
  assert.deepEqual(preserves,['measurementDropped','phoneNeedsReview'],'C1 launch-gap resolution audit fields changed');
  assert.deepEqual(snapshot.launchGapAuxiliary.map(group=>group.key),g.auxiliary.map(group=>group.key),'C1 launch-gap auxiliary coverage changed');
  for(const [index,group] of g.auxiliary.entries()){
    const actual=snapshot.launchGapAuxiliary[index],pins=group.blobs.map(({path,mode,blob})=>({path,mode,blob}));
    for(const field of ['reviewedProduct','currentProduct']){
      assert.deepEqual(sorted(actual[field]),pins,'C1 launch-gap auxiliary complete source map changed');
      assert.deepEqual(scope(actual[field]),group.scope,'C1 launch-gap auxiliary scope changed');
    }
    verifyIndexedRows(actual.currentBytes,group.blobs);
  }
  assert.equal(snapshot.launchGapAuxiliaryUntracked,'','C1 launch-gap untracked auxiliary executable source is not reviewed');
  return {...g.integration,changedPaths:g.changes.map(change=>change.path),integration:g.integration,auxiliaryScopes:g.auxiliary.map(group=>group.scope),amendmentSha256:launchGapAmendmentSha256,releaseEligible:false};
}
function verifyInquiry(snapshot,launchGap,scopePaths) {
  const i=checkedInquiryAmendment(snapshot.inquiryAmendment);
  assert.equal(i.releaseEligible,false,'C1 inquiry amendment cannot grant release');
  assert.deepEqual(i.predecessor,{descriptorPath:launchGapAmendmentPath,descriptorSha256:launchGapAmendmentSha256,integration:launchGap.integration},'C1 inquiry predecessor changed');
  assert.deepEqual(i.scopePaths,scopePaths,'C1 inquiry scope paths changed');
  assert.deepEqual(snapshot.inquirySources.map(source=>source.key),i.sources.map(source=>source.key),'C1 inquiry source identity coverage changed');
  for(const [index,pin] of i.sources.entries()){
    const actual=snapshot.inquirySources[index];
    assert.equal(actual.commit,pin.sourceCommit,'C1 inquiry commit changed');
    assert.equal(actual.tree,pin.sourceTree,'C1 inquiry tree changed');
    assert.deepEqual(actual.parents,pin.parents,'C1 inquiry non-squash parents changed');
    assert.equal(actual.isAncestor,true,'C1 inquiry reviewed lineage changed');
    assert.deepEqual(scope(actual.product),pin.scope,'C1 inquiry historical complete product map changed');
  }
  const sources=new Map(snapshot.inquirySources.map(source=>[source.key,source]));
  assert.deepEqual(sorted(sources.get('base').product),sorted(snapshot.inquiryPredecessorProduct),'C1 inquiry predecessor source map changed');
  assert.deepEqual(sorted(sources.get('launchGapProof').product),sorted(snapshot.inquiryPredecessorProduct),'C1 inquiry approved launch-gap proof source map changed');
  const expected=applyC1InquiryAmendment(new Map(snapshot.inquiryPredecessorProduct.map(row=>[row.path,row])),i.changes);
  assert.deepEqual(sorted(sources.get('integration').product),sorted([...expected.values()]),'C1 inquiry reviewed integration differs from the complete source union');
  assert.deepEqual(sorted(snapshot.currentProduct),sorted([...expected.values()]),'C1 launch-gap inquiry current product differs from the complete source union');
  assert.deepEqual(scope(snapshot.currentProduct),i.integration.scope,'C1 inquiry current complete scope changed');
  for(const key of ['originalBlobs','reviewedBlobs','currentBlobs'])assert.deepEqual(i[key].map(pin=>pin.path),INQUIRY_PATHS,'C1 inquiry pinned path coverage changed');
  for(const [index,change] of i.changes.entries()){
    const {path,mode,blob}=i.originalBlobs[index];
    assert.deepEqual({path,mode,blob},change.before,'C1 inquiry historical pin changed');
    const reviewed=i.reviewedBlobs[index];
    assert.deepEqual(sources.get('component').product.find(row=>row.path===change.path),{path:reviewed.path,mode:reviewed.mode,blob:reviewed.blob},'C1 inquiry component provenance changed');
    if(change.path!==i.composition.path)assert.deepEqual({mode:reviewed.mode,blob:reviewed.blob},change.after,'C1 inquiry disjoint reviewed component changed');
  }
  verifyIndexedRows(snapshot.inquiryOriginal,i.originalBlobs);
  verifyIndexedRows(snapshot.inquiryReviewed,i.reviewedBlobs);
  verifyIndexedRows(snapshot.inquiryCurrent,i.currentBlobs);
  const {predecessor,component,method,...compositionPin}=i.composition;
  assert.equal(predecessor,'base','C1 inquiry composition predecessor changed');
  assert.equal(component,'component','C1 inquiry composition source changed');
  assert.deepEqual(compositionPin,i.currentBlobs.find(pin=>pin.path===i.composition.path),'C1 inquiry exact composition pin changed');
  const body=rows=>rows.find(row=>row.path===i.composition.path).bytes;
  assert.deepEqual(composeC1InquiryManualSms(body(snapshot.inquiryOriginal),body(snapshot.inquiryReviewed)),Buffer.from(body(snapshot.inquiryCurrent)),'C1 inquiry complete G11+GAP02 manual-SMS composition changed');
  return {integration:i.integration,changedPaths:i.changes.map(change=>change.path),amendmentSha256:inquiryAmendmentSha256,releaseEligible:false};
}
function verifyRevenue(snapshot,inquiry,scopePaths) {
  const r=checkedRevenueAmendment(snapshot.revenueAmendment);
  assert.equal(r.releaseEligible,false,'C1 revenue amendment cannot grant release');
  assert.deepEqual(r.predecessor,{descriptorPath:inquiryAmendmentPath,descriptorSha256:inquiryAmendmentSha256,integration:inquiry.integration},'C1 revenue predecessor changed');
  assert.deepEqual(r.scopePaths,scopePaths,'C1 revenue scope paths changed');
  assert.deepEqual(r.base.scope,inquiry.integration.scope,'C1 revenue historical base scope changed');
  for(const [key,pin] of [['revenueBase',r.base],['revenueSource',r.successor]]){
    const actual=snapshot[key];
    assert.equal(actual.commit,pin.sourceCommit,'C1 revenue commit changed');
    assert.equal(actual.tree,pin.sourceTree,'C1 revenue tree changed');
    assert.deepEqual(actual.parents,pin.parents,'C1 revenue parents changed');
    assert.equal(actual.isAncestor,true,'C1 revenue lineage changed');
    assert.deepEqual(scope(actual.product),pin.scope,'C1 revenue historical complete product map changed');
  }
  const expected=sorted([...applyC1RevenueAmendment(new Map(snapshot.revenueBase.product.map(row=>[row.path,row])),r.changes).values()]);
  assert.deepEqual(sorted(snapshot.revenueSource.product),expected,'C1 revenue approved source union changed');
  assert.deepEqual(sorted(snapshot.currentProduct),expected,'C1 revenue current complete source union changed');
  assert.deepEqual(scope(snapshot.currentProduct),r.successor.scope,'C1 revenue current complete scope changed');
  assert.deepEqual(r.originalBlobs.map(({path,mode,blob})=>({path,mode,blob})),r.changes.filter(change=>change.before).map(change=>change.before),'C1 revenue original pin coverage changed');
  assert.deepEqual(r.currentBlobs.map(({path,mode,blob})=>({path,mode,blob})),r.changes.map(change=>({path:change.path,...change.after})),'C1 revenue current pin coverage changed');
  verifyIndexedRows(snapshot.revenueOriginal,r.originalBlobs);
  verifyIndexedRows(snapshot.revenueCurrent,r.currentBlobs);
  return {...r.successor,changedPaths:r.changes.map(change=>change.path),amendmentSha256:revenueAmendmentSha256,releaseEligible:false};
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
  // The historical C1 overlay commit itself must still be exactly legacy plus the reviewed C1 changes.
  assert.deepEqual(sorted(snapshot.overlayProduct),sorted([...expected.values()]),'C1 product differs from the exact reviewed overlay');
  assert.deepEqual(scope(snapshot.overlayProduct),d.overlay.scope,'C1 overlay scope changed');
  // Independently preserve the separately reviewed B test-only amendment.
  const a=checkedAmendment(snapshot.amendment);
  assert.equal(a.releaseEligible,false,'C1 amendment cannot grant release');
  assert.deepEqual(a.baseOverlay,{descriptorPath,descriptorSha256,sourceCommit:d.overlay.sourceCommit,sourceTree:d.overlay.sourceTree,scope:d.overlay.scope},'C1 amendment base changed');
  assert.equal(snapshot.amendmentTree,a.amendment.sourceTree,'C1 amendment tree changed');
  assert.equal(snapshot.amendmentIsAncestor,true,'C1 candidate is outside the reviewed amendment lineage');
  const amended=applyC1TestOnlyAmendment(expected,a.changes);
  assert.deepEqual(sorted(snapshot.amendmentProduct),sorted([...amended.values()]),'C1 amendment commit differs from the reviewed amendment');
  assert.deepEqual(scope(snapshot.amendmentProduct),a.amendment.scope,'C1 amendment scope changed');
  assert.deepEqual(a.originalBlobs.map(pin=>pin.path),a.changes.filter(change=>change.before).map(change=>change.path),'C1 amendment original coverage changed');
  assert.deepEqual(a.currentBlobs.map(pin=>pin.path),a.changes.filter(change=>change.after).map(change=>change.path),'C1 amendment current coverage changed');
  verifyRows(snapshot.amendmentOriginal,a.originalBlobs.map(({mode,...pin})=>pin));
  verifyRows(snapshot.amendmentCurrent,a.currentBlobs);
  const s=checkedSmartSiteAmendment(snapshot.smartSiteAmendment);
  assert.equal(s.releaseEligible,false,'C1 Smart Site amendment cannot grant release');
  assert.deepEqual(s.scopePaths,d.scopePaths,'C1 Smart Site scope paths changed');
  assert.deepEqual(s.baseOverlay,{descriptorPath,descriptorSha256,...d.overlay},'C1 Smart Site base changed');
  assert.deepEqual(s.testOnlyAmendment,{descriptorPath:amendmentPath,descriptorSha256:amendmentSha256,...a.amendment},'C1 Smart Site fixture identity changed');
  for(const [prefix,identity] of [['reviewedB',s.reviewedB],['smartSite',s.smartSite],['integration',s.integration]]){
    assert.equal(snapshot[`${prefix}Commit`],identity.sourceCommit,`C1 ${prefix} commit changed`);
    assert.equal(snapshot[`${prefix}Tree`],identity.sourceTree,`C1 ${prefix} tree changed`);
    assert.equal(snapshot[`${prefix}IsAncestor`],true,`C1 candidate is outside the reviewed ${prefix} lineage`);
  }
  assert.deepEqual(sorted(snapshot.reviewedBProduct),sorted([...amended.values()]),'C1 reviewed B product differs from the exact test-only amendment');
  assert.deepEqual(scope(snapshot.reviewedBProduct),s.reviewedB.scope,'C1 reviewed B scope changed');
  assert.deepEqual(s.reviewedB.scope,a.amendment.scope,'C1 reviewed B fixture scope changed');
  assert.ok(s.changes.every(change=>!a.changes.some(fixture=>fixture.path===change.path)),'C1 Smart Site and B fixture paths overlap');
  // D is a sibling source history: first prove it against original C1, never against B.
  const smartSite=applyC1SmartSiteAmendment(expected,s.changes);
  assert.deepEqual(sorted(snapshot.smartSiteProduct),sorted([...smartSite.values()]),'C1 Smart Site source differs from the reviewed D successor');
  assert.deepEqual(scope(snapshot.smartSiteProduct),s.smartSite.scope,'C1 Smart Site scope changed');
  // Then apply the exact same disjoint D changes to independently validated B.
  const composed=applyC1SmartSiteAmendment(amended,s.changes);
  assert.deepEqual(sorted(snapshot.integrationProduct),sorted([...composed.values()]),'C1 integration source differs from the reviewed B+D composition');
  assert.deepEqual(scope(snapshot.integrationProduct),s.integration.scope,'C1 integration scope changed');
  // Re-run the unchanged launch-gap contract against its exact historical predecessor view.
  const launchGapAmendment=verifyLaunchGap({...snapshot,currentProduct:snapshot.inquiryPredecessorProduct},composed,s,d.scopePaths);
  const inquiryConsentAmendment=verifyInquiry({...snapshot,currentProduct:snapshot.revenueBase.product},launchGapAmendment,d.scopePaths);
  const revenueOpportunitiesAmendment=verifyRevenue(snapshot,inquiryConsentAmendment,d.scopePaths);
  assert.deepEqual(s.originalBlobs.map(pin=>pin.path),s.changes.filter(change=>change.before).map(change=>change.path),'C1 Smart Site original coverage changed');
  assert.deepEqual(s.currentBlobs.map(pin=>pin.path),SMART_SITE_PATHS,'C1 Smart Site current coverage changed');
  verifyRows(snapshot.smartSiteOriginal,s.originalBlobs.map(({mode,...pin})=>pin));
  verifyIndexedRows(snapshot.smartSiteCurrent,s.currentBlobs);
  assert.deepEqual(s.auxiliary.paths,['scripts/smart-sites'],'C1 auxiliary scope paths changed');
  assert.deepEqual(s.auxiliary.blobs.map(pin=>pin.path),SMART_SITE_AUXILIARY_PATHS,'C1 auxiliary pinned coverage changed');
  const auxiliary=s.auxiliary.blobs.map(({path,mode,blob})=>({path,mode,blob}));
  for(const key of ['smartSiteAuxiliaryProduct','integrationAuxiliaryProduct','currentAuxiliaryProduct']){
    assert.deepEqual(sorted(snapshot[key]),auxiliary,`C1 ${key} auxiliary source differs from the exact reviewed map`);
    assert.deepEqual(scope(snapshot[key]),s.auxiliary.scope,'C1 auxiliary scope changed');
  }
  verifyIndexedRows(snapshot.smartSiteAuxiliary,s.auxiliary.blobs);
  verifyRows(snapshot.historicalProtected,d.originalProtected);
  verifyRows(snapshot.historicalProduct,d.originalProductBlobs.map(({mode,...pin})=>pin));
  verifyRows(snapshot.currentProductBytes,d.currentProductBlobs);
  verifyRows(snapshot.currentProtected,d.originalProtected.map(pin=>pin.path===d.amendedDrill.path?d.amendedDrill:{...pin,mode:d.originalProtectedModes[pin.path]}));
  verifyRows(snapshot.sql,d.sql);verifyRows(snapshot.runtime,d.runtime);verifyRows(snapshot.approvals,d.approvals);
  assert.equal(snapshot.workingDiff,'','C1 scoped worktree differs from its index');
  assert.equal(snapshot.untracked,'','C1 untracked scoped source is not reviewed');
  assert.equal(snapshot.auxiliaryUntracked,'','C1 untracked auxiliary executable source is not reviewed');
  return {legacy:d.legacy,overlay:d.overlay,changedProductPaths:d.changes.map(change=>change.path),amendedProof:d.amendedDrill,descriptorSha256,
    testOnlyAmendment:{...a.amendment,changedPaths:a.changes.map(change=>change.path),amendmentSha256},
    smartSiteAmendment:{...s.smartSite,changedPaths:s.changes.map(change=>change.path),reviewedB:s.reviewedB,integration:s.integration,auxiliaryScope:s.auxiliary.scope,amendmentSha256:smartSiteAmendmentSha256},launchGapAmendment,inquiryConsentAmendment,revenueOpportunitiesAmendment,currentScope:revenueOpportunitiesAmendment.scope,releaseEligible:false};
}
export const assertC1SourcePreserved = () => verifyC1SourceSnapshot(loadC1SourceSnapshot());
