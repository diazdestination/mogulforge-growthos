import { contactsTable, db, leadImportsTable, leadsTable, organizationsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { importLeads, listImports, previewSegment, type ImportField } from "./reactivation";
import { needsSourceVerification, originalOpportunityDate } from "./source-history";

let orgId: string;
let otherOrgId: string;
beforeAll(async () => {
  [orgId, otherOrgId] = (await db.insert(organizationsTable).values([
    { name: "Import history", slug: `import-history-${crypto.randomUUID()}` },
    { name: "Import history other", slug: `import-other-${crypto.randomUUID()}` },
  ]).returning()).map((org) => org.id);
});
afterAll(async () => { await deleteTestOrgs(orgId, otherOrgId); });

const fields = ["firstName", "email", "externalOpportunityId", "originalCreatedAt", "sourceUpdatedAt", "lastContactAt", "estimatedValue", "currency", "status", "externalCustomerId"] as const;
const mapping = Object.fromEntries(fields.map((key, index) => [key, index])) as Partial<Record<ImportField, number>>;
const row = (id: string, overrides: Partial<Record<typeof fields[number], string>> = {}) => fields.map((key) => ({
  firstName: "Sample", email: `${id}@example.invalid`, externalOpportunityId: id,
  originalCreatedAt: "2025-01-01", sourceUpdatedAt: "2025-07-01", lastContactAt: "2025-02-01",
  estimatedValue: "12500.50", currency: "USD", status: "estimate_sent", externalCustomerId: `${id}-customer`,
  ...overrides,
})[key]).join(",");
async function upload(rows: string[], organizationId = orgId, sourceKey = "sample-account") {
  const result = await importLeads(organizationId, { csv: [fields.join(","), ...rows].join("\n"), mapping, sourceKey, snapshotAsOf: "2025-09-01" });
  if ("error" in result) throw new Error(result.error);
  return result;
}
async function opportunity(id: string, organizationId = orgId, sourceKey = "sample-account") {
  const [lead] = await db.select().from(leadsTable).where(and(
    eq(leadsTable.organizationId, organizationId), eq(leadsTable.importSourceKey, sourceKey), eq(leadsTable.externalOpportunityId, id),
  ));
  return lead;
}

describe("historical opportunity import", () => {
  it("preserves source identity, dates and known/unknown values independently of ingestion", async () => {
    const receivedAfter = Date.now();
    const result = await upload([row("history"), row("unknown", { originalCreatedAt: "", lastContactAt: "", estimatedValue: "", currency: "" }), row("zero", { estimatedValue: "0" })]);
    expect(result).toMatchObject({ imported: 3, updated: 0, conflicts: 0, sourceKey: "sample-account" });
    const lead = await opportunity("history");
    expect(lead.createdAt.getTime()).toBeGreaterThanOrEqual(receivedAfter - 1000);
    expect(lead.estimatedValueCents).toBe(1_250_050);
    expect(lead.importedHistory).toMatchObject({ originalCreatedAt: "2025-01-01T00:00:00.000Z", lastContactAt: "2025-02-01T00:00:00.000Z", snapshotAsOf: "2025-09-01T00:00:00.000Z", kind: "csv_snapshot" });
    expect(JSON.stringify(lead.importedHistory)).not.toContain("example.invalid");
    expect(originalOpportunityDate(lead)?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(needsSourceVerification(lead)).toBe(true);
    const unknown = await opportunity("unknown");
    expect(unknown.estimatedValueCents).toBeNull();
    expect(originalOpportunityDate(unknown)).toBeNull();
    expect((await opportunity("zero")).estimatedValueCents).toBe(0);
    expect((await listImports(otherOrgId)).some((batch) => batch.id === result.id)).toBe(false);
    const [batch] = await db.select().from(leadImportsTable).where(eq(leadImportsTable.id, result.id));
    expect(batch.snapshotAsOf?.toISOString()).toBe("2025-09-01T00:00:00.000Z");
  });

  it("creates distinct jobs for one existing contact and keeps identical repeats idempotent", async () => {
    const email = "repeat-jobs@example.invalid";
    const [contact] = await db.insert(contactsTable).values({ organizationId: orgId, firstName: "Existing", email }).returning();
    const rows = [row("job-a", { email, externalCustomerId: "shared-customer" }), row("job-b", { email, externalCustomerId: "shared-customer" })];
    expect(await upload(rows)).toMatchObject({ imported: 2, duplicates: 0 });
    const initial = await opportunity("job-a");
    expect(initial.contactId).toBe(contact.id);
    expect((await opportunity("job-b")).contactId).toBe(contact.id);
    expect(await upload(rows)).toMatchObject({ imported: 0, updated: 0, duplicates: 2 });
    expect((await opportunity("job-a")).importedHistory?.lastImportedAt).toBe(initial.importedHistory?.lastImportedAt);
  });

  it("safely updates newer snapshots and quarantines old, equal-time conflicting or locally edited records", async () => {
    await upload([row("upsert")]);
    const initial = await opportunity("upsert");
    expect(await upload([row("upsert", { sourceUpdatedAt: "2025-08-01", status: "won", estimatedValue: "13000" })])).toMatchObject({ updated: 1, imported: 0 });
    const updated = await opportunity("upsert");
    expect(updated.id).toBe(initial.id);
    expect(updated.createdAt).toEqual(initial.createdAt);
    expect(updated.status).toBe("won");
    expect(updated.importedHistory?.firstImportedAt).toBe(initial.importedHistory?.firstImportedAt);
    expect(await upload([row("upsert")])).toMatchObject({ conflicts: 1, updated: 0 });
    expect(await upload([row("upsert", { sourceUpdatedAt: "2025-08-01", status: "lost" })])).toMatchObject({ conflicts: 1 });
    await db.update(leadsTable).set({ status: "completed" }).where(eq(leadsTable.id, initial.id));
    expect(await upload([row("upsert", { sourceUpdatedAt: "2025-08-02", status: "lost" })])).toMatchObject({ conflicts: 1 });
    expect((await opportunity("upsert")).status).toBe("completed");
  });

  it("scopes identical source identities to both tenant and source account", async () => {
    expect(await upload([row("shared-id")])).toMatchObject({ imported: 1 });
    expect(await upload([row("shared-id")], otherOrgId)).toMatchObject({ imported: 1 });
    expect(await upload([row("shared-id")], orgId, "other-account")).toMatchObject({ imported: 1 });
    expect((await opportunity("shared-id")).id).not.toBe((await opportunity("shared-id", otherOrgId)).id);
    expect((await opportunity("shared-id")).id).not.toBe((await opportunity("shared-id", orgId, "other-account")).id);
  });

  it("repeated requests keep one source opportunity and one contact", async () => {
    const results = await Promise.all([upload([row("concurrent")]), upload([row("concurrent")])]);
    expect(results.reduce((count, result) => count + result.imported, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.duplicates, 0)).toBe(1);
    const leads = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, orgId), eq(leadsTable.externalOpportunityId, "concurrent")));
    expect(leads).toHaveLength(1);
    const contacts = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, orgId), eq(contactsTable.email, "concurrent@example.invalid")));
    expect(contacts).toHaveLength(1);
  });

  it("does not clear values from a changed mapping or rewind known source history", async () => {
    await upload([row("partial")]);
    const { estimatedValue: _amount, ...partialMapping } = mapping;
    const result = await importLeads(orgId, {
      csv: `${fields.join(",")}\n${row("partial", { sourceUpdatedAt: "2025-08-01" })}`,
      mapping: partialMapping, sourceKey: "sample-account", snapshotAsOf: "2025-09-01",
    });
    expect(result).toMatchObject({ conflicts: 1, updated: 0 });
    expect((await opportunity("partial")).estimatedValueCents).toBe(1_250_050);
    expect(await upload([row("partial", { sourceUpdatedAt: "2025-08-01", lastContactAt: "2025-01-02" })])).toMatchObject({ conflicts: 1 });
    expect(await upload([row("partial", { sourceUpdatedAt: "2025-08-01", originalCreatedAt: "2025-01-02" })])).toMatchObject({ conflicts: 1 });
    expect(await upload([row("partial", { sourceUpdatedAt: "2025-08-01", status: "" })])).toMatchObject({ skipped: 1 });
  });

  it("rejects truncated rows without clearing known amounts or notes", async () => {
    const header = "First,Email,Opportunity,Updated,Status,Currency,Amount,Notes";
    const narrowMapping = { firstName: 0, email: 1, externalOpportunityId: 2, sourceUpdatedAt: 3, status: 4, currency: 5, estimatedValue: 6, notes: 7 };
    const initial = await importLeads(orgId, { csv: `${header}\nSample,truncated@example.invalid,truncated,2025-07-01,estimate_sent,USD,2500,Original note`, mapping: narrowMapping, sourceKey: "sample-account" });
    expect(initial).toMatchObject({ imported: 1 });
    const truncated = await importLeads(orgId, { csv: `${header}\nSample,truncated@example.invalid,truncated,2025-08-01,estimate_sent,USD`, mapping: narrowMapping, sourceKey: "sample-account" });
    expect(truncated).toMatchObject({ skipped: 1, updated: 0 });
    expect(await opportunity("truncated")).toMatchObject({ estimatedValueCents: 250_000, summary: "Original note" });
    const badHeader = await importLeads(orgId, { csv: "First,Email\nSample,sample@example.invalid", mapping: { firstName: 0, email: 1, estimatedValue: 9 } });
    expect(badHeader).toHaveProperty("error", "A mapped column is missing from the CSV header");
  });

  it("keeps original attribution and updates latest source without overwriting a staff attribution edit", async () => {
    const uploadWithSource = async (updated: string, source: string) => importLeads(orgId, {
      csv: `${[...fields, "Source"].join(",")}\n${row("attribution", { sourceUpdatedAt: updated })},${source}`,
      mapping: { ...mapping, source: fields.length }, sourceKey: "sample-account",
    });
    expect(await uploadWithSource("2025-07-01", "search")).toMatchObject({ imported: 1 });
    expect(await uploadWithSource("2025-08-01", "referral")).toMatchObject({ updated: 1 });
    const lead = await opportunity("attribution");
    expect(lead).toMatchObject({ source: "search", latestSource: "referral" });
    await db.update(leadsTable).set({ latestSource: "staff-reviewed" }).where(eq(leadsTable.id, lead.id));
    expect(await uploadWithSource("2025-08-02", "campaign")).toMatchObject({ conflicts: 1, updated: 0 });
    expect((await opportunity("attribution")).latestSource).toBe("staff-reviewed");
  });

  it("does not resolve ambiguous contacts or transfer an existing opportunity to another person", async () => {
    await db.insert(contactsTable).values([
      { organizationId: orgId, firstName: "One", email: "ambiguous@example.invalid" },
      { organizationId: orgId, firstName: "Two", email: "ambiguous@example.invalid" },
    ]);
    expect(await upload([row("ambiguous", { email: "ambiguous@example.invalid" })])).toMatchObject({ conflicts: 1, imported: 0 });
    await upload([row("identity")]);
    expect(await upload([row("identity", { email: "changed-person@example.invalid", sourceUpdatedAt: "2025-08-01" })])).toMatchObject({ conflicts: 1 });
    expect(await upload([row("identity", { externalCustomerId: "different-id", sourceUpdatedAt: "2025-08-01" })])).toMatchObject({ conflicts: 1 });
  });

  it("quarantines different customers sharing a phone instead of attaching their jobs to the first customer", async () => {
    const withPhone = async (rows: string[]) => {
      const result = await importLeads(orgId, {
        csv: [[...fields, "phone"].join(","), ...rows].join("\n"),
        mapping: { ...mapping, phone: fields.length }, sourceKey: "shared-phone-account",
      });
      if ("error" in result) throw new Error(result.error);
      return result;
    };
    const a = `${row("shared-phone-a", { email: "shared-a@example.invalid", externalCustomerId: "source-customer-a" })},5551234567`;
    expect(await withPhone([a])).toMatchObject({ imported: 1 });
    const b = `${row("shared-phone-b", { email: "shared-b@example.invalid", externalCustomerId: "source-customer-b" })},5551234567`;
    expect(await withPhone([b])).toMatchObject({ imported: 0, conflicts: 1 });
    const phoneOnly = `${row("shared-phone-c", { email: "", externalCustomerId: "source-customer-c" })},5551234567`;
    expect(await withPhone([phoneOnly])).toMatchObject({ imported: 0, conflicts: 1 });
    const changedIdentity = `${row("shared-phone-changed", { email: "different-email@example.invalid", externalCustomerId: "source-customer-a" })},5559998888`;
    expect(await withPhone([changedIdentity])).toMatchObject({ imported: 0, conflicts: 1 });
    expect(await opportunity("shared-phone-changed", orgId, "shared-phone-account")).toBeUndefined();
    const secondJob = `${row("shared-phone-repeat", { email: "shared-a@example.invalid", externalCustomerId: "source-customer-a" })},5551234567`;
    expect(await withPhone([secondJob])).toMatchObject({ imported: 1, conflicts: 0 });
    const oldJob = await opportunity("shared-phone-a", orgId, "shared-phone-account");
    const repeat = await opportunity("shared-phone-repeat", orgId, "shared-phone-account");
    expect(repeat.contactId).toBe(oldJob.contactId);
    expect(await opportunity("shared-phone-b", orgId, "shared-phone-account")).toBeUndefined();
  });

  it("rejects invalid mappings, missing IDs, guessed dates/currencies and future source history", async () => {
    const rows = [row("", {}), row("bad-date", { originalCreatedAt: "01/02/2025" }), row("bad-currency", { currency: "CAD" }), row("no-currency", { currency: "" }), row("future", { sourceUpdatedAt: "2099-01-01" }), row("bad-status", { status: "MadeUpStage" })];
    expect(await upload(rows)).toMatchObject({ imported: 0, skipped: 6 });
    expect(await importLeads(orgId, { csv: "Name,Email\nSample,sample@example.invalid", mapping: { firstName: 0, email: -1 } })).toHaveProperty("error");
    expect(await importLeads(orgId, { csv: "Name,Email\nSample,sample@example.invalid", mapping: { firstName: 0, email: 0 } })).toHaveProperty("error");
    expect(await importLeads(orgId, { csv: `${fields.join(",")}\n${row("missing-source")}`, mapping })).toHaveProperty("error");
    expect(await importLeads(orgId, { csv: "First,Email,Address\nSample,sample@example.invalid,1 Main St", mapping: { firstName: 0, email: 1, addressLine1: 2 } as never })).toHaveProperty("error");
  });

  it("uses historical age and last contact for analysis, excludes unknown dates and remains explicit about verification", async () => {
    await upload([row("old-segment", { status: "follow_up" }), row("unknown-segment", { status: "follow_up", originalCreatedAt: "", lastContactAt: "" })]);
    const old = await opportunity("old-segment");
    const unknown = await opportunity("unknown-segment");
    const before = await previewSegment(orgId, { statuses: ["follow_up"], minAgeDays: 30 });
    expect(before.sample.some((sample) => sample.id === old.id)).toBe(true);
    expect(before.sample.some((sample) => sample.id === unknown.id)).toBe(false);
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    await db.update(leadsTable).set({ importedHistory: { ...unknown.importedHistory!, originalCreatedAt: "2025-01-01T00:00:00.000Z", lastContactAt: recent } }).where(eq(leadsTable.id, unknown.id));
    const aged = await previewSegment(orgId, { statuses: ["follow_up"], minAgeDays: 30, inactiveDays: 30 });
    expect(aged.sample.find((sample) => sample.id === old.id)).toMatchObject({ originalCreatedAt: "2025-01-01T00:00:00.000Z", requiresSourceVerification: true });
    expect(aged.sample.some((sample) => sample.id === unknown.id)).toBe(false);
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(and(eq(leadsTable.organizationId, orgId), eq(leadsTable.externalOpportunityId, "old-segment")));
    expect(count.count).toBe(1);
  });
});
