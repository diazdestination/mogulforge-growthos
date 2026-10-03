import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { invoicesTable } from "./invoices";
import { usersTable } from "./auth";
import { auditEventsTable } from "./audit";
import { revenueExecutionsTable } from "./revenue-workspace";

export type InvoiceDeliveryIntent =
  "initial" | "retry_not_dispatched" | "additional_copy";

/** Append-only identity/review chain. Outcomes stay in the exact execution and audit ledgers. */
export const invoiceDeliveryAttemptsTable = pgTable(
  "invoice_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    intent: text("intent").$type<InvoiceDeliveryIntent>().notNull(),
    duplicateCopyAcknowledged: boolean("duplicate_copy_acknowledged")
      .notNull()
      .default(false),
    executionId: uuid("execution_id").notNull(),
    actionKey: text("action_key").notNull(),
    executionFingerprint: text("execution_fingerprint").notNull(),
    actorUserId: varchar("actor_user_id").notNull(),
    previewId: uuid("preview_id").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    documentSha256: text("document_sha256").notNull(),
    invoiceVersion: integer("invoice_version").notNull(),
    reviewSha256: text("review_sha256").notNull(),
    predecessorExecutionId: uuid("predecessor_execution_id"),
    predecessorActionKey: text("predecessor_action_key"),
    predecessorFingerprint: text("predecessor_fingerprint"),
    predecessorProofId: uuid("predecessor_proof_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("invoice_attempt_org_id_uq").on(t.organizationId, t.id),
    uniqueIndex("invoice_attempt_ordinal_uq").on(
      t.organizationId,
      t.invoiceId,
      t.ordinal,
    ),
    uniqueIndex("invoice_attempt_execution_uq").on(
      t.organizationId,
      t.executionId,
    ),
    uniqueIndex("invoice_attempt_preview_uq").on(t.organizationId, t.previewId),
    uniqueIndex("invoice_attempt_successor_uq")
      .on(t.organizationId, t.predecessorExecutionId)
      .where(sql`${t.predecessorExecutionId} is not null`),
    index("invoice_attempt_invoice_idx").on(t.organizationId, t.invoiceId),
    check(
      "invoice_attempt_ordinal_ck",
      sql`${t.ordinal} between 1 and 5 and ${t.invoiceVersion} > 0`,
    ),
    check(
      "invoice_attempt_copy_ack_ck",
      sql`(${t.intent} = 'additional_copy') = ${t.duplicateCopyAcknowledged}`,
    ),
    check(
      "invoice_attempt_hash_ck",
      sql`${t.executionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.payloadSha256} ~ '^[a-f0-9]{64}$' and ${t.documentSha256} ~ '^[a-f0-9]{64}$' and ${t.reviewSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "invoice_attempt_key_ck",
      sql`${t.actionKey} = 'invoice-delivery:' || ${t.invoiceId}::text || case when ${t.ordinal} = 1 then '' else ':attempt:' || ${t.ordinal}::text end`,
    ),
    check(
      "invoice_attempt_predecessor_ck",
      sql`(${t.ordinal} = 1 and ${t.intent} = 'initial' and ${t.predecessorExecutionId} is null and ${t.predecessorActionKey} is null and ${t.predecessorFingerprint} is null and ${t.predecessorProofId} is null) or (${t.ordinal} > 1 and ${t.intent} in ('retry_not_dispatched','additional_copy') and ${t.predecessorExecutionId} is not null and ${t.predecessorActionKey} is not null and ${t.predecessorFingerprint} is not null and ${t.predecessorProofId} is not null and ${t.predecessorActionKey} = 'invoice-delivery:' || ${t.invoiceId}::text || case when ${t.ordinal} = 2 then '' else ':attempt:' || (${t.ordinal} - 1)::text end)`,
    ),
    foreignKey({
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoicesTable.organizationId, invoicesTable.id],
      name: "invoice_attempt_invoice_fk",
    }),
    foreignKey({
      columns: [t.organizationId, t.actorUserId],
      foreignColumns: [usersTable.organizationId, usersTable.id],
      name: "invoice_attempt_actor_fk",
    }),
    foreignKey({
      columns: [t.organizationId, t.previewId, t.actorUserId, t.invoiceId],
      foreignColumns: [
        auditEventsTable.organizationId,
        auditEventsTable.id,
        auditEventsTable.actorUserId,
        auditEventsTable.entityId,
      ],
      name: "invoice_attempt_review_fk",
    }),
    foreignKey({
      columns: [
        t.organizationId,
        t.executionId,
        t.actionKey,
        t.executionFingerprint,
        t.actorUserId,
      ],
      foreignColumns: [
        revenueExecutionsTable.organizationId,
        revenueExecutionsTable.id,
        revenueExecutionsTable.actionKey,
        revenueExecutionsTable.fingerprint,
        revenueExecutionsTable.actorUserId,
      ],
      name: "invoice_attempt_execution_fk",
    }),
    foreignKey({
      columns: [
        t.organizationId,
        t.predecessorExecutionId,
        t.predecessorActionKey,
        t.predecessorFingerprint,
      ],
      foreignColumns: [
        revenueExecutionsTable.organizationId,
        revenueExecutionsTable.id,
        revenueExecutionsTable.actionKey,
        revenueExecutionsTable.fingerprint,
      ],
      name: "invoice_attempt_predecessor_fk",
    }),
    foreignKey({
      columns: [t.organizationId, t.predecessorProofId],
      foreignColumns: [auditEventsTable.organizationId, auditEventsTable.id],
      name: "invoice_attempt_proof_fk",
    }),
  ],
);
