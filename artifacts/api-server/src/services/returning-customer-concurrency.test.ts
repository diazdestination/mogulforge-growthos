import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { customerWorkCommandsTable, customerWorkRootsTable, db, invoiceOperationsTable, invoiceReceiptAllocationsTable, invoicesTable, leadsTable, pool, projectsTable, propertiesTable, valueEntriesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { acceptedReturningEstimate, returningCustomerFixture, returningEstimateDraft, returningInvoiceDocument, returningProjectDraft } from "../test-helpers/returning-customer-fixture";
import { createCustomerWorkEstimate, createCustomerWorkProject, updateCustomerWorkEstimate } from "./returning-customer";
import { INVOICE_HISTORY_RETAINED, VALUE_HISTORY_RETAINED, mergeLeads, updateContact, updateLead, updateProperty } from "./crm";
import { allocateInvoiceValue, createInvoice, getInvoice, issueInvoice, recordInvoicePayment, recordInvoiceRefund, reverseInvoiceAllocation } from "./invoices";
import { recordValueEntry } from "./revenue-workspace";
import { commitFinancialMigration, previewFinancialMigration } from "./financial-migration";
import { financialSourceFixture } from "../test-helpers/financial-migration-fixture";
const realPg=it.skipIf(process.env.SCHEDULER_TEST_BACKEND==="pglite"),orgs:string[]=[],sessions:string[]=[],realFetch=globalThis.fetch,origin="https://returning-race.example";
let server:Server|undefined,base:string;
beforeAll(async()=>{vi.stubEnv("APP_ORIGIN",origin);vi.stubEnv("SESSION_SECRET","synthetic-returning-race-session");if(process.env.SCHEDULER_TEST_BACKEND!=="pglite"){server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server!.once("listening",resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;}vi.stubGlobal("fetch",async()=>{throw Error("Only captured loopback staff HTTP may run");});});
afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}for(const sid of sessions)await deleteSession(sid);await deleteTestOrgs(...orgs);vi.unstubAllGlobals();vi.unstubAllEnvs();});
async function fixture(){const f=await returningCustomerFixture();orgs.push(f.org);return f;}
function observe<T>(p:Promise<T>,all:Promise<unknown>[]){all.push(p);void p.catch(()=>{});return p;}
async function blockedBy(blocker:number,pattern:string){for(let i=0;i<150;i++){const {rows}=await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",[blocker,pattern]);if(rows[0])return Number(rows[0].pid);await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`Actual independent PostgreSQL barrier not observed: ${pattern}`);}
async function barrier(table:string,timing:"BEFORE INSERT"|"AFTER UPDATE",condition:string){const suffix=randomUUID().replaceAll("-",""),hook=`qa_returning_${suffix}`,key=`qa-returning-${suffix}`,keeper=await pool.connect();await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(hashtext('${key}')); END IF; RETURN NEW; END $$`);await pool.query(`CREATE TRIGGER ${hook} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`);await keeper.query("BEGIN");await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))",[key]);const pid=Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);return {pid,release:()=>keeper.query("COMMIT"),cleanup:async(pending:Promise<unknown>[])=>{await keeper.query("ROLLBACK");keeper.release();await Promise.allSettled(pending);await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`);await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);}};}
const command=(version:number)=>({requestId:randomUUID(),expectedVersion:version,confirmed:true as const});

realPg("retains actual returning-work contact, property and accepted member locks through native command commit while ordinary writers wait",async()=>{
  const f=await fixture(),pending:Promise<unknown>[]=[],input=returningEstimateDraft(f),b=await barrier("customer_work_commands","BEFORE INSERT",`NEW.organization_id='${f.org}'::uuid`);
  const sid=await createSession({user:{id:f.owner.id,email:null,firstName:null,lastName:null,profileImageUrl:null},access_token:"synthetic"});sessions.push(sid);
  try{
    const creating=observe(createCustomerWorkEstimate(f.org,{userId:f.office.id,effectiveRole:"office"},input),pending),creator=await blockedBy(b.pid,'%insert into "customer_work_commands"%');
    const property=observe(updateProperty(f.org,f.secondProperty.id,{contactId:f.otherContact.id}),pending),contact=observe(updateContact(f.org,f.contact.id,{firstName:"Later actual customer edit"}),pending),member=observe(realFetch(`${base}/api/v1/users/${f.office.id}`,{method:"PATCH",headers:{origin,cookie:`sid=${sid}`,"content-type":"application/json"},body:JSON.stringify({isActive:false})}),pending);
    const writers=await Promise.all([blockedBy(creator,'%from "properties"%for update%'),blockedBy(creator,'%update "contacts"%'),blockedBy(creator,'%update "users"%')]);expect(new Set([...writers,creator,b.pid]).size).toBe(5);
    expect(await db.select().from(customerWorkRootsTable).where(eq(customerWorkRootsTable.organizationId,f.org))).toHaveLength(0);
    await b.release();const result=await creating;expect(result.estimate).toMatchObject({contactId:f.contact.id,propertyId:f.secondProperty.id,customerLabel:"Synthetic Returning Customer"});
    await expect(property).rejects.toMatchObject({code:"customer_work_parent_locked"});expect(await contact).toMatchObject({firstName:"Later actual customer edit"});expect((await member).status).toBe(200);
    await expect(createCustomerWorkEstimate(f.org,{userId:f.office.id},input)).rejects.toMatchObject({code:"customer_work_access_denied"});
    expect(await db.select().from(customerWorkCommandsTable).where(eq(customerWorkCommandsTable.organizationId,f.org))).toHaveLength(1);
  }finally{await b.cleanup(pending);}
},20000);

realPg("waits for an actual property reassignment then refuses stale returning customer selection with no root or native command",async()=>{
  const f=await fixture(),pending:Promise<unknown>[]=[],b=await barrier("properties","AFTER UPDATE",`NEW.id='${f.secondProperty.id}'::uuid`);
  try{
    const moving=observe(updateProperty(f.org,f.secondProperty.id,{contactId:f.otherContact.id}),pending),writer=await blockedBy(b.pid,'%update "properties"%');
    const creating=observe(createCustomerWorkEstimate(f.org,f.actor,returningEstimateDraft(f)),pending),creator=await blockedBy(writer,'%from "properties"%for share%');expect(new Set([b.pid,writer,creator]).size).toBe(3);
    await b.release();await moving;await expect(creating).rejects.toMatchObject({code:"customer_work_parent_mismatch"});
    expect(await db.select().from(customerWorkRootsTable).where(eq(customerWorkRootsTable.organizationId,f.org))).toHaveLength(0);expect(await db.select().from(customerWorkCommandsTable).where(eq(customerWorkCommandsTable.organizationId,f.org))).toHaveLength(0);
  }finally{await b.cleanup(pending);}
},20000);

realPg("serializes actual estimate conversion with duplicate creation and accepted-price writers into one retained native job",async()=>{
  for(const mode of ["duplicate","estimate"] as const){
    const f=await fixture(),accepted=await acceptedReturningEstimate(f),input={...returningProjectDraft(f),source:{kind:"estimate",estimateId:accepted.estimate.id,expectedWorkVersion:2}},pending:Promise<unknown>[]=[],b=await barrier("projects","BEFORE INSERT",`NEW.organization_id='${f.org}'::uuid`);
    try{
      const converting=observe(createCustomerWorkProject(f.org,f.actor,input),pending),creator=await blockedBy(b.pid,'%insert into "projects"%');
      const {source:_source,...edit}=returningEstimateDraft(f);
      const next=observe<unknown>(mode==="duplicate"?createCustomerWorkProject(f.org,f.actor,input):updateCustomerWorkEstimate(f.org,f.actor,accepted.estimate.id,{...edit,expectedWorkVersion:2,status:"accepted",taxCents:1}),pending),writer=await blockedBy(creator,'%pg_advisory_xact_lock%');expect(new Set([b.pid,creator,writer]).size).toBe(3);
      await b.release();const result=await converting;
      if(mode==="duplicate")expect(await next).toMatchObject({command:{duplicate:true,targetId:result.project.id}});else await expect(next).rejects.toMatchObject({code:"customer_work_estimate_retained"});
      expect(await db.select().from(projectsTable).where(eq(projectsTable.customerWorkId,accepted.estimate.customerWorkId!))).toHaveLength(1);
    }finally{await b.cleanup(pending);}
  }
},30000);

realPg("retains one returning invoice number and original issue operation under concurrent exact-request recovery",async()=>{
  const f=await fixture(),draft=(await createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"existing_customer",contactId:f.contact.id,propertyId:null},document:returningInvoiceDocument()})).invoice,input=command(draft.version),pending:Promise<unknown>[]=[],b=await barrier("invoice_operations","BEFORE INSERT",`NEW.organization_id='${f.org}'::uuid AND NEW.action='issued'`);
  try{
    const first=observe(issueInvoice(f.org,f.owner.id,draft.id,input),pending),issuer=await blockedBy(b.pid,'%insert into "invoice_operations"%');
    const duplicate=observe(issueInvoice(f.org,f.owner.id,draft.id,input),pending),waiter=await blockedBy(issuer,'%pg_advisory_xact_lock%');expect(new Set([b.pid,issuer,waiter]).size).toBe(3);
    await b.release();const result=await first;expect(result.invoice.invoiceNumber).toBe("INV-000001");expect(await duplicate).toMatchObject({duplicate:true,invoice:{id:draft.id,invoiceNumber:"INV-000001"}});
    expect(await db.select().from(invoiceOperationsTable).where(and(eq(invoiceOperationsTable.organizationId,f.org),eq(invoiceOperationsTable.action,"issued")))).toHaveLength(1);
  }finally{await b.cleanup(pending);}
},20000);

realPg("serializes original returning cash allocation and refund corrections without exceeding the exact receipt or invoice allocation",async()=>{
  const f=await fixture(),firstDraft=(await createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"existing_customer",contactId:f.contact.id,propertyId:null},document:returningInvoiceDocument()})).invoice,one=(await issueInvoice(f.org,f.owner.id,firstDraft.id,command(1))).invoice;
  const secondDraft=(await createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"customer_work",customerWorkId:one.customerWorkId},document:returningInvoiceDocument()})).invoice,two=(await issueInvoice(f.org,f.owner.id,secondDraft.id,command(1))).invoice;
  const paid=(await recordInvoicePayment(f.org,f.owner.id,one.id,{...command(one.version),amountCents:10000,sourceReference:`race-cash-${randomUUID()}`,occurredAt:new Date(Date.now()-60000).toISOString()})).invoice,original=paid.allocations[0];
  const released=(await reverseInvoiceAllocation(f.org,f.owner.id,one.id,original.id,{...command(paid.version),reason:"Split only the original recorded allocation"})).invoice,pending:Promise<unknown>[]=[],b=await barrier("invoice_receipt_allocations","BEFORE INSERT",`NEW.invoice_id='${one.id}'::uuid AND NEW.kind='payment'`);
  try{
    const first=observe(allocateInvoiceValue(f.org,f.owner.id,one.id,{...command(released.version),valueEntryId:original.valueEntryId,amountCents:6000}),pending),allocator=await blockedBy(b.pid,'%insert into "invoice_receipt_allocations"%');
    const excess=observe(allocateInvoiceValue(f.org,f.owner.id,two.id,{...command(two.version),valueEntryId:original.valueEntryId,amountCents:6000}),pending),waiter=await blockedBy(allocator,'%pg_advisory_xact_lock%');expect(new Set([b.pid,allocator,waiter]).size).toBe(3);
    await b.release();await first;await expect(excess).rejects.toMatchObject({code:"invoice_receipt_unavailable"});
  }finally{await b.cleanup(pending);}
  const split=(await allocateInvoiceValue(f.org,f.owner.id,two.id,{...command(two.version),valueEntryId:original.valueEntryId,amountCents:4000})).invoice,current=await getInvoice(f.org,f.owner.id,one.id),refundPending:Promise<unknown>[]=[],rb=await barrier("invoice_receipt_allocations","BEFORE INSERT",`NEW.invoice_id='${one.id}'::uuid AND NEW.kind='refund'`);
  const refund=(invoiceId:string,version:number,amountCents:number)=>recordInvoiceRefund(f.org,f.owner.id,invoiceId,{...command(version),originalPaymentValueEntryId:original.valueEntryId,amountCents,sourceReference:`race-refund-${randomUUID()}`,occurredAt:new Date().toISOString(),reason:"Actual office-recorded external refund correction"});
  try{
    const first=observe(refund(one.id,current.version,6000),refundPending),refunder=await blockedBy(rb.pid,'%insert into "invoice_receipt_allocations"%'),excess=observe(refund(two.id,split.version,5000),refundPending),waiter=await blockedBy(refunder,'%pg_advisory_xact_lock%');expect(new Set([rb.pid,refunder,waiter]).size).toBe(3);
    await rb.release();expect((await first).invoice.recordedPaidCents).toBe(0);await expect(excess).rejects.toMatchObject({code:"invoice_refund_cash_conflict"});
    expect((await getInvoice(f.org,f.owner.id,two.id)).recordedPaidCents).toBe(4000);
    expect(await db.select().from(invoiceReceiptAllocationsTable).where(and(eq(invoiceReceiptAllocationsTable.organizationId,f.org),eq(invoiceReceiptAllocationsTable.kind,"refund")))).toHaveLength(1);
  }finally{await rb.cleanup(refundPending);}
},30000);

async function legacyMoneyFixture(mode:"cash"|"migration") {
  const f=await fixture(),[lead,survivor]=await db.insert(leadsTable).values([
    {organizationId:f.org,contactId:f.contact.id,propertyId:f.secondProperty.id},
    {organizationId:f.org,contactId:f.contact.id},
  ]).returning();
  if(mode==="cash") return {...f,lead,survivor,write:()=>recordValueEntry(f.org,f.owner.id,{leadId:lead.id,kind:"payment",amountCents:3000,sourceReference:`original-cash-${randomUUID()}`,occurredAt:new Date().toISOString(),confirmed:true})};
  const preview=await previewFinancialMigration(f.org,f.owner.id,{sourceJson:JSON.stringify(financialSourceFixture(lead.id))});
  if(!preview.valid) throw Error("Synthetic original migration review was refused");
  return {...f,lead,survivor,write:()=>commitFinancialMigration(f.org,f.owner.id,preview.review.id,{expectedDigest:preview.review.digest,confirmed:true,sourceFrozen:true})};
}

realPg("retains original legacy cash and imported invoice lineage against actual property and merge writers",async()=>{
  for(const mode of ["cash","migration"] as const) {
    const f=await legacyMoneyFixture(mode),pending:Promise<unknown>[]=[],b=await barrier("value_entries","BEFORE INSERT",`NEW.organization_id='${f.org}'::uuid`);
    try {
      const recording=observe<unknown>(f.write(),pending),writer=await blockedBy(b.pid,'%insert into "value_entries"%');
      const moving=observe(updateProperty(f.org,f.secondProperty.id,{contactId:f.otherContact.id}),pending),merging=observe(mergeLeads(f.org,f.survivor.id,f.lead.id,f.owner.id),pending),reparenting=observe(updateLead(f.org,f.lead.id,{propertyId:f.firstProperty.id}),pending);
      const propertyWriter=await blockedBy(writer,'%from "properties"%for update%');
      const waits=await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'",[writer]);
      // Observe both real schedule-prefix writers, not merely outstanding JS promises.
      for(let attempt=0;waits.rows.length<2&&attempt<150;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,10));
        const latest=await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'",[writer]);waits.rows=latest.rows;
      }
      expect(waits.rows).toHaveLength(2);expect(new Set([b.pid,writer,propertyWriter,...waits.rows.map(row=>Number(row.pid))]).size).toBe(5);
      await b.release();await recording;
      const code=mode==="cash"?VALUE_HISTORY_RETAINED:INVOICE_HISTORY_RETAINED;
      await expect(moving).rejects.toMatchObject({code});await expect(reparenting).rejects.toMatchObject({code});expect(await merging).toEqual({ok:false,error:code});
      expect((await db.select().from(leadsTable).where(eq(leadsTable.id,f.lead.id)))[0]).toMatchObject({contactId:f.contact.id,propertyId:f.secondProperty.id,status:"new"});
      expect((await db.select().from(propertiesTable).where(eq(propertiesTable.id,f.secondProperty.id)))[0].contactId).toBe(f.contact.id);
      expect(await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.organizationId,f.org))).toHaveLength(1);
    } finally {await b.cleanup(pending);}
  }
},30000);

realPg("rereads actual property ownership before original legacy cash or historical import commit with no financial writes",async()=>{
  for(const mode of ["cash","migration"] as const) {
    const f=await legacyMoneyFixture(mode),pending:Promise<unknown>[]=[],b=await barrier("properties","AFTER UPDATE",`NEW.id='${f.secondProperty.id}'::uuid`);
    try {
      const moving=observe(updateProperty(f.org,f.secondProperty.id,{contactId:f.otherContact.id}),pending),writer=await blockedBy(b.pid,'%update "properties"%');
      const recording=observe<unknown>(f.write(),pending),reader=await blockedBy(writer,'%from "properties"%for share%');expect(new Set([b.pid,writer,reader]).size).toBe(3);
      await b.release();await moving;await expect(recording).rejects.toMatchObject({status:409});
      expect(await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.organizationId,f.org))).toHaveLength(0);expect(await db.select().from(invoicesTable).where(eq(invoicesTable.organizationId,f.org))).toHaveLength(0);
      expect((await db.select().from(leadsTable).where(eq(leadsTable.id,f.lead.id)))[0]).toMatchObject({contactId:f.contact.id,propertyId:f.secondProperty.id});
    }finally{await b.cleanup(pending);}
  }
},30000);
