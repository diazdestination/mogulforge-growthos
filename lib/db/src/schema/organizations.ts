import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type EntitlementPlanId = "beta" | "growth" | "scale";
export type EntitlementCapability = "revenue.autopilot";
export interface OrganizationEntitlements {
  version: 1;
  planId: EntitlementPlanId;
  source: "manual" | "stripe";
  grants: EntitlementCapability[];
}

export const organizationsTable = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    timezone: text("timezone").notNull().default("America/New_York"),
    // Billing (Stripe) — all nullable; unused until STRIPE_SECRET_KEY is set.
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // trialing | active | past_due | canceled | incomplete | null
    subscriptionStatus: text("subscription_status"),
    planTier: text("plan_tier"),
    // Null preserves legacy access. Only explicit, audited operator assignment
    // enrolls a tenant in capabilities; a billing event never silently migrates it.
    entitlements: jsonb("entitlements").$type<OrganizationEntitlements>(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("organizations_slug_idx").on(table.slug)],
);

export const insertOrganizationSchema = createInsertSchema(
  organizationsTable,
).omit({ id: true, createdAt: true, updatedAt: true, entitlements: true,
  stripeCustomerId: true, stripeSubscriptionId: true, subscriptionStatus: true,
  planTier: true, trialEndsAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
