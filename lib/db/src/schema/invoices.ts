import { sql } from "drizzle-orm";
import {
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { projectsTable } from "./projects";
import { estimatesTable } from "./estimates";
import { usersTable } from "./auth";
import { valueEntriesTable } from "./revenue-workspace";

export interface InvoiceDocument {
  title: string;
  currency: "USD";
  issuerName: string;
  issuerAddress: string | null;
  customerName: string;
  customerAddress: string | null;
  dueDate: string | null;
  notes: string | null;
  lineItems: {
    description: string;
    quantity: string;
    unitPriceCents: number;
    totalCents: number;
  }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
export type InvoiceState = "draft" | "issued" | "void";

export const invoicesTable = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    projectId: uuid("project_id").references(() => projectsTable.id),
    estimateId: uuid("estimate_id").references(() => estimatesTable.id),
    status: text("status").$type<InvoiceState>().notNull().default("draft"),
    version: integer("version").notNull().default(1),
    invoiceNumber: text("invoice_number"),
    draftDocument: jsonb("draft_document").$type<InvoiceDocument>().notNull(),
    issuedDocument: jsonb("issued_document").$type<InvoiceDocument>(),
    issuedDocumentSha256: text("issued_document_sha256"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_org_number_unique").on(
      t.organizationId,
      t.invoiceNumber,
    ),
    index("invoices_org_status_created").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    index("invoices_org_lead").on(t.organizationId, t.leadId),
    index("invoices_org_project").on(t.organizationId, t.projectId),
    check(
      "invoice_state_valid",
      sql`${t.status} in ('draft', 'issued', 'void')`,
    ),
    check("invoice_version_positive", sql`${t.version} > 0`),
    check(
      "invoice_issued_snapshot_present",
      sql`${t.status} <> 'issued' or (${t.invoiceNumber} is not null and ${t.issuedDocument} is not null and ${t.issuedDocumentSha256} is not null and ${t.issuedAt} is not null)`,
    ),
    check(
      "invoice_void_reason_present",
      sql`${t.status} <> 'void' or (${t.voidReason} is not null and ${t.voidedAt} is not null)`,
    ),
  ],
);

export const invoiceSequencesTable = pgTable(
  "invoice_sequences",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizationsTable.id),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => [check("invoice_sequence_positive", sql`${t.nextNumber} > 0`)],
);

/** Completed operations only, written in the same transaction as the change. */
export const invoiceOperationsTable = pgTable(
  "invoice_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    requestId: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    action: text("action").notNull(),
    version: integer("version").notNull(),
    actorUserId: varchar("actor_user_id")
      .notNull()
      .references(() => usersTable.id),
    reason: text("reason"),
    resultId: uuid("result_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_operation_org_request_unique").on(
      t.organizationId,
      t.requestId,
    ),
    index("invoice_operations_org_invoice").on(
      t.organizationId,
      t.invoiceId,
      t.createdAt,
    ),
  ],
);

/** Reversal rows remove an allocation; they never create a cash refund. */
export const invoiceReceiptAllocationsTable = pgTable(
  "invoice_receipt_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    valueEntryId: uuid("value_entry_id")
      .notNull()
      .references(() => valueEntriesTable.id),
    kind: text("kind").$type<"payment" | "refund" | "reversal">().notNull(),
    amountCents: integer("amount_cents").notNull(),
    reversesAllocationId: uuid("reverses_allocation_id").references(
      (): AnyPgColumn => invoiceReceiptAllocationsTable.id,
    ),
    actorUserId: varchar("actor_user_id")
      .notNull()
      .references(() => usersTable.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_allocation_reversal_unique").on(
      t.reversesAllocationId,
    ),
    index("invoice_allocations_org_invoice").on(t.organizationId, t.invoiceId),
    index("invoice_allocations_org_value_entry").on(
      t.organizationId,
      t.valueEntryId,
    ),
    check(
      "invoice_allocation_amount_positive",
      sql`${t.amountCents} > 0 and ${t.amountCents} <= 1000000000`,
    ),
    check(
      "invoice_allocation_kind_valid",
      sql`${t.kind} in ('payment', 'refund', 'reversal')`,
    ),
    check(
      "invoice_allocation_reversal_link",
      sql`(${t.kind} = 'reversal' and ${t.reversesAllocationId} is not null and ${t.reason} is not null) or (${t.kind} in ('payment', 'refund') and ${t.reversesAllocationId} is null)`,
    ),
  ],
);
