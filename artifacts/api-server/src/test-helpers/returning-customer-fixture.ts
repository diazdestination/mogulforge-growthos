import { randomUUID } from "node:crypto";
import { contactsTable, db, organizationsTable, propertiesTable, usersTable } from "@workspace/db";
import { createCustomerWorkEstimate, updateCustomerWorkEstimate } from "../services/returning-customer";

/** Synthetic, zero-lead fixture. No transport, secret, production database or account setup. */
export async function returningCustomerFixture() {
  const url=new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV!=="test" || !["127.0.0.1","localhost"].includes(url.hostname)) throw Error("Use a disposable loopback test database");
  const [company]=await db.insert(organizationsTable).values({name:"SYNTHETIC returning work",slug:`returning-${randomUUID()}`}).returning();
  const [owner,office,viewer]=await db.insert(usersTable).values([
    {organizationId:company.id,role:"owner",emailVerifiedAt:new Date(),isActive:true},
    {organizationId:company.id,role:"office",emailVerifiedAt:new Date(),isActive:true},
    {organizationId:company.id,role:"viewer",emailVerifiedAt:new Date(),isActive:true},
  ]).returning();
  const [contact,otherContact]=await db.insert(contactsTable).values([
    {organizationId:company.id,firstName:"Synthetic",lastName:"Returning Customer",email:`synthetic-${randomUUID()}@example.test`},
    {organizationId:company.id,firstName:"Different",lastName:"Canonical Customer"},
  ]).returning();
  const property={organizationId:company.id,contactId:contact.id,city:"Example",state:"GA",postalCode:"00000"};
  const [firstProperty,secondProperty]=await db.insert(propertiesTable).values([{...property,addressLine1:"100 Synthetic Lane"},{...property,addressLine1:"200 Synthetic Lane"}]).returning();
  return {org:company.id,company,owner,office,viewer,contact,otherContact,firstProperty,secondProperty,actor:{userId:owner.id,effectiveRole:"owner" as const}};
}
export type ReturningCustomerFixture=Awaited<ReturnType<typeof returningCustomerFixture>>;
export const returningEstimateDraft=(f:ReturningCustomerFixture,propertyId:string|null=f.secondProperty.id)=>({requestId:randomUUID(),confirmed:true as const,source:{kind:"existing_customer" as const,contactId:f.contact.id,propertyId},title:"Synthetic repair estimate",lineItems:[{description:"Agreed repair scope",quantity:1,unitPriceCents:10000}],taxCents:0,notes:"Office recorded scope; no customer signature claimed."});
export const returningProjectDraft=(f:ReturningCustomerFixture,propertyId:string|null=f.secondProperty.id)=>({requestId:randomUUID(),confirmed:true as const,source:{kind:"existing_customer" as const,contactId:f.contact.id,propertyId},name:"Synthetic repeat-customer job",status:"scheduled" as const,scheduledStart:null,scheduledEnd:null,crewUserIds:[] as string[],crewNotes:"Preserve the original office notes."});
export const returningInvoiceDocument=(amount=10000)=>({title:"Synthetic returning invoice",currency:"USD" as const,issuerName:"Synthetic contractor",customerName:"Synthetic Returning Customer",lineItems:[{description:"Explicit agreed work",quantity:"1",unitPriceCents:amount}],taxCents:0});
export async function acceptedReturningEstimate(f:ReturningCustomerFixture,propertyId:string|null=f.secondProperty.id) {
  const input=returningEstimateDraft(f,propertyId),saved=await createCustomerWorkEstimate(f.org,f.actor,input);
  const {source:_source,...edit}=input;
  return updateCustomerWorkEstimate(f.org,f.actor,saved.estimate.id,{...edit,requestId:randomUUID(),expectedWorkVersion:saved.estimate.workVersion,status:"accepted"});
}
