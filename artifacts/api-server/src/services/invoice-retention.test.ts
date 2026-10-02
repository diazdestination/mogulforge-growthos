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
  usersTable,
} from "@workspace/db";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createInvoice, issueInvoice, voidInvoice } from "./invoices";
import {
  deleteEstimate,
  deleteProject,
  INVOICE_HISTORY_RETAINED,
  mergeLeads,
  updateProject,
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
