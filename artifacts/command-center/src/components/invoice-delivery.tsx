import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import {
  invoiceButton,
  invoicePrimary,
  type InvoiceDetail,
} from "@/lib/invoice-ui";

export interface InvoiceEmailEvidence {
  invoiceId: string;
  state:
    | "not_sent"
    | "processing"
    | "accepted"
    | "held"
    | "uncertain"
    | "reconciled";
  executionId: string | null;
  detail: string;
  provider: "gmail" | "microsoft" | null;
  providerMessageId: string | null;
  providerRequestId: string | null;
  acceptedAt: string | null;
  deliveryConfirmed: false;
  deliveryDetail: string;
  canPrepare: boolean;
}
interface Preview {
  previewId: string;
  payloadSha256: string;
  expiresAt: string;
  invoiceId: string;
  invoiceVersion: number;
  recipient: string;
  sender: {
    userId: string;
    source: "lead_assignee" | "company_default";
    provider: "gmail" | "microsoft";
    senderEmail: string;
  };
  subject: string;
  body: string;
}
const labels: Record<InvoiceEmailEvidence["state"], string> = {
  not_sent: "Not sent",
  processing: "Send in progress",
  accepted: "Provider accepted — delivery unconfirmed",
  held: "Not sent — reserved attempt held",
  uncertain: "Uncertain — review required",
  reconciled: "Operator reconciliation recorded",
};
function failureMessage(error: unknown) {
  if (error instanceof ContractorApiError)
    return (
      (
        {
          invoice_delivery_review_changed:
            "This review expired or the invoice, customer, source or sender changed. Refresh and review a new preview.",
          invoice_delivery_not_issued:
            "Only a currently issued, non-void invoice can be emailed.",
          invoice_delivery_sender_unavailable:
            "Connect the assigned staff member’s selected Gmail/Microsoft mailbox, or configure the explicit company sender for an unassigned opportunity.",
          invoice_delivery_held:
            "Email is held. Check the customer’s do-not-contact/suppression status, company lifecycle and outbound/staging controls before reviewing again.",
          invoice_delivery_reserved:
            "This invoice already has a reserved send. Check its evidence; do not send another copy.",
          invoice_access_denied:
            "Your current role cannot approve invoice delivery.",
          invoice_invalid_request:
            "The invoice email request could not be validated. Refresh and review again.",
        } as Record<string, string>
      )[error.code] ?? "The invoice email result could not be confirmed."
    );
  return error instanceof Error
    ? error.message
    : "The invoice email result could not be confirmed.";
}

export function InvoiceDelivery({
  invoice,
  organizationId,
  canManage,
}: {
  invoice: InvoiceDetail;
  organizationId: string;
  canManage: boolean;
}) {
  const path = `/invoices/${encodeURIComponent(invoice.id)}/delivery`;
  const evidence = useQuery({
    queryKey: ["invoice-delivery", organizationId, invoice.id],
    queryFn: async ({ signal }) => {
      const result = await contractorRequest<InvoiceEmailEvidence>(path, {
        signal,
      });
      if (result.invoiceId !== invoice.id)
        throw new Error("Invoice delivery response mismatch");
      return result;
    },
    retry: false,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkRequired, setCheckRequired] = useState(false);
  const stale =
    preview &&
    (preview.invoiceId !== invoice.id ||
      preview.invoiceVersion !== invoice.version ||
      invoice.status !== "issued");
  const ready =
    canManage &&
    invoice.status === "issued" &&
    evidence.data?.canPrepare &&
    !evidence.isError &&
    !checkRequired;

  async function prepare() {
    setError("");
    setBusy(true);
    setConfirmed(false);
    setPreview(null);
    try {
      const result = await contractorRequest<Preview>(`${path}/preview`, {
        method: "POST",
        body: { expectedVersion: invoice.version },
      });
      if (
        result.invoiceId !== invoice.id ||
        result.invoiceVersion !== invoice.version
      )
        throw new Error("The invoice changed. Refresh and review it again.");
      setPreview(result);
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const result = await evidence.refetch();
    if (!result.isError) {
      setCheckRequired(false);
      setError("");
      setPreview(null);
      setConfirmed(false);
    }
  }
  async function send() {
    if (!preview || !confirmed || stale || !ready) return;
    setError("");
    setBusy(true);
    try {
      await contractorRequest<InvoiceEmailEvidence>(`${path}/send`, {
        method: "POST",
        body: {
          previewId: preview.previewId,
          payloadSha256: preview.payloadSha256,
          confirmed: true,
        },
      });
      setPreview(null);
      setConfirmed(false);
      // A lost status response must not make the Send button eligible again.
      setCheckRequired(true);
      const result = await evidence.refetch();
      if (!result.isError) setCheckRequired(false);
    } catch (failure) {
      setCheckRequired(true);
      setConfirmed(false);
      setError(
        `${failureMessage(failure)} Check delivery status before doing anything else; do not send a separate copy.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Invoice email delivery"
      className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Email this invoice</h2>
        <button
          className={invoiceButton}
          disabled={busy || evidence.isFetching}
          onClick={() => void refresh()}
        >
          Check delivery status
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Send the immutable issued document to this opportunity’s saved customer
        email, using its assigned staff member’s selected Gmail/Microsoft
        mailbox or the explicit company default. No payment link or charge is
        created.
      </p>
      {evidence.isPending ? (
        <p role="status">Loading invoice email evidence…</p>
      ) : evidence.isError ? (
        <p role="alert">
          Invoice email evidence could not load. Check status before sending;
          missing evidence is not proof that no email was sent.
        </p>
      ) : evidence.data ? (
        <div className="space-y-2 text-sm">
          <p className="font-semibold">{labels[evidence.data.state]}</p>
          <p>{evidence.data.detail}</p>
          <p className="text-muted-foreground">
            {evidence.data.deliveryDetail}
          </p>
          {evidence.data.acceptedAt && (
            <p>
              Acceptance recorded:{" "}
              {new Date(evidence.data.acceptedAt).toLocaleString()}
            </p>
          )}
          {evidence.data.providerMessageId && (
            <p className="break-all">
              {evidence.data.provider} message receipt:{" "}
              {evidence.data.providerMessageId}
            </p>
          )}
          {evidence.data.providerRequestId && (
            <p className="break-all">
              Provider request correlation (not a delivered-message receipt):{" "}
              {evidence.data.providerRequestId}
            </p>
          )}
          {evidence.data.executionId && (
            <p className="break-all text-xs text-muted-foreground">
              Execution reference: {evidence.data.executionId}
            </p>
          )}
        </div>
      ) : null}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {checkRequired && (
        <p role="status" className="text-sm">
          Check delivery status to reconcile the saved request. A new browser
          click cannot bypass the server’s reserved invoice send.
        </p>
      )}
      {!canManage && (
        <p className="text-sm text-muted-foreground">
          Your invoice role is read-only. An owner, admin or office staff member
          must approve delivery.
        </p>
      )}
      {invoice.status !== "issued" && (
        <p className="text-sm">
          Only a currently issued, non-void invoice can be emailed.
        </p>
      )}
      {ready && (
        <button
          className={invoiceButton}
          disabled={busy}
          onClick={() => void prepare()}
        >
          {preview
            ? "Discard preview and review again"
            : "Preview invoice email"}
        </button>
      )}
      {preview && (
        <div className="space-y-4 border-t border-border pt-4">
          <h3 className="font-semibold">Review the exact email</h3>
          <dl className="space-y-2 break-words text-sm">
            <div>
              <dt className="font-medium">To</dt>
              <dd>{preview.recipient}</dd>
            </div>
            <div>
              <dt className="font-medium">From</dt>
              <dd>
                {preview.sender.senderEmail} · {preview.sender.provider} ·{" "}
                {preview.sender.source === "lead_assignee"
                  ? "Assigned staff sender"
                  : "Company default sender"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Subject</dt>
              <dd>{preview.subject}</dd>
            </div>
          </dl>
          <pre
            aria-label="Exact invoice email content"
            className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-4 font-sans text-sm leading-relaxed"
          >
            {preview.body}
          </pre>
          <p className="text-xs text-muted-foreground">
            This review expires at{" "}
            {new Date(preview.expiresAt).toLocaleTimeString()}. Customer,
            source, invoice or sender changes require a fresh review.
          </p>
          {stale && (
            <p role="alert" className="text-sm">
              The invoice changed after this preview. The old approval is
              disabled; review a fresh preview.
            </p>
          )}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-5"
              checked={confirmed}
              disabled={busy || !!stale || !ready}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed this recipient, sender and complete issued document and
            approve sending this one email.
          </label>
          <button
            className={invoicePrimary}
            disabled={busy || !confirmed || !!stale || !ready}
            onClick={() => void send()}
          >
            Approve and send invoice
          </button>
        </div>
      )}
      {busy && (
        <p role="status" className="text-sm">
          Confirming invoice email action…
        </p>
      )}
    </section>
  );
}
