import { randomUUID } from "node:crypto";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  smartSitesTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getManualSmsDrafts, normalizeManualSmsPhone } from "./manual-sms";
import { normalizeSmsPhone } from "./phone-number";
import { normalizeSmartSiteIntake } from "./smart-site-contract";
import { captureSmartSiteInquiry } from "./smart-sites";

// GAP-11: intake and manual SMS share ONE NANP validator. A website lead with a
// phone that passes the coarse ">= 10 digits" intake shape but is not a valid
// US/Canada number is still saved (never silently dropped) and flagged so
// staff see the problem before calling or texting.
describe("smart-site intake phone validation", () => {
  const orgs: string[] = [];
  afterAll(async () => { await deleteTestOrgs(...orgs.splice(0)); });

  async function capture(phone: string, email?: string) {
    const stamp = randomUUID();
    const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Phone Co", slug: `intake-phone-${stamp}` }).returning();
    orgs.push(org.id);
    await db.insert(usersTable).values({
      organizationId: org.id, role: "owner", isActive: true,
      email: `intake-phone-${stamp}@example.test`, emailVerifiedAt: new Date(),
    });
    const [site] = await db.insert(smartSitesTable).values({
      organizationId: org.id, name: "Synthetic site", siteKey: stamp, profile: "hvac",
      source: "synthetic", keyHash: "0".repeat(64), isActive: true,
    }).returning();
    const saved = await captureSmartSiteInquiry(site, normalizeSmartSiteIntake({
      schemaVersion: 1, requestId: randomUUID(),
      contact: { name: "Avery Visitor", phone, ...(email ? { email } : {}) },
      project: { serviceCode: "repair", timing: "soon", summary: "Synthetic inquiry" },
      consent: { contact: true, analytics: false, policyVersion: "synthetic-test-v1", channels: ["phone", "sms"] },
    }));
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, saved.leadId));
    const [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, lead.contactId!));
    const [activity] = await db.select().from(activitiesTable).where(and(
      eq(activitiesTable.leadId, lead.id), eq(activitiesTable.type, "lead_captured"),
    ));
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.leadId, lead.id));
    const [audit] = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.entityId, lead.id), eq(auditEventsTable.action, "smart_site.lead_saved"),
    ));
    return { orgId: org.id, saved, lead, contact, activity, task, audit };
  }

  it("shares one validator between intake and manual SMS", () => {
    for (const raw of ["4045550199", "14045550199", "+1 (404) 555-0199", "4040100199", "4041550199", "0000000000", "442079460123", "+442079460123"]) {
      expect(normalizeManualSmsPhone(raw)).toBe(normalizeSmsPhone(raw));
    }
    expect(normalizeSmsPhone("4040100199")).toBeNull();
  });

  it.each([
    ["exchange starting with 0", "404-010-0199"],
    ["exchange starting with 1", "404-155-0199"],
    ["area code starting with 1", "104-555-0199"],
    ["international digits without +", "44 20 7946 0123"],
  ])("saves the lead but flags an invalid phone (%s) for staff", async (_label, phone) => {
    const r = await capture(phone);
    expect(r.saved).toMatchObject({ status: "saved", duplicate: false });
    // The submitted number is kept, not dropped, so staff can still see it.
    expect(r.contact.phone).toBe(phone.replace(/\D/g, ""));
    expect(r.activity.metadata).toMatchObject({ phoneNeedsReview: true });
    expect(r.activity.body).toContain("not a valid US/Canada number");
    expect(r.task.description).toContain("not a valid US/Canada number");
    expect(r.audit.metadata).toMatchObject({ phoneNeedsReview: true });
    expect(JSON.stringify(r.audit.metadata)).not.toContain(phone.replace(/\D/g, ""));
    // Manual SMS reaches the same verdict.
    expect(await getManualSmsDrafts({ organizationId: r.orgId, leadId: r.lead.id, staffFirstName: null }))
      .toMatchObject({ allowed: false, reason: "invalid_phone" });
  });

  it("does not flag a valid NANP phone", async () => {
    const r = await capture("(404) 555-0199", `valid-${randomUUID()}@example.invalid`);
    expect(r.contact.phone).toBe("4045550199");
    expect((r.activity.metadata as Record<string, unknown>).phoneNeedsReview).toBeUndefined();
    expect(r.activity.body).not.toContain("not a valid");
    expect(r.task.description).not.toContain("not a valid");
    expect((r.audit.metadata as Record<string, unknown>).phoneNeedsReview).toBeUndefined();
    expect((await getManualSmsDrafts({ organizationId: r.orgId, leadId: r.lead.id, staffFirstName: null }))?.reason)
      .not.toBe("invalid_phone");
  });
});
