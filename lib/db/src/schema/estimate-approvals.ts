import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { usersTable } from "./auth";
import { estimatesTable, type EstimateLineItem } from "./estimates";
import { organizationsTable } from "./organizations";

/** What the customer saw when the approval link was created. */
export interface EstimateApprovalSnapshot {
  formatVersion: 1;
  companyName: string;
  customerName: string | null;
  title: string;
  lineItems: EstimateLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string | null;
}

export type EstimateApprovalDecision = "approved" | "declined";

/**
 * ESTI customer approval with e-signature. One row per approval link for one
 * saved estimate version. The link is a capability URL whose token is derived
 * server-side from the row id; only its SHA-256 is stored. `snapshotSha256`
 * digests the estimate content at link creation, so any later edit makes the
 * link outdated and approval is refused. A decided row is retained evidence.
 */
export const estimateApprovalsTable = pgTable(
  "estimate_approvals",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    estimateId: uuid("estimate_id")
      .notNull()
      .references(() => estimatesTable.id),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    snapshot: jsonb("snapshot").$type<EstimateApprovalSnapshot>().notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: varchar("revoked_by_user_id").references(() => usersTable.id),
    decision: text("decision").$type<EstimateApprovalDecision>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    signerName: text("signer_name"),
    signatureDataUrl: text("signature_data_url"),
    signatureSha256: text("signature_sha256"),
    consentText: text("consent_text"),
    declineReason: text("decline_reason"),
    signerIp: text("signer_ip"),
    signerUserAgent: text("signer_user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("estimate_approvals_token_hash_uq").on(table.tokenHash),
    // One open (undecided, unrevoked) link per estimate at a time.
    uniqueIndex("estimate_approvals_open_uq")
      .on(table.estimateId)
      .where(sql`${table.revokedAt} is null and ${table.decision} is null`),
    index("estimate_approvals_org_estimate_idx").on(table.organizationId, table.estimateId),
    check("estimate_approvals_decision_ck", sql`${table.decision} is null or ${table.decision} in ('approved','declined')`),
    check(
      "estimate_approvals_decided_ck",
      sql`(${table.decision} is null and ${table.decidedAt} is null) or (${table.decision} is not null and ${table.decidedAt} is not null and ${table.revokedAt} is null)`,
    ),
    check(
      "estimate_approvals_signed_ck",
      sql`${table.decision} is distinct from 'approved' or (${table.signerName} is not null and ${table.signatureDataUrl} is not null and ${table.signatureSha256} is not null and ${table.consentText} is not null)`,
    ),
    check("estimate_approvals_signature_size_ck", sql`${table.signatureDataUrl} is null or length(${table.signatureDataUrl}) <= 200000`),
  ],
);

export type EstimateApproval = typeof estimateApprovalsTable.$inferSelect;
