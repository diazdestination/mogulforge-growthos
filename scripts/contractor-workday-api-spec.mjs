/** Mechanical staff API projection from the pure closed workday contracts. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';
const requireApi=createRequire(new URL('../artifacts/api-server/package.json',import.meta.url));
const {z}=requireApi('zod');
const contracts=await tsImport('../artifacts/api-server/src/services/contractor-workday-contract.ts',import.meta.url);
const target=new URL('../lib/api-spec/openapi.yaml',import.meta.url);
let source=(await readFile(target,'utf8')).replace(/\r\n/g,'\n');
const schemas=new Map();
const normalize=value=>{if(!value || typeof value!=='object')return; if(value.type==='string' && ['date','date-time'].includes(value.format))delete value.pattern; for(const child of Object.values(value))normalize(child);};
function schema(name,key){ const value=z.toJSONSchema(contracts[key],{target:'openapi-3.0',unrepresentable:'throw'});delete value.$schema;normalize(value);schemas.set(name,value);return{$ref:`#/components/schemas/${name}`}; }
const definitions={
  WorkdayAssetPage:'workdayAssetPageSchema',WorkdayAssetMutation:'workdayAssetMutationSchema',WorkdayAsset:'workdayAssetSchema',
  WorkdayTemplateCatalog:'workdayTemplateCatalogSchema',WorkdayTemplate:'workdayTemplateSchema',WorkdayTemplateMutation:'workdayTemplateMutationSchema',WorkdayTemplatePreview:'workdayTemplatePreviewSchema',
  WorkdayAppointment:'appointmentWorkSchema',WorkdayMutation:'workdayMutationSchema',WorkdayCompletionPreview:'workdayCompletionPreviewSchema',WorkdayPhotoReservation:'workdayPhotoReservationSchema',WorkdayCompletion:'workdayCompletionSchema',WorkdayEntry:'workdayEntrySchema',
  WorkdayCreateAssetRequest:'createWorkdayAssetSchema',WorkdayUpdateAssetRequest:'updateWorkdayAssetSchema',
  WorkdayCreateTemplateRequest:'createWorkdayTemplateSchema',WorkdayReviseTemplateRequest:'reviseWorkdayTemplateSchema',WorkdayPreviewTemplateRequest:'previewWorkdayTemplateSchema',WorkdayApproveTemplateRequest:'approveWorkdayTemplateSchema',WorkdayRetireTemplateRequest:'retireWorkdayTemplateSchema',
  WorkdayCreateEntryRequest:'createWorkdayEntrySchema',WorkdaySaveEntryRequest:'saveWorkdayEntrySchema',WorkdayCancelEntryRequest:'cancelWorkdayEntrySchema',WorkdayPreviewCompletionRequest:'previewWorkdayCompletionSchema',WorkdayCompleteRequest:'completeWorkdaySchema',WorkdayCorrectRequest:'correctWorkdaySchema',WorkdayRequestPhotoRequest:'requestWorkdayPhotoSchema',WorkdayAttachPhotoRequest:'attachWorkdayPhotoSchema',
};
const refs=Object.fromEntries(Object.entries(definitions).map(([name,key])=>[name,schema(name,key)]));
const errors=Object.fromEntries(Object.entries({400:'Malformed closed fields or selector.',401:'Staff sign-in required.',403:'Current human staff, assignment, permission or origin restriction.',404:'Unavailable in this exact company/work context.',409:'Saved version, review or original-request conflict. Read saved work before changing intent.',415:'JSON mutation required.',503:'Unavailable or unknown acknowledgment; no completed work may be inferred.'}).map(([code,description])=>[code,{description}]));
function operation(id,description,response,input,permission,path,query=[]){
  return {operationId:id,tags:['contractor-workday'],summary:description,
    description:`Human accepted verified active company staff only; no API-key authority. Requires ${permission}, plus current assignment or explicit office-on-behalf authority for field writes. Saved drafts/researched baselines are not company review, physical proof, warranty coverage, customer acceptance, messages or payment. Exact original request/payload and immutable historical snapshots are preserved.`,
    parameters:[...Array.from(path.matchAll(/\{([^}]+)\}/g),m=>({name:m[1],in:'path',required:true,schema:{type:'string',format:'uuid'}})),...query],
    ...(input?{requestBody:{required:true,content:{'application/json':{schema:refs[input]}}}}:{}),
    responses:{200:{description:'Actual company-scoped saved record or bounded source view.',content:{'application/json':{schema:refs[response]}}},...errors}};
}
const paths=new Map();
function add(path,method,id,description,response,input,permission,query=[]){const row=paths.get(path)??{};row[method]=operation(id,description,response,input,permission,path,query);paths.set(path,row);}
add('/v1/contacts/{contactId}/assets','get','getWorkdayAssets','Read explicit paged customer/property assets','WorkdayAssetPage',null,'crm.read',[{name:'propertyId',in:'query',schema:{type:'string',format:'uuid'}},{name:'cursor',in:'query',schema:{type:'string',maxLength:1000}}]);
add('/v1/contacts/{contactId}/assets','post','createWorkdayAsset','Record an explicit property asset','WorkdayAssetMutation','WorkdayCreateAssetRequest','crm.write');
add('/v1/assets/{assetId}','patch','updateWorkdayAsset','Edit or retire recorded asset facts without reparenting','WorkdayAssetMutation','WorkdayUpdateAssetRequest','crm.write');
add('/v1/work-checklists','get','getWorkdayChecklists','Read company checklist revisions and unreviewed starters','WorkdayTemplateCatalog',null,'crm.read');
add('/v1/work-checklists','post','createWorkdayChecklist','Save a company draft, never auto-review a research starter','WorkdayTemplateMutation','WorkdayCreateTemplateRequest','settings.manage');
add('/v1/work-checklists/{templateId}','get','getWorkdayChecklist','Read exact company checklist history','WorkdayTemplate',null,'crm.read');
for(const [tail,id,description,input,response] of [
  ['revisions','reviseWorkdayChecklist','Create a new immutable draft revision','WorkdayReviseTemplateRequest','WorkdayTemplateMutation'],
  ['preview','previewWorkdayChecklist','Review exact saved company instructions','WorkdayPreviewTemplateRequest','WorkdayTemplatePreview'],
  ['approve','approveWorkdayChecklist','Approve the actor-bound exact revision','WorkdayApproveTemplateRequest','WorkdayTemplateMutation'],
  ['retire','retireWorkdayChecklist','Block new enrollment without rewriting history','WorkdayRetireTemplateRequest','WorkdayTemplateMutation'],
])add(`/v1/work-checklists/{templateId}/${tail}`,'post',id,description,response,input,'settings.manage');
add('/v1/appointments/{appointmentId}/work','get','getAppointmentWork','Read exact native visit work and separate service outcomes','WorkdayAppointment',null,'crm.read');
for(const [path,method,id,description,input,response] of [
  ['/entries','post','createAppointmentWorkEntry','Explicitly prepare an asset/checklist entry','WorkdayCreateEntryRequest','WorkdayMutation'],
  ['/entries/{entryId}','patch','saveAppointmentWorkEntry','Save actual field progress at the exact version','WorkdaySaveEntryRequest','WorkdayMutation'],
  ['/entries/{entryId}/cancel','post','cancelAppointmentWorkEntry','Cancel preparation without deleting recorded history','WorkdayCancelEntryRequest','WorkdayMutation'],
  ['/completion-preview','post','previewAppointmentWorkCompletion','Review all saved work and explicitly performed services','WorkdayPreviewCompletionRequest','WorkdayCompletionPreview'],
  ['/complete','post','completeAppointmentWork','Record one atomic staff-attested completion','WorkdayCompleteRequest','WorkdayMutation'],
  ['/completions/{completionId}/corrections','post','correctAppointmentWork','Append a note without replaying native effects','WorkdayCorrectRequest','WorkdayMutation'],
  ['/entries/{entryId}/photos/request-url','post','reserveAppointmentWorkPhoto','Reserve one exact native private image upload','WorkdayRequestPhotoRequest','WorkdayPhotoReservation'],
  ['/entries/{entryId}/photos','post','attachAppointmentWorkPhoto','Confirm the reserved exact work image','WorkdayAttachPhotoRequest','WorkdayMutation'],
])add(`/v1/appointments/{appointmentId}/work${path}`,method,id,description,response,input,'crm.write');
const mediaPath='/v1/appointments/{appointmentId}/work/photos/{photoId}/content';
const media=operation('getAppointmentWorkPhoto','Read exact authenticated private image bytes','WorkdayAppointment',null,'crm.read',mediaPath);
media.responses[200]={description:'Private bytes, never a public/portal grant.',content:Object.fromEntries(['image/jpeg','image/png','image/webp'].map(type=>[type,{schema:{type:'string',format:'binary'}}]))};
paths.set(mediaPath,{get:media});
for(const[name]of schemas)source=source.split('\n').filter(line=>!line.startsWith(`    ${name}: `)).join('\n');
for(const[path]of paths)source=source.split('\n').filter(line=>!line.startsWith(`  "${path}": `)).join('\n');
if(!source.includes('paths:\n')||!source.includes('  schemas:\n'))throw new Error('workday_openapi_anchors_missing');
source=source.replace('paths:\n',`paths:\n${[...paths].map(([path,value])=>`  "${path}": ${JSON.stringify(value)}`).join('\n')}\n`);
source=source.replace('  schemas:\n',`  schemas:\n${[...schemas].map(([name,value])=>`    ${name}: ${JSON.stringify(value)}`).join('\n')}\n`);
await writeFile(target,source);
console.log(JSON.stringify({paths:paths.size,operations:20,schemas:schemas.size,providerCalls:0}));
