import { describe, expect, it } from "vitest";
import { canonicalDetailCorrectionPayload, customerDetailSnapshotSchema, detailCorrectionInputSchema, detailCorrectionReceiptSchema, detailCorrectionSaveResultSchema } from "./customer-detail-correction-contract";
const org="11111111-1111-4111-8111-111111111111", contact="22222222-2222-4222-8222-222222222222", request="33333333-3333-4333-8333-333333333333", property="44444444-4444-4444-8444-444444444444";
const version={contactUpdatedAt:"2035-01-01T00:00:00.000Z",propertyUpdatedAt:null,fingerprint:"a".repeat(64)};
const input=(changes:unknown)=>({requestId:request,propertyId:null,expectedVersion:version,changes});
describe("customer detail correction closed transport contract",()=>{
 it("trims supplied names, allows explicit nullable clearing and preserves country-specific phone text",()=>{
  expect(detailCorrectionInputSchema.parse(input({firstName:"  Synthetic  ",lastName:" ",email:null,phone:"+44 (20) 1234 5678"})).changes).toEqual({firstName:"Synthetic",lastName:null,email:null,phone:"+44 (20) 1234 5678"});
 });
 it("treats markup as text without splitting a first name into inferred fields",()=>{
  expect(detailCorrectionInputSchema.parse(input({firstName:"<b>Synthetic Name</b>"})).changes).toEqual({firstName:"<b>Synthetic Name</b>"});
 });
 it("refuses empty patches, malformed supplied values and control characters",()=>{
  for(const changes of [{},{firstName:" "},{firstName:"x\n"},{email:"not-email"},{phone:"call tomorrow"},{firstName:"x".repeat(129)},{property:{}}]) expect(detailCorrectionInputSchema.safeParse(input(changes)).success).toBe(false);
 });
 it("refuses protected keys at every nested boundary and address changes without an explicit selected property",()=>{
  for(const body of [{...input({firstName:"x"}),organizationId:org},input({id:contact}),input({doNotContact:false}),input({consent:true}),input({property:{city:"Example",contactId:contact}}),input({property:{city:"Example"}}),{...input({firstName:"x"}),expectedVersion:{...version,source:"crm"}}]) expect(detailCorrectionInputSchema.safeParse(body).success).toBe(false);
 });
 it("requires UUID and exact selected-property version agreement",()=>{
  for(const body of [{...input({firstName:"x"}),requestId:"fake-id"},{...input({firstName:"x"}),propertyId:property}, {...input({firstName:"x"}),expectedVersion:{...version,fingerprint:"a".repeat(64)+"\n"}}]) expect(detailCorrectionInputSchema.safeParse(body).success).toBe(false);
  expect(detailCorrectionInputSchema.parse({...input({property:{addressLine2:null}}),propertyId:property,expectedVersion:{...version,propertyUpdatedAt:version.contactUpdatedAt}}).changes.property).toEqual({addressLine2:null});
 });
 it("canonicalizes only allowed field order and distinguishes omission from explicit clearing",()=>{
  const a=detailCorrectionInputSchema.parse(input({phone:null,firstName:"S"})),b=detailCorrectionInputSchema.parse(input({firstName:"S",phone:null}));
  expect(canonicalDetailCorrectionPayload(org,contact,"actor",a)).toBe(canonicalDetailCorrectionPayload(org,contact,"actor",b));
  expect(canonicalDetailCorrectionPayload(org,contact,"actor",a)).not.toBe(canonicalDetailCorrectionPayload(org,contact,"actor",detailCorrectionInputSchema.parse(input({firstName:"S"}))));
 });
 it("returns bounded legacy facts verbatim while retaining exact organization/customer/property context",()=>{
  const snapshot=customerDetailSnapshotSchema.parse({organizationId:org,contactId:contact,propertyId:null,details:{firstName:"Legacy\nName",lastName:null,email:"invalid legacy",phone:"legacy extension?",property:null},version});
  expect(snapshot.details.email).toBe("invalid legacy"); expect(snapshot.organizationId).toBe(org);
  const receipt={requestId:request,status:"unchanged",committedAt:version.contactUpdatedAt,changedFields:[],snapshot};
  expect(detailCorrectionSaveResultSchema.parse({receipt,replayed:true})).toEqual({receipt,replayed:true});
  expect(detailCorrectionReceiptSchema.safeParse({...receipt,status:"saved"}).success).toBe(false);
  expect(customerDetailSnapshotSchema.safeParse({...snapshot,organizationId:undefined}).success).toBe(false);
 });
});
