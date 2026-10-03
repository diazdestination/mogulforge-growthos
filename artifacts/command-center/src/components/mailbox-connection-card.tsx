import { useEffect, useState } from "react";
import { z } from "zod/v4";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";

const statusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  version: z.number().int().nonnegative(),
  state: z.enum(["disabled", "pending", "active", "gap", "revoked"]),
  usable: z.boolean(),
  mailboxEmail: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  reason: z.string().nullable(),
  pendingParentCount: z.number().int().nonnegative(),
  reviewCount: z.number().int().nonnegative(),
  leadMonitoringEnabled: z.boolean(),
  leadMonitoringVersion: z.number().int().nonnegative(),
  leadMonitoringApprovedAt: z.string().nullable(),
  leadMonitoringChangedAt: z.string().nullable(),
});
type Status = z.infer<typeof statusSchema>;
export function MailboxConnectionCard({
  returnPath,
}: {
  returnPath: "/account" | "/settings";
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [readApproved, setReadApproved] = useState(false),
    [retentionApproved, setRetentionApproved] = useState(false);
  const [leadApproved, setLeadApproved] = useState(false),
    [leadStale, setLeadStale] = useState(false);
  async function load() {
    try {
      const response = await fetch("/api/v1/mailbox/microsoft", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      setStatus(statusSchema.parse(await response.json()));
      setError("");
      setReadApproved(false);
      setRetentionApproved(false);
      setLeadApproved(false);
      setLeadStale(false);
    } catch {
      setStatus(null);
      setError(
        "Reply-monitoring status could not be loaded. Refresh before changing access.",
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(disable: boolean) {
    if (!status || busy || (!disable && (!readApproved || !retentionApproved)))
      return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/mailbox/microsoft/${disable ? "disable" : "connect"}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            disable
              ? { expectedVersion: status.version, confirmed: true }
              : {
                  expectedVersion: status.version,
                  readAcknowledged: true,
                  retentionAcknowledged: true,
                  returnPath,
                },
          ),
        },
      );
      if (!response.ok) throw new Error();
      if (disable) {
        await load();
        return;
      }
      const value = (await response.json()) as { authorizationUrl?: string };
      const url = new URL(value.authorizationUrl ?? "");
      if (
        url.origin !== "https://login.microsoftonline.com" ||
        url.username ||
        url.password
      )
        throw new Error();
      window.location.assign(url.toString());
    } catch {
      setError(
        "The change was not confirmed. Refresh status; no alternative mailbox or automatic retry was used.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function setLeadContext(enabled: boolean) {
    if (
      !status ||
      busy ||
      leadStale ||
      (enabled && (!status.usable || !leadApproved))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        "/api/v1/mailbox/microsoft/lead-monitoring",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedConnectorVersion: status.version,
            expectedLeadMonitoringVersion: status.leadMonitoringVersion,
            enabled,
            leadContextAcknowledged: true,
          }),
        },
      );
      if (!response.ok) throw new Error();
      setStatus(statusSchema.parse(await response.json()));
      setLeadApproved(false);
    } catch {
      setLeadStale(true);
      setLeadApproved(false);
      setError(
        "Lead-monitoring approval was not confirmed or its version changed. Refresh reply-monitoring status and review again; no automatic retry was used.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Optional Microsoft reply monitoring</CardTitle>
        <CardDescription>
          Separate from sending access. Read only the connected and selected
          personal/work mailbox's Inbox and Sent Items after a new explicit
          start.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p role="alert">{error}</p>}
        {!status ? (
          <p>Reply-monitoring status unavailable or loading.</p>
        ) : (
          <>
            <p role="status">
              {status.usable
                ? `Monitoring is enabled for ${status.mailboxEmail}.`
                : `Monitoring is not ready (${status.reason ?? status.state}).`}
            </p>
            {!status.enabled && (
              <p>
                Platform mailbox reading is disabled. A connection cannot remove
                this control.
              </p>
            )}
            {status.startedAt && (
              <p className="text-sm">
                Current forward-only start:{" "}
                {new Date(status.startedAt).toLocaleString()}
              </p>
            )}
            {status.lastSuccessAt && (
              <p className="text-sm">
                Last completed page:{" "}
                {new Date(status.lastSuccessAt).toLocaleString()}. This is not
                proof of complete mailbox coverage.
              </p>
            )}
            {(status.pendingParentCount > 0 || status.reviewCount > 0) && (
              <p role="status">
                {status.pendingParentCount} replies await exact parent
                observation; {status.reviewCount} retained observations need
                operator review in the original mailbox. These are not confirmed
                customer replies.
              </p>
            )}
            {["gap", "revoked"].includes(status.state) && (
              <p>
                A gap or changed authorization needs operator review. A new
                opt-in starts from now; it cannot recover or silently skip the
                earlier gap. Review that missing period in the original mailbox.
              </p>
            )}
            <p className="text-sm">
              Requested separately: delegated Mail.Read, basic profile
              (User.Read), and offline access. No Mail.ReadWrite, shared
              mailbox, attachments, mailbox edits or message deletion. Existing
              send-only access is unchanged.
            </p>
            <p className="text-sm">
              Service reminders are the default tracked context. Individual BIE
              lead emails require the separate approval below and a new frozen
              send review. This is not a general inbox: Gmail, invoice replies,
              direct-compose and older/untracked messages are not connected
              here.
            </p>
            <p className="text-sm">
              Exact GrowthOS service-reminder replies become office review
              evidence, not commands, marketing consent, bookings or warranty
              decisions. Unmatched or ambiguous messages do not become trusted
              replies. Message IDs and retained digests are not delivery proof.
            </p>
            <section
              aria-label="Tracked lead reply permission"
              className="space-y-3 rounded-lg border border-border p-3"
            >
              <h3 className="font-semibold">Optional tracked lead replies</h3>
              <p className="break-words text-sm">
                {status.leadMonitoringEnabled
                  ? `Lead context approved at version ${status.leadMonitoringVersion}${status.usable ? "" : " — monitoring currently held"}.`
                  : "Lead context is off. Service-reminder monitoring is unchanged."}
              </p>
              {status.leadMonitoringApprovedAt && (
                <p className="text-xs text-muted-foreground">
                  Approved{" "}
                  {new Date(status.leadMonitoringApprovedAt).toLocaleString()}{" "}
                  for {status.mailboxEmail}.
                </p>
              )}
              <p className="text-sm">
                This local permission adds no Microsoft scope and does not reset
                mailbox history or service parents. Only newly prepared and
                individually approved BIE lead emails can be tracked. Replies
                hold follow-up and create office-review evidence; they do not
                authorize instructions or restore cancelled work.
              </p>
              {status.leadMonitoringEnabled ? (
                <Button
                  variant="outline"
                  disabled={busy || leadStale}
                  onClick={() => void setLeadContext(false)}
                >
                  Stop tracked lead replies
                </Button>
              ) : (
                <>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={busy || leadStale || !status.usable}
                      checked={leadApproved}
                      onChange={(event) =>
                        setLeadApproved(event.target.checked)
                      }
                    />
                    <span>
                      I explicitly approve tracked BIE lead replies for this
                      exact selected Microsoft mailbox. A later re-enable will
                      not adopt earlier lead conversations.
                    </span>
                  </label>
                  <Button
                    disabled={
                      busy || leadStale || !status.usable || !leadApproved
                    }
                    onClick={() => void setLeadContext(true)}
                  >
                    Enable tracked lead replies
                  </Button>
                </>
              )}
            </section>
            <fieldset
              disabled={busy || !status.enabled || !status.configured}
              className="space-y-3"
            >
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={readApproved}
                  onChange={(e) => setReadApproved(e.target.checked)}
                />
                <span>
                  I authorize read-only monitoring of this exact selected
                  Microsoft mailbox, separately from sending permission.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={retentionApproved}
                  onChange={(e) => setRetentionApproved(e.target.checked)}
                />
                <span>
                  I reviewed the company's inbound retention policy. Matched
                  content is untrusted, encrypted and retained under that
                  policy; durable duplicate evidence remains. A new start reads
                  only new mail and does not fill earlier gaps.
                </span>
              </label>
              <Button
                disabled={!readApproved || !retentionApproved}
                onClick={() => void act(false)}
              >
                Review Microsoft read permission
              </Button>
            </fieldset>
            {status.version > 0 && status.state !== "disabled" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(true)}
              >
                Disable reply monitoring locally
              </Button>
            )}
          </>
        )}
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          Refresh reply-monitoring status
        </Button>
        <p className="text-xs text-muted-foreground">
          Disabling removes the local read credential and stops future reads;
          existing evidence stays under the company's retention policy. Revoke
          remote consent in Microsoft separately. No live access or reliability
          is implied by this screen.
        </p>
      </CardContent>
    </Card>
  );
}
