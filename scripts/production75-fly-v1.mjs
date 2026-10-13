/** Pinned V1 paths; supplied HTTP/auth only. No environment, files or default fetch. */
import {isDeepStrictEqual} from 'node:util';
import {describeOperatorPermit,consumeOperatorPermit,markOperatorPermitDispatched,validateOperatorMetadata} from './production75-custody.mjs';
const ORIGIN='https://api.fly.io',ID=/^[a-z0-9]{16}$/;
const secrets=new WeakMap(),ownedErrors=new WeakMap(),failureMetadata=new WeakMap(),responseReasons=new WeakMap();
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const fail=code=>{const e=Object.assign(new Error(code),{safeCode:code});ownedErrors.set(e,code);return e;};
const check=(ok,code)=>{if(!ok)throw fail(code);};
/** Only this client's own errors expose fixed, content-free request evidence. */
export function production75V1FailureMetadata(error){return failureMetadata.get(error)??null;}
const RESPONSE_REASONS=new Set(['json','shape','id','name','organization','region','plan','version','status','attachments','selector','validation']);
function responseFailure(reason){const e=fail('production75_v1_response');if(RESPONSE_REASONS.has(reason))responseReasons.set(e,reason==='json'?'production75_v1_json':`production75_v1_metadata_${reason}`);return e;}
const responseCheck=(ok,reason)=>{if(!ok)throw responseFailure(reason);};
const KNOWN_CLUSTER_STATUSES=new Set(['ready','creating','restoring','provisioning','deleting','deleted','failed','suspended']);
function normalizeClusterStatus(value){responseCheck(typeof value==='string'&&value.length>0&&value.length<=64,'status');return KNOWN_CLUSTER_STATUSES.has(value)?value:'not-ready';}
function validated(response,parse){try{return parse();}catch(e){const failure=ownedErrors.has(e)?e:fail('production75_v1_response');failureMetadata.set(failure,freeze({...response.diagnosticContext,safeCode:responseReasons.get(failure)??ownedErrors.get(failure)}));throw failure;}}
const diagnosticMatches=(pattern,value)=>{try{return pattern.test(value??'');}catch{return false;}};
function metadataReason(m){
 if(!diagnosticMatches(ID,m.id))return 'id';
 if(!diagnosticMatches(/^[a-z0-9][a-z0-9-]{0,62}$/,m.name))return 'name';
 if(!diagnosticMatches(/^[a-z0-9-]{1,63}$/,m.organization))return 'organization';
 if(!diagnosticMatches(/^[a-z]{3}$/,m.region))return 'region';
 if(!diagnosticMatches(/^[a-z][a-z0-9-]{0,31}$/,m.plan))return 'plan';
 if(![1,2].includes(m.version))return 'version';
 if(![...KNOWN_CLUSTER_STATUSES,'not-ready'].includes(m.status))return 'status';
 if(!Array.isArray(m.attachedApps)||m.attachedApps.length>100||!m.attachedApps.every(a=>typeof a==='string'&&/^[a-z0-9-]{1,63}$/.test(a)))return 'attachments';
 return 'validation';
}
const safeSelector=id=>check(typeof id==='string'&&ID.test(id),'production75_v1_input');
function metadata(raw,allowOmittedVersion=false){
 responseCheck(raw&&typeof raw==='object'&&!Array.isArray(raw),'shape');
 const organization=typeof raw.organization==='string'?raw.organization:raw.organization?.slug??raw.organization?.Slug;
 responseCheck(!(raw.organization?.slug&&raw.organization?.Slug&&raw.organization.slug!==raw.organization.Slug),'organization');
 let attachedApps=null;
 if(raw.attached_apps!==undefined&&raw.attached_apps!==null){responseCheck(Array.isArray(raw.attached_apps),'attachments');attachedApps=raw.attached_apps.map(a=>typeof a==='string'?a:a?.name);}
 const omittedVersion=!Object.hasOwn(raw,'version');
 responseCheck(!omittedVersion||allowOmittedVersion,'version');
 const result={id:raw.id,name:raw.name,organization,region:raw.region,plan:raw.plan,version:omittedVersion?null:raw.version,status:normalizeClusterStatus(raw.status),attachedApps};
 // The stand-in validates the other fields only; returned version stays unknown.
 const standIn={...result,version:omittedVersion?1:result.version,attachedApps:attachedApps??[]};
 try{validateOperatorMetadata(standIn);}catch{throw responseFailure(metadataReason(standIn));}return freeze(result);
}
export function mergeV1OwnershipEvidence(detail,inventory){
 check(detail&&Array.isArray(inventory),'production75_v1_ownership');const rows=inventory.filter(m=>m?.id===detail.id);check(rows.length===1,'production75_v1_ownership');
 const live=rows[0];check(['id','name','organization','region','plan'].every(k=>isDeepStrictEqual(detail[k],live[k]))&&(detail.version===null||isDeepStrictEqual(detail.version,live.version))&&Array.isArray(live.attachedApps)&&live.attachedApps.length===0&&(detail.attachedApps===null||Array.isArray(detail.attachedApps)&&detail.attachedApps.length===0),'production75_v1_ownership');
 try{return validateOperatorMetadata({...detail,version:live.version,attachedApps:[]});}catch{throw fail('production75_v1_ownership');}
}
export async function useProduction75Credentials(ticket,connect){
 const value=secrets.get(ticket);check(value&&typeof connect==='function','production75_v1_credentials');secrets.delete(ticket);
 try{return await connect(value);}catch{throw fail('production75_v1_credentials_callback');}
}
export function createProduction75V1Client(input={}){
 check(input&&Object.keys(input).every(k=>['fetchFn','getAuthorization','organization','now','limits'].includes(k)),'production75_v1_input');
 const {fetchFn,getAuthorization,organization,now=Date.now,limits={}}=input;
 check(typeof fetchFn==='function'&&typeof getAuthorization==='function'&&organization==='adam-diaz'&&typeof now==='function','production75_v1_input');
 const bound={requestMs:15000,bodyBytes:4000000,...limits};check(Object.keys(bound).every(k=>['requestMs','bodyBytes'].includes(k))&&Number.isSafeInteger(bound.requestMs)&&bound.requestMs>0&&bound.requestMs<=15000&&Number.isSafeInteger(bound.bodyBytes)&&bound.bodyBytes>0&&bound.bodyBytes<=4000000,'production75_v1_input');
 async function request(endpoint,{operation,method='GET',body,statuses=[200],until=Infinity,notFound=false,beforeDispatch}={}){
  const startedAt=now(),controller=new AbortController(),deadline=Math.min(startedAt+bound.requestMs,until);let timer,reader,response,httpStatus=null;
  const context=()=>{let elapsed=0;try{const delta=now()-startedAt;if(Number.isFinite(delta)&&delta>=0)elapsed=Math.min(86400000,Math.floor(delta));}catch{}return freeze({operation,method,httpStatus,elapsedMs:elapsed});};
  const expired=()=>check(now()<deadline,'production75_v1_deadline');
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('production75_v1_deadline'));},Math.max(1,deadline-now()));});
  const race=async operation=>{expired();const value=await Promise.race([Promise.resolve().then(operation),timeout]);expired();return value;};
  try{
   check(['list-clusters','get-cluster','list-backups','list-users','restore-copy','create-reader','delete-copy','credentials'].includes(operation)&&['GET','POST','DELETE'].includes(method),'production75_v1_input');
   const authorization=await race(getAuthorization);check(typeof authorization==='string'&&authorization.length<=65536&&/^(Bearer|FlyV1) [^\r\n]+$/.test(authorization),'production75_v1_authorization');
   const url=ORIGIN+endpoint,options={method,headers:{Authorization:authorization,'Content-Type':'application/json'},redirect:'error',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})};
   const pending=Promise.resolve().then(()=>{expired();beforeDispatch?.();return fetchFn(url,options);});pending.then(r=>{if(controller.signal.aborted)try{void r?.body?.cancel()?.catch(()=>{});}catch{}},()=>{});
   response=await race(()=>pending);const status=response?.status;if(Number.isInteger(status)&&status>=100&&status<=599)httpStatus=status;check(response&&Number.isInteger(status)&&response.redirected===false&&(!response.url||response.url===url),'production75_v1_status');
   if(notFound&&response.status===404)return null;
   check(statuses.includes(response.status),'production75_v1_status');
   if(response.status===204)return {status:204,body:null,diagnosticContext:context()};
   const declared=response.headers?.get('content-length');if(declared!==null&&declared!==undefined)check(/^\d+$/.test(declared)&&Number(declared)<=bound.bodyBytes,'production75_v1_bound');
   const chunks=[];let size=0;
   if(response.body){check(typeof response.body.getReader==='function','production75_v1_response');reader=response.body.getReader();for(;;){const {done,value}=await race(()=>reader.read());if(done)break;check(value instanceof Uint8Array,'production75_v1_response');size+=value.byteLength;check(size<=bound.bodyBytes,'production75_v1_bound');chunks.push(Buffer.from(value));}}
   const text=Buffer.concat(chunks).toString('utf8');let parsed=null;try{parsed=text?JSON.parse(text):null;}catch{throw responseFailure('json');}expired();return {status:response.status,body:parsed,diagnosticContext:context()};
  }catch(e){controller.abort();const failure=fail(ownedErrors.get(e)??'production75_v1_request');failureMetadata.set(failure,freeze({...context(),safeCode:responseReasons.get(e)??ownedErrors.get(failure)}));throw failure;}
  finally{clearTimeout(timer);if(reader){try{void reader.cancel()?.catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}else if(response?.body)try{void response.body.cancel()?.catch(()=>{});}catch{}}
 }
 const scoped=(permit,kind)=>{const scope=describeOperatorPermit(permit,kind,now);check(scope.organization===organization,'production75_v1_input');consumeOperatorPermit(permit,kind,scope.target,now);return scope;};
 return Object.freeze({
  async listClusters(deleted=false){check(typeof deleted==='boolean','production75_v1_input');const r=await request(`/api/v1/organizations/${organization}/postgres${deleted?'/deleted':''}`,{operation:'list-clusters'});return validated(r,()=>{check(Array.isArray(r.body?.data)&&r.body.data.length<=1000,'production75_v1_response');return freeze(r.body.data.map(value=>metadata(value)));});},
  async getCluster(id){safeSelector(id);const r=await request(`/api/v1/organizations/${organization}/postgres/${id}`,{operation:'get-cluster',notFound:true});if(r===null)return null;return validated(r,()=>{const m=metadata(r.body?.data,true);responseCheck(m.id===id,'selector');return m;});},
  async listBackups(id){safeSelector(id);const r=await request(`/api/v1/postgres/${id}/backups`,{operation:'list-backups'});return validated(r,()=>{check(Array.isArray(r.body?.data)&&r.body.data.length<=1000,'production75_v1_response');return freeze(r.body.data.map(b=>{check(b&&typeof b.id==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(b.id)&&['completed','pending','running','failed'].includes(b.status)&&['full','incr'].includes(b.type)&&typeof b.start==='string'&&Number.isFinite(Date.parse(b.start))&&(b.stop===null||typeof b.stop==='string'&&Number.isFinite(Date.parse(b.stop))),'production75_v1_response');return {id:b.id,status:b.status,type:b.type,start:b.start,stop:b.stop};}));});},
  async listUsers(id){safeSelector(id);const r=await request(`/api/v1/postgres/${id}/users`,{operation:'list-users'});return validated(r,()=>{check(Array.isArray(r.body?.data)&&r.body.data.length<=1000,'production75_v1_response');return freeze(r.body.data.map(u=>{check(u&&/^[a-z_][a-z0-9_-]{0,62}$/.test(u.name??'')&&['reader','writer','schema_admin'].includes(u.role),'production75_v1_response');return {name:u.name,role:u.role};}));});},
  async restoreCopy(permit){const s=scoped(permit,'copy-create');const r=await request(`/api/v1/postgres/${s.sourceCluster}/restore`,{operation:'restore-copy',method:'POST',body:{backup_id:s.backupId,name:s.copyName},statuses:[200,201],until:s.until,beforeDispatch:()=>markOperatorPermitDispatched(permit)});return validated(r,()=>{const m=metadata(r.body?.data,true);check(m.name===s.copyName&&m.id!==s.sourceCluster&&m.organization===organization,'production75_v1_response');return m;});},
  async createReader(permit){const s=scoped(permit,'reader-create');const r=await request(`/api/v1/postgres/${s.copyId}/users`,{operation:'create-reader',method:'POST',body:{user_name:s.readerName,role:'reader'},statuses:[200,201],until:s.until,beforeDispatch:()=>markOperatorPermitDispatched(permit)});return validated(r,()=>{const u=r.body?.data;check(u?.name===s.readerName&&u.role==='reader','production75_v1_response');return freeze({name:u.name,role:u.role});});},
  async deleteCopy(permit){const s=scoped(permit,'copy-delete');const r=await request(`/api/v1/organizations/${organization}/postgres/${s.copyId}`,{operation:'delete-copy',method:'DELETE',statuses:[200,202,204],until:s.until,beforeDispatch:()=>markOperatorPermitDispatched(permit)});return freeze({status:r.status,acknowledged:true});},
  async credentials(permit,kind){
   check(['source','writer','reader'].includes(kind),'production75_v1_input');const s=scoped(permit,`credentials-${kind}`),user=kind==='reader'?s.readerName:'fly-user';const r=await request(`/api/v1/postgres/${s.target}/users/${user}/credentials`,{operation:'credentials',until:s.until,beforeDispatch:()=>markOperatorPermitDispatched(permit)});return validated(r,()=>{const value=r.body?.data;
   check(value?.user===user&&typeof value.password==='string'&&Buffer.byteLength(value.password)>0&&Buffer.byteLength(value.password)<=8192&&!value.password.includes('\0'),'production75_v1_response');const ticket=Object.freeze({});secrets.set(ticket,freeze({user,password:value.password}));return ticket;});
  }
 });
}
