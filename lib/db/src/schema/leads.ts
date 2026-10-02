import {
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
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { contactsTable } from "./contacts";
import { leadStatusEnum, urgencyEnum } from "./enums";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

/** An uploaded snapshot is historical evidence, never proof of current eligibility. */
export interface ImportedOpportunityHistory {
  version: 1;
  kind: "csv_snapshot";
  originalCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  statusChangedAt: string | null;
  lastContactAt: string | null;
  snapshotAsOf: string | null;
  firstImportedAt: string;
  lastImportedAt: string;
  externalCustomerId: string | null;
  externalEstimateId: string | null;
  currency: "USD" | null;
  fingerprint: string;
  mappedFields: string[];
  /** Hash of last applied values; detect local edits without copying free text. */
  appliedFingerprint: string;
}

export const importedOpportunityHistorySchema = z.object({
  version: z.literal(1),
  kind: z.literal("csv_snapshot"),
  originalCreatedAt: z.iso.datetime().nullable(),
  sourceUpdatedAt: z.iso.datetime().nullable(),
  statusChangedAt: z.iso.datetime().nullable(),
  lastContactAt: z.iso.datetime().nullable(),
  snapshotAsOf: z.iso.datetime().nullable(),
  firstImportedAt: z.iso.datetime(),
  lastImportedAt: z.iso.datetime(),
  externalCustomerId: z.string().min(1).max(200).nullable(),
  externalEstimateId: z.string().min(1).max(200).nullable(),
  currency: z.literal("USD").nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  appliedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mappedFields: z.array(z.string().min(1).max(40)).max(30),
}).strict();

export const leadsTable = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contactsTable.id),
    propertyId: uuid("property_id").references(() => propertiesTable.id),
    assignedUserId: varchar("assigned_user_id").references(() => usersTable.id),
    status: leadStatusEnum("status").notNull().default("new"),
    urgency: urgencyEnum("urgency").notNull().default("normal"),
    serviceType: text("service_type"),
    source: text("source"),
    sourceDetail: text("source_detail"),
    score: integer("score").notNull().default(0),
    scoreReasons: jsonb("score_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    summary: text("summary"),
    estimatedValueCents: integer("estimated_value_cents"),
    /** Why the lead was lost (free text chosen by the rep; reported in ROI). */
    lostReason: text("lost_reason"),
    /** When the lead was first marked won (set once by the won hook). */
    wonAt: timestamp("won_at", { withTimezone: true }),
    /**
     * Revenue captured when the lead was won: the accepted estimate total
     * when one exists, otherwise the rep's estimated value. Never invented.
     */
    wonRevenueCents: integer("won_revenue_cents"),
    /**
     * Honest revenue-attribution category assigned at win time:
     * directly_attributed | assisted | self_reported | estimated | unknown.
     * Revenue is never claimed without one of these labels.
     */
    wonAttribution: text("won_attribution"),
    firstTouch: jsonb("first_touch").$type<Record<string, unknown>>(),
    lastTouch: jsonb("last_touch").$type<Record<string, unknown>>(),
    /** Most recent marketing source (source keeps the ORIGINAL source). */
    latestSource: text("latest_source"),
    /** utm_campaign of the first touch (queryable copy of firstTouch.utm). */
    campaign: text("campaign"),
    /** First page the visitor landed on before converting. */
    landingPage: text("landing_page"),
    /** External referrer of the first touch. */
    referrer: text("referrer"),
    /** How the lead entered the system: assessment | widget | form | concierge | api | import. */
    creationMethod: text("creation_method"),
    /** Stable account/source namespace, distinct from marketing attribution. */
    importSourceKey: text("import_source_key"),
    /** Opportunity/job/estimate identity, not the customer's identity. */
    externalOpportunityId: text("external_opportunity_id"),
    importedHistory: jsonb("imported_history").$type<ImportedOpportunityHistory>(),
    /**
     * Website analytics visitor id linked at identification time (consent-
     * aware: only set when the visitor identified themselves through a
     * capture flow). Anonymous visitors are never linked.
     */
    anonymousId: text("anonymous_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("leads_org_status_idx").on(table.organizationId, table.status),
    index("leads_org_assigned_idx").on(
      table.organizationId,
      table.assignedUserId,
    ),
    index("leads_org_anon_idx").on(table.organizationId, table.anonymousId),
    uniqueIndex("leads_org_import_opportunity_idx").on(
      table.organizationId, table.importSourceKey, table.externalOpportunityId,
    ),
  ],
);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  importSourceKey: true,
  externalOpportunityId: true,
  importedHistory: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
