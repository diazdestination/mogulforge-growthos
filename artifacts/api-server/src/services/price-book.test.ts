import { auditEventsTable, db, organizationsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  createPriceBookItem,
  deletePriceBookItem,
  listPriceBookItems,
  PriceBookError,
  previewEstimateMargin,
  updatePriceBookItem,
} from "./price-book";

const orgIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const suffix of ["a", "b"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: `Price book ${suffix}`, slug: `test-price-book-${suffix}-${nonce}` })
      .returning();
    const userId = `price-book-user-${suffix}-${nonce}`;
    await db.insert(usersTable).values({ id: userId, email: `pb-${suffix}-${nonce}@example.test`, organizationId: org!.id, role: "owner" });
    orgIds.push(org!.id);
    userIds.push(userId);
  }
});

afterAll(async () => {
  for (let index = 0; index < userIds.length; index += 1) {
    await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, userIds[index]!));
    await deleteTestOrgs(orgIds[index]!);
    await db.delete(usersTable).where(eq(usersTable.id, userIds[index]!));
  }
});

describe("ESTI price book", () => {
  it("creates, lists, updates and audits items per tenant", async () => {
    const shingles = await createPriceBookItem(orgIds[0]!, userIds[0]!, {
      trade: "Roofing",
      name: "Architectural shingles",
      unit: "sq",
      unitCostCents: 12_000,
      unitPriceCents: 20_000,
      targetMarginBps: 3500,
    });
    await createPriceBookItem(orgIds[0]!, userIds[0]!, { trade: "Roofing", name: "Tear-off labor", unit: "sq", unitCostCents: 6_000, unitPriceCents: 9_000 });
    expect((await listPriceBookItems(orgIds[0]!)).map((item) => item.name)).toEqual(["Architectural shingles", "Tear-off labor"]);
    expect(await listPriceBookItems(orgIds[1]!)).toEqual([]);

    const updated = await updatePriceBookItem(orgIds[0]!, userIds[0]!, shingles.id, { unitPriceCents: 21_000 });
    expect(updated.unitPriceCents).toBe(21_000);
    // A partial update leaves every omitted field unchanged.
    expect(updated).toMatchObject({ unit: "sq", unitCostCents: 12_000, targetMarginBps: 3500, isActive: true });
    await expect(updatePriceBookItem(orgIds[1]!, userIds[1]!, shingles.id, { unitPriceCents: 1 })).rejects.toMatchObject({ code: "not_found" });

    const audits = await db
      .select({ action: auditEventsTable.action })
      .from(auditEventsTable)
      .where(and(eq(auditEventsTable.organizationId, orgIds[0]!), eq(auditEventsTable.entityType, "price_book_item")));
    expect(audits.map((row) => row.action).sort()).toEqual(["price_book.item_created", "price_book.item_created", "price_book.item_updated"]);
  });

  it("refuses duplicate names within a trade and invalid amounts", async () => {
    await expect(
      createPriceBookItem(orgIds[0]!, userIds[0]!, { trade: "Roofing", name: "Architectural shingles", unitPriceCents: 100 }),
    ).rejects.toBeInstanceOf(PriceBookError);
    await expect(createPriceBookItem(orgIds[0]!, userIds[0]!, { trade: "Roofing", name: "Bad", unitPriceCents: -1 })).rejects.toThrow();
    await expect(createPriceBookItem(orgIds[0]!, userIds[0]!, { trade: "Roofing", name: "Bad", unitPriceCents: 1, extra: true })).rejects.toThrow();
    // The same name in another trade is allowed.
    await createPriceBookItem(orgIds[0]!, userIds[0]!, { trade: "Gutters", name: "Architectural shingles", unitPriceCents: 1 });
  });

  it("previews margin from this tenant's book only", async () => {
    // "Architectural shingles" now exists in two trades for tenant A, so name matching is ambiguous;
    // an explicit id still resolves.
    const shingles = (await listPriceBookItems(orgIds[0]!)).find((item) => item.trade === "Roofing" && item.name === "Architectural shingles")!;
    const guidance = await previewEstimateMargin(orgIds[0]!, {
      lineItems: [
        { description: "Architectural shingles", quantity: 10, unitPriceCents: 16_000, priceBookItemId: shingles.id },
        { description: "Tear-off labor", quantity: 10, unitPriceCents: 9_000 },
        { description: "Architectural shingles", quantity: 1, unitPriceCents: 20_000 },
      ],
    });
    expect(guidance.lines.map((line) => line.status)).toEqual(["below_target", "on_target", "no_cost"]);
    expect(guidance.lines[0]!.suggestedUnitPriceCents).toBeGreaterThan(16_000);

    const other = await previewEstimateMargin(orgIds[1]!, {
      lineItems: [{ description: "Tear-off labor", quantity: 1, unitPriceCents: 9_000, priceBookItemId: shingles.id }],
    });
    expect(other.lines[0]!.status).toBe("no_cost");
  });

  it("deletes only within the tenant", async () => {
    const [first] = await listPriceBookItems(orgIds[0]!);
    expect(await deletePriceBookItem(orgIds[1]!, userIds[1]!, first!.id)).toBe(false);
    expect(await deletePriceBookItem(orgIds[0]!, userIds[0]!, first!.id)).toBe(true);
    expect((await listPriceBookItems(orgIds[0]!)).some((item) => item.id === first!.id)).toBe(false);
  });
});
