import { db, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { InvoiceError, invoiceListSchema } from "./invoice-contract";
import { listInvoices } from "./invoices";
import {
  getInvoiceDeliveryChains,
  type InvoiceDeliveryChain,
  type InvoiceDeliveryAttemptEvidence,
} from "./invoice-delivery-attempts";

export type InvoiceDeliveryWorklistSummary = Omit<
  InvoiceDeliveryChain,
  "invoiceId" | "attempts"
> & { latestAttempt: InvoiceDeliveryAttemptEvidence | null };

/** Fixed canonical invoice page, not a global delivery-exception query. All reads
 * are SELECT-only; no review, ownership, sender lookup, OAuth or provider work. */
export async function listInvoiceDeliveryWorklist(
  organizationId: string,
  actorUserId: string,
  raw: unknown,
) {
  const [actor] = await db
    .select({
      id: usersTable.id,
      active: usersTable.isActive,
      verifiedAt: usersTable.emailVerifiedAt,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, organizationId),
        eq(usersTable.id, actorUserId),
      ),
    );
  if (
    !actor ||
    !actor.active ||
    !actor.verifiedAt ||
    actor.id.startsWith("invite:") ||
    !hasPermission(actor.role, "invoices.read")
  )
    throw new InvoiceError(
      403,
      "invoice_access_denied",
      "An accepted current staff member with invoice read permission is required.",
    );
  const filter = invoiceListSchema.parse(raw);
  const page = await listInvoices(organizationId, actorUserId, {
    ...filter,
    page: String(filter.page),
  });
  const chains = await getInvoiceDeliveryChains(
    organizationId,
    page.items.map((invoice) => invoice.id),
  );
  const items = page.items.map((invoice) => {
    const chain = chains.get(invoice.id);
    if (!chain || chain.invoiceId !== invoice.id)
      throw new InvoiceError(
        503,
        "invoice_delivery_evidence_unavailable",
        "Invoice delivery evidence could not be verified. Missing evidence is not proof of no send.",
      );
    const latest = chain.attempts.at(-1);
    const delivery: InvoiceDeliveryWorklistSummary = {
      attemptCount: chain.attemptCount,
      maxAttempts: chain.maxAttempts,
      latestExecutionId: chain.latestExecutionId,
      nextIntents: chain.nextIntents,
      attentionReason: chain.attentionReason,
      integrity: chain.integrity,
      latestAttempt: latest
        ? {
            attemptId: latest.attemptId,
            legacy: latest.legacy,
            ordinal: latest.ordinal,
            executionId: latest.executionId,
            actionKey: latest.actionKey,
            intent: latest.intent,
            state: latest.state,
            detail: latest.detail,
            proof: latest.proof,
            proofId: latest.proofId,
            createdAt: latest.createdAt,
            completedAt: latest.completedAt,
            provider: latest.provider,
            providerMessageId: latest.providerMessageId,
            providerRequestId: latest.providerRequestId,
            acceptedAt: latest.acceptedAt,
          }
        : null,
    };
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      title: invoice.title,
      customerName: invoice.customerName,
      status: invoice.status,
      version: invoice.version,
      leadId: invoice.leadId,
      projectId: invoice.projectId,
      ...(invoice.sourceKind === "customer_work"
        ? {
            organizationId: invoice.organizationId,
            customerWorkId: invoice.customerWorkId,
            contactId: invoice.contactId,
            propertyId: invoice.propertyId,
            sourceKind: invoice.sourceKind,
          }
        : {}),
      delivery,
    };
  });
  return {
    items,
    total: page.total,
    page: page.page,
    pageSize: 25 as const,
    boundary:
      "Counts and pages are matching invoices, not all delivery exceptions. No global delivery-state filter/count is provided. Available review modes do not prove sender readiness or inbox delivery; each send needs a fresh exact approval.",
  };
}
