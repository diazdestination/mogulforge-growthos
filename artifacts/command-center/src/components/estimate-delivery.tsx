import { useEffect, useRef, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { Estimate } from "@workspace/api-client-react";
import { contractorRequest } from "@/lib/contractor-api";
import { currentMemberAuthorityMatches } from "@/lib/member-authority-scope";
import {
  estimateEmailEvidenceSchema,
  estimateEmailPreviewSchema,
  estimateDeliveryLabels,
  formatEstimateDeliveryCents,
  type EstimateEmailPreview,
} from "@/lib/estimate-delivery-ui";
// Session-local ownership survives page/member/target remounts. A lost result
// cannot turn a previous POST into a new review. The server owns permanent truth.
const submissions = new WeakMap<QueryClient, Set<string>>();
const control =
  "min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50";
export function EstimateDelivery({
  estimate,
  organizationId,
  canSend,
  authorityScope,
}: {
  estimate: Estimate;
  organizationId: string;
  canSend: boolean;
  authorityScope: string;
}) {
  const cache = useQueryClient();
  const owned = submissions.get(cache) ?? new Set<string>();
  submissions.set(cache, owned);
  const ownerKey = JSON.stringify([organizationId, estimate.id]);
  const identity = JSON.stringify([
    organizationId,
    authorityScope,
    estimate,
    canSend,
  ]);
  const token = useRef({ identity, active: true });
  if (token.current.identity !== identity)
    token.current = { identity, active: true };
  useEffect(() => {
    const original = token.current;
    original.active = true;
    return () => {
      original.active = false;
    };
  }, [identity]);
  const path = `/estimates/${encodeURIComponent(estimate.id)}/delivery`;
  const queryKey = [
    "estimate-delivery",
    organizationId,
    authorityScope,
    estimate.id,
    estimate.updatedAt,
    estimate.workVersion ?? null,
    estimate.status,
  ];
  const evidence = useQuery({
    queryKey,
    retry: false,
    queryFn: async ({ signal }) => {
      const value = estimateEmailEvidenceSchema.parse(
        await contractorRequest(path, { signal }),
      );
      if (value.estimateId !== estimate.id)
        throw new Error("Evidence target differs");
      return value;
    },
  });
  const [review, setReview] = useState<{
    identity: string;
    preview: EstimateEmailPreview;
  } | null>(null);
  const [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [, tick] = useState(0);
  const fence = useRef(false);
  useEffect(() => {
    setReview(null);
    setApproved(false);
    setError("");
    setBusy(false);
  }, [identity]);
  const preview = review?.identity === identity ? review.preview : null;
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  function contextCurrent(original = token.current) {
    if (
      !original.active ||
      token.current !== original ||
      !currentMemberAuthorityMatches(cache, authorityScope)
    )
      return false;
    return true;
  }
  function current(original = token.current) {
    if (!contextCurrent(original)) return false;
    const latest = estimateEmailEvidenceSchema.safeParse(
      cache.getQueryData(queryKey),
    );
    if (
      !latest.success ||
      latest.data.estimateId !== estimate.id ||
      latest.data.integrity !== "valid" ||
      latest.data.state !== "not_sent" ||
      !latest.data.canPrepare ||
      cache.getQueryState(queryKey)?.status === "error"
    )
      return false;
    // Cached list/detail revisions can land before the parent render commits.
    for (const query of cache.getQueryCache().getAll()) {
      if (query.queryKey[0] === "estimate-delivery") continue;
      const data = query.state.data;
      const rows = Array.isArray(data) ? data : [data];
      for (const row of rows)
        if (
          row &&
          typeof row === "object" &&
          row.id === estimate.id &&
          "updatedAt" in row &&
          (row.updatedAt !== estimate.updatedAt ||
            row.status !== estimate.status ||
            (row.workVersion ?? null) !== (estimate.workVersion ?? null) ||
            row.leadId !== estimate.leadId ||
            (row.customerWorkId ?? null) !==
              (estimate.customerWorkId ?? null) ||
            (row.contactId ?? null) !== (estimate.contactId ?? null) ||
            (row.propertyId ?? null) !== (estimate.propertyId ?? null))
        )
          return false;
    }
    return (
      !estimate.organizationId || estimate.organizationId === organizationId
    );
  }
  const ready =
    canSend &&
    estimate.status === "draft" &&
    !estimate.sentAt &&
    !estimate.acceptedAt &&
    evidence.data?.integrity === "valid" &&
    evidence.data.state === "not_sent" &&
    evidence.data.canPrepare &&
    !evidence.isError &&
    !evidence.isFetching &&
    !owned.has(ownerKey);
  async function prepare() {
    const original = token.current;
    if (fence.current || !ready || !current(original)) return;
    fence.current = true;
    setBusy(true);
    setReview(null);
    setApproved(false);
    setError("");
    try {
      const value = estimateEmailPreviewSchema.parse(
        await contractorRequest(`${path}/preview`, {
          method: "POST",
          body: {
            expectedUpdatedAt: estimate.updatedAt,
            expectedWorkVersion: estimate.workVersion ?? null,
          },
        }),
      );
      if (
        value.estimateId !== estimate.id ||
        JSON.stringify(value.document.lineItems) !==
          JSON.stringify(estimate.lineItems) ||
        value.document.title !== estimate.title ||
        value.document.notes !== (estimate.notes ?? null) ||
        value.document.totalCents !== estimate.totalCents ||
        value.document.taxCents !== estimate.taxCents ||
        value.document.subtotalCents !== estimate.subtotalCents ||
        (estimate.customerWorkId &&
          value.sender.source !== "company_default") ||
        Date.parse(value.expiresAt) <= Date.now()
      )
        throw new Error("Saved review differs");
      if (current(original)) setReview({ identity, preview: value });
    } catch {
      if (current(original))
        setError(
          "Review unavailable. Refresh saved evidence and check the estimate, authority and selected sender.",
        );
    } finally {
      fence.current = false;
      if (contextCurrent(original)) setBusy(false);
    }
  }
  async function send() {
    const original = token.current;
    if (
      fence.current ||
      !ready ||
      !current(original) ||
      !preview ||
      !approved ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      return;
    fence.current = true;
    owned.add(ownerKey);
    let uncertain = false;
    setBusy(true);
    setApproved(false);
    setReview(null);
    try {
      const value = estimateEmailEvidenceSchema.parse(
        await contractorRequest(`${path}/send`, {
          method: "POST",
          body: {
            previewId: preview.previewId,
            payloadSha256: preview.payloadSha256,
            confirmed: true,
          },
        }),
      );
      if (value.estimateId !== estimate.id)
        throw new Error("Send target differs");
      cache.setQueryData(queryKey, value);
    } catch {
      uncertain = true;
      if (contextCurrent(original))
        setError(
          "The send result is uncertain. Check the original mailbox and refresh retained evidence. Do not send again.",
        );
    } finally {
      fence.current = false;
      if (contextCurrent(original)) setBusy(false); // Read the original owner only; never POST again after uncertainty.
      if (uncertain) void cache.invalidateQueries({ queryKey, exact: true });
    }
  }
  const retained = evidence.data;
  return (
    <section
      aria-label={`Estimate email delivery ${estimate.title}`}
      className="mt-4 space-y-3 rounded-xl border border-border bg-muted/10 p-4"
    >
      <h3 className="font-bold">Estimate email delivery</h3>
      <p role="status">
        {evidence.isError || retained?.integrity === "unavailable"
          ? "Delivery evidence unavailable — approval blocked"
          : evidence.isLoading
            ? "Checking retained delivery evidence…"
            : retained
              ? estimateDeliveryLabels[retained.state]
              : "Delivery evidence unavailable"}
      </p>
      {retained && <p className="text-sm break-words">{retained.detail}</p>}
      {retained?.state === "accepted" && (
        <p>Acceptance does not confirm inbox delivery or customer approval.</p>
      )}
      {owned.has(ownerKey) && retained?.state === "not_sent" && (
        <p>
          The original submission still needs review. No new send is available.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className={control}
        disabled={busy || evidence.isFetching}
        onClick={() => {
          setReview(null);
          setApproved(false);
          void evidence.refetch();
        }}
      >
        Refresh delivery evidence
      </button>
      {ready && (
        <button
          type="button"
          className={control}
          disabled={busy}
          onClick={() => void prepare()}
        >
          Review estimate email
        </button>
      )}
      {preview && (
        <div className="space-y-3" aria-label="Complete email review">
          <dl className="text-sm space-y-2 break-words">
            <dt>Selected sender</dt>
            <dd>{preview.sender.senderEmail}</dd>
            <dt>Sender source</dt>
            <dd>
              {preview.sender.source === "company_default"
                ? "Company default"
                : "Lead assignee"}{" "}
              · {preview.sender.provider}
            </dd>
            <dt>Recipient</dt>
            <dd>{preview.message.recipient}</dd>
            <dt>Subject</dt>
            <dd>{preview.message.subject}</dd>
          </dl>
          <pre className="whitespace-pre-wrap break-words text-sm font-sans rounded-lg bg-background p-3 border border-border">
            {preview.message.body}
          </pre>
          <p className="text-sm break-words">
            {preview.document.businessName} · {preview.document.customerLabel} ·{" "}
            {preview.document.propertyLabel ?? "No property linked"}
          </p>
          <h4 className="font-semibold">Saved estimate line items</h4>
          <ul>
            {preview.document.lineItems.map((item, index) => (
              <li className="break-words text-sm" key={index}>
                {item.description} · {item.quantity} × $
                {formatEstimateDeliveryCents(item.unitPriceCents)} = $
                {formatEstimateDeliveryCents(item.totalCents)}
              </li>
            ))}
          </ul>
          <p>
            Subtotal $
            {formatEstimateDeliveryCents(preview.document.subtotalCents)} · Tax
            ${formatEstimateDeliveryCents(preview.document.taxCents)} · Total $
            {formatEstimateDeliveryCents(preview.document.totalCents)}
          </p>
          <h4 className="font-semibold">Customer-facing notes</h4>
          <p className="whitespace-pre-wrap break-words">
            {preview.document.notes ?? "No notes"}
          </p>
          <p className="text-sm">
            Review expires {new Date(preview.expiresAt).toLocaleString()}.
            Provider acceptance does not confirm inbox delivery or customer
            approval.
          </p>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={approved}
              onChange={(event) => setApproved(event.target.checked)}
            />
            I approve this exact sender, recipient and complete email.
          </label>
          <button
            type="button"
            className={`${control} bg-primary text-primary-foreground`}
            disabled={
              busy ||
              !ready ||
              !approved ||
              Date.parse(preview.expiresAt) <= Date.now()
            }
            onClick={() => void send()}
          >
            Send reviewed email
          </button>
        </div>
      )}
      {retained?.document && (
        <details>
          <summary className="min-h-11 cursor-pointer">
            Retained original email evidence
          </summary>
          <p>
            {retained.document.businessName} · {retained.document.customerLabel}{" "}
            · {retained.document.propertyLabel ?? "No property linked"}
          </p>
          <p>{retained.document.title}</p>
          <ul>
            {retained.document.lineItems.map((item, index) => (
              <li key={index}>
                {item.description} · {item.quantity} × $
                {formatEstimateDeliveryCents(item.unitPriceCents)} = $
                {formatEstimateDeliveryCents(item.totalCents)}
              </li>
            ))}
          </ul>
          <p>
            Subtotal $
            {formatEstimateDeliveryCents(retained.document.subtotalCents)} · Tax
            ${formatEstimateDeliveryCents(retained.document.taxCents)} · Total $
            {formatEstimateDeliveryCents(retained.document.totalCents)}
          </p>
          <p className="whitespace-pre-wrap break-words">
            {retained.document.notes}
          </p>
          <p>{retained.message?.recipient}</p>
          <p>{retained.message?.subject}</p>
          <pre className="whitespace-pre-wrap break-words font-sans">
            {retained.message?.body}
          </pre>
          <p>
            Provider: {retained.provider ?? "Unavailable"} · Receipt:{" "}
            {retained.providerMessageId ?? "Unavailable"}
          </p>
          <p>
            Retained evidence does not confirm inbox delivery or customer
            approval.
          </p>
        </details>
      )}
    </section>
  );
}
