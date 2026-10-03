import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import {
  invoiceButton,
  invoiceControl,
  invoicePrimary,
  type InvoiceDetail,
} from "@/lib/invoice-ui";
import {
  attemptIntentLabel,
  attemptLabel,
  invoiceDeliveryBlocker,
  invoiceDeliveryLabels,
  invoiceEmailEvidenceSchema,
  invoiceEmailPreviewSchema,
  reviewLabel,
  type InvoiceDeliveryIntent,
  type InvoiceEmailPreview,
} from "@/lib/invoice-delivery-ui";
export type { InvoiceEmailEvidence } from "@/lib/invoice-delivery-ui";

function failureMessage(error: unknown) {
  if (error instanceof ContractorApiError)
    return (
      (
        {
          invoice_delivery_review_changed:
            "This review expired or the invoice, customer, source or sender changed. Refresh and review a new preview.",
          invoice_delivery_review_expired:
            "This review expired. Refresh and review a new preview.",
          invoice_delivery_head_changed:
            "Another attempt changed the saved delivery history. Check delivery status and review again.",
          invoice_delivery_copy_acknowledgement_required:
            "Review the additional-copy warning and acknowledge it after opening the exact preview.",
          invoice_delivery_evidence_unavailable:
            "The saved evidence could not be verified. Check the original mailbox; no new send is authorized.",
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
  return "The invoice email request or evidence could not be confirmed. Refresh and review again.";
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
  const path = `/invoices/${encodeURIComponent(invoice.id)}/delivery`,
    cache = useQueryClient();
  const evidence = useQuery({
    queryKey: ["invoice-delivery", organizationId, invoice.id],
    retry: false,
    queryFn: async ({ signal }) => {
      const result = invoiceEmailEvidenceSchema.parse(
        await contractorRequest(path, { signal }),
      );
      if (
        result.invoiceId !== invoice.id ||
        (result.integrity === "valid" &&
          (result.attemptCount !== result.attempts.length ||
            result.latestExecutionId !==
              (result.attempts.at(-1)?.executionId ?? null) ||
            result.attempts.some(
              (attempt, index) => attempt.ordinal !== index + 1,
            )))
      )
        throw new Error("Invoice delivery response mismatch");
      return result;
    },
  });
  const [preview, setPreview] = useState<InvoiceEmailPreview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [copyAcknowledged, setCopyAcknowledged] = useState(false);
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [checkRequired, setCheckRequired] = useState(false),
    [expired, setExpired] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    setExpired(!!preview && Date.parse(preview.expiresAt) <= Date.now());
    if (!preview) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(
        0,
        Math.min(2_147_483_647, Date.parse(preview.expiresAt) - Date.now()),
      ),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  const ready =
    canManage &&
    invoice.status === "issued" &&
    evidence.data?.integrity === "valid" &&
    !evidence.isError &&
    !checkRequired &&
    evidence.data.attemptCount < evidence.data.maxAttempts &&
    !["processing", "uncertain", "reconciled"].includes(evidence.data.state);
  const modes = ready ? evidence.data!.nextIntents : [];
  const stale =
    !!preview &&
    (expired ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      preview.invoiceId !== invoice.id ||
      preview.invoiceVersion !== invoice.version ||
      invoice.status !== "issued" ||
      preview.expectedLatestExecutionId !== evidence.data?.latestExecutionId ||
      preview.prospectiveAttemptNumber !==
        (evidence.data?.attemptCount ?? -1) + 1 ||
      !evidence.data?.nextIntents.includes(preview.intent) ||
      preview.reason !== (preview.intent === "initial" ? null : reason.trim()));
  function discard() {
    setPreview(null);
    setConfirmed(false);
    setCopyAcknowledged(false);
  }
  async function prepare(intent: InvoiceDeliveryIntent) {
    if (
      inFlight.current ||
      !modes.includes(intent) ||
      (intent !== "initial" &&
        (reason.trim().length < 10 || reason.trim().length > 1000))
    )
      return;
    const head = evidence.data!.latestExecutionId,
      ordinal = evidence.data!.attemptCount + 1,
      approvedReason = intent === "initial" ? null : reason.trim();
    inFlight.current = true;
    setBusy(true);
    setError("");
    discard();
    try {
      const result = invoiceEmailPreviewSchema.parse(
        await contractorRequest(`${path}/preview`, {
          method: "POST",
          body:
            intent === "initial"
              ? { expectedVersion: invoice.version }
              : {
                  expectedVersion: invoice.version,
                  intent,
                  expectedLatestExecutionId: head,
                  reason: approvedReason,
                },
        }),
      );
      if (
        result.invoiceId !== invoice.id ||
        result.invoiceVersion !== invoice.version ||
        result.intent !== intent ||
        result.expectedLatestExecutionId !== head ||
        result.prospectiveAttemptNumber !== ordinal ||
        result.reason !== approvedReason ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error("The exact review changed or expired.");
      setPreview(result);
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    discard();
    try {
      const result = await evidence.refetch();
      if (!result.isError) {
        setCheckRequired(false);
        setError("");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (
      inFlight.current ||
      !preview ||
      !confirmed ||
      stale ||
      !ready ||
      (preview.intent === "additional_copy" && !copyAcknowledged) ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    inFlight.current = true;
    setError("");
    setBusy(true);
    setCheckRequired(true);
    try {
      await contractorRequest(`${path}/send`, {
        method: "POST",
        body: {
          previewId: preview.previewId,
          payloadSha256: preview.payloadSha256,
          confirmed: true,
          ...(preview.intent === "additional_copy"
            ? { duplicateCopyAcknowledged: true }
            : {}),
        },
      });
      discard();
      await cache.invalidateQueries({
        queryKey: ["invoice-delivery-worklist", organizationId],
      });
      const result = await evidence.refetch();
      if (!result.isError) setCheckRequired(false);
    } catch (failure) {
      setConfirmed(false);
      setCopyAcknowledged(false);
      setError(
        `${failureMessage(failure)} Check delivery status before doing anything else; do not send a separate copy.`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      id="invoice-delivery"
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
        email using the selected staff or company Gmail/Microsoft mailbox.
        Emailing another copy never creates a new invoice, balance, payment link
        or charge.
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
          <p className="font-semibold">
            {evidence.data.integrity === "valid"
              ? invoiceDeliveryLabels[evidence.data.state]
              : "Delivery evidence unavailable — review required"}
          </p>
          <p>{evidence.data.detail}</p>
          <p className="text-muted-foreground">
            {evidence.data.deliveryDetail}
          </p>
          <p>
            {evidence.data.attemptCount} of {evidence.data.maxAttempts} lifetime
            email attempts
          </p>
          {evidence.data.attentionReason && (
            <p>{invoiceDeliveryBlocker(evidence.data.attentionReason)}</p>
          )}
          {evidence.data.acceptedAt && (
            <p>
              Acceptance recorded:{" "}
              {new Date(evidence.data.acceptedAt).toLocaleString()}
            </p>
          )}
          {!!evidence.data.attempts.length && (
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer font-medium">
                Email attempt history ({evidence.data.attempts.length})
              </summary>
              <ol className="mt-3 space-y-4">
                {evidence.data.attempts.map((attempt) => (
                  <li
                    key={attempt.executionId}
                    className="space-y-1 border-t border-border pt-3"
                  >
                    <p className="font-medium">
                      Attempt {attempt.ordinal} —{" "}
                      {attemptIntentLabel(attempt.intent)}
                      {attempt.legacy ? " · Earlier saved attempt" : ""}
                    </p>
                    <p>{attemptLabel(attempt)}</p>
                    <p>{attempt.detail}</p>
                    <p className="text-xs text-muted-foreground">
                      Recorded {new Date(attempt.createdAt).toLocaleString()}
                      {attempt.acceptedAt
                        ? ` · Provider acceptance ${new Date(attempt.acceptedAt).toLocaleString()}`
                        : ""}
                    </p>
                    <details className="text-xs">
                      <summary className="cursor-pointer">
                        Support receipt details for attempt {attempt.ordinal}
                      </summary>
                      <dl className="space-y-1 break-all pt-2">
                        <div>
                          <dt>Execution reference</dt>
                          <dd>{attempt.executionId}</dd>
                        </div>
                        <div>
                          <dt>Logical attempt reference</dt>
                          <dd>{attempt.actionKey}</dd>
                        </div>
                        {attempt.proofId && (
                          <div>
                            <dt>Evidence reference</dt>
                            <dd>{attempt.proofId}</dd>
                          </div>
                        )}
                        {attempt.providerMessageId && (
                          <div>
                            <dt>{attempt.provider} message receipt</dt>
                            <dd>{attempt.providerMessageId}</dd>
                          </div>
                        )}
                        {attempt.providerRequestId && (
                          <div>
                            <dt>
                              Provider request correlation (not a
                              delivered-message receipt)
                            </dt>
                            <dd>{attempt.providerRequestId}</dd>
                          </div>
                        )}
                      </dl>
                    </details>
                  </li>
                ))}
              </ol>
            </details>
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
          Check delivery status to reconcile the saved request. Another click,
          preview or browser cannot bypass its reserved attempt.
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
      {!!modes.length && (
        <div className="space-y-3">
          {modes.some((mode) => mode !== "initial") && (
            <>
              <p className="text-sm">
                {modes.includes("additional_copy")
                  ? "The provider accepted the previous email, but delivery is unconfirmed. A new email is another copy of the original issued invoice, not a retry of an unsent message."
                  : "The previous attempt has verified evidence that dispatch did not occur. A new attempt still requires the current recipient, sender and complete document to be reviewed."}
              </p>
              <label
                className="block text-sm font-medium"
                htmlFor="invoice-delivery-reason"
              >
                Reason for another invoice email (10–1,000 characters)
              </label>
              <textarea
                id="invoice-delivery-reason"
                className={invoiceControl}
                value={reason}
                maxLength={1000}
                disabled={busy}
                onChange={(event) => {
                  setReason(event.target.value);
                  discard();
                }}
              />
            </>
          )}
          {modes.map((intent) => (
            <button
              key={intent}
              className={invoiceButton}
              disabled={
                busy || (intent !== "initial" && reason.trim().length < 10)
              }
              onClick={() => void prepare(intent)}
            >
              {preview
                ? "Discard preview and review again"
                : reviewLabel(intent)}
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="space-y-4 border-t border-border pt-4">
          <h3 className="font-semibold">Review the exact email</h3>
          <p className="text-sm">
            {attemptIntentLabel(preview.intent)} · Attempt{" "}
            {preview.prospectiveAttemptNumber} of {preview.maxAttempts}
          </p>
          {preview.reason && (
            <p className="break-words text-sm">Reason: {preview.reason}</p>
          )}
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
            {new Date(preview.expiresAt).toLocaleTimeString()}. A changed
            invoice, recipient, source, sender, reason or delivery history
            requires a fresh review.
          </p>
          {stale && (
            <p role="alert" className="text-sm">
              The invoice changed after this preview, its delivery history
              changed, or the review expired. The old approval is disabled;
              check delivery status and review a fresh preview.
            </p>
          )}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-5"
              checked={confirmed}
              disabled={busy || stale || !ready}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed this recipient, sender and complete issued document and
            approve sending this one email.
          </label>
          {preview.intent === "additional_copy" && (
            <label className="flex items-start gap-3 rounded-lg border border-amber-500/40 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-5"
                checked={copyAcknowledged}
                disabled={busy || stale || !ready}
                onChange={(event) => setCopyAcknowledged(event.target.checked)}
              />
              I understand the previous email was accepted and this sends
              another copy. It is not a new bill or charge, and the customer may
              receive a duplicate.
            </label>
          )}
          <button
            className={invoicePrimary}
            disabled={
              busy ||
              !confirmed ||
              stale ||
              !ready ||
              (preview.intent === "additional_copy" && !copyAcknowledged)
            }
            onClick={() => void send()}
          >
            {preview.intent === "additional_copy"
              ? "Approve and send another copy"
              : "Approve and send invoice"}
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
