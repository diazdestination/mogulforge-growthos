import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, propertiesTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { workdayTestAsset } from "../test-helpers/contractor-workday-fixture";
import { returningCustomerFixture, returningInvoiceDocument, type ReturningCustomerFixture } from "../test-helpers/returning-customer-fixture";
import { createWorkdayAsset, updateWorkdayAsset } from "./property-assets";
import { createInvoice, getInvoice, issueInvoice, updateInvoice } from "./invoices";
import { renderInvoiceEmail } from "./invoice-delivery-contract";

const orgs: string[] = [];
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture() { const f = await returningCustomerFixture(); orgs.push(f.org); return f; }
async function asset(f: ReturningCustomerFixture, overrides: Record<string, unknown> = {}, propertyId = f.secondProperty.id, contactId = f.contact.id) {
  return (await createWorkdayAsset(f.org, f.actor, contactId, { ...workdayTestAsset, ...overrides, requestId: randomUUID(), propertyId })).asset;
}
const recorded = { manufacturer: "Synthetic Make", model: "SM-200", serial: "SYN-0001", location: "Attic", installedOn: "2024-05-01", warrantyStartsOn: "2024-05-01", warrantyEndsOn: "2034-05-01", warrantySource: "Synthetic registration card photographed by office" };
const draft = (f: ReturningCustomerFixture, equipment?: unknown) => ({
  requestId: randomUUID(), source: { kind: "existing_customer" as const, contactId: f.contact.id, propertyId: f.secondProperty.id },
  document: returningInvoiceDocument(), ...(equipment === undefined ? {} : { equipment }),
});

describe("invoice equipment and warranty snapshot", () => {
  it("copies recorded equipment into the draft in staff order and issues it unchanged", async () => {
    const f = await fixture();
    const unit = await asset(f, { label: "Synthetic heat pump", ...recorded });
    const coil = await asset(f, { label: "Synthetic air handler" });
    const created = await createInvoice(f.org, f.owner.id, draft(f, { assetIds: [coil.id, unit.id], warrantyTerms: "  Synthetic one-year workmanship terms.  " }));
    expect(created.invoice.document.equipment).toEqual({
      items: [
        { assetId: coil.id, assetVersion: 1, category: "hvac_equipment", label: "Synthetic air handler", manufacturer: null, model: null, serial: null, location: null, installedOn: null, warrantyStartsOn: null, warrantyEndsOn: null, warrantySource: null },
        { assetId: unit.id, assetVersion: 1, category: "hvac_equipment", label: "Synthetic heat pump", ...recorded },
      ],
      warrantyTerms: "Synthetic one-year workmanship terms.",
    });
    const issued = (await issueInvoice(f.org, f.owner.id, created.invoice.id, { requestId: randomUUID(), expectedVersion: created.invoice.version, confirmed: true })).invoice;
    // Later asset edits never rewrite the issued document or break its fingerprint check.
    await updateWorkdayAsset(f.org, f.actor, unit.id, { ...workdayTestAsset, ...recorded, label: "Renamed later", requestId: randomUUID(), expectedVersion: 1, status: "active" });
    const reread = await getInvoice(f.org, f.owner.id, issued.id);
    expect(reread.document.equipment).toEqual(created.invoice.document.equipment);
    expect(reread.status).toBe("issued");
  });

  it("omits the section entirely without a selection, preserving the original document shape", async () => {
    const f = await fixture();
    const plain = await createInvoice(f.org, f.owner.id, draft(f));
    expect(plain.invoice.document).not.toHaveProperty("equipment");
    const empty = await createInvoice(f.org, f.owner.id, draft(f, { assetIds: [], warrantyTerms: null }));
    expect(empty.invoice.document).not.toHaveProperty("equipment");
  });

  it("replays the identical request and refuses a changed selection under the same request id", async () => {
    const f = await fixture();
    const unit = await asset(f), other = await asset(f, { label: "Second synthetic unit" });
    const input = draft(f, { assetIds: [unit.id] });
    const first = await createInvoice(f.org, f.owner.id, input);
    expect((await createInvoice(f.org, f.owner.id, input)).duplicate).toBe(true);
    await expect(createInvoice(f.org, f.owner.id, { ...input, equipment: { assetIds: [other.id] } })).rejects.toMatchObject({ code: "invoice_request_conflict" });
    expect(first.invoice.document.equipment?.items.map(i => i.assetId)).toEqual([unit.id]);
  });

  it("rejects equipment from another property, another customer or a retired record", async () => {
    const f = await fixture();
    const elsewhere = await asset(f, {}, f.firstProperty.id);
    const retired = await asset(f);
    await updateWorkdayAsset(f.org, f.actor, retired.id, { ...workdayTestAsset, requestId: randomUUID(), expectedVersion: 1, status: "retired" });
    const [otherProperty] = await db.insert(propertiesTable).values({ organizationId: f.org, contactId: f.otherContact.id, addressLine1: "300 Synthetic Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
    const foreign = await asset(f, {}, otherProperty!.id, f.otherContact.id);
    for (const id of [elsewhere.id, retired.id, foreign.id, randomUUID()])
      await expect(createInvoice(f.org, f.owner.id, draft(f, { assetIds: [id] }))).rejects.toMatchObject({ status: 409, code: "invoice_equipment_unavailable" });
    await expect(createInvoice(f.org, f.owner.id, draft(f, { assetIds: [elsewhere.id, elsewhere.id] }))).rejects.toThrow();
  });

  it("refreshes or clears the snapshot on draft edits only", async () => {
    const f = await fixture();
    const unit = await asset(f);
    const created = (await createInvoice(f.org, f.owner.id, draft(f, { assetIds: [unit.id] }))).invoice;
    const cleared = (await updateInvoice(f.org, f.owner.id, created.id, { requestId: randomUUID(), expectedVersion: created.version, document: returningInvoiceDocument() })).invoice;
    expect(cleared.document).not.toHaveProperty("equipment");
    const restored = (await updateInvoice(f.org, f.owner.id, created.id, { requestId: randomUUID(), expectedVersion: cleared.version, document: returningInvoiceDocument(), equipment: { assetIds: [unit.id], warrantyTerms: "Synthetic terms." } })).invoice;
    expect(restored.document.equipment?.warrantyTerms).toBe("Synthetic terms.");
  });
});

describe("invoice email equipment text", () => {
  const base = { invoiceNumber: "INV-000001", issuedAt: "2026-10-11T00:00:00.000Z" };
  const document = { title: "Synthetic", currency: "USD" as const, issuerName: "Synthetic contractor", issuerAddress: null, customerName: "Synthetic customer", customerAddress: null, dueDate: null, notes: null, lineItems: [{ description: "Work", quantity: "1", unitPriceCents: 100, totalCents: 100 }], subtotalCents: 100, taxCents: 0, totalCents: 100 };
  it("lists recorded equipment and terms verbatim without claiming coverage", () => {
    const body = renderInvoiceEmail({ ...base, document: { ...document, equipment: { items: [{ assetId: randomUUID(), assetVersion: 1, category: "hvac_equipment", label: "Heat pump", ...recorded }], warrantyTerms: "Synthetic workmanship terms." } } }).body;
    expect(body).toContain("Equipment serviced:\n1. Heat pump - Synthetic Make SM-200\n   Serial: SYN-0001\n   Location: Attic\n   Installed: 2024-05-01\n   Recorded warranty: 2024-05-01 to 2034-05-01 (source: Synthetic registration card photographed by office)");
    expect(body).toContain("Warranty terms:\nSynthetic workmanship terms.");
    expect(body).toContain("the warranty provider determines coverage");
    expect(body).not.toMatch(/guarantee|covered under warranty/i);
  });
  it("leaves documents without equipment byte-identical", () => {
    const before = renderInvoiceEmail({ ...base, document }).body;
    expect(before).not.toContain("Equipment");
    expect(before).not.toContain("Warranty");
  });
});
