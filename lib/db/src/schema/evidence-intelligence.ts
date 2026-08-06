import {
  boolean,
  customType,
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
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export type ClaimCaseStatus = "open" | "analyzing" | "review" | "issued" | "archived";
export type EvidenceArtifactKind = "photo" | "document" | "note" | "weather" | "property" | "other";
export type EvidenceRunStatus = "running" | "completed" | "failed";
export type ObservationStatus = "ai_draft" | "verified" | "rejected";
export type CertificateStatus = "draft" | "issued" | "superseded";

export const claimCasesTable = pgTable(
  "claim_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    propertyId: uuid("property_id").references(() => propertiesTable.id),
    title: text("title").notNull(),
    lossType: text("loss_type"),
    lossDate: timestamp("loss_date", { withTimezone: true }),
    description: text("description"),
    status: text("status").$type<ClaimCaseStatus>().notNull().default("open"),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id),
    updatedByUserId: varchar("updated_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("claim_cases_org_status_idx").on(table.organizationId, table.status),
    index("claim_cases_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

/**
 * Immutable source material. The raw bytes never leave MogulForge unless the
 * contractor explicitly approves the artifact for AI use. A SHA-256 digest
 * makes every downstream citation independently checkable.
 */
export const claimEvidenceArtifactsTable = pgTable(
  "claim_evidence_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => claimCasesTable.id),
    kind: text("kind").$type<EvidenceArtifactKind>().notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    blob: bytea("blob"),
    redactedText: text("redacted_text"),
    sourceLabel: text("source_label"),
    aiUseApprovedAt: timestamp("ai_use_approved_at", { withTimezone: true }),
    aiUseApprovedByUserId: varchar("ai_use_approved_by_user_id").references(() => usersTable.id),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("claim_artifacts_case_sha_uniq").on(table.organizationId, table.caseId, table.sha256),
    index("claim_artifacts_org_case_idx").on(table.organizationId, table.caseId),
  ],
);

export const claimEvidenceRunsTable = pgTable(
  "claim_evidence_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => claimCasesTable.id),
    status: text("status").$type<EvidenceRunStatus>().notNull().default("running"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    traceId: text("trace_id"),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    initiatedByUserId: varchar("initiated_by_user_id").references(() => usersTable.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("claim_evidence_runs_org_case_idx").on(table.organizationId, table.caseId, table.startedAt)],
);

export const claimObservationsTable = pgTable(
  "claim_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => claimCasesTable.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => claimEvidenceRunsTable.id),
    artifactId: uuid("artifact_id").references(() => claimEvidenceArtifactsTable.id),
    category: text("category").notNull(),
    statement: text("statement").notNull(),
    locator: text("locator"),
    basis: text("basis"),
    confidence: integer("confidence").notNull(),
    needsHumanReview: boolean("needs_human_review").notNull().default(true),
    status: text("status").$type<ObservationStatus>().notNull().default("ai_draft"),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("claim_observations_org_case_idx").on(table.organizationId, table.caseId),
    index("claim_observations_org_status_idx").on(table.organizationId, table.status),
  ],
);

export type CertificateFinding = {
  category: string;
  statement: string;
  confidence: number;
  needsHumanReview: boolean;
  citations: Array<{ artifactId: string; locator: string; basis: string; strength: string }>;
};

export const claimCertificatesTable = pgTable(
  "claim_certificates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => claimCasesTable.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => claimEvidenceRunsTable.id),
    version: integer("version").notNull(),
    status: text("status").$type<CertificateStatus>().notNull().default("draft"),
    executiveSummary: text("executive_summary").notNull(),
    findings: jsonb("findings").$type<CertificateFinding[]>().notNull().default(sql`'[]'::jsonb`),
    conflicts: jsonb("conflicts").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    gaps: jsonb("gaps").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    limitations: jsonb("limitations").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    recommendedNextSteps: jsonb("recommended_next_steps").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    contentHash: text("content_hash").notNull(),
    modelDetails: jsonb("model_details").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id),
    issuedByUserId: varchar("issued_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("claim_certificates_case_version_uniq").on(table.caseId, table.version),
    index("claim_certificates_org_case_idx").on(table.organizationId, table.caseId),
  ],
);

export type ClaimCase = typeof claimCasesTable.$inferSelect;
export type ClaimEvidenceArtifact = typeof claimEvidenceArtifactsTable.$inferSelect;
export type ClaimEvidenceRun = typeof claimEvidenceRunsTable.$inferSelect;
export type ClaimObservation = typeof claimObservationsTable.$inferSelect;
export type ClaimCertificate = typeof claimCertificatesTable.$inferSelect;
