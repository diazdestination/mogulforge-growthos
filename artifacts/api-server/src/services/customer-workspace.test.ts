import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activitiesTable, appointmentsTable, contactsTable, crmTasksTable, db, estimatesTable,
  invoicesTable, leadsTable, organizationsTable, projectsTable, propertiesTable,
  serviceObligationsTable, usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  getCustomerWorkspace, getCustomerWorkspaceAppointment, getCustomerWorkspaceSection,
} from "./customer-workspace";
import {
  CUSTOMER_WORKSPACE_SECTIONS, customerWorkspaceAppointmentDetailSchema,
  customerWorkspaceHeaderSchema, customerWorkspacePageSchema,
  type CustomerWorkspaceSection,
} from "./customer-workspace-contract";

const orgs: string[] = [];
const secret = "PRIVATE-CONTENT-NEVER-PROJECT";
const at = new Date("2026-01-02T12:00:00.000Z");
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic customer workspace", slug: `workspace-${randomUUID()}` }).returning();
  orgs.push(org.id);
  const [owner, viewer, inspector] = await db.insert(usersTable).values([
    { organizationId: org.id, role: "owner", firstName: "Office", lastName: "Owner", email: `${randomUUID()}@example.invalid` },
    { organizationId: org.id, role: "viewer", firstName: "Viewer" },
    { organizationId: org.id, role: "inspector", firstName: "Field" },
  ]).returning();
  const [contact, other] = await db.insert(contactsTable).values([
    { organizationId: org.id, firstName: "Same", lastName: "Customer", email: "same@example.invalid", phone: "+15555550100", doNotContactSms: true },
    { organizationId: org.id, firstName: "Same", lastName: "Customer", email: "same@example.invalid", phone: "+15555550100" },
  ]).returning();
  const [property, second, unrelated] = await db.insert(propertiesTable).values([
    { organizationId: org.id, contactId: contact.id, addressLine1: "1 Synthetic Lane", city: "Test", state: "GA", postalCode: "30000" },
    { organizationId: org.id, contactId: contact.id, addressLine1: "2 Synthetic Lane", city: "Test", state: "GA", postalCode: "30000" },
    { organizationId: org.id, contactId: other.id, addressLine1: "1 Synthetic Lane", city: "Test", state: "GA", postalCode: "30000" },
  ]).returning();
  const f = { org: org.id, owner, viewer, inspector, contact, other, property, second, unrelated };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const page = (f: Fixture, section: CustomerWorkspaceSection, cursor?: string) =>
  getCustomerWorkspaceSection(f.org, f.owner.id, f.contact.id, { section, ...(cursor ? { cursor } : {}) });
async function lead(f: Fixture, extra: Partial<typeof leadsTable.$inferInsert> = {}) {
  return (await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contact.id,
    propertyId: f.property.id, assignedUserId: f.owner.id, summary: secret, ...extra }).returning())[0];
}
async function task(f: Fixture, extra: Partial<typeof crmTasksTable.$inferInsert> = {}) {
  return (await db.insert(crmTasksTable).values({ organizationId: f.org, contactId: f.contact.id,
    assignedUserId: f.owner.id, title: "Check equipment", description: secret, ...extra }).returning())[0];
}
async function appointment(f: Fixture, extra: Partial<typeof appointmentsTable.$inferInsert> = {}) {
  return (await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact.id,
    propertyId: f.property.id, assignedUserId: f.owner.id, scheduledStart: at, notes: secret, ...extra }).returning())[0];
}
async function service(f: Fixture, extra: Partial<typeof serviceObligationsTable.$inferInsert> = {}) {
  const t = await task(f);
  return (await db.insert(serviceObligationsTable).values({ organizationId: f.org, contactId: f.contact.id,
    propertyId: f.property.id, taskId: t.id, kind: "maintenance", equipmentLabel: "Recorded HVAC unit",
    dueAt: at, notes: secret, coverageEvidence: secret, completionNote: secret, ...extra }).returning())[0];
}
async function estimate(f: Fixture, leadId: string) {
  return (await db.insert(estimatesTable).values({ organizationId: f.org, leadId, title: "Estimate scope",
    totalCents: 987654, notes: secret, lineItems: [{ description: secret, quantity: 1, unitPriceCents: 987654, totalCents: 987654 }] }).returning())[0];
}
async function invoice(f: Fixture, leadId: string, extra: Partial<typeof invoicesTable.$inferInsert> = {}) {
  return (await db.insert(invoicesTable).values({ organizationId: f.org, leadId, createdByUserId: f.owner.id,
    draftDocument: { title: "Recorded invoice", currency: "USD", issuerName: secret, issuerAddress: secret,
      customerName: secret, customerAddress: secret, dueDate: null, notes: secret, lineItems: [],
      subtotalCents: 987654, taxCents: 0, totalCents: 987654 }, ...extra }).returning())[0];
}
afterAll(async () => { vi.restoreAllMocks(); await deleteTestOrgs(...orgs); }, 30000);

describe("canonical customer workspace read model", () => {
  it("shows a service-only customer, explicit properties and null property without inventing a lead", async () => {
    const f = await fixture();
    const visit = await appointment(f, { leadId: null });
    const s = await service(f, { appointmentId: visit.id });
    const unlinked = await service(f, { propertyId: null });
    const header = await getCustomerWorkspace(f.org, f.owner.id, f.contact.id);
    expect(customerWorkspaceHeaderSchema.parse(header)).toMatchObject({ organizationId: f.org,
      contact: { id: f.contact.id, doNotContactSms: true }, permissions: { canWrite: true, canReadInvoices: true },
      availableSections: [...CUSTOMER_WORKSPACE_SECTIONS] });
    expect((await page(f, "properties")).items.map(row => row.id).sort()).toEqual([f.property.id, f.second.id].sort());
    expect((await page(f, "leads")).items).toEqual([]);
    expect((await page(f, "services")).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: s.id, kind: "service", serviceKind: "maintenance", property: expect.objectContaining({ id: f.property.id }) }),
      expect.objectContaining({ id: unlinked.id, property: null }),
    ]));
    expect((await page(f, "appointments")).items).toHaveLength(1);
    expect((await page(f, "tasks")).items).toHaveLength(2);
    const stored = await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org));
    expect(stored).toHaveLength(0);
  });

  it("projects only strict non-monetary fields for every supported record", async () => {
    const f = await fixture(), l = await lead(f), e = await estimate(f, l.id);
    const [j] = await db.insert(projectsTable).values({ organizationId: f.org, leadId: l.id,
      estimateId: e.id, name: "Roof work", crewNotes: secret, crewUserIds: [f.owner.id] }).returning();
    await invoice(f, l.id, { projectId: j.id, estimateId: e.id });
    await appointment(f, { leadId: l.id }); await service(f); await task(f, { leadId: l.id });
    await db.insert(activitiesTable).values({ organizationId: f.org, leadId: l.id, contactId: f.contact.id,
      actorUserId: f.owner.id, type: "email_sent", title: secret, body: secret, metadata: { secret, url: "https://private.invalid/object" } });
    for (const section of CUSTOMER_WORKSPACE_SECTIONS) {
      const result = customerWorkspacePageSchema.parse(await page(f, section));
      expect(result.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toMatch(/987654|totalCents|balanceCents|metadata|private.invalid|@example.invalid/);
    }
    expect((await page(f, "activity")).items[0]).toMatchObject({ category: "communication", label: "Communication event recorded" });
  });

  it("requires current accepted verified active membership and preserves effective-role caps", async () => {
    const f = await fixture();
    expect((await getCustomerWorkspace(f.org, f.owner.id, f.contact.id, "viewer")).permissions).toEqual({ canWrite: false, canReadInvoices: false });
    for (const user of [f.viewer, f.inspector]) {
      const h = await getCustomerWorkspace(f.org, user.id, f.contact.id);
      expect(h.availableSections).not.toContain("invoices");
      await expect(getCustomerWorkspaceSection(f.org, user.id, f.contact.id, { section: "invoices" })).rejects.toMatchObject({ status: 403 });
    }
    await expect(getCustomerWorkspaceSection(f.org, f.owner.id, f.contact.id, { section: "invoices" }, "viewer")).rejects.toMatchObject({ status: 403 });
    await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, f.owner.id));
    await expect(getCustomerWorkspaceSection(f.org, f.owner.id, f.contact.id, { section: "invoices" }, "owner")).rejects.toMatchObject({ status: 403 });
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.owner.id));
    await expect(getCustomerWorkspace(f.org, f.owner.id, f.contact.id)).rejects.toMatchObject({ status: 403 });
    await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, f.viewer.id));
    await expect(getCustomerWorkspace(f.org, f.viewer.id, f.contact.id)).rejects.toMatchObject({ status: 403 });
    const [invited] = await db.insert(usersTable).values({ id: `invite:${randomUUID()}`, organizationId: f.org, role: "owner" }).returning();
    await expect(getCustomerWorkspace(f.org, invited.id, f.contact.id)).rejects.toMatchObject({ status: 403 });
  });

  it("never merges matching names, address, email or phone and hides cross-company records", async () => {
    const f = await fixture(), foreign = await fixture();
    await lead(f); await lead(f, { contactId: f.other.id, propertyId: f.unrelated.id });
    await lead(foreign);
    expect((await page(f, "leads")).items).toHaveLength(1);
    expect((await page(f, "properties")).items).toHaveLength(2);
    await expect(getCustomerWorkspace(f.org, f.owner.id, foreign.contact.id)).rejects.toMatchObject({ status: 404 });
    await expect(getCustomerWorkspace(f.org, foreign.owner.id, f.contact.id)).rejects.toMatchObject({ status: 403 });
    const foreignVisit = await appointment(foreign);
    await expect(getCustomerWorkspaceAppointment(f.org, f.owner.id, foreignVisit.id)).rejects.toMatchObject({ status: 404 });
  });

  it("validates populated lead/property/staff parents before paging and excludes their descendants", async () => {
    const f = await fixture(), foreign = await fixture();
    const good = await lead(f), wrongCustomer = await lead(f, { propertyId: f.unrelated.id });
    const wrongCompany = await lead(f, { propertyId: foreign.property.id });
    const wrongOwner = await lead(f, { assignedUserId: foreign.owner.id });
    for (const l of [wrongCustomer, wrongCompany, wrongOwner]) {
      await estimate(f, l.id); await invoice(f, l.id);
      await appointment(f, { leadId: l.id }); await task(f, { leadId: l.id });
    }
    expect((await page(f, "leads")).items.map(row => row.id)).toEqual([good.id]);
    for (const section of ["estimates", "invoices", "appointments", "tasks"] as const)
      expect((await page(f, section)).items).toEqual([]);
    await db.insert(propertiesTable).values({ organizationId: f.org, contactId: foreign.contact.id,
      addressLine1: "Foreign contact property", city: "Test", state: "GA", postalCode: "30000" });
    expect((await page(f, "properties")).items).toHaveLength(2);
  });

  it("requires optional estimate and project parents to match the exact opportunity, not just customer", async () => {
    const f = await fixture(), l = await lead(f), otherLead = await lead(f), e = await estimate(f, l.id), otherEstimate = await estimate(f, otherLead.id);
    const [badProject, goodProject] = await db.insert(projectsTable).values([
      { organizationId: f.org, leadId: l.id, estimateId: otherEstimate.id, name: "Mismatched estimate" },
      { organizationId: f.org, leadId: l.id, estimateId: e.id, name: "Correct job" },
    ]).returning();
    await invoice(f, l.id, { projectId: badProject.id });
    await invoice(f, otherLead.id, { projectId: goodProject.id });
    await invoice(f, l.id, { estimateId: otherEstimate.id });
    const extraEstimate = await estimate(f, l.id);
    await invoice(f, l.id, { projectId: goodProject.id, estimateId: extraEstimate.id });
    const validInvoice = await invoice(f, l.id, { projectId: goodProject.id, estimateId: e.id });
    expect((await page(f, "projects")).items.map(row => row.id)).toEqual([goodProject.id]);
    expect((await page(f, "invoices")).items.map(row => row.id)).toEqual([validInvoice.id]);
  });

  it("checks every appointment parent and preserves exact unlinked or old service-only visits", async () => {
    const f = await fixture(), l = await lead(f), foreign = await fixture();
    const invalidVisits = [
      await appointment(f, { contactId: f.other.id, leadId: l.id }),
      await appointment(f, { leadId: l.id, propertyId: f.second.id }),
      await appointment(f, { propertyId: f.unrelated.id }),
      await appointment(f, { propertyId: foreign.property.id }),
      await appointment(f, { assignedUserId: foreign.owner.id }),
    ];
    for (const a of invalidVisits) await expect(getCustomerWorkspaceAppointment(f.org, f.owner.id, a.id)).rejects.toMatchObject({ status: 404 });
    const old = await appointment(f, { scheduledStart: new Date("2001-01-01T12:00:00Z"), leadId: null, propertyId: null });
    const throughLead = await appointment(f, { contactId: null, leadId: l.id, propertyId: null });
    const throughProperty = await appointment(f, { contactId: null, leadId: null });
    const unlinked = await appointment(f, { contactId: null, leadId: null, propertyId: null });
    expect(customerWorkspaceAppointmentDetailSchema.parse(await getCustomerWorkspaceAppointment(f.org, f.viewer.id, old.id)))
      .toMatchObject({ organizationId: f.org, permissions: { canWrite: false }, appointment: { id: old.id, leadId: null, contactId: f.contact.id, property: null } });
    expect((await getCustomerWorkspaceAppointment(f.org, f.owner.id, unlinked.id)).appointment.contactId).toBeNull();
    expect((await page(f, "appointments")).items.map(row => row.id).sort()).toEqual([old.id, throughLead.id, throughProperty.id].sort());
  });

  it("requires task/activity dual parents to agree and redacts unknown/financial history before paging", async () => {
    const f = await fixture(), l = await lead(f), foreign = await fixture();
    await task(f, { contactId: f.other.id, leadId: l.id });
    await task(f, { leadId: l.id, assignedUserId: foreign.owner.id });
    await task(f, { contactId: null, leadId: null });
    const valid = await task(f, { contactId: null, leadId: l.id });
    expect((await page(f, "tasks")).items.map(row => row.id)).toEqual([valid.id]);
    await db.insert(activitiesTable).values([
      { organizationId: f.org, contactId: f.other.id, leadId: l.id, type: "note", title: secret },
      { organizationId: f.org, contactId: f.contact.id, actorUserId: foreign.owner.id, type: "note", title: secret },
      { organizationId: f.org, contactId: f.contact.id, type: "unknown-private-type", title: secret },
      { organizationId: f.org, contactId: f.contact.id, type: "invoice_event", title: secret, body: secret },
      { organizationId: f.org, contactId: f.contact.id, type: "customer_reply", title: secret, body: secret },
    ]);
    const ownerPage = await page(f, "activity");
    expect(ownerPage.items).toHaveLength(2);
    expect(JSON.stringify(ownerPage)).not.toContain(secret);
    const viewerPage = await getCustomerWorkspaceSection(f.org, f.viewer.id, f.contact.id, { section: "activity" });
    expect(viewerPage.items).toEqual([expect.objectContaining({ category: "communication", label: "Customer response recorded" })]);
  });

  it("validates service task, appointment, property and all ancestor links without guessing repairs", async () => {
    const f = await fixture(), foreign = await fixture();
    const root = await service(f, { status: "completed", completedAt: at });
    const next = await service(f, { predecessorObligationId: root.id, occurrenceIndex: 1 });
    const wrongTask = await task(f, { contactId: f.other.id });
    await service(f, { taskId: wrongTask.id });
    await service(f, { propertyId: f.unrelated.id });
    await service(f, { appointmentId: (await appointment(f, { contactId: f.other.id, propertyId: f.unrelated.id })).id });
    await service(f, { appointmentId: (await appointment(f, { propertyId: f.second.id })).id });
    const foreignRoot = await service(foreign);
    await service(f, { predecessorObligationId: foreignRoot.id, occurrenceIndex: 1 });
    const changedProperty = await service(f, { predecessorObligationId: next.id, occurrenceIndex: 2, propertyId: f.second.id });
    await service(f, { predecessorObligationId: changedProperty.id, occurrenceIndex: 3, propertyId: f.second.id });
    expect((await page(f, "services")).items.map(row => row.id).sort()).toEqual([root.id, next.id].sort());
    // Close the existing chain into a cycle without violating its one-successor key.
    const tail = (await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, changedProperty.id)))[0];
    await db.update(serviceObligationsTable).set({ predecessorObligationId: tail.id }).where(eq(serviceObligationsTable.id, root.id));
    expect((await page(f, "services")).items).toEqual([]);
  });

  it("bounds ancestry traversal and does not expose successors beyond the validated bound", async () => {
    const f = await fixture(), count = 258;
    const taskIds = Array.from({ length: count }, () => randomUUID()), serviceIds = taskIds.map(() => randomUUID());
    await db.insert(crmTasksTable).values(taskIds.map(id => ({ id, organizationId: f.org, contactId: f.contact.id, title: "Historical service" })));
    await db.insert(serviceObligationsTable).values(serviceIds.map((id, index) => ({ id, organizationId: f.org,
      contactId: f.contact.id, taskId: taskIds[index], propertyId: null, kind: "maintenance" as const,
      equipmentLabel: "Historical unit", dueAt: at, predecessorObligationId: index ? serviceIds[index - 1] : null,
      occurrenceIndex: index, createdAt: new Date(at.getTime() + index) })));
    const ids: string[] = []; let cursor: string | undefined;
    do { const result = await page(f, "services", cursor); ids.push(...result.items.map(row => row.id)); cursor = result.nextCursor ?? undefined; } while (cursor);
    expect(ids).toHaveLength(256);
    expect(ids).not.toContain(serviceIds[256]); expect(ids).not.toContain(serviceIds[257]);
  });

  it("uses microsecond keysets with UUID ties and stays stable after newer inserts and status edits", async () => {
    const f = await fixture();
    const rows = await db.insert(leadsTable).values(Array.from({ length: 61 }, () => ({ organizationId: f.org, contactId: f.contact.id }))).returning();
    for (let index = 0; index < rows.length; index++) {
      const timestamp = `2026-01-02T12:00:00.${String(100001 + Math.floor(index / 3)).padStart(6, "0")}Z`;
      await db.execute(sql`UPDATE leads SET created_at=${timestamp}::timestamptz WHERE id=${rows[index].id}`);
    }
    const expected = (await db.execute(sql`SELECT id FROM leads WHERE organization_id=${f.org} ORDER BY created_at DESC,id DESC`)).rows.map(row => row.id);
    const first = await page(f, "leads");
    expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true);
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString());
    expect(decoded.createdAt).toMatch(/\.100013Z$/);
    await lead(f, { createdAt: new Date("2027-01-01T00:00:00Z") });
    await db.update(leadsTable).set({ status: "completed", updatedAt: new Date() }).where(eq(leadsTable.id, rows[0].id));
    const second = await page(f, "leads", first.nextCursor!);
    const third = await page(f, "leads", second.nextCursor!);
    const seen = [...first.items, ...second.items, ...third.items].map(row => row.id);
    expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(61);
    expect(third).toMatchObject({ nextCursor: null, hasMore: false });
  });

  it("pages every section beyond the first 25 without duplicates or omitted historical records", async () => {
    const f = await fixture(), count = 28;
    const ls = await db.insert(leadsTable).values(Array.from({ length: count }, () => ({ organizationId: f.org, contactId: f.contact.id, createdAt: at }))).returning();
    const ts = await db.insert(crmTasksTable).values(ls.map(l => ({ organizationId: f.org, contactId: f.contact.id, leadId: l.id, title: "Older work", createdAt: at }))).returning();
    const es = await db.insert(estimatesTable).values(ls.map(l => ({ organizationId: f.org, leadId: l.id, title: "Older estimate", createdAt: at }))).returning();
    await db.insert(projectsTable).values(ls.map(l => ({ organizationId: f.org, leadId: l.id, name: "Older job", createdAt: at })));
    await db.insert(propertiesTable).values(ls.map(() => ({ organizationId: f.org, contactId: f.contact.id,
      addressLine1: "Older property", city: "Test", state: "GA", postalCode: "30000", createdAt: at })));
    await db.insert(appointmentsTable).values(ls.map(l => ({ organizationId: f.org, contactId: f.contact.id, leadId: l.id, scheduledStart: at, createdAt: at })));
    await db.insert(serviceObligationsTable).values(ts.map(t => ({ organizationId: f.org, contactId: f.contact.id, taskId: t.id,
      kind: "maintenance" as const, equipmentLabel: "Older equipment", dueAt: at, createdAt: at })));
    await db.insert(activitiesTable).values(ls.map(l => ({ organizationId: f.org, contactId: f.contact.id, leadId: l.id, type: "note", title: secret, createdAt: at })));
    for (const l of ls) await invoice(f, l.id, { createdAt: at });
    for (const section of CUSTOMER_WORKSPACE_SECTIONS) {
      const first = await page(f, section), second = await page(f, section, first.nextCursor!);
      expect(first).toMatchObject({ hasMore: true, limit: 25, section, order: "created_desc" });
      expect(first.items).toHaveLength(25);
      expect(second).toMatchObject({ hasMore: false, nextCursor: null });
      const ids = [...first.items, ...second.items].map(row => row.id);
      expect(new Set(ids).size).toBe(section === "properties" ? count + 2 : count);
      expect(ids.length).toBe(new Set(ids).size);
      if (section === "estimates") expect(ids.sort()).toEqual(es.map(e => e.id).sort());
    }
  });

  it("filters invalid parents and unauthorized history before the lookahead limit", async () => {
    const f = await fixture();
    const good = await lead(f, { createdAt: at });
    await db.insert(leadsTable).values(Array.from({ length: 30 }, () => ({ organizationId: f.org,
      contactId: f.contact.id, propertyId: f.unrelated.id, createdAt: new Date("2027-01-01T00:00:00Z") })));
    expect(await page(f, "leads")).toMatchObject({ items: [expect.objectContaining({ id: good.id })], hasMore: false, nextCursor: null });
    await db.insert(activitiesTable).values(Array.from({ length: 30 }, () => ({ organizationId: f.org,
      contactId: f.contact.id, type: "invoice_event", title: secret, createdAt: new Date("2027-01-01T00:00:00Z") })));
    const [note] = await db.insert(activitiesTable).values({ organizationId: f.org, contactId: f.contact.id, type: "note", title: secret, createdAt: at }).returning();
    expect(await getCustomerWorkspaceSection(f.org, f.viewer.id, f.contact.id, { section: "activity" }))
      .toMatchObject({ items: [expect.objectContaining({ id: note.id, label: "Note recorded" })], hasMore: false, nextCursor: null });
  });

  it("rejects malformed and foreign-context cursors and unknown selectors", async () => {
    const f = await fixture(), foreign = await fixture();
    await db.insert(leadsTable).values(Array.from({ length: 26 }, () => ({ organizationId: f.org, contactId: f.contact.id })));
    const result = await page(f, "leads");
    await expect(page(f, "tasks", result.nextCursor!)).rejects.toMatchObject({ status: 400 });
    await expect(getCustomerWorkspaceSection(f.org, f.owner.id, f.other.id, { section: "leads", cursor: result.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await expect(page(foreign, "leads", result.nextCursor!)).rejects.toMatchObject({ status: 400 });
    for (const cursor of ["%%", "e30", `${result.nextCursor}=`, Buffer.from(JSON.stringify({ version: 1 })).toString("base64url")])
      await expect(page(f, "leads", cursor)).rejects.toMatchObject({ status: 400 });
    await expect(getCustomerWorkspaceSection(f.org, f.owner.id, f.contact.id, { section: "leads", offset: 1 } as never)).rejects.toMatchObject({ status: 400 });
    await expect(getCustomerWorkspace(f.org, f.owner.id, "not-a-uuid")).rejects.toMatchObject({ status: 400 });
    await expect(getCustomerWorkspaceAppointment(f.org, f.owner.id, "not-a-uuid")).rejects.toMatchObject({ status: 400 });
  });

  it("fails closed for malformed saved projections instead of returning private fields or blaming request input", async () => {
    const f = await fixture();
    await service(f, { coverageStartsOn: "not-a-recorded-date" });
    await expect(page(f, "services")).rejects.toMatchObject({ status: 503, code: "customer_workspace_unavailable" });
    expect(customerWorkspaceHeaderSchema.safeParse({ ...(await getCustomerWorkspace(f.org, f.owner.id, f.contact.id)), privateMetadata: secret }).success).toBe(false);
    const appointmentDetail = await getCustomerWorkspaceAppointment(f.org, f.owner.id, (await appointment(f)).id);
    expect(customerWorkspaceAppointmentDetailSchema.safeParse({ ...appointmentDetail, appointment: { ...appointmentDetail.appointment, notes: secret } }).success).toBe(false);
    expect(customerWorkspacePageSchema.safeParse({ ...(await page(f, "properties")), section: "invoices" }).success).toBe(false);
  });

  it("uses read-only transactions without settings, audit, enrollment or provider effects", async () => {
    const f = await fixture(), visit = await appointment(f); await service(f);
    await db.execute(sql`INSERT INTO customer_lifecycle (organization_id,state,reason) VALUES (${f.org},'paused','Synthetic read-only acceptance')`);
    const snapshot = async () => (await db.execute(sql`SELECT
      (SELECT count(*) FROM org_settings WHERE organization_id=${f.org}) AS settings,
      (SELECT count(*) FROM audit_events WHERE organization_id=${f.org}) AS audits,
      (SELECT count(*) FROM scheduled_actions WHERE organization_id=${f.org}) AS scheduled,
      (SELECT count(*) FROM service_standing_enrollments WHERE organization_id=${f.org}) AS enrollments`)).rows[0];
    const before = await snapshot();
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider access"));
    const transactions = vi.spyOn(db, "transaction");
    try {
      await getCustomerWorkspace(f.org, f.owner.id, f.contact.id);
      for (const section of CUSTOMER_WORKSPACE_SECTIONS) await page(f, section);
      await getCustomerWorkspaceAppointment(f.org, f.owner.id, visit.id);
      expect(transactions).toHaveBeenCalledTimes(11);
      expect(transactions.mock.calls.every(call => call[1]?.accessMode === "read only")).toBe(true);
      expect(await snapshot()).toEqual(before); expect(outbound).not.toHaveBeenCalled();
    } finally { transactions.mockRestore(); outbound.mockRestore(); }
  });
});
