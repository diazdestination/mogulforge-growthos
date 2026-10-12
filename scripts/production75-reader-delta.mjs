/** Exact additive Reader proof. No I/O, networking, credentials or privilege grants. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertLegacyReaderCapabilities} from './production75-legacy-model.mjs';
const profiles=new WeakSet();
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const fail=code=>Object.assign(new Error(code),{safeCode:code});
const check=(v,code)=>{if(!v)throw fail(code);};
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const sha=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const ordered=rows=>rows.map(stable).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
const equalRows=(a,b,code)=>check(isDeepStrictEqual(ordered(a),ordered(b)),code);
const SECTION_KEYS=['roles','roleSettings','extensions','extensionObjects','databases'];
const NAMES=['fly-db','growthos_staging','mogulforge-growthos-db'];
export function expectedProduction75ReaderProfile(readerName){
 check(typeof readerName==='string'&&/^growthos_reader_[a-z0-9_]{1,32}$/.test(readerName),'production75_delta_profile');
 const p=freeze({role:{name:readerName,superuser:false,inherit:true,create_role:false,create_database:false,login:true,replication:false,bypass_rls:false,connection_limit:-1},membership:{role:'reader',member:readerName,grantor:'postgres',admin_option:false,inherit_option:true,set_option:true},roleSettings:[],readerLogin:readerName,readerRole:readerName});profiles.add(p);return p;
}
export function production75ProfileDigest(profile){check(profiles.has(profile),'production75_delta_profile');return sha(profile);}
function snapshotShape(snapshot){
 check(snapshot&&Object.keys(snapshot).join(',')==='databases'&&Array.isArray(snapshot.databases)&&snapshot.databases.length===3&&new Set(snapshot.databases.map(d=>d?.name)).size===3&&NAMES.every(n=>snapshot.databases.some(d=>d.name===n)),'production75_delta_snapshot');
 for(const d of snapshot.databases){
  check(Object.keys(d).sort().join(',')==='catalog,extra,fingerprints,identity,name,policy'&&d.catalog&&Array.isArray(d.catalog.tables)&&Array.isArray(d.catalog.columns)&&Array.isArray(d.fingerprints)&&d.fingerprints.length===d.catalog.tables.length&&new Set(d.fingerprints.map(f=>f.table)).size===d.fingerprints.length&&d.fingerprints.every(f=>d.catalog.tables.some(t=>t.name===f.table)&&Number.isSafeInteger(f.rows)&&f.rows>=0&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&/^[a-f0-9]{32}$/.test(f.digest??''))&&d.policy?.privileges&&Array.isArray(d.policy.ownership)&&Object.keys(d.extra??{}).sort().join(',')===[...SECTION_KEYS].sort().join(',')&&SECTION_KEYS.every(k=>Array.isArray(d.extra[k]))&&Object.values(d.policy.privileges).every(Array.isArray),'production75_delta_snapshot');
  const i=d.identity;check(i?.database===d.name&&typeof i.login==='string'&&typeof i.role==='string'&&Number.isInteger(i.version)&&i.version>=160000&&i.version<170000&&Number.isInteger(i.pid)&&i.pid>0&&i.read_only==='on'&&i.isolation==='repeatable read','production75_delta_identity');
 }
 check(Buffer.byteLength(JSON.stringify(snapshot))<=32000000,'production75_delta_bound');
}
export function production75SnapshotDigest(snapshot){snapshotShape(snapshot);return sha({databases:NAMES.map(n=>{const {identity,...data}=snapshot.databases.find(d=>d.name===n);return data;})});}
export function assertProduction75ReaderDelta({before,after,readerName,expectedProfile}={}){
 snapshotShape(before);snapshotShape(after);check(profiles.has(expectedProfile)&&expectedProfile.readerLogin===readerName,'production75_delta_profile');
 const proof={profileSha256:production75ProfileDigest(expectedProfile),readerProfileVerified:true,originalVectorsPreserved:true,databases:[],capabilities:null};
 for(const name of NAMES){
  const b=before.databases.find(d=>d.name===name),a=after.databases.find(d=>d.name===name),i=a.identity;
  check(i.login===readerName&&i.role===expectedProfile.readerRole&&i.pid!==b.identity.pid,'production75_delta_identity');
  check(isDeepStrictEqual(a.catalog,b.catalog)&&isDeepStrictEqual(a.fingerprints,b.fingerprints)&&isDeepStrictEqual(a.policy.ownership,b.policy.ownership),'production75_delta_original');
  equalRows(a.extra.roles,[...b.extra.roles,expectedProfile.role],'production75_delta_roles');
  equalRows(a.extra.roleSettings,[...b.extra.roleSettings,...expectedProfile.roleSettings],'production75_delta_settings');
  for(const section of ['extensions','extensionObjects','databases'])check(isDeepStrictEqual(a.extra[section],b.extra[section]),'production75_delta_provider');
  check(Object.keys(a.policy.privileges).sort().join(',')===Object.keys(b.policy.privileges).sort().join(','),'production75_delta_privileges');
  for(const [section,oldRows] of Object.entries(b.policy.privileges)){
   const rows=a.policy.privileges[section];
   if(section==='memberships'){equalRows(rows,[...oldRows,expectedProfile.membership],'production75_delta_memberships');continue;}
   const retained=rows.filter(r=>r.principal!==readerName);equalRows(retained,oldRows,'production75_delta_privileges');
   const actual=rows.filter(r=>r.principal===readerName),template=oldRows.filter(r=>r.principal==='reader');
   const expected=template.map(r=>({...r,principal:readerName}));
   if(section==='roles'){
    const self=template.find(r=>r.name==='reader');check(self,'production75_delta_group_coverage');
    const newSelf=Object.fromEntries(Object.entries(self).map(([k,v])=>[k,k==='principal'||k==='name'?readerName:Object.hasOwn(expectedProfile.role,k)?expectedProfile.role[k]:v]));expected.push(newSelf);
   }
   equalRows(actual,expected,'production75_delta_new_privileges');
  }
  if(a.catalog.tables.length){const c=assertLegacyReaderCapabilities(a.policy,{readerLogin:readerName,readerRole:expectedProfile.readerRole,writerRole:'schema_admin'});if(name==='fly-db')proof.capabilities=c;}
  else{
   const db=a.policy.privileges.database.filter(r=>r.principal===readerName),spaces=a.policy.privileges.namespaces.filter(r=>r.principal===readerName);
   check(db.length===1&&db[0].create===false&&db[0].connect===true&&db[0].temporary===false&&spaces.some(r=>r.name==='public')&&spaces.every(r=>r.create===false),'production75_delta_empty_permissions');
  }
  proof.databases.push(name);
 }
 check(proof.capabilities,'production75_delta_group_coverage');return freeze(proof);
}
