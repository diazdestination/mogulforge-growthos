/** Fixed-query supplied-client observer. No transport, credentials, logs or mutation.
 * Caller owns an exclusive connected backend and READ ONLY transaction. */
import { isDeepStrictEqual } from 'node:util';
import { CATALOG_QUERIES,catalogDigest } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { PRODUCTION75_PRIVILEGE_QUERIES,OWNERSHIP_SQL,IDENTITY_SQL,ORIGINAL_DEFAULTS } from './production75-core.mjs';
export const PRODUCTION75_EXTRA_QUERIES=Object.freeze({
  roles:`SELECT rolname AS name,rolsuper AS superuser,rolinherit AS inherit,rolcreaterole AS create_role,rolcreatedb AS create_database,rolcanlogin AS login,rolreplication AS replication,rolbypassrls AS bypass_rls,rolconnlimit AS connection_limit FROM pg_catalog.pg_roles ORDER BY rolname`,
  roleSettings:`SELECT COALESCE(d.datname,'*') AS database,COALESCE(r.rolname,'*') AS role,md5(COALESCE(array_to_string(s.setconfig,E'\\n'),'')) AS settings_digest FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_catalog.pg_roles r ON r.oid=s.setrole ORDER BY 1,2`,
  extensions:`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,r.rolname AS owner,e.extrelocatable AS relocatable FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace JOIN pg_catalog.pg_roles r ON r.oid=e.extowner ORDER BY e.extname`,
  extensionObjects:`SELECT e.extname AS extension,c.relkind::text AS kind,n.nspname AS schema,c.relname AS name,NULL::text AS arguments,r.rolname AS owner,COALESCE(c.relacl::text,'DEFAULT') AS acl,CASE WHEN c.relkind IN ('v','m') THEN md5(pg_catalog.pg_get_viewdef(c.oid,false)) ELSE NULL END AS definition_digest FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid JOIN pg_catalog.pg_class c ON c.oid=d.objid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE d.refclassid='pg_catalog.pg_extension'::regclass AND d.classid='pg_catalog.pg_class'::regclass AND d.deptype='e' UNION ALL SELECT e.extname,'function',n.nspname,f.proname,pg_catalog.pg_get_function_identity_arguments(f.oid),r.rolname,COALESCE(f.proacl::text,'DEFAULT'),md5(pg_catalog.pg_get_functiondef(f.oid)) FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid JOIN pg_catalog.pg_proc f ON f.oid=d.objid JOIN pg_catalog.pg_namespace n ON n.oid=f.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=f.proowner WHERE d.refclassid='pg_catalog.pg_extension'::regclass AND d.classid='pg_catalog.pg_proc'::regclass AND d.deptype='e' ORDER BY 1,2,3,4,5`,
  databases:`SELECT d.datname AS name,r.rolname AS owner,d.datallowconn AS allow_connections,d.datistemplate AS template,pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,d.datcollate AS collation,d.datctype AS ctype,COALESCE(d.datacl::text,'DEFAULT') AS acl FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba ORDER BY d.datname`
});
const PHYSICAL_PAIRS=new Map([
 ['2ca3d8dbc10313fb7f23bab2e87f61ad13a21e925664e190c087683aad1daf55','307fee292bc66d8f9fe11858d9cd8fe2c2983a59563ba867d6ebf50504f3ef6e'],
 ['2a56e08b2bd331d0eaedea2d504d3fff568bf4e6aaab2279467cf997648d2009','2ed9500b5fb077a19aa16003bd346f8369a1b1cb3da8ea8f9a396265b6410f7b'],
]);
const MAX=Object.freeze({metadataRows:20000,metadataBytes:8000000,operationMs:240000,queryMs:15000});
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const name=v=>typeof v==='string'&&/^[a-z_][a-z0-9_-]{0,62}$/.test(v);
const q=v=>{check(typeof v==='string'&&/^[a-z_][a-z0-9_]*$/.test(v),'production75_observer_catalog');return `"${v}"`;};
export function createProduction75Observer({client,principals,catalog75,catalog142,identity,limits={},now=Date.now}={}) {
 check(client&&typeof client.query==='function'&&typeof now==='function','production75_observer_input');
 check(Array.isArray(principals)&&principals.length>=2&&principals.length<=8&&principals.every(name)&&new Set(principals).size===principals.length,'production75_observer_principals');
 check(identity&&Object.keys(identity).sort().join(',')==='database,login,role'&&Object.values(identity).every(name),'production75_observer_identity');
 const originalHash=catalogDigest(catalog75,{physical:true});check(PHYSICAL_PAIRS.has(originalHash)&&PHYSICAL_PAIRS.get(originalHash)===catalogDigest(catalog142,{physical:true}),'production75_observer_catalog');
 const bound={...MAX,...limits};check(Object.keys(bound).every(k=>k in MAX&&Number.isSafeInteger(bound[k])&&bound[k]>0&&bound[k]<=MAX[k]),'production75_observer_limits');
 const expected=structuredClone(identity),actors=structuredClone(principals),registry=new Map();
 const add=(sql,args)=>{check(typeof sql==='string'&&!sql.includes(';'),'production75_observer_registry');registry.set(sql,args===undefined?undefined:structuredClone(args));};
 for(const sql of [...Object.values(CATALOG_QUERIES),OWNERSHIP_SQL,IDENTITY_SQL,...Object.values(PRODUCTION75_EXTRA_QUERIES)])add(sql);
 for(const sql of Object.values(PRODUCTION75_PRIVILEGE_QUERIES))add(sql,sql.includes('$1')?[actors]:undefined);
 for(const table of catalog75.tables){
  const cols=catalog75.columns.filter(c=>c.table_name===table.name).sort((a,b)=>a.ordinal-b.ordinal);
  const projection=`(SELECT ${cols.map(c=>q(c.name)).join(',')} FROM public.${q(table.name)}) AS original`;
  add(`SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`);
  add(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`);
 }
 for(const [table,fields] of Object.entries(ORIGINAL_DEFAULTS))for(const [column,value] of Object.entries(fields))add(`SELECT count(*)::text AS mismatches FROM public.${q(table)} WHERE to_jsonb(${q(column)}) IS DISTINCT FROM $1::jsonb`,[value===null?null:JSON.stringify(value)]);
 for(const table of catalog142.tables.filter(t=>!catalog75.tables.some(o=>o.name===t.name)))add(`SELECT count(*)::text AS rows FROM public.${q(table.name)}`);
 const until=now()+bound.operationMs;let pid=null,busy=false,unusable=false;
 const remaining=()=>{const ms=until-now();check(ms>0,'production75_observer_deadline');return Math.min(ms,bound.queryMs);};
 async function dispatch(sql,args){let timer;try{const ms=remaining();const r=await Promise.race([Promise.resolve().then(()=>client.query(sql,args)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('production75_observer_deadline'),{safeCode:'production75_observer_deadline'})),ms);})]);remaining();check(r&&Array.isArray(r.rows)&&r.rows.length<=bound.metadataRows&&Buffer.byteLength(JSON.stringify(r.rows))<=bound.metadataBytes,'production75_observer_bound');return r;}catch(e){unusable=true;if(/^production75_observer_/.test(e?.safeCode??''))throw e;throw Object.assign(new Error('production75_observer_database'),{safeCode:'production75_observer_database'});}finally{clearTimeout(timer);}}
 return Object.freeze({query:async(sql,args)=>{
  check((args===undefined||Array.isArray(args))&&typeof sql==='string'&&registry.has(sql)&&isDeepStrictEqual(Array.isArray(args)&&args.length===0?undefined:args,registry.get(sql)),'production75_observer_query');
  check(!busy&&!unusable,'production75_observer_unusable');remaining();busy=true;
  try{
   const id=await dispatch(IDENTITY_SQL);const row=id.rows[0];check(id.rows.length===1&&Object.entries(expected).every(([k,v])=>row?.[k]===v)&&row.read_only==='on'&&row.isolation==='repeatable read'&&Number.isInteger(row.version)&&row.version>=160000&&row.version<170000&&Number.isInteger(row.pid)&&row.pid>0&&(pid===null||row.pid===pid),'production75_observer_identity');pid=row.pid;
   return sql===IDENTITY_SQL?id:await dispatch(sql,args===undefined?undefined:structuredClone(args));
  }catch(e){unusable=true;throw e;}finally{busy=false;}
 }});
}
export async function captureProduction75Extras(observer){
 const extra={};for(const [key,sql] of Object.entries(PRODUCTION75_EXTRA_QUERIES))extra[key]=(await observer.query(sql)).rows;return extra;
}
