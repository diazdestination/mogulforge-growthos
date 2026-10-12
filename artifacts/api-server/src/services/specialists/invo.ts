/**
 * INVO — deterministic invoice-exception specialist (proposal-only).
 *
 * Rules are grounded in two real, redacted contractor invoices supplied by the
 * owner (no customer data is stored in code or tests):
 *  - HVAC: "Upon receipt" terms, two flat-rate repair lines whose descriptions
 *    list components without per-part prices, no warranty-validity dates even
 *    though the owner requires them; multi-repair invoices need office review
 *    before sending.
 *  - Roofing: "Due on receipt", one lump-sum line, $0 paid, full balance open,
 *    and estimate wording ("This shingle estimate includes …") carried into
 *    the invoice.
 *
 * INVO reads balances only through the canonical invoice service (getInvoice),
 * so it never re-derives money. It proposes staff tasks only. A reminder email
 * is NOT proposed: BIE's send_email path is lead-outreach-shaped (it blocks
 * won/completed leads and uses outreach consent), so it cannot correctly and
 * safely target an invoice customer. See reports/approval-gated-specialists-2026-10-11.md.
 */
import {
  db,
  invoiceDeliveryAttemptsTable,
  invoicesTable,
  leadsTable,
  propertyAssetsTable,
  serviceObligationsTable,
  usersTable,
  type BieActionProposal,
  type InvoiceDocument,
  type InvoiceState,
  type UserRole,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { hasPermission } from "../../lib/permissions";
import { getInvoice } from "../invoices";
import {
  OPEN_PROPOSAL_STATUSES,
  insertSpecialistProposals,
  specialistSubjectKeys,
  withSpecialistRun,
  type SpecialistProposalDraft,
} from "./contract";

export const INVO_POLICY = {
  /** "Due on receipt" means due at issue; a staff call is proposed this many days later. */
  overdueAfterDays: 7,
  /** Two or more lines (e.g. two "Standard Repair" lines) need office review before sending. */
  officeReviewMinLines: 2,
  maxInvoicesPerRun: 200,
} as const;

const DAY = 86_400_000;
const ESTIMATE_WORDING = /\bestimates?\b/i;
const WARRANTY_WORDING = /\bwarrant(y|ies|ed)\b/i;
const DATE_TEXT = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i;

export interface InvoFact {
  invoiceId: string;
  invoiceNumber: string | null;
  leadId: string | null;
  status: InvoiceState;
  version: number;
  document: Pick<InvoiceDocument, "title" | "notes" | "dueDate" | "lineItems" | "totalCents">;
  issuedAt: Date | null;
  /** From the canonical invoice service; null when draft or reconciliation is required. */
  balanceDueCents: number | null;
  paymentState: string;
  deliveryAttemptCount: number;
  warrantyReference: { warrantyObligations: Array<{ equipmentLabel: string; coverageStartsOn: string | null; coverageEndsOn: string | null }>; activeAssetCount: number };
}

export interface InvoOptions {
  /** Staff/owner choice for this run: invoices must show warranty-validity dates (HVAC intake). */
  warrantyDatesRequired: boolean;
}

export type InvoDecision =
  | { kind: "draft"; draft: SpecialistProposalDraft }
  | { kind: "skip"; subject: string; reason: string };

type History = Map<string, Pick<BieActionProposal, "status">[]>;

const documentText = (doc: InvoFact["document"]) =>
  [doc.title, doc.notes ?? "", ...doc.lineItems.map((line) => line.description)].join("\n");
/** A proposal that was blocked/failed may be proposed again; anything else is settled or open. */
const alreadyHandled = (history: History, key: string) =>
  (history.get(key) ?? []).some((row) => row.status !== "blocked" && row.status !== "failed");
/** Rationale/evidence label (invoice-authorized proposal only). */
const label = (fact: InvoFact) => fact.invoiceNumber ?? `draft ${fact.document.title}`;
/**
 * Label for task payloads. Executed tasks are readable by any crm.read role, so
 * payload text is built only from system identifiers: a system-issued number
 * (INV-000123) or a generic draft reference. Never user-authored titles, line
 * text, notes or amounts; those stay in invoice-authorized evidence/rationale.
 */
export const publicInvoiceLabel = (fact: Pick<InvoFact, "invoiceNumber" | "invoiceId" | "status">) =>
  fact.invoiceNumber && /^INV-\d{6,}$/.test(fact.invoiceNumber)
    ? fact.invoiceNumber
    : `${fact.status === "draft" ? "draft invoice" : "invoice"} ref ${fact.invoiceId.slice(0, 8)}`;

/** Pure: every INVO exception for one invoice. Never invents dates or amounts. */
export function planInvoice(fact: InvoFact, history: History, now: Date, options: InvoOptions): InvoDecision[] {
  const subject = `invo:${fact.invoiceId}`;
  if (fact.status === "void") return [{ kind: "skip", subject, reason: "void" }];
  if (!fact.leadId) return [{ kind: "skip", subject, reason: "customer_work_invoice_has_no_lead_queue_scope" }];
  const doc = fact.document;
  const text = documentText(doc);
  const unsent = fact.deliveryAttemptCount === 0;
  const common = {
    invoiceId: fact.invoiceId, invoiceNumber: fact.invoiceNumber, invoiceStatus: fact.status, invoiceVersion: fact.version,
    lineCount: doc.lineItems.length, totalCents: doc.totalCents, deliveryAttemptCount: fact.deliveryAttemptCount,
  };
  const out: InvoDecision[] = [];
  const add = (key: string, draft: Omit<SpecialistProposalDraft, "leadId" | "actionType" | "subjectKey">) => {
    if (alreadyHandled(history, key)) out.push({ kind: "skip", subject: key, reason: "already_proposed" });
    else out.push({ kind: "draft", draft: { leadId: fact.leadId!, actionType: "create_task", subjectKey: key, ...draft } });
  };

  // (1) Multi-repair invoice not yet sent → office review before send.
  if (unsent && doc.lineItems.length >= INVO_POLICY.officeReviewMinLines) {
    add(`${subject}:v${fact.version}:office_review`, {
      title: "Office review: multi-repair invoice before sending",
      rationale: `Invoice ${label(fact)} has ${doc.lineItems.length} lines and has not been sent. Multi-repair invoices are reviewed by the office before sending.`,
      evidence: { ...common, rule: "multi_line_office_review", lineDescriptions: doc.lineItems.map((line) => line.description.slice(0, 160)) },
      payload: { title: `Review ${publicInvoiceLabel(fact)} before sending`, description: `Confirm each of the ${doc.lineItems.length} repair lines, quantities and totals before the invoice is sent. Nothing has been sent.`, priority: "high" },
      estimatedValueCents: doc.totalCents,
    });
  }

  // (2) Warranty-validity dates expected (HVAC owner requirement, or warranty wording) but none shown.
  const mentionsWarranty = WARRANTY_WORDING.test(text);
  if (unsent || fact.status === "draft") {
    if ((options.warrantyDatesRequired || mentionsWarranty) && !DATE_TEXT.test(text)) {
      add(`${subject}:v${fact.version}:warranty_dates`, {
        title: "Add warranty-validity dates before sending",
        rationale: `Invoice ${label(fact)} ${mentionsWarranty ? "mentions a warranty" : "is for a company that requires warranty dates on invoices"} but shows no warranty start/end date. INVO does not invent dates; office staff should confirm them from the job and equipment records.`,
        evidence: { ...common, rule: "warranty_dates_missing", warrantyDatesRequired: options.warrantyDatesRequired, mentionsWarranty,
          knownWarrantyObligations: fact.warrantyReference.warrantyObligations, activeEquipmentRecords: fact.warrantyReference.activeAssetCount },
        payload: { title: `Add warranty dates to ${publicInvoiceLabel(fact)}`, description: "Confirm warranty-validity (and equipment install) dates from the job/equipment records and add them to the invoice before sending.", priority: "high" },
        estimatedValueCents: doc.totalCents,
      });
    }
  }

  // (3) Issued, unpaid balance past due ("due on receipt" = due at issue).
  if (fact.status === "issued") {
    if (fact.balanceDueCents == null) out.push({ kind: "skip", subject: `${subject}:overdue`, reason: "balance_unavailable_or_reconciliation_required" });
    else if (fact.balanceDueCents > 0 && fact.issuedAt) {
      const explicitDue = doc.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.dueDate) ? new Date(`${doc.dueDate}T23:59:59Z`) : null;
      const dueAt = explicitDue ?? fact.issuedAt;
      const daysPastDue = Math.floor((now.getTime() - dueAt.getTime()) / DAY);
      const prefix = `${subject}:overdue:`;
      const openOverdue = [...history.entries()].some(([key, rows]) => key.startsWith(prefix) && rows.some((row) => (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(row.status)));
      if (daysPastDue < INVO_POLICY.overdueAfterDays) out.push({ kind: "skip", subject: `${prefix}pending`, reason: "not_yet_overdue" });
      else if (openOverdue) out.push({ kind: "skip", subject: `${prefix}open`, reason: "open_overdue_follow_up" });
      else {
        const week = Math.floor(daysPastDue / INVO_POLICY.overdueAfterDays);
        add(`${prefix}w${week}`, {
          title: "Call about unpaid invoice balance",
          rationale: `Invoice ${label(fact)} has a recorded balance of $${(fact.balanceDueCents / 100).toFixed(2)} and is ${daysPastDue} days past due (${explicitDue ? `due ${doc.dueDate}` : "due on receipt"}). Recorded balances reflect staff-entered receipts only.`,
          evidence: { ...common, rule: "overdue_unpaid_balance", balanceDueCents: fact.balanceDueCents, paymentState: fact.paymentState,
            dueBasis: explicitDue ? "due_date" : "due_on_receipt", dueAt: dueAt.toISOString(), issuedAt: fact.issuedAt.toISOString(), daysPastDue },
          // Task text stays free of amounts: CRM tasks are visible to roles without invoice access.
          payload: { title: `Follow up on unpaid ${publicInvoiceLabel(fact)}`, description: "The invoice is past due with an open recorded balance. Open the invoice, call the customer, confirm whether payment was made elsewhere, and record any receipt.", priority: "high" },
          estimatedValueCents: fact.balanceDueCents,
        });
      }
    }
  }

  // (4) Estimate wording carried into an invoice.
  if (ESTIMATE_WORDING.test(text)) {
    const matches = [doc.title, doc.notes ?? "", ...doc.lineItems.map((line) => line.description)]
      .filter((part) => ESTIMATE_WORDING.test(part)).map((part) => part.slice(0, 200));
    add(`${subject}:v${fact.version}:estimate_wording`, {
      title: "Review estimate wording on an invoice",
      rationale: `Invoice ${label(fact)} contains the word "estimate". Invoices should state billed work, not estimate terms.${unsent ? "" : " The issued document is immutable; correct the template for future invoices or void and reissue if needed."}`,
      evidence: { ...common, rule: "estimate_wording_on_invoice", matchingText: matches },
      payload: { title: `Review wording on ${publicInvoiceLabel(fact)}`, description: "The invoice text uses estimate wording. Confirm the billed scope and warranty language are invoice-appropriate.", priority: "high" },
      estimatedValueCents: null,
    });
  }
  return out;
}

export class SpecialistAccessError extends Error {
  readonly status = 403;
}

/**
 * Invoice-derived proposals (balances, line text, warranty evidence) are only
 * visible to, and actionable by, principals with invoice read access. Both the
 * stored member role and the effective role (e.g. a capped API key) must allow it.
 */
export function canReadInvoiceProposals(storedRole: UserRole | null | undefined, effectiveRole?: UserRole | null): boolean {
  return Boolean(storedRole && hasPermission(storedRole, "invoices.read") && hasPermission(effectiveRole ?? storedRole, "invoices.read"));
}

export interface InvoPrincipal {
  /** Effective role for this request (API-key cap). Defaults to the stored member role. */
  effectiveRole?: UserRole;
}

/** What INVO recorded at proposal time; used to revalidate before any task is created. */
const invoiceProposalEvidence = z.object({
  rule: z.enum(["multi_line_office_review", "warranty_dates_missing", "overdue_unpaid_balance", "estimate_wording_on_invoice"]),
  invoiceId: z.uuid(),
  invoiceVersion: z.number().int().positive(),
  balanceDueCents: z.number().int().nonnegative().optional(),
}).passthrough();

export interface CurrentInvoiceState {
  id: string;
  leadId: string | null;
  status: InvoiceState;
  version: number;
  document: Pick<InvoiceDocument, "title" | "notes" | "lineItems">;
  balanceDueCents: number | null;
  reconciliationRequired: boolean;
  deliveryAttemptCount: number;
}

export function invoiceProposalReference(evidence: Record<string, unknown>) {
  const parsed = invoiceProposalEvidence.safeParse(evidence);
  return parsed.success ? parsed.data : null;
}

/**
 * Pure: is a previously proposed INVO task still valid against the invoice's
 * current canonical state? Returns null when valid, otherwise a block reason.
 * Any version change (edit, issue, payment, refund, reversal) makes it stale.
 */
export function revalidateInvoiceProposal(
  evidence: Record<string, unknown>,
  proposalLeadId: string,
  current: CurrentInvoiceState | null,
): string | null {
  const ref = invoiceProposalReference(evidence);
  if (!ref) return "The proposal has no valid invoice reference.";
  if (!current || current.id !== ref.invoiceId || current.leadId !== proposalLeadId) return "The referenced invoice is not available for this lead.";
  if (current.status === "void") return "The invoice was voided after this proposal.";
  if (current.version !== ref.invoiceVersion) return "The invoice changed after this proposal (edited, issued, paid or corrected). Run INVO again.";
  const text = [current.document.title, current.document.notes ?? "", ...current.document.lineItems.map((line) => line.description)].join("\n");
  switch (ref.rule) {
    case "multi_line_office_review":
      if (current.deliveryAttemptCount > 0) return "The invoice has already been sent.";
      if (current.document.lineItems.length < INVO_POLICY.officeReviewMinLines) return "The invoice no longer has multiple lines.";
      return null;
    case "warranty_dates_missing":
      if (current.deliveryAttemptCount > 0) return "The invoice has already been sent.";
      if (DATE_TEXT.test(text)) return "The invoice now shows a date.";
      return null;
    case "overdue_unpaid_balance":
      if (current.status !== "issued") return "The invoice is not issued.";
      if (current.reconciliationRequired || current.balanceDueCents == null) return "The invoice balance needs reconciliation.";
      if (current.balanceDueCents <= 0) return "The invoice is paid in full.";
      if (current.balanceDueCents !== ref.balanceDueCents) return "The invoice balance changed after this proposal.";
      return null;
    case "estimate_wording_on_invoice":
      if (!ESTIMATE_WORDING.test(text)) return "The invoice no longer contains estimate wording.";
      return null;
  }
}

async function loadFacts(organizationId: string, actorUserId: string, principal: InvoPrincipal): Promise<{ facts: InvoFact[]; skippedCustomerWork: number }> {
  const rows = await db.select({ id: invoicesTable.id, leadId: invoicesTable.leadId, customerWorkId: invoicesTable.customerWorkId })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.organizationId, organizationId), inArray(invoicesTable.status, ["draft", "issued"])))
    .orderBy(desc(invoicesTable.updatedAt))
    .limit(INVO_POLICY.maxInvoicesPerRun);
  const leadRows = rows.filter((row) => row.leadId);
  const ids = leadRows.map((row) => row.id);
  const attempts = ids.length ? await db.select({ invoiceId: invoiceDeliveryAttemptsTable.invoiceId, count: sql<number>`count(*)::int` })
    .from(invoiceDeliveryAttemptsTable)
    .where(and(eq(invoiceDeliveryAttemptsTable.organizationId, organizationId), inArray(invoiceDeliveryAttemptsTable.invoiceId, ids)))
    .groupBy(invoiceDeliveryAttemptsTable.invoiceId) : [];
  const attemptCount = new Map(attempts.map((row) => [row.invoiceId, row.count]));
  const facts: InvoFact[] = [];
  for (const row of leadRows) {
    // Canonical money plus tenant/role checks, under the caller's effective role.
    const invoice = await getInvoice(organizationId, actorUserId, row.id, principal.effectiveRole);
    const [lead] = await db.select({ contactId: leadsTable.contactId }).from(leadsTable)
      .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, row.leadId!)));
    const obligations = lead ? await db.select({
      equipmentLabel: serviceObligationsTable.equipmentLabel, coverageStartsOn: serviceObligationsTable.coverageStartsOn, coverageEndsOn: serviceObligationsTable.coverageEndsOn,
    }).from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, organizationId), eq(serviceObligationsTable.contactId, lead.contactId),
      eq(serviceObligationsTable.kind, "warranty_check"))).limit(10) : [];
    const [assets] = lead ? await db.select({ count: sql<number>`count(*)::int` }).from(propertyAssetsTable)
      .where(and(eq(propertyAssetsTable.organizationId, organizationId), eq(propertyAssetsTable.contactId, lead.contactId), eq(propertyAssetsTable.status, "active"))) : [];
    facts.push({
      invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, leadId: invoice.leadId, status: invoice.status, version: invoice.version,
      document: invoice.document, issuedAt: invoice.issuedAt ? new Date(invoice.issuedAt) : null,
      balanceDueCents: invoice.balanceDueCents, paymentState: invoice.paymentState,
      deliveryAttemptCount: attemptCount.get(invoice.id) ?? 0,
      warrantyReference: { warrantyObligations: obligations, activeAssetCount: assets?.count ?? 0 },
    });
  }
  return { facts, skippedCustomerWork: rows.length - leadRows.length };
}

export interface InvoRunResult {
  runId: string;
  inserted: BieActionProposal[];
  skipped: Array<{ subject: string; reason: string }>;
}

/** Run INVO for one tenant. Requires invoice read access for both the member and the effective (API-key) role. */
export async function runInvo(organizationId: string, actorUserId: string, options: Partial<InvoOptions> = {}, now = new Date(), principal: InvoPrincipal = {}): Promise<InvoRunResult> {
  const [actor] = await db.select({ role: usersTable.role }).from(usersTable)
    .where(and(eq(usersTable.id, actorUserId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true)));
  if (!actor || !canReadInvoiceProposals(actor.role, principal.effectiveRole))
    throw new SpecialistAccessError("INVO reads invoices. An owner, admin, office or sales manager must run it.");
  const resolved: InvoOptions = { warrantyDatesRequired: options.warrantyDatesRequired === true };
  const { facts, skippedCustomerWork } = await loadFacts(organizationId, actorUserId, principal);
  return withSpecialistRun({ organizationId, key: "invo", actorUserId }, async (tx, runId) => {
    const history = await specialistSubjectKeys(tx, organizationId, "invo");
    const drafts: SpecialistProposalDraft[] = [];
    const skipped: Array<{ subject: string; reason: string }> = [];
    for (const fact of facts)
      for (const decision of planInvoice(fact, history, now, resolved))
        if (decision.kind === "draft") drafts.push(decision.draft); else skipped.push(decision);
    const { inserted, skippedOpen } = await insertSpecialistProposals(tx, { organizationId, runId, key: "invo", actorUserId, drafts });
    for (const subject of skippedOpen) skipped.push({ subject, reason: "open_proposal_exists" });
    return {
      inserted, skipped,
      summary: `INVO proposed ${inserted.length} invoice review task${inserted.length === 1 ? "" : "s"}.`,
      result: { invoicesReviewed: facts.length, skippedCustomerWorkInvoices: skippedCustomerWork, skippedCount: skipped.length,
        warrantyDatesRequired: resolved.warrantyDatesRequired, policy: INVO_POLICY, reminderEmail: "not_supported_for_invoices" },
    };
  });
}
