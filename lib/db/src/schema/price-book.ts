import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";

/**
 * ESTI price book: a company's own catalog of priced work and materials per
 * trade. Unit cost is what the contractor pays; unit price is what they
 * charge. Margin guidance compares estimate lines against these entries; it
 * never changes an estimate by itself.
 */
export const priceBookItemsTable = pgTable(
  "price_book_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** Free-text trade label chosen by the company, e.g. "Roofing" or "HVAC". */
    trade: text("trade").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Unit of measure, e.g. "sq", "ea", "lf", "hr". */
    unit: text("unit").notNull().default("ea"),
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    unitPriceCents: integer("unit_price_cents").notNull(),
    /** Target gross margin in basis points (3500 = 35%). Null uses the company default. */
    targetMarginBps: integer("target_margin_bps"),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    updatedByUserId: varchar("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("price_book_items_org_trade_name_uniq").on(table.organizationId, table.trade, table.name),
    index("price_book_items_org_active_idx").on(table.organizationId, table.isActive),
    check("price_book_items_amounts_ck", sql`${table.unitCostCents} >= 0 and ${table.unitPriceCents} >= 0 and ${table.unitPriceCents} <= 100000000 and ${table.unitCostCents} <= 100000000`),
    check("price_book_items_margin_ck", sql`${table.targetMarginBps} is null or (${table.targetMarginBps} >= 0 and ${table.targetMarginBps} < 10000)`),
  ],
);

export type PriceBookItem = typeof priceBookItemsTable.$inferSelect;
