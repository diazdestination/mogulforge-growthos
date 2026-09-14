import { useState } from "react";
import {
  getGetSessionQueryKey,
  getListPlatformOrgsQueryKey,
  useCreateOrg,
  useGetSession,
  useListPlatformOrgs,
  useUpdatePlatformOrg,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Pencil, Plus, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ClientLaunchpad } from "@/components/client-launchpad";
import { ClientOperations } from "@/components/revenue-workspace";

/**
 * Platform super-admin console (MogulForge operators): list every
 * organization on the platform, create new ones, and rename existing ones.
 * Deliberately minimal — org-level administration happens inside each org.
 */
export default function Platform() {
  return (
    <div className="mx-auto w-full max-w-6xl min-w-0 space-y-6 p-4 md:p-8">
      <ClientOperations />
      <ClientLaunchpad />
      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Advanced organization administration
        </summary>
        <LegacyPlatform />
      </details>
    </div>
  );
}

function LegacyPlatform() {
  const { data: session, isLoading: sessionLoading } = useGetSession({
    query: { queryKey: getGetSessionQueryKey() },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPlatformAdmin = session?.isPlatformAdmin === true;
  const { data, isLoading } = useListPlatformOrgs({
    query: {
      queryKey: getListPlatformOrgsQueryKey(),
      enabled: isPlatformAdmin,
    },
  });
  const [newOrgName, setNewOrgName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListPlatformOrgsQueryKey() });

  const createOrg = useCreateOrg({
    mutation: {
      onSuccess: (res) => {
        setNewOrgName("");
        invalidate();
        toast({
          title: "Organization created",
          description: res.organization.name,
        });
      },
      onError: () =>
        toast({
          title: "Could not create organization",
          description: "Check the name and try again.",
          variant: "destructive",
        }),
    },
  });
  const updateOrg = useUpdatePlatformOrg({
    mutation: {
      onSuccess: () => {
        setEditing(null);
        invalidate();
        toast({ title: "Organization updated" });
      },
      onError: () =>
        toast({
          title: "Could not update organization",
          variant: "destructive",
        }),
    },
  });

  if (sessionLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isPlatformAdmin) {
    return (
      <div
        className="max-w-md mx-auto p-8 text-center"
        data-testid="platform-denied"
      >
        <ShieldAlert className="w-10 h-10 mx-auto text-muted-foreground mb-4" />
        <h1 className="text-xl font-bold mb-2">Platform access required</h1>
        <p className="text-sm text-muted-foreground">
          This console is only available to platform administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Platform organizations
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every company on this platform. Create a workspace for a new client or
          rename an existing one.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newOrgName.trim().length >= 2) {
            createOrg.mutate({ data: { name: newOrgName.trim() } });
          }
        }}
      >
        <input
          value={newOrgName}
          onChange={(e) => setNewOrgName(e.target.value)}
          placeholder="New organization name"
          aria-label="New organization name"
          data-testid="new-org-name"
          className="flex-1 h-10 rounded-md border border-border bg-background px-3 text-sm"
        />
        <button
          type="submit"
          disabled={createOrg.isPending || newOrgName.trim().length < 2}
          data-testid="create-org"
          className="inline-flex items-center gap-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-md px-4 h-10 hover:bg-primary/90 disabled:opacity-50"
        >
          {createOrg.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          Create
        </button>
      </form>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border bg-card"
          data-testid="platform-org-list"
        >
          {(data?.organizations ?? []).map((org) => (
            <li key={org.id} className="flex items-center gap-3 p-4">
              <div className="w-9 h-9 rounded bg-muted flex items-center justify-center shrink-0">
                <Building2 className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                {editing?.id === org.id ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editing.name.trim().length >= 2) {
                        updateOrg.mutate({
                          id: org.id,
                          data: { name: editing.name.trim() },
                        });
                      }
                    }}
                  >
                    <input
                      value={editing.name}
                      onChange={(e) =>
                        setEditing({ id: org.id, name: e.target.value })
                      }
                      aria-label={`Rename ${org.name}`}
                      className="flex-1 h-8 rounded border border-border bg-background px-2 text-sm"
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="text-xs font-semibold text-primary"
                      disabled={updateOrg.isPending}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="font-medium text-sm truncate">
                      {org.name}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {org.slug} · {org.memberCount} member
                      {org.memberCount === 1 ? "" : "s"} · {org.timezone}
                    </div>
                  </>
                )}
              </div>
              {editing?.id !== org.id && (
                <button
                  onClick={() => setEditing({ id: org.id, name: org.name })}
                  aria-label={`Edit ${org.name}`}
                  className="p-2 rounded hover:bg-muted text-muted-foreground"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
