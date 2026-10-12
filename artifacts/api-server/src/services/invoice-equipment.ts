import { and, eq, inArray } from "drizzle-orm";
import { propertyAssetsTable, type db, type InvoiceEquipmentSection } from "@workspace/db";
import { z } from "zod/v4";
import { workdayAssetFields } from "./contractor-workday-contract";
import { InvoiceError, type invoiceEquipmentSelectionSchema } from "./invoice-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const assetFacts = z.object(workdayAssetFields).strict();

/**
 * Copy staff-selected, currently active property assets into an invoice draft.
 * Assets must belong to the invoice's customer and, when the invoice names a
 * property, that property. Warranty fields are exactly what staff recorded.
 */
export async function invoiceEquipment(
  tx: Tx,
  org: string,
  lineage: { contact: { id: string }; property?: { id: string } | null },
  selection: z.output<typeof invoiceEquipmentSelectionSchema> | undefined,
): Promise<InvoiceEquipmentSection | undefined> {
  if (!selection || (selection.assetIds.length === 0 && !selection.warrantyTerms)) return undefined;
  const rows = selection.assetIds.length
    ? await tx
        .select()
        .from(propertyAssetsTable)
        .where(and(eq(propertyAssetsTable.organizationId, org), inArray(propertyAssetsTable.id, selection.assetIds)))
        .for("share")
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = selection.assetIds.map((id) => {
    const row = byId.get(id);
    if (
      !row ||
      row.status !== "active" ||
      row.contactId !== lineage.contact.id ||
      (lineage.property && row.propertyId !== lineage.property.id)
    )
      throw new InvoiceError(
        409,
        "invoice_equipment_unavailable",
        "Choose active equipment recorded for this invoice's customer and property.",
      );
    const facts = assetFacts.safeParse(row.facts);
    if (!facts.success)
      throw new InvoiceError(503, "invoice_unavailable", "Invoice records need operator review. No new action was confirmed.");
    const f = facts.data;
    return {
      assetId: row.id,
      assetVersion: row.version,
      category: f.category,
      label: f.label,
      manufacturer: f.manufacturer,
      model: f.model,
      serial: f.serial,
      location: f.location,
      installedOn: f.installedOn,
      warrantyStartsOn: f.warrantyStartsOn,
      warrantyEndsOn: f.warrantyEndsOn,
      warrantySource: f.warrantySource,
    };
  });
  return { items, warrantyTerms: selection.warrantyTerms };
}
