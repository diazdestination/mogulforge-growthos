import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { contractorRequest } from "@/lib/contractor-api";
import { invoiceButton, invoiceControl } from "@/lib/invoice-ui";
import { customerInvoicePath } from '@/lib/customer-work-links';
import {
  attemptLabel,
  invoiceDeliveryBlocker,
  invoiceDeliveryWorklistSchema,
  reviewLabel,
} from "@/lib/invoice-delivery-ui";

export function InvoiceDeliveryWorklist({
  organizationId,
  canManage,
  leadId,
  projectId,
}: {
  organizationId: string;
  canManage: boolean;
  leadId: string;
  projectId: string;
}) {
  const [page, setPage] = useState(0),
    [status, setStatus] = useState("");
  const query = useQuery({
    queryKey: [
      "invoice-delivery-worklist",
      organizationId,
      page,
      status,
      leadId,
      projectId,
    ],
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ page: String(page) });
      if (status) params.set("status", status);
      if (leadId) params.set("leadId", leadId);
      if (projectId) params.set("projectId", projectId);
      const result = invoiceDeliveryWorklistSchema.parse(
        await contractorRequest(`/invoices/delivery-worklist?${params}`, {
          signal,
        }),
      );
      if (
        result.page !== page ||
        result.items.some(
          (item) =>
            (item.organizationId !== undefined && item.organizationId !== organizationId) ||
            (item.leadId === null && (!item.customerWorkId || !item.contactId || item.organizationId !== organizationId || item.sourceKind !== 'customer_work')) ||
            (status && item.status !== status) ||
            (leadId && item.leadId !== leadId) ||
            (projectId && item.projectId !== projectId),
        )
      )
        throw new Error("Invoice delivery page mismatch");
      return result;
    },
  });
  return (
    <section aria-label="Invoice email delivery worklist" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Invoice email delivery</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Check each invoice's delivery evidence, then open it for a fresh
            review. These are invoice pages, not a global exception queue. There
            is no delivery-state filter or all-exceptions count yet.
          </p>
        </div>
        <button
          className={invoiceButton}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh delivery list
        </button>
      </div>
      <div className="max-w-xs">
        <label
          className="mb-1 block text-sm font-medium"
          htmlFor="delivery-document-status"
        >
          Document status
        </label>
        <select
          id="delivery-document-status"
          className={invoiceControl}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All invoices</option>
          <option value="draft">Drafts</option>
          <option value="issued">Issued</option>
          <option value="void">Void</option>
        </select>
      </div>
      {!canManage && (
        <p className="text-sm text-muted-foreground">
          Read-only view. An owner, admin or office user must review and approve
          an email.
        </p>
      )}
      {query.isPending ? (
        <p role="status">Loading invoice delivery evidence…</p>
      ) : query.isError ? (
        <p role="alert">
          Invoice delivery evidence could not load. Refresh to check again;
          missing evidence is not proof that no email was sent.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {query.data.total} matching invoice
            {query.data.total === 1 ? "" : "s"} · Page {query.data.page + 1} ·
            up to 25 invoices per page
          </p>
          {!query.data.items.length ? (
            <p>No invoices match this page.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border bg-card">
              {query.data.items.map((item) => (
                <li key={item.invoiceId} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words font-semibold">
                        {item.invoiceNumber || "Unnumbered draft"} —{" "}
                        {item.title}
                      </h3>
                      <p className="break-words text-sm">
                        {item.customerName} · {item.status}
                      </p>
                    </div>
                    <Link
                      className={invoiceButton}
                      href={`${customerInvoicePath(item.invoiceId, organizationId) || `/invoices/${encodeURIComponent(item.invoiceId)}`}#invoice-delivery`}
                    >
                      Open invoice
                    </Link>
                  </div>
                  <p className="text-sm font-medium">
                    {attemptLabel(
                      item.delivery.latestAttempt,
                      item.delivery.integrity,
                    )}
                  </p>
                  <p className="text-sm">
                    {item.delivery.attemptCount} of {item.delivery.maxAttempts}{" "}
                    lifetime email attempts
                  </p>
                  {item.delivery.nextIntents.length ? (
                    <p className="text-sm">
                      Available for a fresh review:{" "}
                      {item.delivery.nextIntents.map(reviewLabel).join(" · ")}.
                      Sender readiness and current holds are checked again
                      before sending.
                    </p>
                  ) : (
                    <p className="text-sm">
                      No new send is available through this workflow.{" "}
                      {item.delivery.attemptCount >= item.delivery.maxAttempts
                        ? "The lifetime attempt limit is reached."
                        : "Open the invoice and check its evidence or original mailbox."}
                    </p>
                  )}
                  {item.delivery.attentionReason && (
                    <p className="break-words text-sm text-muted-foreground">
                      {invoiceDeliveryBlocker(item.delivery.attentionReason)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap justify-between gap-3">
            <button
              className={invoiceButton}
              disabled={query.isFetching || page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous invoice page
            </button>
            <button
              className={invoiceButton}
              disabled={query.isFetching || (page + 1) * 25 >= query.data.total}
              onClick={() => setPage((value) => value + 1)}
            >
              Next invoice page
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Provider acceptance is not inbox delivery, a payment receipt or a
            charge. An uncertain or reconciled send is never made retryable by
            opening another browser window.
          </p>
        </>
      )}
    </section>
  );
}
