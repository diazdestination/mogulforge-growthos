import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  contactsTable,
  crmTasksTable,
  db,
  estimatesTable,
  invoicesTable,
  leadsTable,
  organizationsTable,
  projectsTable,
  propertiesTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createInvoice, getInvoice, issueInvoice, voidInvoice } from "./invoices";
import { recordValueEntry } from "./revenue-workspace";
import {
  deleteEstimate,
  deleteProject,
  INVOICE_HISTORY_RETAINED,
  VALUE_HISTORY_RETAINED,
  mergeLeads,
  updateLead,
  updateProject,
  updateProperty,
} from "./crm";
const orgs: string[] = [],
  sessions: string[] = [];
let server: Server, base: string;
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic retained invoices",
      slug: `retained-${randomUUID()}`,
    })
    .returning();
  orgs.push(org.id);
  const [owner] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      role: "owner",
      emailVerifiedAt: new Date(),
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Synthetic customer" })
    .returning();
  const [lead, survivor] = await db
    .insert(leadsTable)
    .values([
      { organizationId: org.id, contactId: contact.id },
      { organizationId: org.id, contactId: contact.id },
    ])
    .returning();
  const [estimate] = await db
    .insert(estimatesTable)
    .values({ organizationId: org.id, leadId: lead.id, title: "Agreed scope" })
    .returning();
  const [project] = await db
    .insert(projectsTable)
    .values({
      organizationId: org.id,
      leadId: lead.id,
      estimateId: estimate.id,
      name: "Synthetic job",
    })
    .returning();
  const command = {
    requestId: randomUUID(),
    leadId: lead.id,
    projectId: project.id,
    estimateId: estimate.id,
    document: {
      title: "Agreed work",
      currency: "USD",
      issuerName: "Synthetic contractor",
      customerName: "Synthetic customer",
      lineItems: [
        { description: "Service", quantity: "1", unitPriceCents: 10000 },
      ],
      taxCents: 0,
    },
  };
  const sid = await createSession({
    user: {
      id: owner.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-retention",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  sessions.push(sid);
  return {
    org: org.id,
    owner: owner.id,
    contact: contact.id,
    lead: lead.id,
    survivor: survivor.id,
    estimate: estimate.id,
    project: project.id,
    command,
    sid,
  };
}
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test listener");
  base = `http://127.0.0.1:${address.port}/api/v1`;
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
});
describe("retained invoice relationships", () => {
  it.each(["draft", "issued", "void"] as const)(
    "keeps exact legacy estimate, lead property and property owner for every retained %s invoice",
    async (status) => {
      const f = await fixture();
      const [property, alternateProperty] = await db.insert(propertiesTable).values([
        { organizationId:f.org, contactId:f.contact, addressLine1:"Original fictional worksite",city:"Fixture",state:"GA",postalCode:"00000" },
        { organizationId:f.org, contactId:f.contact, addressLine1:"Different fictional worksite",city:"Fixture",state:"GA",postalCode:"00000" },
      ]).returning();
      const [otherContact] = await db.insert(contactsTable).values({organizationId:f.org,firstName:"Different fictional owner"}).returning();
      await updateLead(f.org,f.lead,{propertyId:property.id});
      const [alternateEstimate] = await db.insert(estimatesTable).values({organizationId:f.org,leadId:f.lead,title:"Separate retained scope"}).returning();
      let invoice = (await createInvoice(f.org,f.owner,f.command)).invoice;
      if (status !== "draft") invoice = (await issueInvoice(f.org,f.owner,invoice.id,{requestId:randomUUID(),expectedVersion:invoice.version,confirmed:true})).invoice;
      if (status === "void") invoice = (await voidInvoice(f.org,f.owner,invoice.id,{requestId:randomUUID(),expectedVersion:invoice.version,confirmed:true,reason:"Retained original document"})).invoice;
      const original = (await db.select().from(invoicesTable).where(eq(invoicesTable.id,invoice.id)))[0];
      for (const [path,body] of [
        [`/projects/${f.project}`,{estimateId:null}],
        [`/projects/${f.project}`,{estimateId:alternateEstimate.id}],
        [`/leads/${f.lead}`,{propertyId:null}],
        [`/leads/${f.lead}`,{propertyId:alternateProperty.id}],
        [`/properties/${property.id}`,{contactId:otherContact.id}],
      ] as const) {
        const response = await fetch(base+path,{method:"PATCH",headers:{authorization:`Bearer ${f.sid}`,"content-type":"application/json"},body:JSON.stringify(body)});
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({code:INVOICE_HISTORY_RETAINED});
      }
      expect((await db.select().from(invoicesTable).where(eq(invoicesTable.id,invoice.id)))[0]).toEqual(original);
      expect(await getInvoice(f.org,f.owner,invoice.id)).toMatchObject({id:invoice.id,leadId:f.lead,projectId:f.project,estimateId:f.estimate,status});
      expect((await db.select().from(projectsTable).where(eq(projectsTable.id,f.project)))[0].estimateId).toBe(f.estimate);
      expect((await db.select().from(leadsTable).where(eq(leadsTable.id,f.lead)))[0]).toMatchObject({contactId:f.contact,propertyId:property.id});
      expect((await db.select().from(propertiesTable).where(eq(propertiesTable.id,property.id)))[0].contactId).toBe(f.contact);
      // Same lineage and ordinary operational/display edits remain possible.
      expect(await updateProject(f.org,f.project,{estimateId:f.estimate,crewNotes:"Retain the office work plan"})).toMatchObject({crewNotes:"Retain the office work plan"});
      expect(await updateLead(f.org,f.lead,{propertyId:property.id,summary:"Current office summary",contactId:otherContact.id})).toMatchObject({contactId:f.contact,propertyId:property.id,summary:"Current office summary"});
      expect(await updateProperty(f.org,property.id,{contactId:f.contact,addressLine1:"Corrected display address"})).toMatchObject({contactId:f.contact,addressLine1:"Corrected display address"});
    },
  );
  it.each(["payment","refund","direct_cost","cost_refund"] as const)(
    "retains the original legacy %s scope on both merge directions and parent edits without relocating cash or work",
    async (kind) => {
      const f=await fixture();
      const [property,alternateProperty]=await db.insert(propertiesTable).values([
        {organizationId:f.org,contactId:f.contact,addressLine1:"Recorded original worksite",city:"Fixture",state:"GA",postalCode:"00000"},
        {organizationId:f.org,contactId:f.contact,addressLine1:"Different explicit worksite",city:"Fixture",state:"GA",postalCode:"00000"},
      ]).returning();
      const [otherContact]=await db.insert(contactsTable).values({organizationId:f.org,firstName:"Different cash-history customer"}).returning();
      await updateLead(f.org,f.lead,{propertyId:property.id});
      const value=await recordValueEntry(f.org,f.owner,{leadId:f.lead,kind,amountCents:2000,sourceReference:`retained-${kind}-${randomUUID()}`,occurredAt:new Date(Date.now()-1000).toISOString(),confirmed:true});
      for(const [survivor,source] of [[f.survivor,f.lead],[f.lead,f.survivor]]) {
        expect(await mergeLeads(f.org,survivor,source,f.owner)).toEqual({ok:false,error:VALUE_HISTORY_RETAINED});
        const response=await fetch(`${base}/leads/${survivor}/merge`,{method:"POST",headers:{authorization:`Bearer ${f.sid}`,"content-type":"application/json"},body:JSON.stringify({sourceLeadId:source})});
        expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:VALUE_HISTORY_RETAINED});
      }
      for(const [path,body] of [[`/leads/${f.lead}`,{propertyId:alternateProperty.id}],[`/leads/${f.lead}`,{propertyId:null}],[`/properties/${property.id}`,{contactId:otherContact.id}]] as const) {
        const response=await fetch(base+path,{method:"PATCH",headers:{authorization:`Bearer ${f.sid}`,"content-type":"application/json"},body:JSON.stringify(body)});
        expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:VALUE_HISTORY_RETAINED});
      }
      expect((await db.select().from(valueEntriesTable).where(eq(valueEntriesTable.id,value.id)))[0]).toEqual(value);
      expect((await db.select().from(estimatesTable).where(eq(estimatesTable.id,f.estimate)))[0].leadId).toBe(f.lead);
      expect((await db.select().from(projectsTable).where(eq(projectsTable.id,f.project)))[0]).toMatchObject({leadId:f.lead,estimateId:f.estimate});
      expect((await db.select().from(leadsTable).where(eq(leadsTable.id,f.lead)))[0]).toMatchObject({contactId:f.contact,propertyId:property.id,status:"new"});
      expect((await db.select().from(propertiesTable).where(eq(propertiesTable.id,property.id)))[0].contactId).toBe(f.contact);
      expect(await updateLead(f.org,f.lead,{propertyId:property.id,summary:"Allowed current office plan"})).toMatchObject({propertyId:property.id});
      expect(await updateProperty(f.org,property.id,{addressLine1:"Allowed address correction"})).toMatchObject({addressLine1:"Allowed address correction",contactId:f.contact});
      expect(await mergeLeads(randomUUID(),f.survivor,f.lead,f.owner)).toEqual({ok:false,error:"not_found"});
    },
  );
  it("keeps uninvoiced legacy estimate replacement/removal and cash-free parent edits available",async()=>{
    const f=await fixture(),[estimate]=await db.insert(estimatesTable).values({organizationId:f.org,leadId:f.lead,title:"Revised unbilled scope"}).returning(),[property]=await db.insert(propertiesTable).values({organizationId:f.org,contactId:f.contact,addressLine1:"Unbilled explicit worksite",city:"Fixture",state:"GA",postalCode:"00000"}).returning();
    expect(await updateProject(f.org,f.project,{estimateId:estimate.id})).toMatchObject({estimateId:estimate.id});
    expect(await updateProject(f.org,f.project,{estimateId:null})).toMatchObject({estimateId:null});
    expect(await updateLead(f.org,f.lead,{propertyId:property.id})).toMatchObject({propertyId:property.id});
    expect(await updateLead(f.org,f.lead,{propertyId:null})).toMatchObject({propertyId:null});
    expect(await mergeLeads(f.org,f.survivor,f.lead,f.owner)).toMatchObject({ok:true});
  });
  it("cancels an open preparation task when an uninvoiced completed job is deleted", async () => {
    const f = await fixture();
    await updateProject(f.org, f.project, { status: "completed" });
    const before = await db
      .select()
      .from(crmTasksTable)
      .where(
        eq(
          crmTasksTable.sourceEvent,
          `project.invoice_preparation:${f.project}`,
        ),
      );
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("open");
    expect(await deleteProject(f.org, f.project)).toBe(true);
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.id, before[0].id))
      )[0].status,
    ).toBe("cancelled");
  });
  it.each(["draft", "issued", "void"] as const)(
    "prevents merge and related deletion for a retained %s document",
    async (status) => {
      const f = await fixture();
      let invoice = (await createInvoice(f.org, f.owner, f.command)).invoice;
      if (status !== "draft")
        invoice = (
          await issueInvoice(f.org, f.owner, invoice.id, {
            requestId: randomUUID(),
            expectedVersion: invoice.version,
            confirmed: true,
          })
        ).invoice;
      if (status === "void")
        invoice = (
          await voidInvoice(f.org, f.owner, invoice.id, {
            requestId: randomUUID(),
            expectedVersion: invoice.version,
            confirmed: true,
            reason: "Synthetic retained void history",
          })
        ).invoice;
      expect(await mergeLeads(f.org, f.survivor, f.lead, f.owner)).toEqual({
        ok: false,
        error: INVOICE_HISTORY_RETAINED,
      });
      expect(await mergeLeads(f.org, f.lead, f.survivor, f.owner)).toEqual({
        ok: false,
        error: INVOICE_HISTORY_RETAINED,
      });
      expect(await deleteEstimate(f.org, f.estimate)).toBe(
        INVOICE_HISTORY_RETAINED,
      );
      expect(await deleteProject(f.org, f.project)).toBe(
        INVOICE_HISTORY_RETAINED,
      );
      for (const path of [
        `/estimates/${f.estimate}`,
        `/projects/${f.project}`,
      ]) {
        const response = await fetch(base + path, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${f.sid}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: INVOICE_HISTORY_RETAINED,
        });
      }
      const merged = await fetch(`${base}/leads/${f.survivor}/merge`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.sid}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourceLeadId: f.lead }),
      });
      expect(merged.status).toBe(409);
      expect(
        (
          await db
            .select()
            .from(invoicesTable)
            .where(eq(invoicesTable.id, invoice.id))
        )[0],
      ).toMatchObject({
        leadId: f.lead,
        projectId: f.project,
        estimateId: f.estimate,
        status,
      });
      expect(
        (
          await db
            .select()
            .from(projectsTable)
            .where(eq(projectsTable.id, f.project))
        )[0].leadId,
      ).toBe(f.lead);
      expect(await deleteEstimate(randomUUID(), f.estimate)).toBe(false);
      expect(await deleteProject(randomUUID(), f.project)).toBe(false);
    },
  );
});
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "PostgreSQL invoice retention concurrency",
  () => {
    it.each(["project", "estimate"])(
      "serializes %s-linked invoice creation and lead merging so retained documents cannot be reparented",
      async (link) => {
        const f = await fixture();
        const command =
          link === "project"
            ? f.command
            : { ...f.command, projectId: undefined };
        const [created, merged] = await Promise.allSettled([
          createInvoice(f.org, f.owner, command),
          mergeLeads(f.org, f.survivor, f.lead, f.owner),
        ]);
        if (created.status === "fulfilled") {
          expect(merged).toMatchObject({
            status: "fulfilled",
            value: { ok: false, error: INVOICE_HISTORY_RETAINED },
          });
          expect(created.value.invoice.leadId).toBe(f.lead);
          expect(
            (
              await db
                .select()
                .from(projectsTable)
                .where(eq(projectsTable.id, f.project))
            )[0].leadId,
          ).toBe(f.lead);
        } else {
          expect(created.reason).toMatchObject({ status: 404 });
          expect(merged).toMatchObject({
            status: "fulfilled",
            value: { ok: true },
          });
          expect(
            await db
              .select()
              .from(invoicesTable)
              .where(eq(invoicesTable.organizationId, f.org)),
          ).toHaveLength(0);
        }
      },
    );
  },
);
