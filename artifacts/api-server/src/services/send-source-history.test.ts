import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { automationRunsTable, consentRecordsTable, contactsTable, db, leadsTable, organizationsTable, type SendingHoursSettings } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { checkSendEligibility } from "./send-gate";
import { createAutomation, runEvent } from "./automation";
import { providers } from "./providers";

const hours: SendingHoursSettings = {
  quietHoursEnabled: false, timezone: "UTC", startHour: 9, endHour: 17,
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"], maxTouchesPerDay: 0,
};
let org: string, foreignOrg: string;
let contact: typeof contactsTable.$inferSelect;
let importedId: string, freshId: string, foreignId: string;

beforeAll(async () => {
  const rows = await db.insert(organizationsTable).values([
    { name: "Source gate A", slug: `source-gate-a-${randomUUID()}` },
    { name: "Source gate B", slug: `source-gate-b-${randomUUID()}` },
  ]).returning();
  [org, foreignOrg] = rows.map((row) => row.id);
  [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", email: "source-gate@example.test" }).returning();
  const [other] = await db.insert(contactsTable).values({ organizationId: foreignOrg, firstName: "Other", email: contact.email }).returning();
  const leads = await db.insert(leadsTable).values([
    { organizationId: org, contactId: contact.id, creationMethod: "import" },
    { organizationId: org, contactId: contact.id, creationMethod: "form" },
    { organizationId: foreignOrg, contactId: other.id, creationMethod: "form" },
  ]).returning();
  [importedId, freshId, foreignId] = leads.map((lead) => lead.id);
});
afterAll(async () => { await deleteTestOrgs(org, foreignOrg); });

const gate = (leadId?: string) => checkSendEligibility({ organizationId: org, contact, leadId, channel: "email", kind: "outreach", sendingHours: hours });

describe("source history cannot authorize automated outreach", () => {
  it("holds a legacy CSV opportunity, including contact-only jobs with ambiguous provenance", async () => {
    for (const id of [importedId, undefined]) expect(await gate(id)).toMatchObject({
      ok: false, outcome: "blocked", reason: "imported_source_requires_current_review",
    });
  });
  it("keeps a separate fresh inquiry usable when its opportunity is explicitly identified", async () => {
    expect(await gate(freshId)).toEqual({ ok: true });
  });
  it("refuses foreign, missing and wrong-contact opportunity substitutions", async () => {
    const [otherContact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Wrong", email: "different@example.test" }).returning();
    const [wrong] = await db.insert(leadsTable).values({ organizationId: org, contactId: otherContact.id, creationMethod: "form" }).returning();
    for (const id of [foreignId, wrong.id, randomUUID()]) expect(await gate(id)).toMatchObject({
      ok: false, reason: "source_opportunity_unavailable",
    });
  });
  it("does not change the existing requested-service transactional gate", async () => {
    expect(await checkSendEligibility({ organizationId: org, contact, leadId: importedId, channel: "email", kind: "transactional" })).toEqual({ ok: true });
  });
  it("records blocked email and SMS automation attempts without calling either provider", async () => {
    await db.update(contactsTable).set({ phone: "+15555550123" }).where(eq(contactsTable.id, contact.id));
    await db.insert(consentRecordsTable).values({ organizationId: org, contactId: contact.id, channel: "sms", granted: true, disclosureVersion: "synthetic-test" });
    const rule = await createAutomation(org, {
      name: "Synthetic imported-source boundary", event: "lead.updated", actions: [
        { type: "send_email", params: { subject: "Synthetic", body: "Synthetic email" } },
        { type: "send_sms", params: { body: "Synthetic SMS" } },
      ],
    });
    const email = vi.spyOn(providers.email, "send").mockRejectedValue(new Error("Provider must not be called"));
    const sms = vi.spyOn(providers.sms, "send").mockRejectedValue(new Error("Provider must not be called"));
    try {
      await runEvent(org, "lead.updated", { leadId: importedId });
      const [run] = await db.select().from(automationRunsTable).where(eq(automationRunsTable.automationId, rule.id));
      expect(run.actionResults).toHaveLength(2);
      expect(run.actionResults.every((result) => result.status === "skipped" && result.detail?.includes("imported_source_requires_current_review"))).toBe(true);
      expect(email).not.toHaveBeenCalled();
      expect(sms).not.toHaveBeenCalled();
    } finally { email.mockRestore(); sms.mockRestore(); }
  });
});
