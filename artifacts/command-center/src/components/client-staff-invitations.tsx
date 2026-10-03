import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlatformEmailDeliveryPanel } from "./platform-email-delivery-panel";

type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  version: number;
  state: "pending" | "expired" | "accepted" | "revoked";
  deliveryState: "sending" | "sent" | "unconfirmed";
  expiresAt: string;
};
type Listing = {
  organizationId: string;
  invitations: Invitation[];
  truncated: boolean;
};
const roles = {
  owner: "Owner",
  admin: "Administrator",
  office: "Office responder",
  sales_rep: "Sales representative",
  sales_manager: "Sales manager",
  inspector: "Inspector",
  production: "Production",
  viewer: "Read only",
};
const messages: Record<string, string> = {
  already_a_member:
    "This person already belongs to this workspace. Manage their access in Team settings.",
  email_unavailable:
    "This email already has an account or invitation. Review its existing access before continuing.",
  invitation_changed:
    "This invitation changed. Refresh its status before trying again.",
  invitation_recently_attempted:
    "An email was attempted within the last minute. Wait, refresh its status, then review before sending again.",
  invitation_already_accepted:
    "This invitation was accepted. Manage the member in Team settings.",
  transactional_email_unavailable:
    "Invitation email is not configured. Complete transactional email setup before sending.",
  invitation_request_changed:
    "This request changed. Restore the original details or edit the email to start a new request.",
  invitation_delivery_reconciliation_required:
    "A previous invitation send is still unknown. Review delivery evidence with platform support; a new link cannot bypass that uncertainty.",
  invalid_request: "Check the email, role and approval before sending.",
};
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: body ? "POST" : "GET",
    credentials: "include",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      messages[value.error ?? ""] ??
        "The result could not be confirmed. Your entries are saved here. Refresh the invitation list before taking another action.",
    );
  }
  return response.json() as Promise<T>;
}
const validInvitation = (v: Invitation, organizationId: string) =>
  v.organizationId === organizationId &&
  typeof v.id === "string" &&
  typeof v.email === "string" &&
  Object.hasOwn(roles, v.role) &&
  Number.isInteger(v.version) &&
  v.version > 0 &&
  ["pending", "expired", "accepted", "revoked"].includes(v.state) &&
  ["sending", "sent", "unconfirmed"].includes(v.deliveryState) &&
  Number.isFinite(Date.parse(v.expiresAt));

export function ClientStaffInvitations({
  organizationId,
  actorId,
  needsOwner,
}: {
  organizationId: string;
  actorId: string;
  needsOwner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  return (
    <section className="border-y py-5" aria-label="Client staff setup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose">
          <h3 className="font-semibold">Client staff</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {needsOwner
              ? "Invite the client’s first owner, then their office team."
              : "Invite staff to this workspace or review pending access."}{" "}
            Capture needs an accepted manager and responder. Pending invitations
            do not count.
          </p>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => {
            setStarted(true);
            setOpen(!open);
          }}
          aria-expanded={open}
          aria-controls="client-staff-panel"
        >
          {open ? "Close staff setup" : "Invite client staff"}
        </Button>
      </div>
      {started && (
        <div hidden={!open}>
          <StaffPanel
            key={`${actorId}:${organizationId}`}
            organizationId={organizationId}
            actorId={actorId}
            needsOwner={needsOwner}
          />
        </div>
      )}
    </section>
  );
}

function StaffPanel({
  organizationId,
  actorId,
  needsOwner,
}: {
  organizationId: string;
  actorId: string;
  needsOwner: boolean;
}) {
  const client = useQueryClient();
  const key = ["client-launchpad", actorId, organizationId, "invitations"];
  const path = `/platform/clients/${organizationId}/invitations`;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<keyof typeof roles>(
    needsOwner ? "owner" : "office",
  );
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<{
    row: Invitation;
    action: "revoke" | "reissue";
  } | null>(null);
  const [stale, setStale] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const list = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const value = await request<Listing>(path, undefined, signal);
      if (
        value.organizationId !== organizationId ||
        !Array.isArray(value.invitations) ||
        typeof value.truncated !== "boolean" ||
        !value.invitations.every((v) => validInvitation(v, organizationId))
      )
        throw new Error(
          "Invitation status is unavailable. Refresh to check this workspace.",
        );
      return value;
    },
    retry: false,
  });
  const refresh = async () => {
    const result = await list.refetch();
    if (!result.isError) {
      setStale(false);
      setReview(null);
      change.reset();
    }
    void client.invalidateQueries({
      queryKey: ["client-launchpad", actorId, organizationId, "readiness"],
    });
  };
  const created = useMutation({
    mutationFn: async () => {
      const value = await request<{ invitation: Invitation }>(path, {
        requestId: requestId.current,
        email: email.trim(),
        role,
        confirmed: true,
      });
      if (
        !validInvitation(value.invitation, organizationId) ||
        value.invitation.email !== email.trim().toLowerCase()
      )
        throw new Error(
          "The result could not be confirmed. Refresh status; retrying unchanged details will reuse this request.",
        );
      return value.invitation;
    },
    onSuccess: (row) => {
      setNotice(
        row.state === "accepted"
          ? "This invitation is already accepted."
          : row.deliveryState === "sent"
            ? "Email accepted by the sender. The person must still accept their invitation."
            : "Delivery is unconfirmed. Review delivery evidence before deliberately sending a fresh link.",
      );
      setEmail("");
      setConfirmed(false);
      requestId.current = crypto.randomUUID();
      void refresh();
    },
  });
  const change = useMutation({
    mutationFn: async (command: NonNullable<typeof review>) => {
      const value = await request<Invitation>(
        `${path}/${command.row.id}/${command.action}`,
        { expectedVersion: command.row.version, confirmed: true },
      );
      if (
        !validInvitation(value, organizationId) ||
        value.id !== command.row.id
      )
        throw new Error(
          "The result could not be confirmed. Refresh status before another action.",
        );
      return value;
    },
    onSuccess: (row) => {
      setNotice(
        row.state === "revoked"
          ? "Invitation revoked. Its existing links can no longer be accepted."
          : row.deliveryState === "sent"
            ? "Fresh link accepted by the sender. Earlier links are invalid."
            : "Fresh link delivery is unconfirmed. Review delivery evidence before sending again.",
      );
      setReview(null);
      void refresh();
    },
    onError: () => setStale(true),
  });
  const busy = created.isPending || change.isPending;
  const edit = () => {
    requestId.current = crypto.randomUUID();
    setConfirmed(false);
    setNotice("");
    created.reset();
  };
  return (
    <div id="client-staff-panel" className="mt-5 space-y-6">
      <form
        aria-label="Invite client staff"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed && !busy && !list.isError && !list.isPending)
            created.mutate();
        }}
      >
        <fieldset
          disabled={busy || list.isError || list.isPending}
          className="space-y-4"
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-[2fr_1fr]">
            <div className="space-y-2">
              <Label htmlFor="staff-email">Staff email</Label>
              <Input
                id="staff-email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  edit();
                  setEmail(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-role">Access</Label>
              <select
                id="staff-role"
                className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={role}
                onChange={(e) => {
                  edit();
                  setRole(e.target.value as keyof typeof roles);
                }}
              >
                {Object.entries(roles).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            The client approved this person’s email and access. Send their
            invitation.
          </label>
          <Button
            type="submit"
            className="min-h-11 dark:text-background"
            disabled={!confirmed || !email.trim() || busy}
          >
            {created.isPending
              ? "Sending invitation…"
              : created.isError
                ? "Retry same invitation request"
                : "Send invitation"}
          </Button>
        </fieldset>
        {created.isError && (
          <p role="alert" className="mt-3 max-w-prose text-sm text-destructive">
            {created.error instanceof TypeError
              ? "The result could not be confirmed. Refresh status; retrying unchanged details will reuse this request."
              : created.error.message}
          </p>
        )}
      </form>
      {notice && (
        <p role="status" className="max-w-prose text-sm">
          {notice}
        </p>
      )}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-medium">Invitation status</h4>
          <Button
            variant="ghost"
            disabled={busy || list.isFetching}
            onClick={() => void refresh()}
          >
            Refresh invitations
          </Button>
        </div>
        {list.isPending ? (
          <p role="status" className="mt-3 text-sm">
            Checking invitations…
          </p>
        ) : list.isError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            Invitation status is unavailable. Refresh before sending.
          </p>
        ) : list.data?.invitations.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No invitations recorded here. Existing accepted members remain in
            Team settings.
          </p>
        ) : (
          <ul className="mt-2 divide-y">
            {list.data?.invitations.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4"
              >
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium">{row.email}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {roles[row.role as keyof typeof roles]} ·{" "}
                    {row.state === "accepted"
                      ? "Accepted"
                      : row.state === "revoked"
                        ? "Revoked"
                        : row.state === "expired"
                          ? "Expired"
                          : row.deliveryState === "sent"
                            ? "Awaiting acceptance"
                            : "Delivery unconfirmed"}
                  </p>
                  {row.state === "pending" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Expires {new Date(row.expiresAt).toLocaleString()}
                    </p>
                  )}
                </div>
                {row.state !== "accepted" && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || stale || list.isFetching}
                      onClick={() => {
                        setReview({ row, action: "reissue" });
                        change.reset();
                      }}
                    >
                      Review fresh link
                    </Button>
                    {row.state !== "revoked" && (
                      <Button
                        variant="ghost"
                        disabled={busy || stale || list.isFetching}
                        onClick={() => {
                          setReview({ row, action: "revoke" });
                          change.reset();
                        }}
                      >
                        Revoke invitation
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {list.data?.truncated && (
          <p className="mt-2 text-sm">
            Showing the latest 100 invitations. Ask platform support to review
            older pending access before reissuing it.
          </p>
        )}
      </div>
      <PlatformEmailDeliveryPanel actorId={actorId} scope="platform" organizationId={organizationId} />
      {review && (
        <div
          className="space-y-3 border-t pt-4"
          aria-label="Review invitation action"
        >
          <p className="max-w-prose break-words text-sm">
            {review.action === "reissue"
              ? `Send a new link to ${review.row.email}? Check delivery evidence first if the last result is unknown. This invalidates earlier links and reopens revoked access. Confirm the client still approves this role.`
              : `Revoke ${review.row.email}’s invitation? Existing links will stop working. Accepted accounts are managed in Team settings.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              className="dark:text-background"
              disabled={busy || stale}
              onClick={() => change.mutate(review)}
            >
              {change.isPending
                ? "Saving…"
                : review.action === "reissue"
                  ? "Confirm and send fresh link"
                  : "Confirm revocation"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReview(null);
                change.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {change.isError && (
        <p role="alert" className="max-w-prose text-sm text-destructive">
          {change.error instanceof TypeError
            ? "The result could not be confirmed. Refresh status before another action."
            : change.error.message}
        </p>
      )}
      {stale && (
        <p className="text-sm">
          Refresh invitations to review the current state before another change.
        </p>
      )}
    </div>
  );
}
