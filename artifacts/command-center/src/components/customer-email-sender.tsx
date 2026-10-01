import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetEmailProviderStatusQueryKey,
  getGetSettingsQueryKey,
  useGetEmailProviderStatus,
  useGetSettings,
  useListUsers,
  useUpdateSettings,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export function CustomerEmailSender() {
  const { data: settings } = useGetSettings();
  const { data: users } = useListUsers();
  const { data: status } = useGetEmailProviderStatus();
  const [sender, setSender] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  useEffect(
    () => setSender(settings?.customerEmailSenderUserId ?? ""),
    [settings?.customerEmailSenderUserId],
  );
  const update = useUpdateSettings({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() }),
          queryClient.invalidateQueries({
            queryKey: getGetEmailProviderStatusQueryKey(),
          }),
        ]);
        toast({ title: "Customer email sender saved" });
      },
      onError: (error) =>
        toast({
          title: "Could not save sender",
          description: error.message,
          variant: "destructive",
        }),
    },
  });
  const eligible =
    users?.filter((user) => user.isActive && user.role !== "viewer") ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer email sender</CardTitle>
        <CardDescription>
          Choose the staff member's selected Gmail or Microsoft account for
          portal sign-in codes and customer messages without an assigned lead
          owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="customer-email-sender">Company default sender</Label>
        <select
          id="customer-email-sender"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={sender}
          onChange={(event) => setSender(event.target.value)}
          disabled={!settings || update.isPending}
        >
          <option value="">
            No default sender — leave unassigned email blocked
          </option>
          {sender && !eligible.some((user) => user.id === sender) && (
            <option value={sender}>
              Previously selected sender — unavailable
            </option>
          )}
          {eligible.map((user) => (
            <option key={user.id} value={user.id}>
              {[user.firstName, user.lastName].filter(Boolean).join(" ") ||
                user.email ||
                "Staff member"}
              {user.email ? ` (${user.email})` : ""}
            </option>
          ))}
        </select>
        <p className="text-sm text-muted-foreground">
          The selected person must connect and choose their sending account in{" "}
          <a href="/account" className="underline">
            My Profile
          </a>{" "}
          first. Messages for assigned leads use that lead owner's selected
          mailbox. A disconnected or inactive sender blocks the send until
          corrected.
        </p>
        {status && (
          <p role="status" className="text-sm">
            {status.provider === "gmail" || status.provider === "microsoft"
              ? `Connected default: ${status.senderEmail}.`
              : (status.reason ?? "Default customer email is unavailable.")}
          </p>
        )}
        <Button
          disabled={
            !settings ||
            update.isPending ||
            sender === (settings.customerEmailSenderUserId ?? "")
          }
          onClick={() =>
            update.mutate({
              data: { customerEmailSenderUserId: sender || null },
            })
          }
        >
          {update.isPending ? "Saving…" : "Save customer sender"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Account verification, password recovery, team invitations, and
          platform security notices use MogulForge's separate transactional
          sender.
        </p>
      </CardContent>
    </Card>
  );
}
