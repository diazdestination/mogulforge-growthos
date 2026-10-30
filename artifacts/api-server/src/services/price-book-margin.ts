/**
 * Pure margin guidance for ESTI. No database, no model: given estimate lines
 * and the company's price-book entries, report the cost, gross margin and a
 * target-meeting unit price for every line whose cost is known. Lines without
 * a known cost are reported as unpriced; cost is never guessed.
 */

export const DEFAULT_TARGET_MARGIN_BPS = 3000;

export type MarginLineInput = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  /** Optional explicit link to a price-book entry; otherwise matched by name. */
  priceBookItemId?: string | null;
};

export type MarginBookEntry = {
  id: string;
  name: string;
  unit: string;
  unitCostCents: number;
  unitPriceCents: number;
  targetMarginBps: number | null;
  isActive: boolean;
};

export type MarginLineStatus = "below_cost" | "below_target" | "on_target" | "no_cost";

export type MarginLineResult = {
  index: number;
  description: string;
  priceBookItemId: string | null;
  priceBookItemName: string | null;
  unit: string | null;
  revenueCents: number;
  costCents: number | null;
  marginCents: number | null;
  marginBps: number | null;
  targetMarginBps: number | null;
  /** Unit price that reaches the target margin at this line's unit cost. */
  suggestedUnitPriceCents: number | null;
  status: MarginLineStatus;
};

export type MarginGuidance = {
  lines: MarginLineResult[];
  /** Totals cover only lines with a known cost. */
  pricedRevenueCents: number;
  pricedCostCents: number;
  pricedMarginCents: number;
  pricedMarginBps: number | null;
  unpricedLineCount: number;
  belowTargetLineCount: number;
  belowCostLineCount: number;
  defaultTargetMarginBps: number;
};

export function normalizeItemName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Margin in basis points, rounded toward zero; null when revenue is zero. */
export function marginBps(revenueCents: number, costCents: number): number | null {
  if (revenueCents <= 0) return null;
  return Math.trunc(((revenueCents - costCents) * 10000) / revenueCents);
}

/** Smallest whole-cent unit price whose margin over unitCost is at least target. */
export function priceForTargetMargin(unitCostCents: number, targetBps: number): number {
  if (unitCostCents <= 0) return 0;
  const bps = Math.min(Math.max(Math.trunc(targetBps), 0), 9999);
  let price = Math.ceil((unitCostCents * 10000) / (10000 - bps));
  // Guard against floating point: step up until the integer margin clears target.
  while ((marginBps(price, unitCostCents) ?? 0) < bps) price += 1;
  return price;
}

export function computeMarginGuidance(
  lines: MarginLineInput[],
  book: MarginBookEntry[],
  defaultTargetMarginBps = DEFAULT_TARGET_MARGIN_BPS,
): MarginGuidance {
  const active = book.filter((entry) => entry.isActive);
  const byId = new Map(active.map((entry) => [entry.id, entry]));
  const byName = new Map<string, MarginBookEntry | null>();
  for (const entry of active) {
    const key = normalizeItemName(entry.name);
    // Two active entries with the same name in different trades are ambiguous.
    byName.set(key, byName.has(key) ? null : entry);
  }

  const results: MarginLineResult[] = lines.map((line, index) => {
    const quantity = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    const revenueCents = Math.round(quantity * Math.max(0, Math.trunc(line.unitPriceCents)));
    const entry =
      (line.priceBookItemId ? byId.get(line.priceBookItemId) : undefined) ??
      byName.get(normalizeItemName(line.description)) ??
      null;
    if (!entry || entry.unitCostCents <= 0) {
      return {
        index,
        description: line.description,
        priceBookItemId: entry?.id ?? null,
        priceBookItemName: entry?.name ?? null,
        unit: entry?.unit ?? null,
        revenueCents,
        costCents: null,
        marginCents: null,
        marginBps: null,
        targetMarginBps: entry ? entry.targetMarginBps ?? defaultTargetMarginBps : null,
        suggestedUnitPriceCents: null,
        status: "no_cost",
      };
    }
    const costCents = Math.round(quantity * entry.unitCostCents);
    const target = entry.targetMarginBps ?? defaultTargetMarginBps;
    const lineMargin = marginBps(revenueCents, costCents);
    const status: MarginLineStatus =
      revenueCents < costCents ? "below_cost" : (lineMargin ?? -1) < target ? "below_target" : "on_target";
    return {
      index,
      description: line.description,
      priceBookItemId: entry.id,
      priceBookItemName: entry.name,
      unit: entry.unit,
      revenueCents,
      costCents,
      marginCents: revenueCents - costCents,
      marginBps: lineMargin,
      targetMarginBps: target,
      suggestedUnitPriceCents: priceForTargetMargin(entry.unitCostCents, target),
      status,
    };
  });

  const priced = results.filter((line) => line.costCents !== null);
  const pricedRevenueCents = priced.reduce((sum, line) => sum + line.revenueCents, 0);
  const pricedCostCents = priced.reduce((sum, line) => sum + (line.costCents ?? 0), 0);
  return {
    lines: results,
    pricedRevenueCents,
    pricedCostCents,
    pricedMarginCents: pricedRevenueCents - pricedCostCents,
    pricedMarginBps: marginBps(pricedRevenueCents, pricedCostCents),
    unpricedLineCount: results.length - priced.length,
    belowTargetLineCount: results.filter((line) => line.status === "below_target").length,
    belowCostLineCount: results.filter((line) => line.status === "below_cost").length,
    defaultTargetMarginBps,
  };
}
