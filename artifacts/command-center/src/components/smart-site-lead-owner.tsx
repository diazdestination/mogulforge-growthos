import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SmartSiteInquiryOwnership } from "@workspace/api-client-react";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentMemberAuthorityMatches } from "@/lib/member-authority-scope";

type InquiryOwnership = Pick<
  SmartSiteInquiryOwnership,
  | "organizationId"
  | "leadId"
  | "siteName"
  | "status"
  | "assignedUserId"
  | "ownerName"
  | "ownerEligible"
  | "canClaim"
>;

type Props = {
  organizationId: string;
  leadId: string;
  userId: string;
  scopeKey: string;
  canWrite: boolean;
};

const readFailure =
  "Inquiry ownership could not be refreshed. Try refreshing again.";

/** The notification destination reads this inquiry directly, never the capped queue. */
export function SmartSiteLeadOwner(props: Props) {
  // Real authority or lead changes discard pending local state, even for a caller
  // that does not provide its own React key.
  return (
    <OwnershipPanel
      key={`${props.scopeKey}:${props.organizationId}:${props.leadId}:${props.userId}:${props.canWrite}`}
      {...props}
    />
  );
}

function OwnershipPanel({
  organizationId,
  leadId,
  userId,
  scopeKey,
  canWrite,
}: Props) {
  const client = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const authorityMatches = () =>
    mounted.current && currentMemberAuthorityMatches(client, scopeKey);
  const [claimSaved, setClaimSaved] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const key = [
    "smart-sites",
    organizationId,
    "lead-follow-up",
    leadId,
    scopeKey,
    canWrite,
  ];
  const endpoint = `/api/v1/smart-sites/leads/${encodeURIComponent(leadId)}`;
  const ownership = useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<InquiryOwnership | null> => {
      const response = await fetch(`${endpoint}/follow-up`, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(readFailure);
      const data = await response.json();
      if (
        data?.organizationId !== organizationId ||
        data?.leadId !== leadId ||
        typeof data.siteName !== "string" ||
        typeof data.status !== "string" ||
        !(
          data.assignedUserId === null ||
          typeof data.assignedUserId === "string"
        ) ||
        !(data.ownerName === null || typeof data.ownerName === "string") ||
        typeof data.ownerEligible !== "boolean" ||
        typeof data.canClaim !== "boolean"
      ) {
        throw new Error(readFailure);
      }
      return data;
    },
    retry: false,
    // Returning after an uncertain or late claim must not reuse a fresh but
    // unassigned cache entry from before the write.
    refetchOnMount: "always",
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  const inquiry = ownership.data;
  const fresh =
    !ownership.isFetching &&
    !ownership.isError &&
    !ownership.isStale &&
    !refreshRequired;
  const eligible =
    canWrite && inquiry?.canClaim && inquiry.assignedUserId === null;
  const claim = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!authorityMatches() || !fresh || !eligible)
        throw new Error(readFailure);
      const response = await fetch(`${endpoint}/owner`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId: userId, expectedOwnerId: null }),
      });
      if (response.status === 409) {
        throw new Error(
          "This inquiry changed. Refresh ownership to see who is handling it.",
        );
      }
      if (!response.ok)
        throw new Error(
          "Your claim was not confirmed. Refresh ownership before trying again.",
        );
      const receipt = await response.json();
      if (receipt?.leadId !== leadId || receipt?.assignedUserId !== userId) {
        throw new Error(
          "Your claim was not confirmed. Refresh ownership before trying again.",
        );
      }
    },
    onSuccess: async () => {
      if (!authorityMatches()) return;
      await client.cancelQueries({ queryKey: key, exact: true });
      if (!authorityMatches()) return;
      setClaimSaved(true);
      setClaimError("");
      // Preserve the acknowledged write independently of any subsequent read.
      client.setQueryData<InquiryOwnership | null>(key, (old) =>
        old
          ? {
              ...old,
              assignedUserId: userId,
              ownerName: null,
              ownerEligible: true,
              canClaim: false,
            }
          : old,
      );
      await Promise.allSettled([
        client.invalidateQueries({ queryKey: ["smart-sites", organizationId] }),
        client.invalidateQueries({
          predicate: (query) =>
            /leads|tasks|activities|next-action|today-actions/.test(
              JSON.stringify(query.queryKey),
            ),
        }),
      ]);
    },
    onError: (error) => {
      if (!authorityMatches()) return;
      setRefreshRequired(true);
      setClaimError(
        error instanceof Error &&
          [
            readFailure,
            "This inquiry changed. Refresh ownership to see who is handling it.",
            "Your claim was not confirmed. Refresh ownership before trying again.",
          ].includes(error.message)
          ? error.message
          : "Your claim was not confirmed. Refresh ownership before trying again.",
      );
    },
  });

  const refresh = async () => {
    const result = await ownership.refetch();
    if (authorityMatches() && result.isSuccess) {
      setRefreshRequired(false);
      setClaimError("");
      claim.reset();
    }
  };

  if (inquiry === null && !claimSaved && !ownership.isError) return null;
  const owner =
    inquiry?.assignedUserId === userId
      ? "You"
      : inquiry?.ownerName || "Previous team member";
  return (
    <section
      aria-label="Website inquiry ownership"
      className="space-y-3 rounded-xl border border-primary/30 bg-muted/10 p-4 text-sm"
    >
      <h2 className="flex items-center gap-2 font-semibold">
        <UserCheck className="h-4 w-4 shrink-0 text-primary" /> Inquiry owner
      </h2>
      {ownership.isPending ? (
        <p role="status" className="text-muted-foreground">
          Checking inquiry ownership…
        </p>
      ) : (
        inquiry && (
          <div className="min-w-0 space-y-1">
            <p className="break-words font-medium">
              {inquiry.assignedUserId ? owner : "Unassigned"}
            </p>
            <p className="break-words text-muted-foreground">
              Website inquiry · {inquiry.siteName}
            </p>
            {inquiry.assignedUserId && !inquiry.ownerEligible && (
              <p>
                The assigned person can no longer respond. Ask the office to
                reassign this inquiry.
              </p>
            )}
          </div>
        )
      )}
      {claimSaved && (
        <p role="status" className="font-medium">
          Your claim was saved.
        </p>
      )}
      {claimSaved && inquiry === null && (
        <p role="alert">
          This inquiry is no longer available. Refresh the lead to check your
          access.
        </p>
      )}
      {(ownership.isError || claimError) && (
        <p role="alert" className="text-red-700 dark:text-red-400">
          {ownership.isError ? readFailure : claimError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {eligible && (
          <Button
            size="sm"
            className="min-h-11 dark:text-slate-950"
            disabled={!fresh || claim.isPending}
            onClick={() => {
              if (authorityMatches()) claim.mutate();
            }}
          >
            {claim.isPending ? "Claiming…" : "Claim inquiry"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={ownership.isFetching || claim.isPending}
          onClick={() => void refresh()}
        >
          Refresh ownership
        </Button>
      </div>
      {eligible && (
        <p className="text-xs text-muted-foreground">
          Claim this inquiry so the team knows you will follow up.
        </p>
      )}
    </section>
  );
}
