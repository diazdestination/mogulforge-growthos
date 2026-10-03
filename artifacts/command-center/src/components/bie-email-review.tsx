import { z } from "zod/v4";

const emailReview = z.object({
  version: z.literal(1),
  preparedByUserId: z.string().min(1),
  preparedAt: z.iso.datetime(),
  recipient: z.email(),
  sender: z.object({
    provider: z.enum(["gmail", "microsoft"]),
    senderEmail: z.email(),
  }),
  leadId: z.string().min(1),
  contactId: z.string().min(1),
  leadCreatedAt: z.iso.datetime(),
  leadUpdatedAt: z.iso.datetime(),
});
const trackedDelivery = z.object({
  version: z.literal(1),
  kind: z.literal("bie_lead_email"),
  recipient: z.email(),
  mailboxIdentity: z.object({
    provider: z.literal("microsoft"),
    mailboxEmail: z.email(),
  }),
  leadMonitoringApproval: z.object({
    version: z.number().int().positive(),
    approvedAt: z.iso.datetime(),
  }),
});
export function preparedBieEmail(payload: Record<string, unknown>) {
  const parsed = emailReview.safeParse(payload.emailReview);
  if (
    !parsed.success ||
    typeof payload.subject !== "string" ||
    typeof payload.body !== "string"
  )
    return null;
  const tracked =
    payload.deliverySnapshot === undefined
      ? null
      : trackedDelivery.safeParse(payload.deliverySnapshot);
  if (
    tracked &&
    (!tracked.success ||
      parsed.data.sender.provider !== "microsoft" ||
      tracked.data.recipient !== parsed.data.recipient ||
      tracked.data.mailboxIdentity.mailboxEmail !==
        parsed.data.sender.senderEmail)
  )
    return null;
  return {
    ...parsed.data,
    tracked: Boolean(tracked?.success),
    leadApprovalVersion: tracked?.success
      ? tracked.data.leadMonitoringApproval.version
      : null,
  };
}
/** Rendered text only. This cannot broaden permission or reconstruct a snapshot. */
export function BieEmailReviewSummary({
  payload,
  status,
  showContent = false,
}: {
  payload: Record<string, unknown>;
  status: string;
  showContent?: boolean;
}) {
  const review = preparedBieEmail(payload);
  return (
    <section
      aria-label="Frozen email review"
      className="mt-3 min-w-0 space-y-2 rounded-lg border border-border bg-background p-3 text-sm"
    >
      {review ? (
        <>
          <p className="break-all">
            <span className="font-semibold">To:</span> {review.recipient}
          </p>
          <p className="break-all">
            <span className="font-semibold">From:</span>{" "}
            {review.sender.senderEmail} ·{" "}
            {review.sender.provider === "microsoft" ? "Microsoft" : "Gmail"}
          </p>
          <p className="text-xs text-muted-foreground">
            Frozen {new Date(review.preparedAt).toLocaleString()}. Sending
            rechecks the current approved contact and this selected account.
          </p>
          <p>
            {review.tracked
              ? `Tracked Microsoft lead reply — explicit monitoring approval version ${review.leadApprovalVersion}.`
              : "Untracked email — original-mailbox lead reply monitoring is not included in this review."}
          </p>
        </>
      ) : (
        <p>
          {status === "proposed"
            ? "Prepare the recipient and sender before approving this email. No current recipient or mailbox has been frozen for review."
            : "Legacy or unavailable email review — no tracked lead reply is claimed. Existing send ownership and safety holds remain."}
        </p>
      )}
      {showContent && (
        <>
          <p className="break-words font-medium">
            Subject:{" "}
            {typeof payload.subject === "string"
              ? payload.subject
              : "Unavailable"}
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">
            {typeof payload.body === "string"
              ? payload.body
              : "Content unavailable"}
          </pre>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Approval is not sending or delivery. Incoming content remains untrusted
        office evidence, never permission to book or send again.
      </p>
    </section>
  );
}
