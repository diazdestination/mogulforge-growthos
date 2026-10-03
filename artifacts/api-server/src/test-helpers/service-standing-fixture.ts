import { randomUUID } from "node:crypto";
import { contactsTable, db, gmailConnectionsTable, organizationsTable, orgSettingsTable, usersTable } from "@workspace/db";
import { approveServiceRecurrence, createServiceObligation } from "../services/service-obligations";

/** Synthetic only. No token is decryptable and no provider credentials are used. */
export async function serviceStandingFixture(source = "manual", contactId?: string, organizationId?: string) {
  const [org] = organizationId ? [{ id: organizationId }] : await db.insert(organizationsTable).values({ name: "Standing Fixture", slug: `standing-${randomUUID()}` }).returning();
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = contactId ? [{ id: contactId }] : await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic service customer", email: "service-customer@example.invalid", phone: "+14045550123" }).returning();
  if (!organizationId) {
    await db.insert(orgSettingsTable).values({ organizationId: org.id, businessProfile: { businessName: "Standing Fixture" }, customerEmailSenderUserId: owner.id, sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 2 } });
    await db.insert(gmailConnectionsTable).values({ organizationId: org.id, userId: owner.id, email: "office@example.invalid", encryptedRefreshToken: "synthetic-never-decrypt", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"] });
  }
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const created = await createServiceObligation(org.id, owner.id, { contactId: contact.id, kind: "maintenance", equipmentLabel: "Synthetic HVAC unit", dueDate: due, noticeDays: 7,
    source, externalRef: source === "manual" ? null : `synthetic-import-${randomUUID()}`, assignedUserId: owner.id });
  if ("error" in created) throw new Error(created.error);
  const obligation = await approveServiceRecurrence(org.id, owner.id, created.id, { expectedUpdatedAt: created.updatedAt.toISOString(), intervalMonths: 1, endDate: "2040-12-31", agreementNote: "Synthetic explicitly agreed monthly maintenance series." });
  if ("error" in obligation) throw new Error(obligation.error);
  return { org: org.id, owner, contactId: contact.id, obligation };
}
