import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { smartSitesTable } from "./smart-sites";

// First-party analytics event capture (page views, funnel steps, etc).
export const analyticsEventsTable = pgTable(
  "analytics_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** Present only for the consent-first Smart Sites measurement contract. */
    smartSiteId: uuid("smart_site_id").references(() => smartSitesTable.id),
    /** Browser-generated idempotency key. Null for the older generic analytics path. */
    eventId: uuid("event_id"),
    schemaVersion: integer("schema_version"),
    /** Set only after an explicitly consented visitor identifies through intake. */
    leadId: uuid("lead_id").references(() => leadsTable.id),
    consentPolicyVersion: text("consent_policy_version"),
    payloadHash: text("payload_hash"),
    eventName: text("event_name").notNull(),
    anonymousId: text("anonymous_id"),
    sessionId: text("session_id"),
    path: text("path"),
    referrer: text("referrer"),
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    serviceCode: text("service_code"),
    surface: text("surface"),
    step: text("step"),
    properties: jsonb("properties")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("analytics_org_event_idx").on(
      table.organizationId,
      table.eventName,
      table.occurredAt,
    ),
    // Behavior lookups for an identified visitor (lead attribution).
    index("analytics_org_anon_idx").on(
      table.organizationId,
      table.anonymousId,
      table.occurredAt,
    ),
    uniqueIndex("analytics_smart_site_event_uq").on(
      table.smartSiteId,
      table.eventId,
    ),
    index("analytics_smart_site_time_idx").on(
      table.smartSiteId,
      table.occurredAt,
    ),
    index("analytics_org_lead_idx").on(
      table.organizationId,
      table.leadId,
    ),
  ],
);

export const insertAnalyticsEventSchema = createInsertSchema(
  analyticsEventsTable,
).omit({ id: true, occurredAt: true });
export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;
export type AnalyticsEvent = typeof analyticsEventsTable.$inferSelect;
