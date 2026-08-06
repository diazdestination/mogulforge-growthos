import { useState } from 'react';
import { useCreateOrg } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@workspace/replit-auth-web';
import { Building2, Loader2 } from 'lucide-react';

/**
 * Shown to signed-in users who don't belong to an organization yet:
 * create a company workspace (they become its owner) or sign out to accept
 * an invite with a different account.
 */
export function CreateOrgScreen() {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createOrg = useCreateOrg({
    mutation: {
      onSuccess: async () => {
        // Registration can leave the browser at /signup. Once the org exists,
        // force the canonical app entry so that stale auth/session queries and
        // the public-only path cannot briefly render the signed-in 404 page.
        await queryClient.invalidateQueries();
        window.location.assign(import.meta.env.BASE_URL || '/');
      },
      onError: (err) => {
        const message =
          (err as { data?: { error?: string } } | null)?.data?.error ??
          'Could not create your workspace. Please try again.';
        setError(message);
      },
    },
  });

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <div className="max-w-md w-full px-8 py-12">
        <div className="w-14 h-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-6">
          <Building2 className="w-7 h-7" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Create your workspace</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Set up a CRM workspace for your company. You'll be the owner and a
          guided setup will walk you through the rest. Expecting to join an
          existing team? Ask an admin to invite your email address instead.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (name.trim().length >= 2) createOrg.mutate({ data: { name: name.trim() } });
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="org-name" className="block text-sm font-medium mb-1.5">
              Company name
            </label>
            <input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Summit Home Services"
              data-testid="create-org-name"
              className="w-full h-11 rounded-md border border-border bg-background px-3 text-sm"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="create-org-error">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={createOrg.isPending || name.trim().length < 2}
            data-testid="create-org-submit"
            className="w-full inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-11 rounded-md font-semibold text-sm disabled:opacity-50"
          >
            {createOrg.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Create workspace
          </button>
        </form>
        <button
          onClick={logout}
          className="mt-6 text-xs text-muted-foreground hover:text-foreground underline"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
