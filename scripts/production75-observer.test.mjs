import { test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createProduction75Observer, captureProduction75Extras, PRODUCTION75_EXTRA_QUERIES } from './production75-observer.mjs';
import { CATALOG_QUERIES } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { PRODUCTION75_PRIVILEGE_QUERIES, IDENTITY_SQL } from './production75-core.mjs';
const catalog75=JSON.parse(await readFile(new URL('../reports/production75-recovery-2026-10-11/catalog75-fly-db.json',import.meta.url)));
const catalog142=JSON.parse(await readFile(new URL('../reports/production75-recovery-2026-10-11/catalog142-fly-db.json',import.meta.url)));
const principals=['fly-user','growthos-staging-live','native-reader'];
const identity={database:'native_db',login:'native-reader',role:'native-reader'};
const identityRow={...identity,version:160014,pid:101,isolation:'repeatable read',read_only:'on'};
function fixture(extra={}){const calls=[];const client={query:async(...args)=>{calls.push(args);return {rows:args[0]===IDENTITY_SQL?[identityRow]:[]};}};return {calls,observer:createProduction75Observer({client,principals,catalog75,catalog142,identity,...extra})};}
test('fixed catalog and exact principal policy reads work with existing collectors',async()=>{
 const {calls,observer}=fixture();await observer.query(CATALOG_QUERIES.tables);await observer.query(PRODUCTION75_PRIVILEGE_QUERIES.tables,[principals]);expect(calls.filter(x=>x[0]!==IDENTITY_SQL)).toHaveLength(2);
});
test.each(['SELECT 1','SELECT public.pg_stat_monitor_reset()','SELECT * FROM public.pg_stat_monitor','SELECT * FROM pg_authid','DELETE FROM contacts','BEGIN READ ONLY','SELECT 1; SELECT 2'])('unregistered statement %s is rejected before dispatch',async sql=>{const {calls,observer}=fixture();await expect(observer.query(sql)).rejects.toMatchObject({safeCode:'production75_observer_query'});expect(calls).toHaveLength(0);});
test('object query configurations and extra/mutated parameters are refused before dispatch',async()=>{const {calls,observer}=fixture();for(const [sql,args] of [[{text:CATALOG_QUERIES.tables},undefined],[CATALOG_QUERIES.tables,['unexpected']],[PRODUCTION75_PRIVILEGE_QUERIES.tables,[['fly-user']]]])await expect(observer.query(sql,args)).rejects.toMatchObject({safeCode:'production75_observer_query'});expect(calls).toHaveLength(0);});
test('non-array values with a fake zero length cannot bypass parameter validation',async()=>{const {calls,observer}=fixture();await expect(observer.query(CATALOG_QUERIES.tables,{length:0})).rejects.toMatchObject({safeCode:'production75_observer_query'});expect(calls).toHaveLength(0);});
test('only pinned original catalogs can register fingerprint reads',()=>{const bad=structuredClone(catalog75);bad.tables[0].name='pg_authid';expect(()=>fixture({catalog75:bad})).toThrow(/production75_observer_catalog/);});
test('known physical catalogs from different layouts cannot be mixed',async()=>{const other=JSON.parse(await readFile(new URL('../reports/production75-recovery-2026-10-11/catalog142-growthos_staging.json',import.meta.url)));expect(()=>fixture({catalog142:other})).toThrow(/production75_observer_catalog/);});
test('a hanging backend is bounded and the observer cannot be reused after timeout',async()=>{const f=fixture({limits:{queryMs:5},client:{query:()=>new Promise(()=>{})}});await expect(f.observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({safeCode:'production75_observer_deadline'});await expect(f.observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({safeCode:'production75_observer_unusable'});});
test('bounds reject malformed/oversized rows and expose no backend error details',async()=>{
 for(const rows of [null,[{value:'too large'}]]){const {observer}=fixture({limits:{metadataBytes:3},client:{query:async()=>({rows})}});await expect(observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({safeCode:'production75_observer_bound'});}
 const {observer}=fixture({client:{query:async()=>{throw Error('private-backend-detail');}}});try{await observer.query(CATALOG_QUERIES.tables);throw Error('missing rejection');}catch(e){expect(e.message).toBe('production75_observer_database');expect(e.cause).toBeUndefined();}
});
test('deadline is checked before dispatch and after a late response',async()=>{
 let now=0;const {calls,observer}=fixture({now:()=>now,limits:{operationMs:10}});now=11;await expect(observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({safeCode:'production75_observer_deadline'});expect(calls).toHaveLength(0);
 now=0;const f=fixture({now:()=>now,limits:{operationMs:10},client:{query:async()=>{now=11;return {rows:[]};}}});await expect(f.observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({safeCode:'production75_observer_deadline'});
});
test('capture preserves all five extra sections with no filtering',async()=>{let n=0;const f=fixture({client:{query:async sql=>({rows:sql===IDENTITY_SQL?[identityRow]:[{marker:++n}]})}});const extra=await captureProduction75Extras(f.observer);expect(Object.keys(extra)).toEqual(['roles','roleSettings','extensions','extensionObjects','databases']);expect(Object.values(extra).flat()).toHaveLength(5);expect(Object.keys(PRODUCTION75_EXTRA_QUERIES)).toHaveLength(5);});
test.each([{role:'schema_admin'},{database:'other_db'},{read_only:'off'},{isolation:'read committed'},{version:170000}])('identity change %j prevents metadata dispatch',async changed=>{const calls=[];const f=fixture({client:{query:async sql=>{calls.push(sql);return {rows:[{...identityRow,...changed}]};}}});await expect(f.observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({safeCode:'production75_observer_identity'});expect(calls).toEqual([IDENTITY_SQL]);});
