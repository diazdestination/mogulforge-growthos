import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { usersTable } from "./auth";
import { invoicesTable } from "./invoices";
import { organizationsTable } from "./organizations";

/** Stripe mode a row belongs to. Test and live objects never mix. */
export const STRIPE_CONNECT_MODES = ["test", "live"] as const;
export type StripeConnectMode = (typeof STRIPE_CONNECT_MODES)[number];

/** What Stripe still needs before (or to keep) charges enabled; no field values. */
export type StripeAccountRequirements = {
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
  currentDeadline: string | null;
};

/** Office-review flag raised by a Stripe refund or dispute; never changes the balance. */
export type InvoicePaymentReviewFlag = {
  kind: "refund" | "dispute";
  stripeId: string;
  amountCents: number;
  status: string | null;
  reason: string | null;
  flaggedAt: string;
  /** Stripe event time of the latest applied change (older events never rewind a flag). */
  updatedAt: string;
};

/**
 * BILL card & bank collection through Stripe Connect. Each contractor links
 * their own Stripe account; homeowner payments settle directly to it. GrowthOS
 * stores only the connected account id and capability flags, never keys.
 * One account per organization per Stripe mode (test and live are separate).
 */
export const stripeConnectAccountsTable = pgTable(
  "stripe_connect_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    stripeAccountId: text("stripe_account_id").notNull(),
    mode: text("mode").$type<StripeConnectMode>().notNull().default("test"),
    requirements: jsonb("requirements").$type<StripeAccountRequirements>(),
    chargesEnabled: boolean("charges_enabled").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    detailsSubmitted: boolean("details_submitted").notNull().default(false),
    connectedByUserId: varchar("connected_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("stripe_connect_accounts_org_mode_uniq").on(table.organizationId, table.mode),
    uniqueIndex("stripe_connect_accounts_account_uniq").on(table.stripeAccountId),
    check("stripe_connect_accounts_mode_ck", sql`${table.mode} in ('test', 'live')`),
  ],
);

export const INVOICE_PAYMENT_LINK_STATES = [
  "open",
  "processing",
  "paid",
  "failed",
  "expired",
  "needs_reconciliation",
] as const;
export type InvoicePaymentLinkState = (typeof INVOICE_PAYMENT_LINK_STATES)[number];

/**
 * One Stripe Checkout session for one issued invoice version. A completed
 * payment is recorded on the invoice as the staff member who created the link;
 * anything that cannot be recorded exactly is held for reconciliation.
 */
export const invoicePaymentLinksTable = pgTable(
  "invoice_payment_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    invoiceVersion: integer("invoice_version").notNull(),
    amountCents: integer("amount_cents").notNull(),
    stripeAccountId: text("stripe_account_id").notNull(),
    mode: text("mode").$type<StripeConnectMode>().notNull().default("test"),
    checkoutSessionId: text("checkout_session_id"),
    checkoutUrl: text("checkout_url"),
    paymentIntentId: text("payment_intent_id"),
    state: text("state").$type<InvoicePaymentLinkState>().notNull().default("open"),
    detail: text("detail").notNull().default(""),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    recordedValueEntryId: uuid("recorded_value_entry_id"),
    reviewFlags: jsonb("review_flags").$type<InvoicePaymentReviewFlag[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("invoice_payment_links_session_uniq").on(table.checkoutSessionId),
    index("invoice_payment_links_org_invoice_idx").on(table.organizationId, table.invoiceId),
    check("invoice_payment_links_amount_ck", sql`${table.amountCents} between 50 and 100000000`),
    check("invoice_payment_links_mode_ck", sql`${table.mode} in ('test', 'live')`),
  ],
);

export type StripeConnectAccount = typeof stripeConnectAccountsTable.$inferSelect;
export type InvoicePaymentLink = typeof invoicePaymentLinksTable.$inferSelect;
