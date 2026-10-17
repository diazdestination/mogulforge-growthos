import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildProduction75Source } from './production75-source.mjs';
import { prepareProduction75, assertProduction75Preserved, ORIGINAL_DEFAULTS } from './production75-core.mjs';

const commit = '7091af816715cfd437925eb0af82fb47d3411e34';
const sourceManifest = JSON.parse(await readFile(new URL('../reports/release-preparation-2026-10-09/source-manifest.json', import.meta.url)));
// Hash-authenticated canonical checkout bytes also work in shallow CI clones.
const files = await Promise.all(sourceManifest.sqlFiles.map(async e => ({ ...e,
  bytes: Buffer.from((await readFile(new URL(`../${e.path}`,import.meta.url),'utf8')).replaceAll('\r\n','\n')) })));

test('exact main selection is 15 CREATE,32 FK,21 indexes; complete bridge is92 statements', () => {
  const source = buildProduction75Source(files);
  assert.equal(source.sourceCommit, commit);
  assert.equal(source.selectedStatements.length, 68);
  assert.deepEqual(source.bridgeCounts, { create: 20, column: 1, foreignKey: 44, index: 27 });
  assert.equal(source.steps.length, 19);
  assert.equal(source.steps[0].sql.includes('CREATE TYPE'), false);
  assert.equal(source.steps[0].sql.includes('CREATE TABLE "organizations"'), false);
  for (let i = 1; i < 19; i++) assert.equal(source.steps[i].sql, files[i].bytes.toString('utf8'));
});

test('tampered source is refused before a plan can exist', () => {
  const changed = files.map(f => ({ ...f }));
  changed[18].bytes = Buffer.concat([changed[18].bytes, Buffer.from('\nSELECT 1;')]);
  assert.throws(() => buildProduction75Source(changed), /production75_source_drift/);
});

test('13 original defaults include11 NULL and2 zero, no defaults in new tables', () => {
  const values = Object.values(ORIGINAL_DEFAULTS).flatMap(Object.values);
  assert.equal(values.length, 13);
  assert.equal(values.filter(v => v === null).length, 11);
  assert.equal(values.filter(v => v === 0).length, 2);
  assert.equal(ORIGINAL_DEFAULTS.org_settings.customer_email_sender_user_id, null);
});

test('preparation requires explicit target, policy and physical expectation inputs', () => {
  assert.throws(() => prepareProduction75({ source: buildProduction75Source(files) }), /production75_/);
});

const fixture = async name => JSON.parse(await readFile(new URL(`../reports/production75-recovery-2026-10-11/${name}`,import.meta.url)));
const canonical = async name => JSON.parse(await readFile(new URL(`../reports/staging-observation-2026-10-10/fixtures/${name}`,import.meta.url)));

test('reviewed local physical variants remain distinct while matching full142 logical definitions', async () => {
  const {catalogDigest}=await import('../reports/release-preparation-2026-10-09/schema-catalog.mjs');
  const source=buildProduction75Source(files),canonical95=await canonical('catalog-95.json'),canonical142=await canonical('catalog-142.json');
  const plans=[];
  for(const name of ['fly-db','growthos_staging']) {
    const catalog75=await fixture(`catalog75-${name}.json`),policy=await fixture(`local-policy-${name}.json`);
    const plan=prepareProduction75({source,catalog75,canonical95,canonical142,...policy});plans.push(plan);
    assert.equal(plan.catalog75.columns.length,849);
    assert.equal(catalogDigest(plan.catalog142),catalogDigest(canonical142));
    assert.equal(plan.catalog142.columns.length,1867);
    assert.equal(plan.expectedPhysicalNewColumns.length,1018);
    for(const original of catalog75.columns)assert.equal(plan.catalog142.columns.find(c=>c.table_name===original.table_name&&c.name===original.name).ordinal,original.ordinal);
  }
  assert.notEqual(catalogDigest(plans[0].catalog75,{physical:true}),catalogDigest(plans[1].catalog75,{physical:true}));
  assert.notEqual(catalogDigest(plans[0].catalog142,{physical:true}),catalogDigest(plans[1].catalog142,{physical:true}));
});

test('physical,source and permission expectations cannot be omitted or weakened', async () => {
  const input={source:buildProduction75Source(files),catalog75:await fixture('catalog75-fly-db.json'),canonical95:await canonical('catalog-95.json'),canonical142:await canonical('catalog-142.json'),...await fixture('local-policy-fly-db.json')};
  const changed=structuredClone(input.catalog75);changed.columns[0].ordinal++;
  assert.throws(()=>prepareProduction75({...input,catalog75:changed}),/production75_baseline_catalog/);
  const reordered=structuredClone(input.catalog75);reordered.enums[0].labels.reverse();
  assert.throws(()=>prepareProduction75({...input,catalog75:reordered}),/production75_baseline_catalog/);
  const wrongDefault=structuredClone(input.canonical142);wrongDefault.columns[0].default_expression='1';
  assert.throws(()=>prepareProduction75({...input,canonical142:wrongDefault}),/production75_canonical_catalog/);
  const incomplete=structuredClone(input.policy142);incomplete.privileges.columns.pop();
  assert.throws(()=>prepareProduction75({...input,policy142:incomplete}),/production75_column_policy_coverage/);
  assert.throws(()=>prepareProduction75({...input,policy75:{}}),/production75_policy_required/);
  assert.throws(()=>prepareProduction75({...input,target:{...input.target,database:'bad;target'}}),/production75_explicit_target/);
  assert.throws(()=>prepareProduction75({...input,target:{...input.target,principals:[input.target.readerLogin]}}),/production75_explicit_target/);
  assert.equal(prepareProduction75({...input,until:95}).steps.length,3);
});

test('unexpected initial identity is refused before BEGIN and returns no observed identity values', async () => {
  const {executeProduction75}=await import('./production75-core.mjs');
  const input={source:buildProduction75Source(files),catalog75:await fixture('catalog75-fly-db.json'),canonical95:await canonical('catalog-95.json'),canonical142:await canonical('catalog-142.json'),...await fixture('local-policy-fly-db.json')};
  for(const [field,value] of [['database','unexpected-private-database'],['login','unexpected-private-login'],['role','unexpected-private-role'],['version',150001],['pid',0]]) {
    const plan=prepareProduction75(input),calls=[],identity={database:input.target.database,login:input.target.writerLogin,role:input.target.writerRole,version:160014,pid:1234,[field]:value};
    const client={query:async(sql)=>{calls.push(sql);return{rows:[identity]};}};
    const result=await executeProduction75(client,{plan,expectedBefore:{catalog:input.catalog75,policy:input.policy75,fingerprints:Array(75).fill({})},persist:async()=>{assert.fail('no journal before identity admission');}});
    assert.equal(result.status,'failed');assert.equal(result.errorCode,'production75_identity');assert.equal(calls.length,1);
    assert.equal(result.initialIdentityChecks[field],false);assert.equal(JSON.stringify(result).includes('unexpected-private'),false);
  }
});

test('Reader admission requires a different login and effective role from Writer', async () => {
  const input={source:buildProduction75Source(files),catalog75:await fixture('catalog75-fly-db.json'),canonical95:await canonical('catalog-95.json'),canonical142:await canonical('catalog-142.json'),...await fixture('local-policy-fly-db.json')};
  for(const change of [
    {readerLogin:input.target.writerLogin,readerRole:input.target.writerRole},
    {readerLogin:input.target.writerLogin},
    {readerRole:input.target.writerRole},
  ])assert.throws(()=>prepareProduction75({...input,target:{...input.target,...change}}),/production75_explicit_target/);
});

async function providerMetadataFixture() {
  const input={source:buildProduction75Source(files),catalog75:await fixture('catalog75-fly-db.json'),canonical95:await canonical('catalog-95.json'),canonical142:await canonical('catalog-142.json'),...await fixture('local-policy-fly-db.json')};
  const providerRows=[
    {kind:'relation',schema:'public',name:'synthetic_provider_view',sub_name:null,owner:'postgres',acl:'{postgres=arwdDxt/postgres,=r/postgres}'},
    {kind:'column',schema:'public',name:'synthetic_provider_view',sub_name:'sample_count',owner:'postgres',acl:'DEFAULT'},
    {kind:'function',schema:'public',name:'synthetic_provider_function',sub_name:'integer',owner:'postgres',acl:'DEFAULT'},
  ];
  const sort=rows=>rows.sort((a,b)=>JSON.stringify([a.kind,a.schema,a.name,a.sub_name]).localeCompare(JSON.stringify([b.kind,b.schema,b.name,b.sub_name])));
  for(const name of ['policy75','policy95','policy142'])input[name].ownership=sort([...input[name].ownership,...structuredClone(providerRows)]);
  const plan=prepareProduction75(input),fingerprints=plan.catalog75.tables.map(t=>({table:t.name,rows:0,bytes:0,digest:'d41d8cd98f00b204e9800998ecf8427e'}));
  const before={catalog:plan.catalog75,policy:plan.policies[75],fingerprints};
  const after={catalog:plan.catalog142,policy:plan.policies[142],fingerprints,defaults:Array(13).fill('verified'),newTables:plan.catalog142.tables.filter(t=>!plan.catalog75.tables.some(old=>old.name===t.name)).map(t=>t.name)};
  return{input,plan,before,after,providerRows};
}

test('preserves unchanged provider-owned view/column/function metadata outside the75 application catalog', async () => {
  const {plan,before,after}=await providerMetadataFixture();
  assert.deepEqual(assertProduction75Preserved(before,after,plan),{originalTables:75,originalColumns:849,newTablesEmpty:67,defaultsVerified:13});
});

test('pre-existing provider metadata cannot change, disappear or be replaced even in explicit future policy', async () => {
  for(const change of ['changed-acl','removed-column','changed-owner','removed-function','changed-schema-owner','changed-type-acl','changed-database-acl']) {
    const {input,before,after}=await providerMetadataFixture();const altered=structuredClone(input.policy142);
    if(change==='removed-column')altered.ownership=altered.ownership.filter(r=>!(r.kind==='column'&&r.name==='synthetic_provider_view'));
    else if(change==='removed-function')altered.ownership=altered.ownership.filter(r=>r.name!=='synthetic_provider_function');
    else {const row=change.startsWith('changed-schema')?altered.ownership.find(r=>r.kind==='schema'):change.startsWith('changed-type')?altered.ownership.find(r=>r.kind==='type'):change.startsWith('changed-database')?altered.ownership.find(r=>r.kind==='database'):altered.ownership.find(r=>r.kind==='relation'&&r.name==='synthetic_provider_view');row[change.includes('owner')?'owner':'acl']='unexpected';}
    const plan=prepareProduction75({...input,policy142:altered});
    assert.throws(()=>assertProduction75Preserved(before,{...after,policy:plan.policies[142]},plan),/production75_original_acl_changed/,change);
  }
});

test('rogue added ownership objects are not hidden by an explicit future policy', async () => {
  const {input,before,after}=await providerMetadataFixture();
  input.policy142.ownership.push({kind:'relation',schema:'public',name:'rogue_provider_view',sub_name:null,owner:'postgres',acl:'DEFAULT'});
  const plan=prepareProduction75(input);
  assert.throws(()=>assertProduction75Preserved(before,{...after,policy:plan.policies[142]},plan),/production75_original_acl_changed/);
});

test('an original ownership identity is retained even if its name coincides with a known added table', async () => {
  const {input,before,after}=await providerMetadataFixture();
  const original={kind:'relation',schema:'public',name:'service_obligations',sub_name:null,owner:'postgres',acl:'DEFAULT'};
  input.policy75.ownership.push(original);
  input.policy142.ownership.find(r=>r.kind==='relation'&&r.name==='service_obligations').owner='unexpected';
  const plan=prepareProduction75(input);
  assert.throws(()=>assertProduction75Preserved({...before,policy:plan.policies[75]},{...after,policy:plan.policies[142]},plan),/production75_original_acl_changed/);
});
