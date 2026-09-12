import {
  boolean,
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
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { usersTable } from "./auth";

/** A server-to-server acquisition connection; credentials are never stored in plaintext. */
export const smartSitesTable = pgTable(
  "smart_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    siteKey: text("site_key").notNull(),
    profile: text("profile").notNull(),
    source: text("source").notNull(),
    keyHash: text("key_hash").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    responseTargetMinutes: integer("response_target_minutes")
      .notNull()
      .default(60),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("smart_sites_org_key_uq").on(t.organizationId, t.siteKey),
  ],
);

/** A durable receipt, not a second CRM. Lead, task, audit and receipt commit together. */
export const smartSiteSubmissionsTable = pgTable(
  "smart_site_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => smartSitesTable.id),
    requestId: uuid("request_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    consent: jsonb("consent").$type<Record<string, unknown>>().notNull(),
    siteReceivedAt: timestamp("site_received_at", { withTimezone: true }),
    responseDueAt: timestamp("response_due_at", { withTimezone: true }),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("smart_site_submissions_request_uq").on(t.siteId, t.requestId),
    uniqueIndex("smart_site_submissions_lead_uq").on(t.leadId),
    index("smart_site_submissions_org_created_idx").on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);

/** Append-only, staff-declared outreach evidence. Not proof of provider delivery or a customer reply. */
export const smartSiteFollowupsTable = pgTable(
  "smart_site_followups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    actorUserId: varchar("actor_user_id")
      .notNull()
      .references(() => usersTable.id),
    requestId: uuid("request_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    channel: text("channel").notNull(),
    outcome: text("outcome").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("smart_site_followups_request_uq").on(
      t.organizationId,
      t.requestId,
    ),
    index("smart_site_followups_lead_idx").on(t.organizationId, t.leadId),
  ],
);
