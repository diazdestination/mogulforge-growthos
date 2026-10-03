import { randomUUID } from "node:crypto";
import { auditEventsTable, contactsTable, crmTasksTable, db, missedCallHandoffsTable, organizationsTable, propertiesTable, twilioCallsTable, twilioClientBindingsTable, usersTable } from "@workspace/db";
import { callieIntakesTable, calliePolicyRevisionsTable } from "../../../../lib/db/src/schema/callie";
import { buildCalliePolicySnapshot, DEFAULT_CALLIE_POLICY } from "../services/callie-contract";

let sequence = 1000;
/** Synthetic records only; no provider is selected or contacted. */
export async function callieOfficeFixture(reviewed = false) {
  const [org] = await db.insert(organizationsTable).values({ name: "Fictional CALLIE office", slug: `callie-office-${randomUUID()}` }).returning();
  const [owner, office] = await db.insert(usersTable).values([{ organizationId: org.id, role: "owner", emailVerifiedAt: new Date(), firstName: "Synthetic owner" }, { organizationId: org.id, role: "office", emailVerifiedAt: new Date(), firstName: "Synthetic office" }]).returning();
  const shopPhone = `+1202555${String(++sequence).padStart(4, "0")}`;
  const [binding] = await db.insert(twilioClientBindingsTable).values({ organizationId: org.id, accountSid: `AC${randomUUID().replaceAll("-", "")}`, phoneNumber: shopPhone, messagingServiceSid: `MG${randomUUID().replaceAll("-", "")}`,
    authTokenSecretRef: "TWILIO_CLIENT_CALLIE_OFFICE_AUTH_TOKEN", publicOrigin: "https://callie-office.example.invalid", businessName: "Fictional CALLIE office", smsDisclosureVersion: "synthetic.v1" }).returning();
  const snapshot = buildCalliePolicySnapshot({ ...DEFAULT_CALLIE_POLICY, businessHoursOwnerId: owner.id, afterHoursOwnerId: owner.id }, { id: binding.id, accountSid: binding.accountSid, sender: binding.phoneNumber, messagingServiceSid: binding.messagingServiceSid!, disclosureVersion: binding.smsDisclosureVersion!, origin: binding.publicOrigin, businessName: binding.businessName });
  const [review] = await db.insert(auditEventsTable).values({ organizationId: org.id, actorUserId: owner.id, action: "callie.policy.previewed", entityType: "organization", entityId: org.id, metadata: { synthetic: true } }).returning();
  const [policy] = await db.insert(calliePolicyRevisionsTable).values({ organizationId: org.id, version: 1, enabled: false, snapshot, reviewId: review.id, reviewPayloadHash: "a".repeat(64), approvedByUserId: owner.id }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Fictional caller", phone: "+12025550123" }).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org.id, contactId: contact.id, addressLine1: "1 Fictional Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
  const [call] = await db.insert(twilioCallsTable).values({ organizationId: org.id, requestKey: randomUUID(), direction: "inbound", phone: contact.phone!, staffPhone: "+12025550199", accountSid: binding.accountSid, providerSid: `CA${randomUUID().replaceAll("-", "")}`, dialStatus: "no-answer", authorizationSource: "signed-inbound", ...(reviewed ? { contactId: contact.id } : {}) }).returning();
  const [task] = await db.insert(crmTasksTable).values({ organizationId: org.id, title: "Return fictional missed call", assignedUserId: owner.id, sourceEvent: "voice.missed_call", ...(reviewed ? { contactId: contact.id } : {}) }).returning();
  const [handoff] = await db.insert(missedCallHandoffsTable).values({ organizationId: org.id, callId: call.id, taskId: task.id, ...(reviewed ? { contactId: contact.id, reviewedAt: new Date(), reviewedByUserId: owner.id } : {}) }).returning();
  const [intake] = await db.insert(callieIntakesTable).values({ organizationId: org.id, callId: call.id, policyRevisionId: policy.id, bindingId: binding.id, accountSid: binding.accountSid, providerCallSid: call.providerSid!, fromPhone: call.phone, calledNumber: binding.phoneNumber, ownerUserId: owner.id,
    dueAt: new Date(Date.now() - 1000), stage: "complete", state: "blocked", serviceIntent: "maintenance", requestIntent: "visit", callbackWindow: "morning", reason: "caller_declined_text" }).returning();
  return { org: org.id, owner, office, binding, policy, contact, property, call, task, handoff, intake };
}
