import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";

const receipt = z.object({
  id: z.uuid(), organizationId: z.uuid().nullable(), invitationId: z.uuid().nullable(),
  recipientLabel: z.email().nullable(),
  purpose: z.enum(["email_verification", "password_reset", "staff_invitation"]),
  outcome: z.enum(["claimed", "accepted", "rejected", "unknown", "not_attempted"]),
  outcomeCode: z.string().nullable(), provider: z.literal("resend"), providerMessageId: z.uuid().nullable(),
  deliveryState: z.enum(["unconfirmed", "delivered", "delayed", "failed", "bounced", "complained", "needs_review"]),
  deliveryConfirmed: z.boolean(), retryAllowed: z.literal(false), claimedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), lastEventAt: z.iso.datetime().nullable(),
}).refine(value => value.deliveryConfirmed === (value.deliveryState === "delivered") && (!value.deliveryConfirmed || value.outcome === "accepted"));
const responseSchema = z.object({ deliveries: z.array(receipt).max(25), page: z.number().int().positive(), pageSize: z.literal(25), hasMore: z.boolean(),
  unmatchedCallbackCount: z.number().int().nonnegative().nullable(), unmatchedCallbackLimit: z.literal(1000) });
const purposes = { email_verification: "Email verification", password_reset: "Password reset", staff_invitation: "Staff invitation" };
function deliveryLabel(row: z.infer<typeof receipt>) {
  if (row.deliveryState === "needs_review") return "Conflicting evidence — operator review required";
  if (row.deliveryState === "complained") return "Spam complaint — further identity mail is held";
  if (row.deliveryState === "bounced") return "Permanent bounce — further identity mail is held";
  if (row.deliveryState === "delivered") return "Delivered to the recipient's mail server";
  if (row.deliveryState === "failed") return "Provider reported a delivery failure";
  if (row.deliveryState === "delayed") return "Provider reported delayed delivery";
  if (row.outcome === "accepted") return "Accepted by the sender — inbox delivery unconfirmed";
  if (row.outcome === "rejected") return "Rejected by the sender — review configuration";
  if (row.outcome === "not_attempted") return "Not attempted — configuration or authorization guard blocked it";
  if (row.outcome === "claimed") return "Send slot reserved — outcome not yet confirmed";
  return "Outcome unknown — do not send again";
}

/** Read-only evidence: refreshing this panel never retries an email or grants account access. */
export function PlatformEmailDeliveryPanel({ actorId, scope, organizationId, invitationId }: {
  actorId: string; scope: "platform" | "member"; organizationId?: string; invitationId?: string;
}) {
  const [page, setPage] = useState(1);
  const status = useQuery({ queryKey: ["platform-email-delivery", actorId, scope, organizationId, invitationId, page], retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ page: String(page) });
      if (scope === "platform" && organizationId) params.set("organizationId", organizationId);
      if (invitationId) params.set("invitationId", invitationId);
      const result = await fetch(`/api/v1/${scope === "platform" ? "platform" : "staff-invitations"}/email-deliveries?${params}`, {
        method: "GET", credentials: "include", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!result.ok) throw new Error("Delivery evidence unavailable");
      const value = responseSchema.parse(await result.json());
      if (value.page !== page || value.deliveries.some(row => (organizationId && row.organizationId !== organizationId) || (invitationId && row.invitationId !== invitationId) || (scope === "member" && row.purpose !== "staff_invitation")))
        throw new Error("Unexpected delivery evidence");
      return value;
    },
  });
  return <section aria-label="Platform email delivery evidence" className="min-w-0 space-y-3 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-medium">Account email delivery</h4>
      <Button type="button" variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>Refresh delivery status</Button></div>
    <p className="max-w-prose text-sm text-muted-foreground">Acceptance is not inbox delivery. Mail-server delivery does not verify an account or accept an invitation. Refreshing status sends nothing; uncertain attempts cannot be retried here.</p>
    {status.isPending ? <p role="status">Checking delivery evidence…</p> : status.isError ? <p role="alert" className="text-sm text-destructive">Delivery evidence is unavailable. Refresh to check; do not assume an email was sent or try sending it again.</p>
      : <>
        {status.data.unmatchedCallbackCount !== null && status.data.unmatchedCallbackCount > 0 && <p role="status" className="text-sm">{status.data.unmatchedCallbackCount} authenticated callback records await an exact send receipt. Capacity: {status.data.unmatchedCallbackLimit}. These are not confirmed deliveries.</p>}
        {status.data.deliveries.length === 0 ? <p className="text-sm">No delivery receipts on this page. Historical invitations may have no durable provider evidence.</p>
          : <ul className="divide-y">{status.data.deliveries.map(row => <li key={row.id} className="min-w-0 space-y-1 py-3">
            <p className="font-medium">{purposes[row.purpose]}</p><p className="break-all text-sm">{row.recipientLabel ?? "Original account address unavailable or changed"}</p><p className="text-sm">{deliveryLabel(row)}</p>
            <p className="break-all text-xs text-muted-foreground">Receipt {row.id} · {new Date(row.claimedAt).toLocaleString()}</p>
            {row.outcomeCode && <p className="break-all text-xs text-muted-foreground">Reason: {row.outcomeCode}</p>}
          </li>)}</ul>}
        <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="ghost" disabled={page === 1 || status.isFetching} onClick={() => setPage(value => value - 1)}>Previous receipts</Button>
          <span className="text-sm">Page {page}</span><Button type="button" variant="ghost" disabled={!status.data.hasMore || status.isFetching} onClick={() => setPage(value => value + 1)}>Next receipts</Button></div>
      </>}
  </section>;
}
