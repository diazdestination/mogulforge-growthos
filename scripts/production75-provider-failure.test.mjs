import {test,expect} from 'vitest';
import * as v1 from './production75-fly-v1.mjs';
const fixtureSecret='private-provider-diagnostic-fixture';
const client=extra=>v1.createProduction75V1Client({organization:'adam-diaz',getAuthorization:async()=> 'Bearer fixture',...extra});
const proof=e=>v1.production75V1FailureMetadata?.(e);
async function failure(p){try{await p;throw new Error('Expected failure');}catch(e){return e;}}

test('HTTP rejection preserves only owned immutable request evidence',async()=>{
 let clock=100;
 const api=client({now:()=>clock,fetchFn:async()=>{clock=107;return new Response(fixtureSecret,{status:503});}});
 const e=await failure(api.listClusters());
 expect(proof(e)).toEqual({operation:'list-clusters',method:'GET',httpStatus:503,elapsedMs:7,safeCode:'production75_v1_status'});
 expect(Object.isFrozen(proof(e))).toBe(true);
 expect(JSON.stringify(proof(e))).not.toContain(fixtureSecret);
 expect(Object.keys(proof(e))).toHaveLength(5);
});

test('transport failure strips arbitrary messages causes and forged safe codes',async()=>{
 let clock=0;
 const api=client({now:()=>clock,fetchFn:async()=>{clock=13;throw Object.assign(new Error(fixtureSecret),{cause:fixtureSecret,safeCode:'production75_fake_secret'});}});
 expect(proof(await failure(api.getCluster('abcdefghijklmnop')))).toEqual({operation:'get-cluster',method:'GET',httpStatus:null,elapsedMs:13,safeCode:'production75_v1_request'});
 expect(proof(Object.assign(new Error(fixtureSecret),{safeCode:'production75_v1_status'}))).toBeNull();
 expect(proof(null)).toBeNull();
 expect(proof(fixtureSecret)).toBeNull();
});

test('deadline failure remains distinct from network and HTTP rejection',async()=>{
 let clock=0;
 const api=client({now:()=>clock,limits:{requestMs:5},fetchFn:async()=>{clock=20;return new Response('{}',{status:200});}});
 expect(proof(await failure(api.listClusters()))).toEqual({operation:'list-clusters',method:'GET',httpStatus:null,elapsedMs:20,safeCode:'production75_v1_deadline'});
});

test('acknowledged response validation retains status and excludes provider body',async()=>{
 let clock=0;
 const api=client({now:()=>clock,fetchFn:async()=>{clock=2;return new Response(JSON.stringify({data:{name:fixtureSecret}}),{status:200});}});
 expect(proof(await failure(api.listUsers('abcdefghijklmnop')))).toEqual({operation:'list-users',method:'GET',httpStatus:200,elapsedMs:2,safeCode:'production75_v1_response'});
});

test('concurrent failures keep each request status separate',async()=>{
 let release,firstResponseGated=false;
 const api=client({fetchFn:async url=>{if(url.endsWith('abcdefghijklmnop')&&!firstResponseGated){firstResponseGated=true;return new Promise(resolve=>{release=()=>resolve(new Response(fixtureSecret,{status:503}));});}return new Response(fixtureSecret,{status:url.endsWith('abcdefghijklmnop')?503:409});}});
 const first=failure(api.getCluster('abcdefghijklmnop'));
 const second=await failure(api.getCluster('bcdefghijklmnopq'));
 release();const last=await first;
 expect(proof(second)).toMatchObject({operation:'get-cluster',httpStatus:409,safeCode:'production75_v1_status'});
 expect(proof(last)).toMatchObject({operation:'get-cluster',httpStatus:503,safeCode:'production75_v1_status'});
 expect(JSON.stringify([proof(last),proof(second)])).not.toContain(fixtureSecret);
});

const metadataFixture=()=>({id:'abcdefghijklmnop',name:'copy',organization:{Slug:'adam-diaz'},region:'iad',plan:'basic',version:1,status:'ready',attached_apps:[]});
test.each([
 ['shape',()=>undefined],
 ['id',r=>({...r,id:null})],
 ['name',r=>({...r,name:fixtureSecret.toUpperCase()})],
 ['organization',r=>({...r,organization:{slug:'adam-diaz',Slug:fixtureSecret}})],
 ['region',r=>({...r,region:fixtureSecret})],
 ['plan',r=>({...r,plan:null})],
 ['version',r=>({...r,version:0})],
 ['status',r=>({...r,status:null})],
 ['attachments',r=>({...r,attached_apps:{password:fixtureSecret}})],
 ['attachments',r=>({...r,attached_apps:[{name:fixtureSecret.toUpperCase(),password:fixtureSecret}]})],
 ['selector',r=>({...r,id:'bcdefghijklmnopq'})],
])('owned metadata reason %s excludes rejected values and preserves outward rejection',async(reason,change)=>{
 const api=client({fetchFn:async()=>new Response(JSON.stringify({data:change(metadataFixture()),password:fixtureSecret}),{status:200})});
 const e=await failure(api.getCluster('abcdefghijklmnop'));
 expect(e.safeCode).toBe('production75_v1_response');
 expect(e.message).toBe('production75_v1_response');
 expect(proof(e)).toMatchObject({operation:'get-cluster',method:'GET',httpStatus:200,safeCode:'production75_v1_metadata_'+reason});
 expect(Object.keys(proof(e))).toHaveLength(5);
 expect(Object.isFrozen(proof(e))).toBe(true);
 expect(JSON.stringify(e)+JSON.stringify(proof(e))).not.toContain(fixtureSecret);
});

test('malformed JSON has an owned fixed reason without retaining response text',async()=>{
 const api=client({fetchFn:async()=>new Response(fixtureSecret,{status:200})});
 const e=await failure(api.getCluster('abcdefghijklmnop'));
 expect(e.safeCode).toBe('production75_v1_response');
 expect(proof(e)).toMatchObject({operation:'get-cluster',httpStatus:200,safeCode:'production75_v1_json'});
 expect(JSON.stringify(proof(e))).not.toContain(fixtureSecret);
});

test.each(['id','name','organization','region','plan'])('non-coercible JSON in %s retains its field reason',async field=>{
 const raw=metadataFixture(),invalid={toString:null,password:fixtureSecret};
 raw[field]=field==='organization'?{Slug:invalid}:invalid;
 const api=client({fetchFn:async()=>new Response(JSON.stringify({data:raw}),{status:200})});
 const e=await failure(api.getCluster('abcdefghijklmnop'));
 expect(e.safeCode).toBe('production75_v1_response');
 expect(proof(e)).toMatchObject({safeCode:'production75_v1_metadata_'+field});
 expect(JSON.stringify(proof(e))).not.toContain(fixtureSecret);
});

test.each(['unlisted-provider-phase',fixtureSecret,'not-ready'])('unknown bounded status is opaque non-ready and excludes its raw value',async status=>{
 const api=client({fetchFn:async()=>new Response(JSON.stringify({data:{...metadataFixture(),status}}),{status:200})});
 const result=await api.getCluster('abcdefghijklmnop');
 expect(result.status).toBe('not-ready');
 expect(result.id).toBe('abcdefghijklmnop');
 if(status!=='not-ready')expect(JSON.stringify(result)).not.toContain(status);
});
test.each([null,0,true,[],{},'','x'.repeat(65)])('malformed status %j remains rejected',async status=>{
 const api=client({fetchFn:async()=>new Response(JSON.stringify({data:{...metadataFixture(),status}}),{status:200})});
 const e=await failure(api.getCluster('abcdefghijklmnop'));
 expect(e.safeCode).toBe('production75_v1_response');
 expect(proof(e)).toMatchObject({safeCode:'production75_v1_metadata_status'});
});
