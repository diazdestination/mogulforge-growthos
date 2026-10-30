import { describe, expect, it } from "vitest";

import {
  computeMarginGuidance,
  marginBps,
  normalizeItemName,
  priceForTargetMargin,
  type MarginBookEntry,
} from "../services/price-book-margin";

const shingles: MarginBookEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Architectural shingles",
  unit: "sq",
  unitCostCents: 12_000,
  unitPriceCents: 20_000,
  targetMarginBps: 3500,
  isActive: true,
};
const labor: MarginBookEntry = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Tear-off labor",
  unit: "sq",
  unitCostCents: 6_000,
  unitPriceCents: 9_000,
  targetMarginBps: null,
  isActive: true,
};

describe("margin math", () => {
  it("computes margin in basis points and refuses zero revenue", () => {
    expect(marginBps(10_000, 6_500)).toBe(3500);
    expect(marginBps(10_000, 11_000)).toBe(-1000);
    expect(marginBps(0, 100)).toBeNull();
  });

  it("finds the smallest whole-cent price that reaches the target", () => {
    const price = priceForTargetMargin(12_000, 3500);
    expect(marginBps(price, 12_000)).toBeGreaterThanOrEqual(3500);
    expect(marginBps(price - 1, 12_000)).toBeLessThan(3500);
    expect(priceForTargetMargin(0, 3500)).toBe(0);
    expect(priceForTargetMargin(333, 9999)).toBeGreaterThan(0);
  });

  it("normalizes names for matching", () => {
    expect(normalizeItemName("  Architectural   Shingles ")).toBe("architectural shingles");
  });
});

describe("estimate margin guidance", () => {
  it("matches by id or name, uses the default target, and never invents cost", () => {
    const guidance = computeMarginGuidance(
      [
        { description: "architectural shingles", quantity: 20, unitPriceCents: 20_000 },
        { description: "Something custom", quantity: 1, unitPriceCents: 50_000, priceBookItemId: labor.id },
        { description: "Dumpster", quantity: 1, unitPriceCents: 45_000 },
      ],
      [shingles, labor],
    );
    expect(guidance.lines[0]).toMatchObject({ priceBookItemId: shingles.id, costCents: 240_000, revenueCents: 400_000, marginBps: 4000, status: "on_target", targetMarginBps: 3500 });
    expect(guidance.lines[1]).toMatchObject({ priceBookItemId: labor.id, costCents: 6_000, status: "on_target", targetMarginBps: 3000 });
    expect(guidance.lines[2]).toMatchObject({ priceBookItemId: null, costCents: null, marginBps: null, status: "no_cost" });
    expect(guidance.unpricedLineCount).toBe(1);
    expect(guidance.pricedRevenueCents).toBe(450_000);
    expect(guidance.pricedCostCents).toBe(246_000);
    expect(guidance.pricedMarginBps).toBe(4533);
  });

  it("flags below-target and below-cost lines with a target-meeting price", () => {
    const guidance = computeMarginGuidance(
      [
        { description: "Architectural shingles", quantity: 10, unitPriceCents: 16_000 },
        { description: "Tear-off labor", quantity: 10, unitPriceCents: 5_000 },
      ],
      [shingles, labor],
    );
    expect(guidance.lines[0]!.status).toBe("below_target");
    expect(guidance.lines[0]!.suggestedUnitPriceCents).toBe(priceForTargetMargin(12_000, 3500));
    expect(guidance.lines[1]!.status).toBe("below_cost");
    expect(guidance.belowTargetLineCount).toBe(1);
    expect(guidance.belowCostLineCount).toBe(1);
  });

  it("ignores inactive entries and refuses ambiguous name matches", () => {
    const duplicate = { ...shingles, id: "33333333-3333-4333-8333-333333333333" };
    const inactive = { ...labor, isActive: false };
    const guidance = computeMarginGuidance(
      [
        { description: "Architectural shingles", quantity: 1, unitPriceCents: 20_000 },
        { description: "Tear-off labor", quantity: 1, unitPriceCents: 9_000 },
      ],
      [shingles, duplicate, inactive],
    );
    expect(guidance.lines.map((line) => line.status)).toEqual(["no_cost", "no_cost"]);
  });
});
