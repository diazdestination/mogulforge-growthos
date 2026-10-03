import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { auditEventsTable } from "./audit";
import { serviceObligationsTable, type ServiceRecurrence } from "./service-obligations";

export interface ServiceStandingSettings {
  enabled: boolean;
  channel: "email" | "sms";
  agreementStartsOn: string;
  agreementEndsOn: string;
  agreementEvidence: string;
  sourceReview: { kind: "native" | "reconciled_import"; verifiedAt: string; cutoverAt: string | null; evidence: string };
}
export interface ServiceStandingScope {
  seriesRootObligationId: string; anchorObligationId: string; anchorUpdatedAt: string; anchorOccurrenceIndex: number;
  reviewedObligationId: string; reviewedUpdatedAt: string; reviewedOccurrenceIndex: number;
  contactId: string; propertyId: string | null; kind: string; equipmentLabel: string; noticeDays: number;
  source: string; externalRef: string | null; recurrence: ServiceRecurrence;
  coverageStartsOn: string | null; coverageEndsOn: string | null; coverageEvidence: string | null;
  ownerUserId: string; recipient: string; businessName: string;
}
export interface ServiceStandingEmailIdentity {
  kind: "email"; userId: string; source: "company_default"; provider: "gmail" | "microsoft"; senderEmail: string;
  connectionId: string; connectionRevision: string; accountId: string | null;
}
export interface ServiceStandingSmsIdentity {
  kind: "sms"; id: string; accountSid: string; sender: string; messagingServiceSid: string;
  disclosureVersion: string; origin: string; businessName: string;
}
export interface ServiceStandingSnapshot {
  schemaVersion: "service-standing-policy.v1";
  settings: ServiceStandingSettings; scope: ServiceStandingScope;
  seriesFingerprint: string; sourceReviewFingerprint: string;
  templateVersion: "service-care.v2"; template: { subject: string; body: string };
  sender: ServiceStandingEmailIdentity | ServiceStandingSmsIdentity;
  sendingHours: { quietHoursEnabled: boolean; timezone: string; startHour: number; endHour: number; days: string[]; maxTouchesPerDay: number };
}

/** Immutable series identity; monitor timestamps are not customer-send authority. */
export const serviceStandingEnrollmentsTable = pgTable("service_standing_enrollments", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  seriesRootObligationId: uuid("series_root_obligation_id").notNull(),
  anchorObligationId: uuid("anchor_obligation_id").notNull(),
  createdByUserId: varchar("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastResultCode: text("last_result_code"),
  lastMaterializedObligationId: uuid("last_materialized_obligation_id"),
}, (t) => [
  unique("service_standing_enrollment_org_id_uq").on(t.organizationId, t.id),
  uniqueIndex("service_standing_enrollment_root_uq").on(t.organizationId, t.seriesRootObligationId),
  index("service_standing_enrollment_check_idx").on(t.nextCheckAt, t.organizationId),
  foreignKey({ columns: [t.organizationId, t.seriesRootObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "service_standing_root_fk" }),
  foreignKey({ columns: [t.organizationId, t.anchorObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "service_standing_anchor_fk" }),
  foreignKey({ columns: [t.organizationId, t.lastMaterializedObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "service_standing_last_occurrence_fk" }),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "service_standing_creator_fk" }),
]);

/** Highest version is current, including disable. No mutable policy head or enabled flag. */
export const serviceStandingPolicyRevisionsTable = pgTable("service_standing_policy_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  enrollmentId: uuid("enrollment_id").notNull(),
  version: integer("version").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  ownerUserId: varchar("owner_user_id").notNull(),
  snapshot: jsonb("snapshot").$type<ServiceStandingSnapshot>().notNull(),
  reviewId: uuid("review_id").notNull(),
  reviewPayloadHash: text("review_payload_hash").notNull(),
  approvedByUserId: varchar("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("service_standing_revision_org_id_uq").on(t.organizationId, t.id),
  unique("service_standing_revision_exact_uq").on(t.organizationId, t.id, t.enrollmentId, t.version),
  uniqueIndex("service_standing_revision_version_uq").on(t.organizationId, t.enrollmentId, t.version),
  uniqueIndex("service_standing_revision_review_uq").on(t.organizationId, t.reviewId),
  foreignKey({ columns: [t.organizationId, t.enrollmentId], foreignColumns: [serviceStandingEnrollmentsTable.organizationId, serviceStandingEnrollmentsTable.id], name: "service_standing_revision_enrollment_fk" }),
  foreignKey({ columns: [t.organizationId, t.ownerUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "service_standing_revision_owner_fk" }),
  foreignKey({ columns: [t.organizationId, t.approvedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "service_standing_revision_actor_fk" }),
  foreignKey({ columns: [t.organizationId, t.reviewId, t.approvedByUserId], foreignColumns: [auditEventsTable.organizationId, auditEventsTable.id, auditEventsTable.actorUserId], name: "service_standing_revision_review_fk" }),
  check("service_standing_revision_version_ck", sql`${t.version} > 0`),
  check("service_standing_revision_hash_ck", sql`${t.reviewPayloadHash} ~ '^[a-f0-9]{64}$'`),
  check("service_standing_revision_enabled_ck", sql`coalesce(jsonb_typeof(${t.snapshot}->'settings'->'enabled') = 'boolean' and (${t.snapshot}->'settings'->>'enabled')::boolean = ${t.enabled}, false)`),
]);
