import { db, priceBookItemsTable, type PriceBookItem } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit } from "./audit";
import {
  computeMarginGuidance,
  DEFAULT_TARGET_MARGIN_BPS,
  type MarginGuidance,
} from "./price-book-margin";

/** Tenant-scoped ESTI price book. Writes are audited; reads never cross tenants. */

export class PriceBookError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "duplicate" | "invalid",
  ) {
    super(message);
    this.name = "PriceBookError";
  }
}

const cents = z.number().int().min(0).max(100_000_000);

export const priceBookItemInputSchema = z
  .object({
    trade: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullish(),
    unit: z.string().trim().min(1).max(20).default("ea"),
    unitCostCents: cents.default(0),
    unitPriceCents: cents,
    targetMarginBps: z.number().int().min(0).max(9999).nullish(),
    isActive: z.boolean().default(true),
  })
  .strict();

// No defaults here: an omitted field must stay unchanged, never reset.
export const priceBookItemUpdateSchema = z
  .object({
    trade: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullable(),
    unit: z.string().trim().min(1).max(20),
    unitCostCents: cents,
    unitPriceCents: cents,
    targetMarginBps: z.number().int().min(0).max(9999).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

export const marginPreviewSchema = z
  .object({
    lineItems: z
      .array(
        z
          .object({
            description: z.string().max(500),
            quantity: z.number().min(0).max(1_000_000),
            unitPriceCents: cents,
            priceBookItemId: z.string().uuid().nullish(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type PriceBookItemView = {
  id: string;
  trade: string;
  name: string;
  description: string | null;
  unit: string;
  unitCostCents: number;
  unitPriceCents: number;
  targetMarginBps: number | null;
  isActive: boolean;
  updatedAt: string;
};

function view(row: PriceBookItem): PriceBookItemView {
  return {
    id: row.id,
    trade: row.trade,
    name: row.name,
    description: row.description,
    unit: row.unit,
    unitCostCents: row.unitCostCents,
    unitPriceCents: row.unitPriceCents,
    targetMarginBps: row.targetMarginBps,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const record = error as { code?: string; cause?: { code?: string } } | null;
  return record?.code === "23505" || record?.cause?.code === "23505";
}

export async function listPriceBookItems(
  organizationId: string,
  options: { includeInactive?: boolean } = {},
): Promise<PriceBookItemView[]> {
  const scope = eq(priceBookItemsTable.organizationId, organizationId);
  const rows = await db
    .select()
    .from(priceBookItemsTable)
    .where(options.includeInactive ? scope : and(scope, eq(priceBookItemsTable.isActive, true)))
    .orderBy(asc(priceBookItemsTable.trade), asc(priceBookItemsTable.name));
  return rows.map(view);
}

export async function createPriceBookItem(
  organizationId: string,
  userId: string,
  raw: unknown,
): Promise<PriceBookItemView> {
  const input = priceBookItemInputSchema.parse(raw);
  try {
    const [row] = await db
      .insert(priceBookItemsTable)
      .values({
        organizationId,
        trade: input.trade,
        name: input.name,
        description: input.description ?? null,
        unit: input.unit,
        unitCostCents: input.unitCostCents,
        unitPriceCents: input.unitPriceCents,
        targetMarginBps: input.targetMarginBps ?? null,
        isActive: input.isActive,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning();
    await recordAudit({
      organizationId,
      actorUserId: userId,
      action: "price_book.item_created",
      entityType: "price_book_item",
      entityId: row!.id,
      metadata: { trade: row!.trade, name: row!.name, unitCostCents: row!.unitCostCents, unitPriceCents: row!.unitPriceCents },
    });
    return view(row!);
  } catch (error) {
    if (isUniqueViolation(error)) throw new PriceBookError("An item with that name already exists in this trade.", "duplicate");
    throw error;
  }
}

export async function updatePriceBookItem(
  organizationId: string,
  userId: string,
  id: string,
  raw: unknown,
): Promise<PriceBookItemView> {
  const input = priceBookItemUpdateSchema.parse(raw);
  const patch: Partial<typeof priceBookItemsTable.$inferInsert> = { updatedByUserId: userId };
  if (input.trade !== undefined) patch.trade = input.trade;
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.unitCostCents !== undefined) patch.unitCostCents = input.unitCostCents;
  if (input.unitPriceCents !== undefined) patch.unitPriceCents = input.unitPriceCents;
  if (input.targetMarginBps !== undefined) patch.targetMarginBps = input.targetMarginBps ?? null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  try {
    const [row] = await db
      .update(priceBookItemsTable)
      .set(patch)
      .where(and(eq(priceBookItemsTable.organizationId, organizationId), eq(priceBookItemsTable.id, id)))
      .returning();
    if (!row) throw new PriceBookError("Price book item not found.", "not_found");
    await recordAudit({
      organizationId,
      actorUserId: userId,
      action: "price_book.item_updated",
      entityType: "price_book_item",
      entityId: row.id,
      metadata: { changed: Object.keys(input) },
    });
    return view(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new PriceBookError("An item with that name already exists in this trade.", "duplicate");
    throw error;
  }
}

export async function deletePriceBookItem(organizationId: string, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(priceBookItemsTable)
    .where(and(eq(priceBookItemsTable.organizationId, organizationId), eq(priceBookItemsTable.id, id)))
    .returning({ id: priceBookItemsTable.id, name: priceBookItemsTable.name });
  if (rows.length === 0) return false;
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "price_book.item_deleted",
    entityType: "price_book_item",
    entityId: rows[0]!.id,
    metadata: { name: rows[0]!.name },
  });
  return true;
}

/** Read-only margin guidance for draft estimate lines; changes nothing. */
export async function previewEstimateMargin(organizationId: string, raw: unknown): Promise<MarginGuidance> {
  const input = marginPreviewSchema.parse(raw);
  const book = await db
    .select()
    .from(priceBookItemsTable)
    .where(and(eq(priceBookItemsTable.organizationId, organizationId), eq(priceBookItemsTable.isActive, true)));
  return computeMarginGuidance(input.lineItems, book, DEFAULT_TARGET_MARGIN_BPS);
}
