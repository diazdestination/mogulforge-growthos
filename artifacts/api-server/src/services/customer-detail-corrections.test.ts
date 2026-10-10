import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { auditEventsTable, contactsTable, db, leadsTable, organizationsTable, propertiesTable, usersTable, type UserRole } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getCustomerDetailCorrectionReceipt, getCustomerDetailSnapshot, saveCustomerDetailCorrection } from "./customer-detail-corrections";
let org:string, foreign:string;
beforeAll(async()=>{
 const target=new URL(process.env.DATABASE_URL??"");
 if(process.env.NODE_ENV!=="test" || !["127.0.0.1","localhost"].includes(target.hostname)) throw new Error("Use isolated synthetic test database");
 [org,foreign]=(await db.insert(organizationsTable).values([{name:"SYNTHETIC detail corrections",slug:randomUUID()},{name:"SYNTHETIC foreign details",slug:randomUUID()}]).returning()).map(r=>r.id);
});
afterAll(async()=>{ await deleteTestOrgs(org,foreign); });
async function fixture(){
 const actorUserId=randomUUID();
 await db.insert(usersTable).values({id:actorUserId,organizationId:org,role:"office",email:`${actorUserId}@example.invalid`,emailVerifiedAt:new Date(),isActive:true});
 const [a,b]=(await db.insert(contactsTable).values([{organizationId:org,firstName:"Synthetic",lastName:"Original",phone:"+44 20 1234 5678",doNotContact:true,doNotContactEmail:true,doNotContactSms:true,preferredContactMethod:"phone"},{organizationId:org,firstName:"Synthetic"}]).returning());
 const [p,second,wrong]=await db.insert(propertiesTable).values(["One","Two","Wrong"].map((label,index)=>({organizationId:org,contactId:index===2?b.id:a.id,addressLine1:`${label} Synthetic Lane`,city:"Example",state:"NY",postalCode:"00000"}))).returning();
 return {c:{organizationId:org,contactId:a.id,actorUserId,effectiveRole:"office" as UserRole},a,b,p,second,wrong};
}
async function command(f:Awaited<ReturnType<typeof fixture>>,changes:unknown,propertyId:string|null=null,requestId=randomUUID()){
 const snapshot=await getCustomerDetailSnapshot({...f.c,propertyId});
 return {requestId,propertyId,expectedVersion:snapshot.version,changes};
}
async function rows(f:Awaited<ReturnType<typeof fixture>>){
 const [a]=await db.select().from(contactsTable).where(eq(contactsTable.id,f.a.id));
 const [p]=await db.select().from(propertiesTable).where(eq(propertiesTable.id,f.p.id)); return {a,p};
}
it("reads only explicitly selected property or contact-only snapshot with complete contextual identity",async()=>{
 const f=await fixture();
 expect(await getCustomerDetailSnapshot({...f.c,propertyId:null})).toMatchObject({organizationId:org,contactId:f.a.id,propertyId:null,details:{property:null},version:{propertyUpdatedAt:null}});
 expect(await getCustomerDetailSnapshot({...f.c,propertyId:f.second.id})).toMatchObject({propertyId:f.second.id,details:{property:{addressLine1:"Two Synthetic Lane"}}});
 await expect(getCustomerDetailSnapshot({...f.c,propertyId:f.wrong.id})).rejects.toMatchObject({status:409,code:"detail_correction_property_parent_changed"});
});
it("denies foreign organization/customer/property and missing selected records",async()=>{
 const f=await fixture(); const [foreignContact]=await db.insert(contactsTable).values({organizationId:foreign,firstName:"Foreign synthetic"}).returning();
 const [foreignProperty]=await db.insert(propertiesTable).values({organizationId:foreign,contactId:foreignContact.id,addressLine1:"Foreign",city:"Example",state:"NY",postalCode:"00000"}).returning();
 await expect(getCustomerDetailSnapshot({...f.c,organizationId:foreign,contactId:foreignContact.id,propertyId:null})).rejects.toMatchObject({status:403});
 for(const contactId of [foreignContact.id,randomUUID()]) await expect(getCustomerDetailSnapshot({...f.c,contactId,propertyId:null})).rejects.toMatchObject({status:404});
 for(const propertyId of [foreignProperty.id,randomUUID()]) await expect(getCustomerDetailSnapshot({...f.c,propertyId})).rejects.toMatchObject({status:404});
});
it("rereads active accepted actual role and allows effective role only to narrow access",async()=>{
 const f=await fixture();
 for(const role of ["viewer","production"] as const){
  await db.update(usersTable).set({role}).where(eq(usersTable.id,f.c.actorUserId));
  await expect(getCustomerDetailSnapshot({...f.c,effectiveRole:"owner",propertyId:null})).rejects.toMatchObject({status:403});
 }
 await db.update(usersTable).set({role:"owner"}).where(eq(usersTable.id,f.c.actorUserId));
 await expect(getCustomerDetailSnapshot({...f.c,effectiveRole:"viewer",propertyId:null})).rejects.toMatchObject({status:403});
 await db.update(usersTable).set({isActive:false}).where(eq(usersTable.id,f.c.actorUserId));
 await expect(getCustomerDetailSnapshot({...f.c,effectiveRole:"owner",propertyId:null})).rejects.toMatchObject({status:403});
 await db.update(usersTable).set({isActive:true,emailVerifiedAt:null}).where(eq(usersTable.id,f.c.actorUserId));
 await expect(getCustomerDetailSnapshot({...f.c,effectiveRole:"owner",propertyId:null})).rejects.toMatchObject({status:403});
});
it("rejects protected-field injection before saving any allowed field",async()=>{
 const f=await fixture(), before=await rows(f), input=await command(f,{firstName:"Changed",doNotContact:false});
 await expect(saveCustomerDetailCorrection({...f.c,input})).rejects.toMatchObject({status:400}); expect(await rows(f)).toEqual(before);
});
it("refuses separately stale contact and property versions and reassigned property parent",async()=>{
 for(const kind of ["contact","property","parent"]){
  const f=await fixture(), input=await command(f,{firstName:"Changed",property:{city:"Changed"}},f.p.id);
  if(kind==="contact") await db.update(contactsTable).set({updatedAt:new Date(f.a.updatedAt.getTime()+1000)}).where(eq(contactsTable.id,f.a.id));
  else await db.update(propertiesTable).set(kind==="parent"?{contactId:f.b.id}:{updatedAt:new Date(f.p.updatedAt.getTime()+1000)}).where(eq(propertiesTable.id,f.p.id));
  const before=await rows(f); await expect(saveCustomerDetailCorrection({...f.c,input})).rejects.toMatchObject({status:409}); expect(await rows(f)).toEqual(before);
 }
});
it("saves both selected rows atomically with monotonic timestamps and a scoped original lost-response receipt",async()=>{
 const f=await fixture(), input=await command(f,{firstName:" Changed ",property:{city:"New City"}},f.p.id);
 const saved=await saveCustomerDetailCorrection({...f.c,input});
 expect(saved).toMatchObject({replayed:false,receipt:{requestId:input.requestId,status:"saved",changedFields:["firstName","property.city"],snapshot:{organizationId:org,contactId:f.a.id,propertyId:f.p.id}}});
 const current=await rows(f); expect(current.a.updatedAt.getTime()).toBeGreaterThan(f.a.updatedAt.getTime()); expect(current.p.updatedAt.getTime()).toBeGreaterThan(f.p.updatedAt.getTime());
 expect(await getCustomerDetailCorrectionReceipt({...f.c,requestId:input.requestId})).toEqual(saved.receipt);
 await saveCustomerDetailCorrection({...f.c,input:await command(f,{lastName:"Later"},f.p.id)});
 expect(await saveCustomerDetailCorrection({...f.c,input})).toEqual({receipt:saved.receipt,replayed:true});
 expect(await getCustomerDetailCorrectionReceipt({...f.c,contactId:f.b.id,requestId:input.requestId})).toBeNull();
});
it("rejects same request ID changed payload or foreign actor and leaves exactly one audit receipt",async()=>{
 const f=await fixture(), input=await command(f,{firstName:"Changed"}); await saveCustomerDetailCorrection({...f.c,input});
 await expect(saveCustomerDetailCorrection({...f.c,input:{...input,changes:{firstName:"Different"}}})).rejects.toMatchObject({status:409});
 const otherActor=randomUUID(); await db.insert(usersTable).values({id:otherActor,organizationId:org,role:"owner",emailVerifiedAt:new Date()});
 await expect(saveCustomerDetailCorrection({...f.c,actorUserId:otherActor,input})).rejects.toMatchObject({status:409});
 expect(await getCustomerDetailCorrectionReceipt({...f.c,actorUserId:otherActor,requestId:input.requestId})).toBeNull();
 expect(await db.select().from(auditEventsTable).where(eq(auditEventsTable.id,input.requestId))).toHaveLength(1);
});
it("records explicit no-op without changing either row and replays its one original receipt",async()=>{
 const f=await fixture(), input=await command(f,{firstName:f.a.firstName,property:{city:f.p.city}},f.p.id), before=await rows(f);
 const saved=await saveCustomerDetailCorrection({...f.c,input}); expect(saved.receipt).toMatchObject({status:"unchanged",changedFields:[]}); expect(await rows(f)).toEqual(before);
 expect(await saveCustomerDetailCorrection({...f.c,input})).toEqual({receipt:saved.receipt,replayed:true});
});
it("rolls back both row edits on an audit primary-key collision belonging to another customer",async()=>{
 const f=await fixture(), requestId=randomUUID(), input=await command(f,{firstName:"Changed",property:{city:"Changed"}},f.p.id,requestId), before=await rows(f);
 await db.insert(auditEventsTable).values({id:requestId,organizationId:org,actorUserId:f.c.actorUserId,action:"synthetic.history",entityType:"contact",entityId:f.b.id,metadata:{synthetic:true}});
 await expect(saveCustomerDetailCorrection({...f.c,input})).rejects.toMatchObject({status:409,code:"detail_correction_request_conflict"}); expect(await rows(f)).toEqual(before);
});
it("changes phone text without changing DNC, acquisition history, ownership or invoking outbound fetch",async()=>{
 const f=await fixture(); const [lead]=await db.insert(leadsTable).values({organizationId:org,contactId:f.a.id,propertyId:f.p.id}).returning();
 const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Outbound forbidden in synthetic test"));
 try{
  await saveCustomerDetailCorrection({...f.c,input:await command(f,{phone:"+44 (20) 9999 8888"})});
  const after=await rows(f); expect(after.a).toMatchObject({organizationId:org,createdAt:f.a.createdAt,doNotContact:true,doNotContactEmail:true,doNotContactSms:true,preferredContactMethod:"phone",phone:"+44 (20) 9999 8888"});
  expect(await db.select().from(leadsTable).where(eq(leadsTable.id,lead.id))).toEqual([lead]); expect(fetchSpy).not.toHaveBeenCalled();
 } finally {fetchSpy.mockRestore();}
});
it("serializes two native PostgreSQL saves from one version so exactly one writes",async()=>{
 const f=await fixture(), input=await command(f,{firstName:"One"});
 const results=await Promise.allSettled([saveCustomerDetailCorrection({...f.c,input}),saveCustomerDetailCorrection({...f.c,input:{...input,requestId:randomUUID(),changes:{firstName:"Two"}}})]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1); expect(results.filter(r=>r.status==="rejected")).toMatchObject([{reason:{status:409,code:"detail_correction_stale_version"}}]);
 const audits=await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId,org),eq(auditEventsTable.entityId,f.a.id))); expect(audits).toHaveLength(1);
});
it("does not relabel an unrelated database unique failure as an idempotency conflict",async()=>{
 const f=await fixture(), input=await command(f,{firstName:"Changed"});
 const unrelated=Object.assign(new Error("Synthetic unrelated failure"),{cause:{code:"23505",constraint:"other_table_pkey",table:"other_table"}});
 const transaction=vi.spyOn(db,"transaction").mockRejectedValueOnce(unrelated);
 try { await expect(saveCustomerDetailCorrection({...f.c,input})).rejects.toBe(unrelated); }
 finally {transaction.mockRestore();}
});
