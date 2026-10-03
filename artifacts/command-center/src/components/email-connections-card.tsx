import { useEffect, useState } from "react";
import { GmailConnectionCard } from "./gmail-connection-card";
import { MailboxConnectionCard } from "./mailbox-connection-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { useToast } from "@/hooks/use-toast";

type MicrosoftStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
};
type SenderStatus = {
  provider: "gmail" | "microsoft" | null;
  connected: boolean;
  reason: string | null;
  gmail: { connected: boolean; configured: boolean; email: string | null };
  microsoft: { connected: boolean; configured: boolean; email: string | null };
};

const nullableText = (value: unknown) =>
  value === null || typeof value === "string";
function mailboxStatus(value: unknown): value is SenderStatus["gmail"] {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.configured === "boolean" &&
    typeof status.connected === "boolean" &&
    nullableText(status.email)
  );
}
function validSender(value: unknown): value is SenderStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return (
    [null, "gmail", "microsoft"].includes(status.provider as string | null) &&
    typeof status.connected === "boolean" &&
    nullableText(status.reason) &&
    mailboxStatus(status.gmail) &&
    mailboxStatus(status.microsoft)
  );
}
function validMicrosoft(value: unknown): value is MicrosoftStatus {
  if (!mailboxStatus(value)) return false;
  const status = value as unknown as Record<string, unknown>;
  return nullableText(status.lastErrorCode) && nullableText(status.lastErrorAt);
}

/** Per-user mailbox connection and explicit dispatch identity; never activation. */
export function EmailConnectionsCard({
  callbackState,
  returnPath,
}: {
  callbackState: string | null;
  returnPath: "/account" | "/settings";
}) {
  const [microsoft, setMicrosoft] = useState<MicrosoftStatus | null>(null);
  const [sender, setSender] = useState<SenderStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  async function load() {
    try {
      const [mailResponse, senderResponse] = await Promise.all([
        fetch("/api/v1/integrations/microsoft", { credentials: "include" }),
        fetch("/api/v1/integrations/email-sender", { credentials: "include" }),
      ]);
      if (!mailResponse.ok || !senderResponse.ok)
        throw new Error("Email connection status could not be loaded.");
      const mailbox: unknown = await mailResponse.json();
      const choice: unknown = await senderResponse.json();
      if (!validSender(choice) || !validMicrosoft(mailbox))
        throw new Error("Invalid sender status");
      setMicrosoft(mailbox);
      setSender(choice);
      setSelected(choice.provider ?? "");
      setError(null);
    } catch {
      setMicrosoft(null);
      setSender(null);
      setError(
        "Email connection status could not be loaded. Refresh before making changes.",
      );
    }
  }
  useEffect(() => {
    void load();
    const callback = new URLSearchParams(window.location.search).get(
      "microsoft",
    );
    if (callback === "denied" || callback === "failed") {
      toast({
        title:
          "Microsoft connection was not completed. Start again when ready.",
        variant: "destructive",
      });
    }
    if (callback) window.history.replaceState({}, "", returnPath);
    // Connection status, never the query-string hint, determines readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function connect() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/integrations/microsoft/connect", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnPath }),
      });
      const result = (await response.json()) as { authorizationUrl?: string };
      if (!response.ok || !result.authorizationUrl) throw new Error();
      const target = new URL(result.authorizationUrl);
      if (
        target.protocol !== "https:" ||
        target.hostname !== "login.microsoftonline.com"
      )
        throw new Error();
      window.location.assign(target.toString());
    } catch {
      setError(
        "Could not start Microsoft authorization. Check configuration or try a new connection.",
      );
      setBusy(false);
    }
  }
  async function disconnect() {
    if (
      !window.confirm(
        "Remove this Microsoft credential from GrowthOS? Future sends will stop; already accepted messages may still arrive. Remote Microsoft consent is not revoked by this action.",
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch("/api/v1/integrations/microsoft", {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error();
      toast({
        title:
          "Microsoft disconnected locally. Review Microsoft app permissions separately to revoke consent.",
      });
      await load();
    } catch {
      setError("Microsoft could not be disconnected. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }
  async function saveSender() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/integrations/email-sender", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: selected }),
      });
      if (!response.ok) throw new Error();
      await load();
      toast({ title: "Your email sending account was saved" });
    } catch {
      setError("Connect the selected mailbox before saving your sender.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Your email sending account</CardTitle>
          <CardDescription>
            Choose the account GrowthOS should use for your approved customer
            emails. Connecting an account does not enable campaigns or remove
            safety holds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Label htmlFor="email-provider-choice">
            Send your customer emails with
          </Label>
          <select
            id="email-provider-choice"
            className="w-full min-h-11 rounded-md border bg-background px-3 py-2 text-sm"
            value={selected}
            disabled={busy || !sender || Boolean(error)}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a connected account</option>
            <option value="gmail" disabled={!sender?.gmail.connected}>
              Gmail
              {sender?.gmail.email
                ? ` — ${sender.gmail.email}`
                : " — not connected"}
            </option>
            <option value="microsoft" disabled={!sender?.microsoft.connected}>
              Microsoft 365 / Outlook
              {sender?.microsoft.email
                ? ` — ${sender.microsoft.email}`
                : " — not connected"}
            </option>
          </select>
          <p role="status" className="text-sm text-muted-foreground">
            {sender?.connected
              ? "Selected account is connected. Delivery still requires the applicable approval and contact-policy checks."
              : (sender?.reason ?? "Checking sending account…")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                !sender ||
                Boolean(error) ||
                !selected ||
                selected === sender.provider
              }
              onClick={() => void saveSender()}
            >
              Save sending account
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void load()}
            >
              Refresh email status
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            If this account disconnects, email stops. GrowthOS will not switch
            to another mailbox. Yahoo and other unconnected providers are not
            supported for automated sending.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Microsoft 365 / Outlook</CardTitle>
          <CardDescription>
            Connect your own work, school, or personal Microsoft mailbox, then
            select it above. Your Microsoft administrator may need to approve
            this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            {microsoft?.connected
              ? `Connected: ${microsoft.email}`
              : microsoft?.lastErrorCode ===
                  "microsoft_reauthorization_required"
                ? "Reconnect required — Microsoft access expired, changed, or was revoked."
                : microsoft?.configured
                  ? "No Microsoft mailbox connected."
                  : "A platform administrator must configure Microsoft OAuth before connection is available."}
          </p>
          {microsoft?.lastErrorAt && (
            <p role="status" className="text-sm text-destructive">
              Last Microsoft operation needs attention.{" "}
              {microsoft.lastErrorCode === "microsoft_send_outcome_unknown"
                ? "Check Sent Items before a new attempt; the previous send may have been accepted."
                : "Review the connection and selected sender before a new attempt."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !microsoft?.configured || Boolean(error)}
              onClick={() => void connect()}
            >
              {microsoft?.connected
                ? "Reconnect Microsoft"
                : "Connect Microsoft"}
            </Button>
            {microsoft?.email && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                Disconnect Microsoft locally
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Permissions: send mail as you, read your basic account profile, and
            maintain offline access. This send-only connection does not request
            inbox reading, mail editing, or shared-mailbox send-as access.
            Optional reply reading below requires a separate explicit approval.
          </p>
          <p className="text-sm text-muted-foreground">
            Disconnect removes the local credential and cancels pending GrowthOS
            connections; it does not revoke Microsoft consent. For work/school
            accounts, review{" "}
            <a
              href="https://myapplications.microsoft.com/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              My Apps permissions
            </a>{" "}
            or ask your Microsoft administrator. For personal accounts, review
            the apps permitted by your Microsoft account.
          </p>
          <p className="text-xs text-muted-foreground">
            Microsoft acceptance is not delivery confirmation. Its send API
            provides no mailbox message ID; GrowthOS keeps request correlation
            separate.
          </p>
        </CardContent>
      </Card>
      <MailboxConnectionCard returnPath={returnPath} />
      <GmailConnectionCard
        callbackState={callbackState}
        returnPath={returnPath}
      />
    </div>
  );
}
