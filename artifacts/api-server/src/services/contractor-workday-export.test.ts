import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value&&typeof value==="object"?`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`:JSON.stringify(value)??"null";
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const secret="SYNTHETIC_PRIVATE_WORKDAY_MUST_NOT_EXPORT";
const facts={category:"hvac_equipment",label:"Recorded unit",manufacturer:null,model:null,serial:null,location:null,installedOn:null,notes:null,warrantyStartsOn:null,warrantyEndsOn:null,warrantySource:null,attributes:[{label:"Unit type",value:"Recorded description",privateStaff:secret}],privateStaff:secret};
const definition={name:"Recorded company checklist",trade:"hvac",description:"Staff-recorded observations only",items:[{key:"scope",label:"Recorded observation",kind:"result",required:true,allowNotApplicable:false,unit:null,privateStaff:secret}],privateStaff:secret};
function fixture(tampered=false){
  const records:Record<string,Record<string,unknown>[]>={
    contacts:[{id:id(2)}],properties:[{id:id(3),contact_id:id(2)}],appointments:[{id:id(4),contact_id:id(2),property_id:id(3),lead_id:null}],stored_objects:[{id:id(5),content_type:"image/png",size_bytes:1}],
    property_assets:[{id:id(6),contact_id:id(2),property_id:id(3),version:1,status:"active",facts}],
    work_checklist_templates:[{id:id(7),version:1,status:"reviewed"}],
    work_checklist_revisions:[{id:id(8),template_id:id(7),version:1,definition,definition_sha256:tampered?"0".repeat(64):digest(definition),baseline_id:null,baseline_version:null,reviewed_at:"2026-10-06T00:00:00Z"}],
    appointment_work_completions:[{id:id(9),appointment_id:id(4),contact_id:id(2),property_id:id(3),original_completion_id:null,snapshot:{result:{id:id(9),appointmentId:id(4),contactId:id(2),propertyId:id(3),requestId:id(20),recordedByUserId:secret,performerUserId:secret,actingNote:secret,performedAt:"2026-10-06T00:00:00Z",recordedAt:"2026-10-06T00:00:00Z",summary:"Recorded performed work",outcome:"completed",followupTaskId:null,entries:[{id:id(10),version:2,checklistRevisionId:id(8),assetId:id(6),privateStaff:secret}],services:[],nativeAppointmentStatus:"completed"},parent:{privateStaff:secret},tasksBefore:[{description:secret}],previewToken:secret}},
      {id:id(11),appointment_id:id(4),contact_id:id(2),property_id:id(3),original_completion_id:id(9),snapshot:{note:"Append-only clarification",actingNote:secret}}],
    appointment_work_entries:[{id:id(10),appointment_id:id(4),contact_id:id(2),property_id:id(3),asset_id:id(6),service_obligation_id:null,checklist_revision_id:id(8),version:2,state:"finalized",asset_snapshot:{...facts,id:id(6),version:1},answers:[{itemKey:"scope",result:"done",value:null,reason:null,privateStaff:secret}],notes:"Recorded field note",completion_id:id(9)}],
    appointment_work_photos:[{id:id(12),appointment_id:id(4),entry_id:id(10),object_id:id(5),state:"attached",item_key:null,caption:"Recorded private photo",content_type:"image/png",size_bytes:1,object_sha256:"a".repeat(64),privateObjectPath:secret}],
  };
  const queries:string[]=[];
  const client={connect:async()=>{},end:async()=>{},on:()=>{},query:async(input:string|{text:string;values?:unknown[]})=>{
    const text=typeof input==="string"?input:input.text;queries.push(text);
    if(text.includes("FROM public.users"))return{rows:[{id:"synthetic-owner"}]};
    if(text.startsWith("SELECT id, name, slug"))return{rows:[{id:id(1),name:"FICTIONAL export company",slug:"synthetic-export",created_at:"2026-10-06T00:00:00Z"}]};
    const match=text.match(/^SELECT (.+) FROM public\."([a-z_]+)" WHERE organization_id/);
    if(match){const columns=[...match[1].matchAll(/"([a-z_][a-z_0-9]*)"/g)].map(row=>row[1]);return{rows:(records[match[2]]??[]).map(row=>Object.fromEntries(columns.map(key=>[key,row[key]??null])))};}
    return{rows:[]};
  }};
  return{queries,client};
}
describe("closed workday business export",()=>{
  it("retains usable linked business history and drops raw internal identities/capabilities recursively",async()=>{
    const {client}=fixture();
    const result=await createCustomerLifecycleExporter({createClient:()=>client as never})(id(1),"synthetic-owner");
    expect(result.manifest.tables).toHaveLength(28);
    expect(result.manifest.tables.map(row=>row.table)).toContain("customer_work_roots");
    expect(result.manifest.tables.map(row=>row.table)).not.toContain("customer_work_commands");
    expect(result.data.property_assets).toHaveLength(1);
    expect(result.data.appointment_work_entries).toHaveLength(1);
    expect(result.data.appointment_work_completions).toHaveLength(2);
    expect(result.data.appointment_work_photos).toHaveLength(1);
    expect(result.data.appointment_work_entries[0].completion_id).toBe(id(9));
    expect(result.data.appointment_work_completions[1].snapshot).toEqual({note:"Append-only clarification"});
    const revision=result.data.work_checklist_revisions[0];
    expect(revision.definition_sha256).toBe(digest(definition));
    expect(revision.exported_definition_sha256).toBe(digest(revision.definition));
    expect(revision.exported_definition_sha256).not.toBe(revision.definition_sha256);
    expect(JSON.stringify(result.data)).not.toContain(secret);
    expect(JSON.stringify(result.data)).not.toMatch(/previewToken|privateObjectPath|tasksBefore|recordedByUserId|requestId/);
    expect(result.manifest.completeAccountExport).toBe(false);
  });
  it("refuses a tampered original checklist digest without an audit commit or partial archive",async()=>{
    const {client,queries}=fixture(true);
    await expect(createCustomerLifecycleExporter({createClient:()=>client as never})(id(1),"synthetic-owner")).rejects.toMatchObject({status:503,code:"customer_export_unavailable"});
    expect(queries.some(query=>query.startsWith("INSERT INTO public.audit_events"))).toBe(false);
    expect(queries.some(query=>query==="COMMIT")).toBe(false);
  });
});
