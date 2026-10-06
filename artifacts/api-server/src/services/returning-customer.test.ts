import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activitiesTable, auditEventsTable, crmTasksTable, customerWorkCommandsTable, customerWorkRootsTable, db, estimatesTable, invoiceOperationsTable, invoicesTable, leadsTable, projectsTable, propertiesTable, usersTable, valueEntriesTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { acceptedReturningEstimate, returningCustomerFixture, returningEstimateDraft, returningInvoiceDocument, returningProjectDraft, type ReturningCustomerFixture } from "../test-helpers/returning-customer-fixture";
import { createCustomerWorkEstimate, createCustomerWorkProject, updateCustomerWorkEstimate, updateCustomerWorkProject } from "./returning-customer";
import { createInvoice, getInvoice, issueInvoice, listInvoices, readReturningInvoiceLineage, recordInvoicePayment, recordInvoiceRefund, reverseInvoiceAllocation, allocateInvoiceValue } from "./invoices";
import { deleteEstimate, deleteProject, getEstimate, getProject, listEstimates, listProjects, updateEstimate, updateProject, updateProperty, updateTask } from "./crm";
import { customerWorkEstimateMutationSchema, customerWorkProjectMutationSchema } from "./returning-customer-contract";
import { invoiceDocument, legacyCreateInvoiceSchema } from "./invoice-contract";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
const orgs:string[]=[];
async function fixture(){const f=await returningCustomerFixture();orgs.push(f.org);return f;}
afterAll(async()=>{await deleteTestOrgs(...orgs);});
const command=(version:number)=>({requestId:randomUUID(),expectedVersion:version,confirmed:true as const});
async function issued(f:ReturningCustomerFixture,extra:Record<string,unknown>={}) {
  const made=await createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"existing_customer",contactId:f.contact.id,propertyId:null},document:returningInvoiceDocument(),...extra});
  return (await issueInvoice(f.org,f.owner.id,made.invoice.id,command(made.invoice.version))).invoice;
}
async function noLeads(f:ReturningCustomerFixture){expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId,f.org))).toEqual([]);}
it("records a zero-lead estimate, explicit acceptance, one native job and issued invoice without fabricated acquisition or automatic cash",async()=>{
  const f=await fixture(),accepted=await acceptedReturningEstimate(f);
  customerWorkEstimateMutationSchema.parse(accepted);
  expect(accepted.estimate).toMatchObject({leadId:null,contactId:f.contact.id,propertyId:f.secondProperty.id,status:"accepted",workVersion:2});
  const input={...returningProjectDraft(f),source:{kind:"estimate",estimateId:accepted.estimate.id,expectedWorkVersion:2},status:"completed"};
  const job=await createCustomerWorkProject(f.org,f.actor,input);customerWorkProjectMutationSchema.parse(job);
  expect(job.project.customerWorkId).toBe(accepted.estimate.customerWorkId);
  const [task]=await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId,f.org),eq(crmTasksTable.sourceEvent,`project.invoice_preparation:${job.project.id}`)));
  expect(task).toMatchObject({leadId:null,contactId:f.contact.id,status:"open"});
  const dueAt=new Date("2037-01-01T12:00:00Z");
  await updateTask(f.org,task.id,{description:"Office authored billing instructions",assignedUserId:f.office.id,dueAt,status:"in_progress"});
  const invoice=await createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"customer_work",customerWorkId:job.project.customerWorkId},projectId:job.project.id,estimateId:accepted.estimate.id,document:returningInvoiceDocument()});
  expect(invoice.invoice).toMatchObject({leadId:null,customerWorkId:job.project.customerWorkId,contactId:f.contact.id,propertyId:f.secondProperty.id,status:"draft",recordedPaidCents:0});
  expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id,task.id)))[0]).toMatchObject({status:"done",description:"Office authored billing instructions",assignedUserId:f.office.id,dueAt});
  const final=await issueInvoice(f.org,f.owner.id,invoice.invoice.id,command(1));
  expect(final.invoice).toMatchObject({status:"issued",invoiceNumber:"INV-000001",recordedPaidCents:0,balanceDueCents:10000});
  expect(await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.organizationId,f.org))).toHaveLength(0);await noLeads(f);
});
it("retains original request targets and versions across lost acknowledgments and rejects actor/payload/action changes",async()=>{
  const f=await fixture(),input=returningEstimateDraft(f,null),first=await createCustomerWorkEstimate(f.org,f.actor,input);
  const replay=await createCustomerWorkEstimate(f.org,f.actor,input);expect(replay.command).toMatchObject({duplicate:true,targetId:first.estimate.id,version:1});
  await expect(createCustomerWorkEstimate(f.org,f.actor,{...input,title:"Different command"})).rejects.toMatchObject({code:"customer_work_request_conflict"});
  await expect(createCustomerWorkEstimate(f.org,{userId:f.office.id},input)).rejects.toMatchObject({code:"customer_work_request_conflict"});
  await expect(createCustomerWorkProject(f.org,f.actor,{...returningProjectDraft(f),requestId:input.requestId})).rejects.toMatchObject({code:"customer_work_request_conflict"});
  await expect(createCustomerWorkEstimate(f.org,{...f.actor,effectiveRole:"viewer"},input)).rejects.toMatchObject({code:"customer_work_access_denied"});
  await db.update(usersTable).set({isActive:false}).where(eq(usersTable.id,f.owner.id));
  await expect(createCustomerWorkEstimate(f.org,f.actor,input)).rejects.toMatchObject({code:"customer_work_access_denied"});
  expect(await db.select().from(customerWorkCommandsTable).where(eq(customerWorkCommandsTable.organizationId,f.org))).toHaveLength(1);
  expect(first.estimate.propertyId).toBeNull();await noLeads(f);
});
it("requires exact saved acceptance and permits only one native conversion without replacing retained estimate price",async()=>{
  const f=await fixture(),draft=returningEstimateDraft(f),saved=await createCustomerWorkEstimate(f.org,f.actor,draft);
  const input={...returningProjectDraft(f),source:{kind:"estimate",estimateId:saved.estimate.id,expectedWorkVersion:1}};
  await expect(createCustomerWorkProject(f.org,f.actor,input)).rejects.toMatchObject({code:"customer_work_estimate_not_accepted"});
  const {source:_source,...fields}=draft;
  const accepted=await updateCustomerWorkEstimate(f.org,f.actor,saved.estimate.id,{...fields,requestId:randomUUID(),status:"accepted",expectedWorkVersion:1});
  await expect(createCustomerWorkProject(f.org,f.actor,input)).rejects.toMatchObject({code:"customer_work_stale_version"});
  const job=await createCustomerWorkProject(f.org,f.actor,{...input,source:{...input.source,expectedWorkVersion:2}});
  await expect(createCustomerWorkProject(f.org,f.actor,{...input,requestId:randomUUID(),source:{...input.source,expectedWorkVersion:2}})).rejects.toMatchObject({code:"customer_work_project_exists"});
  await expect(updateCustomerWorkEstimate(f.org,f.actor,saved.estimate.id,{...fields,requestId:randomUUID(),status:"accepted",expectedWorkVersion:2,taxCents:1})).rejects.toMatchObject({code:"customer_work_estimate_retained"});
  expect((await getProject(f.org,job.project.id))?.estimateId).toBe(accepted.estimate.id);
});
it("holds foreign/mixed roots and properties before writes and never infers a property's root by equal customer",async()=>{
  const f=await fixture(),foreign=await fixture();
  for (const source of [{kind:"existing_customer",contactId:f.contact.id,propertyId:foreign.firstProperty.id},{kind:"existing_customer",contactId:f.otherContact.id,propertyId:f.firstProperty.id}]) await expect(createCustomerWorkEstimate(f.org,f.actor,{...returningEstimateDraft(f),source})).rejects.toMatchObject({code:"customer_work_parent_mismatch"});
  const a=await createCustomerWorkProject(f.org,f.actor,returningProjectDraft(f,f.firstProperty.id)),b=await acceptedReturningEstimate(f,f.firstProperty.id);
  await expect(createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"customer_work",customerWorkId:b.estimate.customerWorkId},projectId:a.project.id,document:returningInvoiceDocument()})).rejects.toMatchObject({code:"invoice_not_found"});
  await expect(createCustomerWorkProject(f.org,f.actor,{...returningProjectDraft(f),source:{kind:"estimate",estimateId:b.estimate.id,expectedWorkVersion:1}})).rejects.toMatchObject({code:"customer_work_stale_version"});
  await expect(createInvoice(f.org,f.owner.id,{requestId:randomUUID(),source:{kind:"existing_customer",contactId:f.contact.id,propertyId:null},projectId:a.project.id,document:returningInvoiceDocument()})).rejects.toBeDefined();
  await noLeads(f);
});
it("retains explicit property/root linkage across ordinary legacy mutation and deletion endpoints",async()=>{
  const f=await fixture(),estimate=await acceptedReturningEstimate(f),job=await createCustomerWorkProject(f.org,f.actor,{...returningProjectDraft(f),source:{kind:"estimate",estimateId:estimate.estimate.id,expectedWorkVersion:2}});
  for (const work of [()=>updateEstimate(f.org,estimate.estimate.id,{title:"unversioned"}),()=>updateProject(f.org,job.project.id,{name:"unversioned"})]) await expect(work()).rejects.toMatchObject({code:"customer_work_versioned_command_required"});
  for (const work of [()=>deleteEstimate(f.org,estimate.estimate.id),()=>deleteProject(f.org,job.project.id)]) await expect(work()).rejects.toMatchObject({code:"customer_work_history_retained"});
  await expect(updateProperty(f.org,f.secondProperty.id,{contactId:f.otherContact.id})).rejects.toMatchObject({code:"customer_work_parent_locked"});
  const original=await readReturningInvoiceLineage(db,f.org,(await issued(f,{source:{kind:"customer_work",customerWorkId:job.project.customerWorkId},projectId:job.project.id})).id,{actorUserId:f.owner.id});
  await updateProperty(f.org,f.secondProperty.id,{addressLine1:"Changed actual address"});
  await db.update(propertiesTable).set({updatedAt:original.property!.updatedAt}).where(eq(propertiesTable.id,f.secondProperty.id));
  const changed=await readReturningInvoiceLineage(db,f.org,original.invoice.id,{actorUserId:f.owner.id});
  expect(changed.sourceSha256).not.toBe(original.sourceSha256);expect(changed.invoice.document).toEqual(original.invoice.document);
});
it("preserves office preparation notes, assignment and deadline on versioned complete and reopen",async()=>{
  const f=await fixture(),input=returningProjectDraft(f,null),created=await createCustomerWorkProject(f.org,f.actor,{...input,status:"completed"});
  const [task]=await db.select().from(crmTasksTable).where(eq(crmTasksTable.sourceEvent,`project.invoice_preparation:${created.project.id}`));
  const dueAt=new Date("2034-01-01T12:00:00Z");await updateTask(f.org,task.id,{description:"Keep this original note",assignedUserId:f.office.id,dueAt,status:"done"});
  const {source:_source,...edit}=input;
  const reopened=await updateCustomerWorkProject(f.org,f.actor,created.project.id,{...edit,requestId:randomUUID(),expectedWorkVersion:1,status:"in_progress"});
  await updateCustomerWorkProject(f.org,f.actor,created.project.id,{...edit,requestId:randomUUID(),expectedWorkVersion:reopened.project.workVersion,status:"completed"});
  expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id,task.id)))[0]).toMatchObject({description:"Keep this original note",assignedUserId:f.office.id,dueAt,status:"open"});
});
it("reads old exact returning records independently of native list caps and scopes lists by canonical root/customer",async()=>{
  const f=await fixture(),first=await createCustomerWorkProject(f.org,f.actor,returningProjectDraft(f,null)),estimate=await acceptedReturningEstimate(f);
  await createCustomerWorkProject(f.org,f.actor,returningProjectDraft(f));
  const rows=await listProjects(f.org,{limit:1,offset:0});expect(rows).toHaveLength(1);
  expect(await getProject(f.org,first.project.id)).toMatchObject({id:first.project.id,leadId:null,contactId:f.contact.id,propertyId:null});
  expect(await listProjects(f.org,{customerWorkId:first.project.customerWorkId!})).toHaveLength(1);
  expect(await listEstimates(f.org,{customerWorkId:estimate.estimate.customerWorkId!})).toHaveLength(1);
  expect(await getEstimate(f.org,estimate.estimate.id)).toMatchObject({contactId:f.contact.id,sourceKind:"customer_work"});
});
it("records linked external refunds with exact original-payment and invoice caps without processor effects",async()=>{
  const f=await fixture(),invoice=await issued(f),paymentAt=new Date(Date.now()-60000).toISOString();
  const paid=(await recordInvoicePayment(f.org,f.owner.id,invoice.id,{...command(invoice.version),amountCents:10000,sourceReference:`receipt-${randomUUID()}`,occurredAt:paymentAt})).invoice;
  const original=paid.allocations[0],input={...command(paid.version),originalPaymentValueEntryId:original.valueEntryId,amountCents:3000,sourceReference:`refund-${randomUUID()}`,occurredAt:new Date(Date.now()-1000).toISOString(),reason:"Staff records external refund confirmation"};
  const refund=await recordInvoiceRefund(f.org,f.owner.id,invoice.id,input);expect(refund.invoice).toMatchObject({recordedPaidCents:7000,balanceDueCents:3000,paymentState:"partial"});
  expect(refund.invoice.allocations.find(a=>a.kind==="refund")).toMatchObject({refundOfValueEntryId:original.valueEntryId,amountCents:3000});
  expect((await recordInvoiceRefund(f.org,f.owner.id,invoice.id,input)).duplicate).toBe(true);
  await expect(recordInvoiceRefund(f.org,f.owner.id,invoice.id,{...input,requestId:randomUUID(),expectedVersion:refund.invoice.version,amountCents:7001})).rejects.toMatchObject({code:"invoice_refund_cash_conflict"});
  await expect(reverseInvoiceAllocation(f.org,f.owner.id,invoice.id,original.id,{...command(refund.invoice.version),reason:"Must retain linked original payment"})).rejects.toMatchObject({code:"invoice_refund_allocation_conflict"});
  const refundAllocation=refund.invoice.allocations.find(a=>a.kind==="refund")!;
  const reversed=(await reverseInvoiceAllocation(f.org,f.owner.id,invoice.id,refundAllocation.id,{...command(refund.invoice.version),reason:"Correct only this recorded allocation"})).invoice;
  expect(reversed).toMatchObject({recordedPaidCents:10000,paymentState:"reconciliation_required",unallocatedRefundCents:3000,balanceDueCents:null});
  const restored=(await allocateInvoiceValue(f.org,f.owner.id,invoice.id,{...command(reversed.version),valueEntryId:refundAllocation.valueEntryId,amountCents:3000})).invoice;
  expect(restored).toMatchObject({recordedPaidCents:7000,unallocatedRefundCents:0});
  const values=await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.organizationId,f.org));expect(values).toHaveLength(2);expect(values.every(v=>v.leadId===null && v.customerWorkId===invoice.customerWorkId)).toBe(true);await noLeads(f);
});
it("shares receipt allocations only inside one explicit work root, never across another job or a lead for the same customer",async()=>{
  const f=await fixture(),one=await issued(f),two=await issued(f,{source:{kind:"customer_work",customerWorkId:one.customerWorkId}}),other=await issued(f);
  const paid=(await recordInvoicePayment(f.org,f.owner.id,one.id,{...command(one.version),amountCents:10000,sourceReference:`cash-${randomUUID()}`,occurredAt:new Date(Date.now()-1000).toISOString()})).invoice,entry=paid.allocations[0];
  const released=(await reverseInvoiceAllocation(f.org,f.owner.id,one.id,entry.id,{...command(paid.version),reason:"Split recorded cash across this exact work"})).invoice;
  await allocateInvoiceValue(f.org,f.owner.id,one.id,{...command(released.version),valueEntryId:entry.valueEntryId,amountCents:5000});
  const split=(await allocateInvoiceValue(f.org,f.owner.id,two.id,{...command(two.version),valueEntryId:entry.valueEntryId,amountCents:5000})).invoice;
  await expect(allocateInvoiceValue(f.org,f.owner.id,other.id,{...command(other.version),valueEntryId:entry.valueEntryId,amountCents:1})).rejects.toMatchObject({code:"invoice_receipt_unavailable"});
  await expect(recordInvoiceRefund(f.org,f.owner.id,two.id,{...command(split.version),originalPaymentValueEntryId:entry.valueEntryId,amountCents:5001,sourceReference:`refund-${randomUUID()}`,occurredAt:new Date().toISOString(),reason:"Cannot refund another invoice's allocation"})).rejects.toMatchObject({code:"invoice_payment_conflict"});
  expect((await listInvoices(f.org,f.owner.id,{customerWorkId:one.customerWorkId!})).total).toBe(2);
  expect((await listInvoices(f.org,f.owner.id,{contactId:f.contact.id})).total).toBe(3);
});
it("keeps returning invoice replay bound to accepted current human authority and immutable original request",async()=>{
  const f=await fixture(),input={requestId:randomUUID(),source:{kind:"existing_customer",contactId:f.contact.id,propertyId:null},document:returningInvoiceDocument()};
  const result=await createInvoice(f.org,f.owner.id,input);
  expect((await createInvoice(f.org,f.owner.id,input)).invoice.id).toBe(result.invoice.id);
  await expect(createInvoice(f.org,f.office.id,input)).rejects.toMatchObject({code:"invoice_request_conflict"});
  await expect(createInvoice(f.org,f.owner.id,input,"viewer")).rejects.toMatchObject({code:"invoice_access_denied"});
  await db.update(usersTable).set({emailVerifiedAt:null}).where(eq(usersTable.id,f.owner.id));
  await expect(createInvoice(f.org,f.owner.id,input)).rejects.toMatchObject({code:"customer_work_access_denied"});
  expect(await db.select().from(customerWorkRootsTable).where(eq(customerWorkRootsTable.organizationId,f.org))).toHaveLength(1);
  expect(await db.select().from(invoiceOperationsTable).where(eq(invoiceOperationsTable.organizationId,f.org))).toHaveLength(1);
});
it("keeps the exact legacy parsed invoice creation fingerprint and source pool unchanged",async()=>{
  const f=await fixture(),[lead]=await db.insert(leadsTable).values({organizationId:f.org,contactId:f.contact.id,propertyId:f.firstProperty.id}).returning();
  const raw={requestId:randomUUID(),leadId:lead.id,document:{...returningInvoiceDocument(),lineItems:[{description:" Legacy exact parsed line ",quantity:"0001.250",unitPriceCents:8000}]}};
  const parsed=legacyCreateInvoiceSchema.parse(raw),input={...parsed,projectId:parsed.projectId??null,estimateId:parsed.estimateId??null,document:invoiceDocument(parsed.document)};
  const hash=createHash("sha256").update(JSON.stringify({action:"draft_created",input})).digest("hex"),result=await createInvoice(f.org,f.owner.id,raw);
  const [receipt]=await db.select().from(invoiceOperationsTable).where(eq(invoiceOperationsTable.requestId,raw.requestId));expect(receipt.fingerprint).toBe(hash);expect(result.invoice).toMatchObject({leadId:lead.id,customerWorkId:null,sourceKind:"lead"});
  expect((await createInvoice(f.org,f.owner.id,raw)).duplicate).toBe(true);expect(await db.select().from(customerWorkRootsTable).where(eq(customerWorkRootsTable.organizationId,f.org))).toHaveLength(0);
});
it("refuses refunds above one invoice's exact original-payment allocation even when that invoice has other paid cash",async()=>{
  const f=await fixture(),one=await issued(f),two=await issued(f,{source:{kind:"customer_work",customerWorkId:one.customerWorkId}});
  const paid=(await recordInvoicePayment(f.org,f.owner.id,one.id,{...command(one.version),amountCents:10000,sourceReference:`shared-original-${randomUUID()}`,occurredAt:new Date(Date.now()-60000).toISOString()})).invoice,original=paid.allocations[0];
  const freed=(await reverseInvoiceAllocation(f.org,f.owner.id,one.id,original.id,{...command(paid.version),reason:"Explicit allocation correction for this one work root"})).invoice;
  const partial=(await allocateInvoiceValue(f.org,f.owner.id,one.id,{...command(freed.version),valueEntryId:original.valueEntryId,amountCents:4000})).invoice;
  await allocateInvoiceValue(f.org,f.owner.id,two.id,{...command(two.version),valueEntryId:original.valueEntryId,amountCents:6000});
  const mixed=(await recordInvoicePayment(f.org,f.owner.id,one.id,{...command(partial.version),amountCents:6000,sourceReference:`other-cash-${randomUUID()}`,occurredAt:new Date(Date.now()-5000).toISOString()})).invoice;
  expect(mixed.recordedPaidCents).toBe(10000);
  await expect(recordInvoiceRefund(f.org,f.owner.id,one.id,{...command(mixed.version),originalPaymentValueEntryId:original.valueEntryId,amountCents:5000,sourceReference:`denied-refund-${randomUUID()}`,occurredAt:new Date(Date.now()-1000).toISOString(),reason:"Other cash cannot increase this receipt allocation"})).rejects.toMatchObject({code:"invoice_refund_allocation_conflict"});
  expect((await getInvoice(f.org,f.owner.id,one.id)).version).toBe(mixed.version);expect((await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.organizationId,f.org))).filter(v=>v.kind==="refund")).toEqual([]);
});
it("preserves org-wide cash references and refuses a refund's changed request or a different work's original payment",async()=>{
  const f=await fixture(),one=await issued(f),other=await issued(f),sourceReference=`unique-cash-${randomUUID()}`;
  const paid=(await recordInvoicePayment(f.org,f.owner.id,one.id,{...command(one.version),amountCents:5000,sourceReference,occurredAt:new Date(Date.now()-60000).toISOString()})).invoice;
  await expect(recordInvoicePayment(f.org,f.owner.id,other.id,{...command(other.version),amountCents:5000,sourceReference,occurredAt:new Date(Date.now()-60000).toISOString()})).rejects.toMatchObject({code:"invoice_receipt_unavailable"});
  const input={...command(paid.version),originalPaymentValueEntryId:paid.allocations[0].valueEntryId,amountCents:1000,sourceReference:`unique-refund-${randomUUID()}`,occurredAt:new Date(Date.now()-1000).toISOString(),reason:"An external refund was recorded by authorized staff"};
  await expect(recordInvoiceRefund(f.org,f.owner.id,other.id,{...input,expectedVersion:other.version})).rejects.toMatchObject({code:"invoice_refund_source_unavailable"});
  await recordInvoiceRefund(f.org,f.owner.id,one.id,input);
  await expect(recordInvoiceRefund(f.org,f.owner.id,one.id,{...input,amountCents:2000})).rejects.toMatchObject({code:"invoice_request_conflict"});
  expect(await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.organizationId,f.org))).toHaveLength(2);
});
it("allows SELECT-only retained reads and exact result reconciliation while paused but creates no new returning work",async()=>{
  const f=await fixture(),input=returningEstimateDraft(f,null),saved=await createCustomerWorkEstimate(f.org,f.actor,input),invoice=await issued(f);
  await transitionCustomerLifecycle(f.org,f.owner.id,{action:"pause",expectedVersion:0,reason:"Synthetic owner holds new contractor operations"});
  const before=(await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId,f.org))).length;
  expect((await createCustomerWorkEstimate(f.org,f.actor,input)).command.duplicate).toBe(true);expect(await getEstimate(f.org,saved.estimate.id)).toMatchObject({id:saved.estimate.id});expect(await getInvoice(f.org,f.owner.id,invoice.id)).toMatchObject({id:invoice.id});
  await expect(createCustomerWorkProject(f.org,f.actor,returningProjectDraft(f))).rejects.toMatchObject({code:"customer_work_company_held"});
  await expect(recordInvoicePayment(f.org,f.owner.id,invoice.id,{...command(invoice.version),amountCents:1,sourceReference:`held-cash-${randomUUID()}`,occurredAt:new Date().toISOString()})).rejects.toMatchObject({code:"customer_work_company_held"});
  expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId,f.org))).length).toBe(before);
});
it("includes a selected project's actual estimate ancestry in delivery evidence without rewriting a native invoice null",async()=>{
  const f=await fixture(),accepted=await acceptedReturningEstimate(f),job=await createCustomerWorkProject(f.org,f.actor,{...returningProjectDraft(f),source:{kind:"estimate",estimateId:accepted.estimate.id,expectedWorkVersion:2}}),invoice=await issued(f,{source:{kind:"customer_work",customerWorkId:job.project.customerWorkId},projectId:job.project.id});
  await db.update(invoicesTable).set({estimateId:null}).where(eq(invoicesTable.id,invoice.id));
  const proof=await readReturningInvoiceLineage(db,f.org,invoice.id,{actorUserId:f.owner.id});expect(proof.parentEvidence.estimate?.id).toBe(accepted.estimate.id);expect(proof.invoice.estimateId).toBeNull();
  await db.update(estimatesTable).set({notes:"Later exact ancestor correction",updatedAt:proof.parentEvidence.estimate!.updatedAt}).where(eq(estimatesTable.id,accepted.estimate.id));
  expect((await readReturningInvoiceLineage(db,f.org,invoice.id,{actorUserId:f.owner.id})).sourceSha256).not.toBe(proof.sourceSha256);expect((await getInvoice(f.org,f.owner.id,invoice.id)).estimateId).toBeNull();
});
