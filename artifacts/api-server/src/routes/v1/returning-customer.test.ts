import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db, leadsTable, customerWorkRootsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateCustomerWorkEstimateResponse, UpdateCustomerWorkEstimateResponse, CreateCustomerWorkProjectResponse, UpdateCustomerWorkProjectResponse, CreateInvoiceResponse, GetInvoiceResponse, IssueInvoiceResponse, RecordInvoicePaymentResponse, RecordInvoiceRefundResponse } from "@workspace/api-zod";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { returningCustomerFixture, returningEstimateDraft, returningInvoiceDocument, returningProjectDraft, type ReturningCustomerFixture } from "../../test-helpers/returning-customer-fixture";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { customerWorkEstimateMutationSchema, customerWorkProjectMutationSchema } from "../../services/returning-customer-contract";
import * as keys from "../../services/api-keys";
const realFetch=globalThis.fetch,origin="https://returning-work.example",sessions:string[]=[];
let server:Server,base:string,a:ReturningCustomerFixture,b:ReturningCustomerFixture,owner:string,office:string,viewer:string,foreign:string,unverified:string,pending:string;
async function session(id:string){const sid=await createSession({user:{id,email:null,firstName:null,lastName:null,profileImageUrl:null},access_token:"synthetic-only"});sessions.push(sid);return sid;}
async function request(path:string,options:{sid?:string;method?:string;body?:unknown;headers?:Record<string,string>}={}){return realFetch(`${base}/api/v1${path}`,{method:options.method??(options.body===undefined?"GET":"POST"),headers:{origin,cookie:`sid=${options.sid??owner}`,...(options.body===undefined?{}:{"content-type":"application/json"}),...options.headers},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});}
function wire<T>(schema:{parse(v:unknown):T},value:unknown):T {const parsed=schema.parse(value),json=JSON.parse(JSON.stringify(parsed));expect(json).toEqual(value);return json as T;}
beforeAll(async()=>{
  vi.stubEnv("APP_ORIGIN",origin);vi.stubEnv("SESSION_SECRET","synthetic-returning-work-http-key");a=await returningCustomerFixture();b=await returningCustomerFixture();
  owner=await session(a.owner.id);office=await session(a.office.id);viewer=await session(a.viewer.id);foreign=await session(b.owner.id);
  const [u,p]=await db.insert(usersTable).values([{organizationId:a.org,role:"owner",emailVerifiedAt:null},{organizationId:a.org,id:`invite:${randomUUID()}`,role:"owner",emailVerifiedAt:new Date()}]).returning();unverified=await session(u.id);pending=await session(p.id);
  server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch",async()=>{throw Error("No provider transport permitted in returning-work HTTP tests");});
});
afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const sid of sessions)await deleteSession(sid);await deleteTestOrgs(a?.org,b?.org);vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it("actual generated HTTP responses cover zero-lead estimate to accepted job, invoice, receipt and linked refund",async()=>{
  const draft=returningEstimateDraft(a),created=await request("/customer-work/estimates",{body:draft});expect(created.status).toBe(200);
  const made=customerWorkEstimateMutationSchema.parse(wire(CreateCustomerWorkEstimateResponse,await created.json()));
  const {source:_source,...edit}=draft;
  const acceptedResponse=await request(`/customer-work/estimates/${made.estimate.id}`,{method:"PATCH",body:{...edit,requestId:randomUUID(),expectedWorkVersion:1,status:"accepted"}});expect(acceptedResponse.status).toBe(200);
  const accepted=customerWorkEstimateMutationSchema.parse(wire(UpdateCustomerWorkEstimateResponse,await acceptedResponse.json()));
  const input={...returningProjectDraft(a),source:{kind:"estimate",estimateId:accepted.estimate.id,expectedWorkVersion:2},status:"completed"};
  const projectResponse=await request("/customer-work/projects",{body:input});expect(projectResponse.status).toBe(200);
  const project=customerWorkProjectMutationSchema.parse(wire(CreateCustomerWorkProjectResponse,await projectResponse.json()));
  const invoiceResponse=await request("/invoices",{body:{requestId:randomUUID(),source:{kind:"customer_work",customerWorkId:project.project.customerWorkId},projectId:project.project.id,estimateId:accepted.estimate.id,document:returningInvoiceDocument()}});expect(invoiceResponse.status).toBe(201);
  const invoice=wire(CreateInvoiceResponse,await invoiceResponse.json()).invoice;
  const issuedResponse=await request(`/invoices/${invoice.id}/issue`,{body:{requestId:randomUUID(),expectedVersion:invoice.version,confirmed:true}});expect(issuedResponse.status).toBe(200);
  const issued=wire(IssueInvoiceResponse,await issuedResponse.json()).invoice;
  const paidResponse=await request(`/invoices/${invoice.id}/payments`,{body:{requestId:randomUUID(),expectedVersion:issued.version,confirmed:true,amountCents:10000,sourceReference:`http-cash-${randomUUID()}`,occurredAt:new Date(Date.now()-5000).toISOString()}});expect(paidResponse.status).toBe(200);
  const paid=wire(RecordInvoicePaymentResponse,await paidResponse.json()).invoice;
  const refundInput={requestId:randomUUID(),expectedVersion:paid.version,confirmed:true,originalPaymentValueEntryId:paid.allocations[0].valueEntryId,amountCents:2000,sourceReference:`http-refund-${randomUUID()}`,occurredAt:new Date(Date.now()-1000).toISOString(),reason:"Office records an evidenced external refund only"};
  const refundResponse=await request(`/invoices/${invoice.id}/refunds`,{body:refundInput});expect(refundResponse.status).toBe(200);
  const refund=wire(RecordInvoiceRefundResponse,await refundResponse.json());expect(refund.invoice).toMatchObject({leadId:null,contactId:a.contact.id,propertyId:a.secondProperty.id,customerWorkId:project.project.customerWorkId,recordedPaidCents:8000,balanceDueCents:2000});
  expect(wire(RecordInvoiceRefundResponse,await(await request(`/invoices/${invoice.id}/refunds`,{body:refundInput})).json()).duplicate).toBe(true);
  const read=await request(`/invoices/${invoice.id}`);expect(read.status).toBe(200);wire(GetInvoiceResponse,await read.json());
  expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId,a.org))).toEqual([]);
});
it("direct jobs and standalone invoices retain explicit null property and use immutable versioned commands",async()=>{
  const draft=returningProjectDraft(a,null),result=await request("/customer-work/projects",{body:draft});expect(result.status).toBe(200);
  const initial=customerWorkProjectMutationSchema.parse(wire(CreateCustomerWorkProjectResponse,await result.json()));expect(initial.project).toMatchObject({leadId:null,propertyId:null,contactId:a.contact.id});
  const {source:_source,...fields}=draft;
  const editedResponse=await request(`/customer-work/projects/${initial.project.id}`,{method:"PATCH",body:{...fields,requestId:randomUUID(),expectedWorkVersion:1,crewNotes:"Human corrected job notes"}});expect(editedResponse.status).toBe(200);
  const edited=customerWorkProjectMutationSchema.parse(wire(UpdateCustomerWorkProjectResponse,await editedResponse.json()));expect(edited.project.workVersion).toBe(2);
  const legacy=await request(`/projects/${initial.project.id}`,{method:"PATCH",body:{name:"Cannot bypass work version"}});expect(legacy.status).toBe(409);
  const invoice=await request("/invoices",{body:{requestId:randomUUID(),source:{kind:"existing_customer",contactId:a.contact.id,propertyId:null},document:returningInvoiceDocument()}});expect(invoice.status).toBe(201);
  const saved=wire(CreateInvoiceResponse,await invoice.json()).invoice;expect(saved).toMatchObject({projectId:null,estimateId:null,leadId:null,propertyId:null});expect(saved.customerWorkId).not.toBe(initial.project.customerWorkId);
});
it("blank API keys, stale human membership, read-only roles and foreign sources cannot create native work",async()=>{
  const key=vi.spyOn(keys,"resolveApiKey"),path="/customer-work/estimates",input=returningEstimateDraft(a);
  const before=await db.select().from(customerWorkRootsTable).where(eq(customerWorkRootsTable.organizationId,a.org));
  for (const value of ["","synthetic-not-resolved"])expect((await request(path,{body:input,headers:{"x-api-key":value}})).status).toBe(403);
  expect(key).not.toHaveBeenCalled();
  for(const sid of [unverified,pending,viewer])expect((await request(path,{sid,body:input})).status).toBe(403);
  expect((await request(path,{sid:foreign,body:input})).status).toBe(404);
  expect((await request(path,{body:input,headers:{origin:"https://wrong.example"}})).status).toBe(403);
  expect((await request(path,{body:input,headers:{"content-type":"text/plain"}})).status).toBe(415);
  expect(await db.select().from(customerWorkRootsTable).where(eq(customerWorkRootsTable.organizationId,a.org))).toEqual(before);
});
it("strict source, version and selector inputs fail before native work or money changes",async()=>{
  const input=returningEstimateDraft(a),path="/customer-work/estimates";
  for(const body of [{...input,source:{kind:"existing_customer",contactId:a.contact.id}},{...input,leadId:randomUUID()},{...input,lineItems:[{description:"Wrong precision",quantity:1.0001,unitPriceCents:100}]},{...input,confirmed:false}]) expect((await request(path,{body})).status).toBe(400);
  expect((await request(`${path}?organizationId=${b.org}`,{body:input})).status).toBe(400);
  expect((await request("/customer-work/projects/not-a-uuid",{method:"PATCH",body:returningProjectDraft(a)})).status).toBe(400);
  const saved=customerWorkEstimateMutationSchema.parse(await(await request(path,{body:input})).json());
  const {source:_source,...fields}=input;
  expect((await request(`${path}/${saved.estimate.id}`,{method:"PATCH",body:{...fields,requestId:randomUUID(),expectedWorkVersion:2,status:"accepted"}})).status).toBe(409);
  const replay=await request(path,{body:input});expect(replay.status).toBe(200);expect(customerWorkEstimateMutationSchema.parse(await replay.json()).command).toMatchObject({duplicate:true,targetId:saved.estimate.id});
  expect((await request(path,{sid:office,body:input})).status).toBe(409);
});
