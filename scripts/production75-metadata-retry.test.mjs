import {test,expect,vi} from 'vitest';
import {createProduction75V1Client,production75V1FailureMetadata} from './production75-fly-v1.mjs';
const raw=()=>({id:'abcdefghijklmnop',name:'copy',version:1,region:'iad',plan:'basic',status:'ready',organization:{Slug:'adam-diaz'},attached_apps:[]});
const client=extra=>createProduction75V1Client({organization:'adam-diaz',getAuthorization:async()=> 'Bearer synthetic-fixture',...extra});
test.each([500,502,503,504])('transient metadata HTTP%s can recover within the same request budget',async status=>{
 vi.useFakeTimers();try{
  let calls=0,cancelled=0;
  const api=client({fetchFn:async()=>{calls++;if(calls<3)return {status,redirected:false,headers:new Headers(),body:{cancel:async()=>{cancelled++;}}};return new Response(JSON.stringify({data:raw()}),{status:200});}});
  const result=api.getCluster('abcdefghijklmnop').then(value=>({value}),error=>({error}));await vi.advanceTimersByTimeAsync(4000);
  const observed=await result;expect(observed.error).toBeUndefined();expect(observed.value).toMatchObject({id:'abcdefghijklmnop',status:'ready'});expect(calls).toBe(3);expect(cancelled).toBe(2);
 }finally{vi.useRealTimers();}
});
test('metadata retries stop at three attempts and expose only the final owned failure',async()=>{
 vi.useFakeTimers();try{let calls=0;const api=client({fetchFn:async()=>{calls++;return new Response('synthetic-private-provider-value',{status:500});}});
 const pending=api.listClusters().then(()=>null,e=>e);await vi.advanceTimersByTimeAsync(4000);const e=await pending;
 expect(calls).toBe(3);expect(e.safeCode).toBe('production75_v1_status');expect(production75V1FailureMetadata(e)).toMatchObject({operation:'list-clusters',method:'GET',httpStatus:500,safeCode:'production75_v1_status'});
 expect(JSON.stringify(e)+JSON.stringify(production75V1FailureMetadata(e))).not.toContain('synthetic-private-provider-value');
 }finally{vi.useRealTimers();}
});
test.each([401,403,404,422])('terminal metadata status%s never dispatches another request',async status=>{
 let calls=0;const api=client({fetchFn:async()=>{calls++;return new Response('{}',{status});}});
 await expect(api.listClusters()).rejects.toMatchObject({safeCode:'production75_v1_status'});expect(calls).toBe(1);
});
test('malformed successful metadata is held without a retry',async()=>{
 let calls=0;const api=client({fetchFn:async()=>{calls++;return new Response('invalid-json',{status:200});}});
 await expect(api.listClusters()).rejects.toMatchObject({safeCode:'production75_v1_response'});expect(calls).toBe(1);
});
test('retry backoff cannot extend the original total request deadline',async()=>{
 vi.useFakeTimers();try{let calls=0;const api=client({limits:{requestMs:500},fetchFn:async()=>{calls++;return new Response('{}',{status:500});}});
 const pending=api.listClusters().then(()=>null,e=>e);await vi.advanceTimersByTimeAsync(1000);const e=await pending;expect(e.safeCode).toBe('production75_v1_deadline');expect(calls).toBe(1);
 }finally{vi.useRealTimers();}
});
